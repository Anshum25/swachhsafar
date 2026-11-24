// On-device face analysis (@vladmandic/face-api, TensorFlow.js). Loaded only when a screen needs it; the
// library and models are precached by the service worker, so it works offline. Photos are analysed in memory
// and never leave the device for this purpose.
import { FACE_MODEL, meanDescriptor } from './faceMatch.js';

const MODELS = '/models/face';
let loading = null;

export class FaceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function loadFaceEngine() {
  loading ??= (async () => {
    const faceapi = await import('@vladmandic/face-api');
    const { tf } = faceapi;
    if (!(await tf.setBackend('webgl').catch(() => false))) await tf.setBackend('cpu');
    await tf.ready();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODELS),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS),
    ]);
    return faceapi;
  })().catch((e) => {
    loading = null;
    throw new FaceError('engine_unavailable', `Face verification could not start on this device (${e.message}).`);
  });
  return loading;
}

async function imageFrom(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

// ---- photo quality ----------------------------------------------------------------------------------------
// Measured on a small grey copy of the photo: mean brightness (0-255) and sharpness (variance of the
// Laplacian, which falls as a photo blurs). These are used to EXPLAIN a failure -- "too dark", "blurred" --
// never to accept a face, and the limits are deliberately loose: they flag the clearly bad photo only.
export const QUALITY = { dark: 55, bright: 225, blurry: 40 };
export function photoQuality(input) {
  const w0 = input.naturalWidth || input.videoWidth || input.width;
  const h0 = input.naturalHeight || input.videoHeight || input.height;
  const k = Math.min(1, 320 / Math.max(w0, h0, 1));
  const w = Math.max(3, Math.round(w0 * k));
  const h = Math.max(3, Math.round(h0 * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(input, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += g[j];
  }
  let lsum = 0; let lsq = 0; let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      lsum += l; lsq += l * l; n += 1;
    }
  }
  const mean = lsum / Math.max(1, n);
  return { brightness: sum / (w * h), sharpness: lsq / Math.max(1, n) - mean * mean };
}

// Why no face was found, in words the person holding the phone can act on.
export function noFaceReason(q) {
  if (q.brightness < QUALITY.dark) return ['too_dark', 'No face found: the photo is too dark. Move to a brighter place or face the light, and take it again.'];
  if (q.brightness > QUALITY.bright) return ['too_bright', 'No face found: the photo is washed out. Move out of direct sunlight or away from a bright window behind the person.'];
  if (q.sharpness < QUALITY.blurry) return ['blurry', 'No face found: the photo is blurred. Hold the phone steady and tap the screen to focus before taking it.'];
  return ['no_face', 'No face found. Fill most of the photo with the face, looking straight at the camera, and take it again.'];
}

// Faces in a single photo: the fast detector first, then the thorough one (SSD MobileNet) when the fast one
// finds nothing -- it misses faces that are turned a little, in shade, or small in the frame.
async function detectInPhoto(faceapi, img) {
  const tiny = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 });
  let faces = await faceapi.detectAllFaces(img, tiny).withFaceLandmarks().withFaceDescriptors();
  if (!faces.length && await ssdReady(faceapi)) {
    faces = await faceapi.detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 }))
      .withFaceLandmarks().withFaceDescriptors();
  }
  return faces;
}

// Descriptor of the one face in the photo (a data URL or object URL). Throws FaceError with a code that says
// what to do: too_dark / too_bright / blurry / no_face / many_faces / face_too_small (enrolment only).
// `minFaceShare`: the smallest face width, as a share of the photo's width, that is accepted -- set for
// enrolment, where a small face makes a poor reference that every later check is compared against.
export async function describeFace(src, { minFaceShare = 0 } = {}) {
  const faceapi = await loadFaceEngine();
  const img = await imageFrom(src);
  const faces = await detectInPhoto(faceapi, img);
  if (!faces.length) {
    const [code, message] = noFaceReason(photoQuality(img));
    throw new FaceError(code, message);
  }
  // A face in the background (a passer-by) is ignored when one face clearly dominates the photo.
  const sorted = [...faces].sort((a, b) => b.detection.box.width - a.detection.box.width);
  if (sorted.length > 1 && sorted[1].detection.box.width > sorted[0].detection.box.width * 0.6) {
    throw new FaceError('many_faces', 'More than one face in the photo. Photograph only this person.');
  }
  const face = sorted[0];
  const share = face.detection.box.width / (img.naturalWidth || img.width || 1);
  if (share < minFaceShare) {
    throw new FaceError('face_too_small', 'The face is too small in this photo. Come closer so the face fills most of the frame.');
  }
  return { descriptor: Array.from(face.descriptor), model: FACE_MODEL, score: face.detection.score, faceShare: share };
}

// ---- live camera (liveness check) ---------------------------------------------------------------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Eye aspect ratio (Soukupová & Čech 2016) from the six 68-point landmarks of one eye: low when closed.
const ear = (p) => (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * dist(p[0], p[3]));

// Faces in one video frame with the measures the liveness challenge needs: { count, box, ear, yaw, size }.
// yaw: nose tip offset from the eyes' midpoint, in inter-eye distances (0 = facing the camera).
export async function analyseFrame(video) {
  const faceapi = await loadFaceEngine();
  // 320 rather than 224: the eye corners this reads are what a blink is measured from, and a closed eye
  // drawn from too small a crop barely looks closed at all.
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const faces = await faceapi.detectAllFaces(video, options).withFaceLandmarks();
  if (faces.length !== 1) return { count: faces.length };
  const pts = faces[0].landmarks.positions;
  const leftEye = pts.slice(36, 42);
  const rightEye = pts.slice(42, 48);
  const eyeL = pts[36], eyeR = pts[45], nose = pts[30];
  const span = dist(eyeL, eyeR) || 1;
  const mid = { x: (eyeL.x + eyeR.x) / 2, y: (eyeL.y + eyeR.y) / 2 };
  const box = faces[0].detection.box;
  return {
    count: 1, box, score: faces[0].detection.score,
    ear: (ear(leftEye) + ear(rightEye)) / 2,
    eyes: [eyeBox(leftEye), eyeBox(rightEye)],
    yaw: (nose.x - mid.x) / span,
    size: box.width / (video.videoWidth || 1),
  };
}

// The region to read an eye out of: the six landmarks around it, widened a little so the sampled patch
// still holds the whole eye when the head shifts between one detection and the next.
function eyeBox(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs);
  const y0 = Math.min(...ys); const y1 = Math.max(...ys);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const padX = w * 0.20;
  const padY = h * 0.30;   // Keep tightly on eyelid/eye slit to avoid eyebrow contrast masking the blink closure
  return { x: x0 - padX, y: y0 - padY, w: w + padX * 2, h: h + padY * 2 };
}

// ---- how open an eye is, read from the pixels ---------------------------------------------------------
//
// Not from the landmarks. The 68-point model will not draw a closed eye closed -- it keeps an outline
// roughly where an eye would be -- so the ratio between those points barely moves when someone blinks,
// and a blink measured that way is one a person cannot make. The pixels are unambiguous: an open eye is
// a dark pupil and lashes against bright sclera, which is a lot of variation across a small patch, and a
// closed eye is an eyelid, which is nearly flat skin.
//
// Reading pixels needs no model, so it can run many times a second, which matters as much as the signal:
// a blink lasts a couple of tenths of a second and the detector alone does not produce frames that fast.
const SAMPLE_W = 24;
const SAMPLE_H = 12;
let sampler = null;

export function eyeOpenness(video, eyes) {
  if (!video || !eyes?.length) return null;
  if (!sampler) {
    sampler = document.createElement('canvas');
    sampler.width = SAMPLE_W;
    sampler.height = SAMPLE_H;
  }
  const ctx = sampler.getContext('2d', { willReadFrequently: true });
  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  if (!vw || !vh) return null;

  let total = 0;
  let counted = 0;
  for (const e of eyes) {
    const x = Math.max(0, Math.min(vw - 1, e.x));
    const y = Math.max(0, Math.min(vh - 1, e.y));
    const w = Math.max(2, Math.min(vw - x, e.w));
    const h = Math.max(2, Math.min(vh - y, e.h));
    try {
      ctx.drawImage(video, x, y, w, h, 0, 0, SAMPLE_W, SAMPLE_H);
    } catch {
      return null;
    }
    const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
    let sum = 0;
    let sumSq = 0;
    const n = SAMPLE_W * SAMPLE_H;
    for (let i = 0; i < data.length; i += 4) {
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += l;
      sumSq += l * l;
    }
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    // Spread relative to brightness, so a face in shadow and a face in sunlight read alike.
    total += Math.sqrt(variance) / Math.max(12, mean);
    counted += 1;
  }
  return counted ? total / counted : null;
}

// Descriptor of the single face in a video frame or canvas (null when not exactly one face).
export async function describeFrame(input) {
  const faceapi = await loadFaceEngine();
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const faces = await faceapi.detectAllFaces(input, options).withFaceLandmarks().withFaceDescriptors();
  return faces.length === 1 ? Array.from(faces[0].descriptor) : null;
}

// ---- group photo -------------------------------------------------------------------------------------
// Every face in one frame, with a descriptor each. A group photo puts faces much further from the camera
// than an attendance selfie does, so this runs the detector at a far larger input size than the live
// loop: at 416 a back-row face thirty pixels wide is simply not found, and a person missed here is a
// person who has to be added by hand. It is slower, but it runs once on a still, not many times a second.
export const GROUP_INPUT_SIZE = 608;
// Below this, a face carries too few pixels for its descriptor to mean anything. Such faces are still
// reported -- the supervisor should see that someone was there -- but never identified automatically.
export const MIN_FACE_PX = 24;

// The live preview's own pass: where the faces are, and nothing else. Descriptors are what makes reading a
// group photo slow, and the preview does not need them -- it only has to know that a steady number of
// big-enough faces is in frame, which is the moment to take the picture. Run at a smaller input size than
// the still, because this happens many times a second.
export const PREVIEW_INPUT_SIZE = 416;

// Returns [{ box, score }] for a video frame, left to right.
export async function detectFaces(input, { inputSize = PREVIEW_INPUT_SIZE } = {}) {
  const faceapi = await loadFaceEngine();
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.4 });
  const found = await faceapi.detectAllFaces(input, options);
  return found
    .map((d) => ({
      box: { x: Math.round(d.box.x), y: Math.round(d.box.y), width: Math.round(d.box.width), height: Math.round(d.box.height) },
      score: d.score,
    }))
    .sort((a, b) => a.box.x - b.box.x);
}

// ---- the group detector -------------------------------------------------------------------------------
// The tiny detector above is built for speed: it is what the live preview and the selfie loop run many
// times a second. In a crew photo it misses exactly the faces that matter -- small ones at the back, faces
// turned a little, faces in shade -- so the still is read with SSD MobileNet v1, a slower and far more
// thorough detector shipped with the same library. It is loaded only when a group photo is first read.
// If it cannot load (an old cache without the file), the tiny detector is used, as before.
const SSD_INPUT = 512;   // SSD MobileNet always sees its input at this size
let ssdLoading = null;
async function ssdReady(faceapi) {
  ssdLoading ??= faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS).then(() => true, (e) => {
    console.warn('[face] SSD detector unavailable, using the tiny detector', e);
    ssdLoading = null;
    return false;
  });
  return ssdLoading;
}
const detectorOptions = (faceapi, ssd, minScore, inputSize) => (ssd
  ? new faceapi.SsdMobilenetv1Options({ minConfidence: minScore, maxResults: 200 })
  : new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: minScore }));

// Intersection over the smaller box: two detections of one face from overlapping tiles overlap almost
// completely, even when one of them is cut by a tile edge.
function overlap(a, b) {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (x * y) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

// Strongest first; any later box that is mostly the same face is dropped.
function mergeBoxes(boxes) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const b of sorted) if (!kept.some((k) => overlap(k, b) > 0.5)) kept.push(b);
  return kept;
}

// Every face in a large still, including the small ones at the back of a big crew. The detector only ever
// sees its input shrunk to its own input size, so on a 2560px photo of fifteen people a back-row face
// shrinks to a dozen pixels and disappears. So the photo is read whole AND in overlapping tiles (each tile
// is shrunk far less), and the detections are merged. `tiles: false` reads it whole only.
async function detectAllTiled(faceapi, input, w, h, { ssd, inputSize, tiles = true }) {
  const options = detectorOptions(faceapi, ssd, ssd ? 0.35 : 0.4, inputSize);
  const size = ssd ? SSD_INPUT : inputSize;
  const boxes = [];
  const add = (dets, ox, oy, scale) => {
    for (const d of dets) {
      boxes.push({ x: ox + d.box.x / scale, y: oy + d.box.y / scale,
        width: d.box.width / scale, height: d.box.height / scale, score: d.score });
    }
  };
  add(await faceapi.detectAllFaces(input, options), 0, 0, 1);
  if (!tiles) return mergeBoxes(boxes);

  const cols = w >= 2400 ? 4 : w >= 1200 ? 3 : 2;
  const rows = h >= 1000 ? 3 : 2;
  const tw = Math.ceil(w / cols * 1.3);
  const th = Math.ceil(h / rows * 1.3);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = Math.round(Math.min(w - tw, (c * (w - tw)) / Math.max(1, cols - 1)));
      const y = Math.round(Math.min(h - th, (r * (h - th)) / Math.max(1, rows - 1)));
      const tile = document.createElement('canvas');
      // Small tiles are enlarged so the faces in them reach the detector at a readable size.
      const scale = Math.max(1, size / Math.max(tw, th));
      tile.width = Math.round(tw * scale);
      tile.height = Math.round(th * scale);
      const ctx = tile.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(input, x, y, tw, th, 0, 0, tile.width, tile.height);
      add(await faceapi.detectAllFaces(tile, options), x, y, scale);
    }
  }
  return mergeBoxes(boxes);
}

// The descriptor of the face at `box` in `input`, read from its own enlarged close-up so a small face
// still gets a full-size pass. Null when the close-up shows no face near its middle (eyes shut hard,
// turned away, blurred): that reading is skipped, not guessed.
const CROP = 384;
async function describeBox(faceapi, input, box, ssd) {
  const side = Math.max(box.width, box.height) * 2.2;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const crop = document.createElement('canvas');
  crop.width = crop.height = CROP;
  const ctx = crop.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(input, cx - side / 2, cy - side / 2, side, side, 0, 0, CROP, CROP);
  let all = await faceapi.detectAllFaces(crop, detectorOptions(faceapi, ssd, 0.3, 320)).withFaceLandmarks().withFaceDescriptors();
  // At this scale the tiny detector sometimes finds a face the SSD one does not: try it before giving up.
  if (!all.length && ssd) {
    all = await faceapi.detectAllFaces(crop, detectorOptions(faceapi, false, 0.3, 320)).withFaceLandmarks().withFaceDescriptors();
  }
  // In a tight crew the close-up also holds the neighbours' faces; take the one in the middle, which is
  // the face this crop was cut for -- not whichever happens to score highest.
  const half = CROP / 2;
  const mid = (f) => Math.hypot(f.detection.box.x + f.detection.box.width / 2 - half, f.detection.box.y + f.detection.box.height / 2 - half);
  const d = all.sort((a, b) => mid(a) - mid(b)).find((f) => mid(f) < CROP / 4) ?? null;
  return d ? Array.from(d.descriptor) : null;
}

// Reads a burst of frames of the same crew (canvases of one size, taken a fraction of a second apart).
// Faces are found in every frame -- the first one tiled, at full thoroughness, the others whole -- and
// merged, so a person blinking or turned away in one frame is still found in another. Each face is then
// read in EVERY frame and its readings averaged (meanDescriptor), which steadies a recognition that a
// single frame would get wrong.
//
// Returns { faces: [{ descriptor, readings, box, score, small }], width, height }. `onProgress(done, total)`
// reports the slow part, so the screen can show it.
export async function describeBurst(frames, { inputSize = GROUP_INPUT_SIZE, onProgress } = {}) {
  const faceapi = await loadFaceEngine();
  const ssd = await ssdReady(faceapi);
  const inputs = await Promise.all(frames.map((f) => (typeof f === 'string' ? imageFrom(f) : f)));
  const first = inputs[0];
  const w = first.videoWidth || first.naturalWidth || first.width;
  const h = first.videoHeight || first.naturalHeight || first.height;

  const found = [];
  for (let i = 0; i < inputs.length; i += 1) {
    found.push(...await detectAllTiled(faceapi, inputs[i], w, h, { ssd, inputSize, tiles: i === 0 }));
  }
  const boxes = mergeBoxes(found);

  const total = boxes.length * inputs.length;
  let done = 0;
  const faces = [];
  for (const b of boxes) {
    const box = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    const readings = [];
    for (const input of inputs) {
      const r = await describeBox(faceapi, input, box, ssd);
      if (r) readings.push(r);
      done += 1;
      onProgress?.(done, total);
    }
    faces.push({
      // A face no frame could read keeps no descriptor: it is shown, never identified.
      descriptor: meanDescriptor(readings),
      readings: readings.length,
      box,
      score: b.score,
      small: !readings.length || Math.min(box.width, box.height) < MIN_FACE_PX,
    });
  }
  // Left to right, so the order on screen is the order in the list.
  faces.sort((a, b) => a.box.x - b.box.x);
  return { faces, width: w, height: h };
}

// One still: a burst of one.
export async function describeAll(src, options = {}) {
  return describeBurst([src], options);
}

// One person's face cut out of the group photo, with room around it so a reviewer can see who it is.
// Each attendance record keeps its own crop: the whole group photo is one image and an attendance record
// may hold only one photo of its own, but more than that, a crop is the part of the evidence that is
// actually about this employee.
export async function cropFace(src, box, { margin = 0.45, size = 320 } = {}) {
  const input = typeof src === 'string' ? await imageFrom(src) : src;
  const w = input.videoWidth || input.naturalWidth || input.width;
  const h = input.videoHeight || input.naturalHeight || input.height;
  const pad = Math.round(Math.max(box.width, box.height) * margin);
  const side = Math.min(Math.max(box.width, box.height) + pad * 2, Math.min(w, h));
  // Clamped so a face at the edge of the frame still yields a square crop rather than a stretched one.
  const x = Math.max(0, Math.min(w - side, Math.round(box.x + box.width / 2 - side / 2)));
  const y = Math.max(0, Math.min(h - side, Math.round(box.y + box.height / 2 - side / 2)));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(input, x, y, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.85);
}
