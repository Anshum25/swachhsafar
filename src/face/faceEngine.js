// On-device face analysis (@vladmandic/face-api, TensorFlow.js). Loaded only when a screen needs it; the
// library and models are precached by the service worker, so it works offline. Photos are analysed in memory
// and never leave the device for this purpose.
import { FACE_MODEL } from './faceMatch.js';

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

// Descriptor of the one face in the photo (a data URL or object URL). Throws FaceError no_face / many_faces.
export async function describeFace(src) {
  const faceapi = await loadFaceEngine();
  const img = await imageFrom(src);
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
  const faces = await faceapi.detectAllFaces(img, options).withFaceLandmarks().withFaceDescriptors();
  if (!faces.length) throw new FaceError('no_face', 'No face found. Take the photo again, facing the camera in good light.');
  if (faces.length > 1) throw new FaceError('many_faces', 'More than one face in the photo. Photograph only this person.');
  return { descriptor: Array.from(faces[0].descriptor), model: FACE_MODEL, score: faces[0].detection.score };
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

// Intersection over the smaller box: two detections of one face from overlapping tiles overlap almost
// completely, even when one of them is cut by a tile edge.
function overlap(a, b) {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (x * y) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

// Every face in a large still, including the small ones at the back of a big crew. The detector only ever
// sees its input shrunk to `inputSize`, so on a 1920px photo of fifteen people a back-row face shrinks to a
// dozen pixels and disappears. So the photo is read whole AND in overlapping tiles (each tile is shrunk far
// less), and the detections are merged.
async function detectAllTiled(faceapi, input, w, h, inputSize) {
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.4 });
  const boxes = [];
  const add = (dets, ox, oy, scale) => {
    for (const d of dets) {
      boxes.push({ x: ox + d.box.x / scale, y: oy + d.box.y / scale,
        width: d.box.width / scale, height: d.box.height / scale, score: d.score });
    }
  };
  add(await faceapi.detectAllFaces(input, options), 0, 0, 1);

  const cols = w >= 1200 ? 3 : 2;
  const rows = h >= 1000 ? 3 : 2;
  const tw = Math.ceil(w / cols * 1.3);
  const th = Math.ceil(h / rows * 1.3);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = Math.round(Math.min(w - tw, (c * (w - tw)) / Math.max(1, cols - 1)));
      const y = Math.round(Math.min(h - th, (r * (h - th)) / Math.max(1, rows - 1)));
      const tile = document.createElement('canvas');
      // Small tiles are enlarged so the faces in them reach the detector at a readable size.
      const scale = Math.max(1, inputSize / Math.max(tw, th));
      tile.width = Math.round(tw * scale);
      tile.height = Math.round(th * scale);
      tile.getContext('2d').drawImage(input, x, y, tw, th, 0, 0, tile.width, tile.height);
      add(await faceapi.detectAllFaces(tile, options), x, y, scale);
    }
  }

  // Strongest first; any later box that is mostly the same face is dropped.
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const b of boxes) if (!kept.some((k) => overlap(k, b) > 0.5)) kept.push(b);
  return kept;
}

// Returns { faces: [{ descriptor, box, score, small }], width, height } for a data URL, canvas or video.
// Each face is read from its own enlarged crop, so a small face still gets a full-size descriptor pass.
export async function describeAll(src, { inputSize = GROUP_INPUT_SIZE } = {}) {
  const faceapi = await loadFaceEngine();
  const input = typeof src === 'string' ? await imageFrom(src) : src;
  const w = input.videoWidth || input.naturalWidth || input.width;
  const h = input.videoHeight || input.naturalHeight || input.height;
  const found = await detectAllTiled(faceapi, input, w, h, inputSize);
  const single = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 });

  const faces = [];
  for (const b of found) {
    const box = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    const side = Math.max(box.width, box.height) * 2;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const sx = Math.max(0, cx - side / 2);
    const sy = Math.max(0, cy - side / 2);
    const crop = document.createElement('canvas');
    crop.width = crop.height = 320;
    crop.getContext('2d').drawImage(input, sx, sy, side, side, 0, 0, 320, 320);
    const d = await faceapi.detectSingleFace(crop, single).withFaceLandmarks().withFaceDescriptor();
    faces.push({
      // A face the close-up pass cannot confirm keeps no descriptor: it is shown, never identified.
      descriptor: d ? Array.from(d.descriptor) : null,
      box,
      score: b.score,
      small: !d || Math.min(box.width, box.height) < MIN_FACE_PX,
    });
  }
  // Left to right, so the order on screen is the order in the list.
  faces.sort((a, b) => a.box.x - b.box.x);
  return { faces, width: w, height: h };
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
