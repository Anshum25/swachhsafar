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
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
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
    yaw: (nose.x - mid.x) / span,
    size: box.width / (video.videoWidth || 1),
  };
}

// Descriptor of the single face in a video frame or canvas (null when not exactly one face).
export async function describeFrame(input) {
  const faceapi = await loadFaceEngine();
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const faces = await faceapi.detectAllFaces(input, options).withFaceLandmarks().withFaceDescriptors();
  return faces.length === 1 ? Array.from(faces[0].descriptor) : null;
}
