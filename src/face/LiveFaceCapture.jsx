// Live face capture for attendance: front camera, liveness challenge (blink + head turn), then a still photo
// of the same person. Runs fully on the device (works offline); video frames are never stored or sent.
import { useEffect, useRef, useState } from 'react';
import { analyseFrame, describeFrame, loadFaceEngine } from './faceEngine.js';
import { createLiveness } from './liveness.js';
import { distance } from './faceMatch.js';
import { CameraIcon, CheckIcon, RefreshIcon, Spinner } from '../components/Icons.jsx';

const SAME_PERSON = 0.5; // descriptor distance between the first and last frame
const CAMERA_ERRORS = {
  NotAllowedError: 'Camera permission is off for this app. Allow the camera and try again.',
  NotFoundError: 'No camera found on this device.',
  NotReadableError: 'The camera is in use by another app. Close it and try again.',
};

export default function LiveFaceCapture({ onDone, name }) {
  const video = useRef(null);
  const [phase, setPhase] = useState('idle'); // idle | starting | running | passed | failed
  const [prompt, setPrompt] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const stream = useRef(null);
  const stopped = useRef(false);

  const stop = () => {
    stopped.current = true;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => stop, []);

  async function start() {
    setError(null);
    setPhase('starting');
    setProgress(0);
    stopped.current = false;
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      video.current.srcObject = stream.current;
      await video.current.play();
      await loadFaceEngine();
    } catch (e) {
      stop();
      setPhase('failed');
      setError(CAMERA_ERRORS[e.name] ?? e.message ?? 'The camera could not start.');
      onDone({ liveness: 'unavailable', photo: null, reason: 'camera' });
      return;
    }
    setPhase('running');
    const run = createLiveness();
    let first = null;
    const loop = async () => {
      if (stopped.current || !video.current) return;
      const m = await analyseFrame(video.current).catch(() => ({ count: 0 }));
      if (stopped.current || !video.current) return;
      if (!first && m.count === 1 && Math.abs(m.yaw) < 0.09) first = await describeFrame(video.current).catch(() => null);
      const r = run.feed(m);
      setPrompt(r.prompt ?? '');
      if (r.done != null) setProgress(r.done);
      if (r.status === 'running') { setTimeout(loop, 90); return; }
      if (r.status === 'failed') {
        stop();
        setPhase('failed');
        setError(r.reason === 'multiple_faces' ? 'More than one face was in view.' : 'The live check timed out.');
        onDone({ liveness: 'failed', photo: null, reason: r.reason });
        return;
      }
      // Passed: still photo of the final frame; the same face as at the start.
      if (!video.current) return;
      const canvas = document.createElement('canvas');
      canvas.width = video.current.videoWidth || 640;
      canvas.height = video.current.videoHeight || 480;
      canvas.getContext('2d').drawImage(video.current, 0, 0);
      const last = await describeFrame(canvas).catch(() => null);
      stop();
      if (!first || !last || distance(first, last) > SAME_PERSON) {
        setPhase('failed');
        setError('The face changed during the check. Keep the same person in view throughout.');
        onDone({ liveness: 'failed', photo: null, reason: 'face_changed' });
        return;
      }
      setPhase('passed');
      onDone({ liveness: 'passed', photo: canvas.toDataURL('image/jpeg', 0.85), reason: null });
    };
    loop();
  }

  return (
    <div className="space-y-2" data-testid="live-face">
      <div className={`relative mx-auto aspect-[3/4] w-full max-w-[15rem] overflow-hidden rounded-2xl bg-brand-950 ${phase === 'idle' ? 'hidden' : ''}`}>
        <video ref={video} playsInline muted className="h-full w-full -scale-x-100 object-cover" />
        <span className="pointer-events-none absolute inset-[12%] rounded-[50%] border-2 border-dashed border-white/80" />
        {phase === 'running' && (
          <p className="absolute inset-x-2 bottom-2 rounded-lg bg-black/60 px-2 py-1.5 text-center text-sm font-semibold text-white" aria-live="assertive">{prompt}</p>
        )}
        {phase === 'starting' && <span className="absolute inset-0 grid place-items-center text-white"><Spinner className="h-6 w-6" /></span>}
      </div>
      {phase === 'running' && (
        <div className="flex justify-center gap-1.5" aria-label={`Step ${progress + 1} of 2`}>
          {[0, 1].map((i) => <span key={i} className={`h-1.5 w-8 rounded-full ${i < progress ? 'bg-success' : 'bg-line'}`} />)}
        </div>
      )}
      {phase === 'idle' && (
        <button type="button" onClick={start}
          className="mx-auto flex aspect-[1.2] w-full max-w-[11.5rem] flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-400 bg-brand-100/70 text-brand-700 transition hover:bg-brand-100 active:scale-[0.98]">
          <CameraIcon className="mb-1 h-9 w-9" />
          <span className="text-[15px] font-bold">Start live check</span>
          <span className="px-2 text-center text-xs font-medium text-muted">{name}: blink and turn your head</span>
        </button>
      )}
      {phase === 'passed' && <p className="flex items-center justify-center gap-2 text-sm font-semibold text-success"><CheckIcon className="h-4 w-4" /> Live check passed</p>}
      {phase === 'failed' && (
        <div className="text-center">
          <p className="text-sm text-red-700" role="alert">{error}</p>
          <button type="button" className="btn-secondary mt-2 h-9" onClick={start}><RefreshIcon /> Try again</button>
        </div>
      )}
    </div>
  );
}
