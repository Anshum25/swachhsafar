// Live face capture for attendance. Runs fully on the device (works offline); video frames are never
// stored or sent, and only the still it ends on is kept.
//
// Two modes, and they prove different things:
//
// - `presence` (the default): the camera opens itself and takes the still as soon as one face is held
//   steady in the oval, about a second. There is nothing to tap and nothing to upload. It proves a face
//   was in front of the lens -- NOT that the person was: a photograph held up to the camera passes it.
// - `challenge`: blink and head turn before the still, which a photograph does not pass. A division
//   turns it on with `face_liveness_required`.
//
// See docs/SECURITY.md: neither is a certified presentation-attack detector.
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

// How a face has to sit before `presence` mode takes the still: one face, filling enough of the frame,
// roughly facing the camera, for several frames in a row so it is not caught mid-turn or blurred.
// How long the face has to be held in the oval before the still is taken. Counted in time, not frames:
// three frames is a second on a slow phone and a third of a second on a fast one, so the capture
// happened before the person had settled -- and a face caught mid-movement is the one the match then
// fails on. A second and a half is long enough to hold still for deliberately and short enough not to
// be a wait.
const PRESENCE_HOLD_MS = 1500;
const PRESENCE_FRAMES = 3;   // and never on fewer frames than this, however fast the phone is
const PRESENCE_YAW = 0.3;

export default function LiveFaceCapture({ onDone, name, mode = 'presence' }) {
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
  // Presence mode starts itself. The person opened this dialog to mark attendance; making them tap
  // "start the camera" first is a step that exists only because the challenge needed explaining.
  useEffect(() => {
    if (mode === 'presence') start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Waits for a face to be held in the oval, then takes the still. No challenge, no shutter: by the time
  // someone has read a prompt it has usually already happened.
  function presenceLoop() {
    let steady = 0;
    let heldSince = null;
    const deadline = Date.now() + 25_000;
    const look = async () => {
      if (stopped.current || !video.current) return;
      const m = await analyseFrame(video.current).catch(() => ({ count: 0 }));
      if (stopped.current || !video.current) return;
      const t = Date.now();
      if (t > deadline) {
        stop();
        setPhase('failed');
        setError('No face was found. Hold the phone at arm’s length with the face inside the oval, in good light.');
        onDone({ liveness: 'not_required', photo: null, reason: 'no_face' });
        return;
      }
      // Anything wrong starts the hold again: the point of waiting is that the face was still for the
      // whole of it, not that it passed through the right position once.
      let wrong = null;
      if (m.count > 1) wrong = 'Only one person should be in view';
      else if (m.count === 0) wrong = 'Fit the face inside the oval';
      else if (m.size < 0.22) wrong = 'Move a little closer';
      else if (Math.abs(m.yaw) > PRESENCE_YAW) wrong = 'Look at the camera';

      if (wrong) {
        steady = 0;
        heldSince = null;
        setPrompt(wrong);
        setProgress(0);
      } else {
        steady += 1;
        heldSince ??= t;
        setPrompt('Hold still');
        setProgress(Math.min(1, (t - heldSince) / PRESENCE_HOLD_MS));
      }

      const held = heldSince != null && t - heldSince >= PRESENCE_HOLD_MS && steady >= PRESENCE_FRAMES;
      if (!held) { setTimeout(look, 0); return; }

      const canvas = document.createElement('canvas');
      canvas.width = video.current.videoWidth || 640;
      canvas.height = video.current.videoHeight || 480;
      canvas.getContext('2d').drawImage(video.current, 0, 0);
      stop();
      setPhase('passed');
      // `not_required`: this mode does not claim liveness, and a record must never say it was proved
      // when it was not. The face itself is still matched against the registered descriptors.
      onDone({ liveness: 'not_required', photo: canvas.toDataURL('image/jpeg', 0.85), reason: null });
    };
    look();
  }

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
    if (mode === 'presence') return presenceLoop();
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
      // As fast as the detector will go. Detection itself paces this loop; the extra 90ms wait that
      // used to be here could drop a whole blink between two measurements.
      if (r.status === 'running') { setTimeout(loop, 0); return; }
      if (r.status === 'failed') {
        stop();
        setPhase('failed');
        setError(r.reason === 'multiple_faces' ? 'More than one face was in view.'
          : r.pending === 'blink' ? 'No blink was seen. Look straight at the camera, hold still, then close both eyes for a moment and open them.'
            : r.pending === 'turn' ? 'No head turn was seen. Turn your head to one side, then back to the camera.'
              : 'The live check timed out.');
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
        {phase === 'running' && mode === 'presence' && (
          <span aria-hidden="true"
            className={`pointer-events-none absolute inset-[12%] rounded-[50%] border-4 transition-colors duration-200 ${progress > 0 ? 'border-success' : 'border-transparent'}`}
            style={{ clipPath: `inset(${100 - Math.round(progress * 100)}% 0 0 0)` }} />
        )}
        {phase === 'running' && (
          <p className="absolute inset-x-2 bottom-2 rounded-lg bg-black/60 px-2 py-1.5 text-center text-sm font-semibold text-white" aria-live="assertive">{prompt}</p>
        )}
        {phase === 'starting' && <span className="absolute inset-0 grid place-items-center text-white"><Spinner className="h-6 w-6" /></span>}
      </div>
      {phase === 'running' && mode !== 'presence' && (
        <div className="flex justify-center gap-1.5" aria-label={`Step ${progress + 1} of 2`}>
          {[0, 1].map((i) => <span key={i} className={`h-1.5 w-8 rounded-full ${i < progress ? 'bg-success' : 'bg-line'}`} />)}
        </div>
      )}
      {phase === 'running' && mode === 'presence' && (
        <div className="mx-auto h-1.5 w-full max-w-[15rem] overflow-hidden rounded-full bg-line"
          role="progressbar" aria-label="Hold the face still" aria-valuenow={Math.round(progress * 100)}>
          <span className="block h-full rounded-full bg-success transition-[width] duration-150"
            style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {phase === 'starting' && mode === 'presence' && (
        <p className="text-center text-sm text-muted">Opening the camera…</p>
      )}
      {phase === 'idle' && mode !== 'presence' && (
        <button type="button" onClick={start}
          className="mx-auto flex aspect-[1.2] w-full max-w-[11.5rem] flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-400 bg-brand-100/70 text-brand-700 transition hover:bg-brand-100 active:scale-[0.98]">
          <CameraIcon className="mb-1 h-9 w-9" />
          <span className="text-[15px] font-bold">Start live check</span>
          <span className="px-2 text-center text-xs font-medium text-muted">{name}: blink and turn your head</span>
        </button>
      )}
      {phase === 'passed' && (
        <p className="flex items-center justify-center gap-2 text-sm font-semibold text-success">
          <CheckIcon className="h-4 w-4" /> {mode === 'presence' ? 'Face captured' : 'Live check passed'}
        </p>
      )}
      {phase === 'failed' && (
        <div className="text-center">
          <p className="text-sm text-red-700" role="alert">{error}</p>
          <button type="button" className="btn-secondary mt-2 h-9" onClick={start}><RefreshIcon /> Try again</button>
        </div>
      )}
    </div>
  );
}
