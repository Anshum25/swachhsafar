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
