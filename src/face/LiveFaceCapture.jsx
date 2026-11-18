// Live face capture for attendance. Runs fully on the device (works offline); video frames are never
// stored or sent, and only the still it ends on is kept.
//
// Two modes, and they prove different things:
//
// - `presence` (the default): the camera opens itself, and the still is taken once a face has been held
//   in the oval AND has blinked. Nothing is asked of the person up front -- people blink every few
//   seconds without being told to, so most of the time this just happens while they hold the phone up,
//   and the prompt only appears if it does not. A photograph of a face, on paper or on another phone's
//   screen, never blinks, so it cannot be used to mark someone present.
// - `challenge`: a head turn as well as the blink, which also defeats a video of the person played to
//   the camera from a distance where the turn is not in the clip. A division turns it on with
//   `face_liveness_required`.
//
// See docs/SECURITY.md: neither is a certified presentation-attack detector.
import { useEffect, useRef, useState } from 'react';
import { analyseFrame, describeFrame, loadFaceEngine } from './faceEngine.js';
import { createLiveness } from './liveness.js';
import { distance } from './faceMatch.js';
import { CameraIcon, CheckIcon, FlipCameraIcon, RefreshIcon, Spinner } from '../components/Icons.jsx';

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
// How long to wait for the blink people make on their own before asking for one. Spontaneous blinks
// come every few seconds, so most captures never show the prompt at all.
const PRESENCE_ASK_AFTER_MS = 2500;

export default function LiveFaceCapture({ onDone, name, mode = 'presence' }) {
  const video = useRef(null);
  // Which camera. The front one is right for a person marking their own attendance; a supervisor
  // marking someone else's is holding the phone the other way round and needs the back one.
  const [facing, setFacing] = useState('user');
  // Each start gets a number. A loop from an earlier camera is in the middle of awaiting a frame when
  // the camera is switched, and would otherwise come back and carry on beside the new one.
  const runId = useRef(0);
  const [phase, setPhase] = useState('idle'); // idle | starting | running | passed | failed
  const [prompt, setPrompt] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const stream = useRef(null);
  const stopped = useRef(false);

  const stop = () => {
    stopped.current = true;
    runId.current += 1;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => stop, []);
  function flip() {
    const next = facing === 'user' ? 'environment' : 'user';
    setFacing(next);
    start(next);
  }

  // Presence mode starts itself. The person opened this dialog to mark attendance; making them tap
  // "start the camera" first is a step that exists only because the challenge needed explaining.
  useEffect(() => {
    if (mode === 'presence') start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Waits for a face to be held in the oval, then takes the still. No challenge, no shutter: by the time
  // someone has read a prompt it has usually already happened.
  function presenceLoop(run) {
    let steady = 0;
    let heldSince = null;
    // The blink is watched for by the same state machine the challenge uses, so there is one place
    // where "was that a blink" is decided and one place where it is tested.
    const blinkCheck = createLiveness({ challenges: ['blink'], options: { timeoutMs: 25_000 } });
    let blinked = false;
    const startedAt = Date.now();
    const deadline = startedAt + 25_000;
    const look = async () => {
      if (stopped.current || !video.current || run !== runId.current) return;
      const m = await analyseFrame(video.current).catch(() => ({ count: 0 }));
      if (stopped.current || !video.current || run !== runId.current) return;
      const t = Date.now();
      if (t > deadline) {
        stop();
        setPhase('failed');
        setError(heldSince != null || blinked
          ? 'No blink was seen, so this could not be confirmed as a live person. Look at the camera and blink. A photo of a face cannot be used here.'
          : 'No face was found. Hold the phone at arm’s length with the face inside the oval, in good light.');
        onDone({ liveness: 'failed', photo: null, reason: blinked ? 'no_face' : 'no_blink' });
        return;
      }
      // Anything wrong starts the hold again: the point of waiting is that the face was still for the
      // whole of it, not that it passed through the right position once.
      let wrong = null;
      if (m.count > 1) wrong = 'Only one person should be in view';
      else if (m.count === 0) wrong = 'Fit the face inside the oval';
      else if (m.size < 0.22) wrong = 'Move a little closer';
      else if (Math.abs(m.yaw) > PRESENCE_YAW) wrong = 'Look at the camera';

      // The blink is watched for throughout, including while the face is being lined up.
      if (!blinked && m.count === 1) blinked = blinkCheck.feed(m).status === 'passed';

      if (wrong) {
        steady = 0;
        heldSince = null;
        setPrompt(wrong);
        setProgress(0);
      } else {
        steady += 1;
        heldSince ??= t;
        setProgress(Math.min(1, (t - heldSince) / PRESENCE_HOLD_MS));
        // Nobody is told to blink until their own blink is overdue.
        setPrompt(blinked || t - startedAt < PRESENCE_ASK_AFTER_MS ? 'Hold still' : 'Blink');
      }

      const held = heldSince != null && t - heldSince >= PRESENCE_HOLD_MS && steady >= PRESENCE_FRAMES;
      if (!held || !blinked) { setTimeout(look, 0); return; }

      const canvas = document.createElement('canvas');
      canvas.width = video.current.videoWidth || 640;
      canvas.height = video.current.videoHeight || 480;
      canvas.getContext('2d').drawImage(video.current, 0, 0);
      stop();
      setPhase('passed');
      // A blink was seen, so this says so: the record carries what was actually proved, no more and
      // no less.
      onDone({ liveness: 'passed', photo: canvas.toDataURL('image/jpeg', 0.85), reason: null });
    };
    look();
  }

  async function start(useCamera = facing) {
    setError(null);
    setPhase('starting');
    setProgress(0);
    setPrompt('');
    stop();                       // whatever was running stops owning the run
    stopped.current = false;
    const myRun = (runId.current += 1);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: useCamera, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (myRun !== runId.current) { stream.current?.getTracks().forEach((t) => t.stop()); return; }
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
    if (mode === 'presence') return presenceLoop(myRun);
    const run = createLiveness();
    let first = null;
    const loop = async () => {
      if (stopped.current || !video.current || myRun !== runId.current) return;
      const m = await analyseFrame(video.current).catch(() => ({ count: 0 }));
      if (stopped.current || !video.current || myRun !== runId.current) return;
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
        {/* Mirrored for the front camera only: that is how people expect to see themselves, and a
            mirrored view of what the back camera sees just reads as broken. */}
        <video ref={video} playsInline muted className={`h-full w-full object-cover ${facing === 'user' ? '-scale-x-100' : ''}`} />
        {phase !== 'idle' && (
          <button type="button" onClick={flip} data-testid="flip-camera"
            aria-label={facing === 'user' ? 'Use the back camera' : 'Use the front camera'}
            className="absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition active:scale-95">
            <FlipCameraIcon className="h-5 w-5" />
          </button>
        )}
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
        <button type="button" onClick={() => start()}
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
          <div className="mt-2 flex justify-center gap-2">
            <button type="button" className="btn-secondary h-9" onClick={() => start()}><RefreshIcon /> Try again</button>
            <button type="button" className="btn-secondary h-9" onClick={flip}>
              <FlipCameraIcon className="h-4 w-4" /> {facing === 'user' ? 'Back camera' : 'Front camera'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
