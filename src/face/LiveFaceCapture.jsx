// Live face capture for attendance. Runs on the device (works offline); video frames are never stored or
// sent, only the still it ends on and a small proof of what was verified.
//
// A photo of a face is never accepted. The camera is the only input -- there is no gallery or file picker
// here -- and before the still is taken the person must:
//   1. be the only face in the frame, close enough to read;
//   2. perform a server-issued random challenge (always a head turn and a blink, plus one more, in an order
//      the app did not know in advance), seen happening in live frames (liveness.createActiveChallenge);
//   3. show real 3-D depth across the head movement -- a printed photo or a phone/monitor screen is flat
//      (depthCheck.js);
//   4. remain the same person from the start of the challenge to the end.
// The attempt also fails if the camera is lost, the app goes to the background mid-check, or the camera
// identifies itself as a virtual one. The server then checks the challenge again (app/services/liveness.py).
//
// See docs/SECURITY.md for what this does not defeat. It is not a certified presentation-attack detector.
import { useEffect, useRef, useState } from 'react';
import { analyseFrame, describeFrame, eyeOpenness, loadFaceEngine } from './faceEngine.js';
import { ACTION_PROMPTS, createActiveChallenge } from './liveness.js';
import { depthVerdict } from './depthCheck.js';
import { distance } from './faceMatch.js';
import { acquireTicket } from './livenessTickets.js';
import { useSession } from '../app/session.jsx';
import { AlertIcon, CameraIcon, CheckIcon, FlipCameraIcon, RefreshIcon, Spinner } from '../components/Icons.jsx';

const SAME_PERSON = 0.5; // descriptor distance between the first and last frame
const EYE_SAMPLE_MS = 45; // the eyes are read from pixels between detections: a blink is over in ~200 ms
const MAX_NEUTRAL_FRAMES = 8;
const MAX_MOVED_FRAMES = 12;
// Names a virtual camera driver gives itself. Detectable only when the driver is honest about its name.
export const VIRTUAL_CAMERA = /virtual|obs|manycam|snap camera|xsplit|droidcam|iriun|epoccam|\bndi\b|camtwist|splitcam|youcam|e2esoft|vcam|fake/i;

// What the person is told, by failure kind (spec: camera / spoof / liveness / unavailable).
const MESSAGES = {
  camera: 'Camera access unavailable.',
  spoof: 'Spoofing attempt detected.',
  liveness: 'Liveness verification failed.',
  unavailable: 'Live verification is not available on this device right now.',
};
const CAMERA_ERRORS = {
  NotAllowedError: 'Camera permission is off for this app. Allow the camera and try again.',
  NotFoundError: 'No camera found on this device.',
  NotReadableError: 'The camera is in use by another app. Close it and try again.',
  OverconstrainedError: 'The camera could not be opened with the required settings.',
};
const REASONS = {
  timeout: (pending) => (pending ? `The requested action was not seen in time (${ACTION_PROMPTS[pending]?.toLowerCase() ?? pending}).` : 'The live check timed out.'),
  multiple_faces: () => 'More than one face was in the frame. Only the employee should be in view.',
  wrong_action: () => 'The movement did not follow the instructions.',
  face_changed: () => 'The face changed during the check. Keep the same person in view throughout.',
  flat: () => 'No real 3-D face was seen. A photo or a screen cannot be used for attendance.',
  virtual_camera: () => 'A virtual camera was detected. Use the phone’s own camera.',
  disconnected: () => 'The camera stopped during verification.',
  interrupted: () => 'The app left the screen during verification. Stay on this screen until it finishes.',
  no_ticket: () => 'Connect to the internet once to download live-verification challenges, then try again.',
  engine: () => 'Face verification could not start on this device.',
};

export default function LiveFaceCapture({ onDone, name, autoStart = true }) {
  const { api, user } = useSession() ?? {};
  const video = useRef(null);
  const stream = useRef(null);
  const runId = useRef(0);
  const [facing, setFacing] = useState('user');
  const [phase, setPhase] = useState('idle'); // idle | starting | running | verifying | passed | failed
  const [prompt, setPrompt] = useState('');
  const [progress, setProgress] = useState({ step: 0, total: 3 });
  const [failure, setFailure] = useState(null); // { kind, detail }
  const [eyesShut, setEyesShut] = useState(false);

  const stop = () => {
    runId.current += 1;
    stream.current?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    stream.current = null;
  };
  useEffect(() => stop, []);
  useEffect(() => {
    if (autoStart) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fail(run, kind, reason, pending) {
    if (run !== runId.current) return;
    stop();
    setPhase('failed');
    setFailure({ kind, detail: (REASONS[reason] ?? (() => null))(pending) });
    onDone?.({ liveness: kind === 'camera' || kind === 'unavailable' ? 'unavailable' : 'failed', photo: null, proof: null, reason });
  }

  function flip() {
    const next = facing === 'user' ? 'environment' : 'user';
    setFacing(next);
    start(next);
  }

  async function start(useCamera = facing) {
    stop();
    const run = (runId.current += 1);
    const owns = () => run === runId.current && video.current;
    setFailure(null);
    setPhase('starting');
    setPrompt('Initializing camera…');
    setProgress({ step: 0, total: 3 });

    // 1. Live camera only. A camera that cannot open stops here: there is no other way in.
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no camera API'), { name: 'NotFoundError' });
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: useCamera, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (run !== runId.current) { s.getTracks().forEach((t) => t.stop()); return; }
      stream.current = s;
      video.current.srcObject = s;
      await video.current.play();
    } catch (e) {
      if (run !== runId.current) return;
      stop();
      setPhase('failed');
      setFailure({ kind: 'camera', detail: CAMERA_ERRORS[e.name] ?? null });
      onDone?.({ liveness: 'unavailable', photo: null, proof: null, reason: 'camera' });
      return;
    }
    const track = stream.current.getVideoTracks()[0];
    const cameraLabel = (track?.label ?? '').slice(0, 120) || null;
    if (cameraLabel && VIRTUAL_CAMERA.test(cameraLabel)) { fail(run, 'spoof', 'virtual_camera'); return; }
    if (track) track.onended = () => fail(run, 'camera', 'disconnected');

    try {
      await loadFaceEngine();
    } catch {
      fail(run, 'unavailable', 'engine');
      return;
    }
    if (!owns()) return;

    // 2. A server-issued challenge, used once.
    const ticket = await acquireTicket({ post: api?.post, userId: user?.id, online: typeof navigator === 'undefined' || navigator.onLine });
    if (!owns()) return;
    if (!ticket) { fail(run, 'unavailable', 'no_ticket'); return; }

    const challenge = createActiveChallenge({ actions: ticket.actions });
    setProgress({ step: 0, total: ticket.actions.length });
    setPhase('running');
    setPrompt('Position your face inside the frame');

    // Leaving the screen mid-check (to open the gallery, another app, a recording) ends the attempt.
    const onHidden = () => { if (document.visibilityState === 'hidden') fail(run, 'liveness', 'interrupted'); };
    document.addEventListener('visibilitychange', onHidden);
    const cleanup = () => document.removeEventListener('visibilitychange', onHidden);

    const neutralPts = [];
    const movedPts = [];
    let first = null;
    let placed = null;
    let openMax = 0;
    let settled = false;

    const handle = (r) => {
      if (r.status === 'failed') {
        cleanup();
        fail(run, 'liveness', r.reason, r.pending);
        return true;
      }
      return r.status === 'passed';
    };

    // Fast: the eyes, from pixels, for the blink.
    const sampleEyes = () => {
      if (!owns() || settled) return;
      if (placed?.count === 1 && placed.eyes) {
        const openness = eyeOpenness(video.current, placed.eyes);
        if (openness != null) {
          openMax = Math.max(openness, openMax * 0.992);
          setEyesShut(openness < openMax * 0.84);
          const r = challenge.feed({ ...placed, ear: openness });
          if (r.status === 'failed') { settled = true; handle(r); return; }
        }
      }
      setTimeout(sampleEyes, EYE_SAMPLE_MS);
    };

    // Slow: find the face, follow the challenge, collect landmarks for the depth check.
    const loop = async () => {
      if (!owns() || settled) return;
      const m = await analyseFrame(video.current).catch(() => ({ count: 0 }));
      if (!owns() || settled) return;
      placed = m;
      const openness = m.count === 1 && m.eyes ? eyeOpenness(video.current, m.eyes) : null;
      const r = challenge.feed(openness == null ? m : { ...m, ear: openness });
      if (m.count === 1 && m.points) {
        // The neutral reference comes only from the calibration frames: steady, facing the camera.
        if (r.calibrating) {
          neutralPts.push(m.points);
          if (neutralPts.length > MAX_NEUTRAL_FRAMES) neutralPts.shift();
        }
        if (r.extreme && movedPts.length < MAX_MOVED_FRAMES) movedPts.push(m.points);
        // The identity at the start. Tried on every near-frontal frame until it is read: tried only during
        // the few calibration frames, one unlucky miss left `first` empty and every attempt then failed as
        // "face changed", even for the right person standing still.
        if (!first && (r.calibrating || Math.abs(m.yaw) < 0.12) && !r.extreme) {
          first = await describeFrame(video.current).catch(() => null);
          if (!owns() || settled) return;
        }
      }
      setPrompt(r.prompt ?? '');
      setProgress({ step: r.step, total: r.total });
      if (r.status === 'failed') { settled = true; handle(r); return; }
      if (r.status !== 'passed') { setTimeout(loop, 0); return; }

      // 3. Passed the actions: take the still, then the checks that need it.
      settled = true;
      setPhase('verifying');
      setPrompt('Verifying live person…');
      const canvas = document.createElement('canvas');
      canvas.width = video.current.videoWidth || 640;
      canvas.height = video.current.videoHeight || 480;
      canvas.getContext('2d').drawImage(video.current, 0, 0);
      let last = await describeFrame(canvas).catch(() => null);
      // One missed read of the final frame is not a different person: read a few more live frames.
      for (let i = 0; !last && i < 3 && owns(); i += 1) {
        canvas.getContext('2d').drawImage(video.current, 0, 0);
        last = await describeFrame(canvas).catch(() => null);
      }
      cleanup();
      if (run !== runId.current) return;
      const depth = depthVerdict(neutralPts, movedPts);
      const drift = first && last ? distance(first, last) : Infinity;
      if (!depth.live) { fail(run, 'spoof', 'flat'); return; }
      if (!(drift <= SAME_PERSON)) { fail(run, 'liveness', 'face_changed'); return; }
      stop();
      setPhase('passed');
      const iso = (ms) => new Date(ms).toISOString();
      onDone?.({
        liveness: 'passed',
        photo: canvas.toDataURL('image/jpeg', 0.85),
        reason: null,
        proof: {
          challenge_id: ticket.id, signature: ticket.signature,
          steps: r.steps.map((s) => ({ action: s.action, at: iso(s.at) })),
          started_at: iso(r.startedAt), completed_at: iso(r.completedAt),
          depth_score: depth.score, identity_drift: Math.round(drift * 1000) / 1000,
          frames: r.frames, camera_label: cameraLabel,
        },
      });
    };
    sampleEyes();
    loop();
  }

  const { step, total } = progress;
  const actionPrompt = phase === 'running' && Object.values(ACTION_PROMPTS).includes(prompt);
  return (
    <div className="space-y-2" data-testid="live-face">
      <div className={`relative mx-auto aspect-[3/4] w-full max-w-[15rem] overflow-hidden rounded-2xl bg-brand-950 ${phase === 'idle' ? 'hidden' : ''}`}>
        {/* Mirrored for the front camera only, the way people expect to see themselves. */}
        <video ref={video} playsInline muted className={`h-full w-full object-cover ${facing === 'user' ? '-scale-x-100' : ''}`} />
        {(phase === 'running' || phase === 'starting') && (
          <button type="button" onClick={flip} data-testid="flip-camera"
            aria-label={facing === 'user' ? 'Use the back camera' : 'Use the front camera'}
            className="absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition active:scale-95">
            <FlipCameraIcon className="h-5 w-5" />
          </button>
        )}
        <span className={`pointer-events-none absolute inset-[12%] rounded-[50%] border-2 border-dashed ${actionPrompt ? 'border-success' : 'border-white/80'}`} />
        {(phase === 'running' || phase === 'verifying' || phase === 'starting') && (
          <p className="absolute inset-x-2 bottom-2 flex items-center justify-center gap-2 rounded-lg bg-black/65 px-2 py-1.5 text-center text-sm font-semibold text-white"
            aria-live="assertive" data-testid="live-prompt">
            {prompt === ACTION_PROMPTS.blink && (
              <span aria-hidden="true" data-testid="eye-state"
                className={`h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-100 ${eyesShut ? 'bg-amber-300' : 'bg-success'}`} />
            )}
            {phase !== 'running' && <Spinner className="h-4 w-4" />}
            {prompt}
          </p>
        )}
      </div>
      {(phase === 'running' || phase === 'verifying') && (
        <div className="flex justify-center gap-1.5" role="progressbar" aria-label={`Step ${Math.min(step + 1, total)} of ${total}`}
          aria-valuenow={step} aria-valuemax={total}>
          {Array.from({ length: total }, (_, i) => <span key={i} className={`h-1.5 w-8 rounded-full ${i < step ? 'bg-success' : 'bg-line'}`} />)}
        </div>
      )}
      {phase === 'idle' && (
        <button type="button" onClick={() => start()}
          className="mx-auto flex aspect-[1.2] w-full max-w-[11.5rem] flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-400 bg-brand-100/70 text-brand-700 transition hover:bg-brand-100 active:scale-[0.98]">
          <CameraIcon className="mb-1 h-9 w-9" />
          <span className="text-[15px] font-bold">Start live check</span>
          <span className="px-2 text-center text-xs font-medium text-muted">{name}: follow the instructions on screen</span>
        </button>
      )}
      {phase === 'passed' && (
        <p className="flex items-center justify-center gap-2 text-sm font-semibold text-success">
          <CheckIcon className="h-4 w-4" /> Live person verified
        </p>
      )}
      {phase === 'failed' && failure && (
        <div className="space-y-2 text-center" role="alert" data-testid="live-failure" data-kind={failure.kind}>
          <p className="flex items-center justify-center gap-1.5 text-sm font-semibold text-red-700">
            <AlertIcon className="h-4 w-4" /> {MESSAGES[failure.kind]}
          </p>
          {failure.detail && <p className="text-xs text-red-700">{failure.detail}</p>}
          <div className="flex justify-center gap-2">
            <button type="button" className="btn-secondary h-9" onClick={() => start()}><RefreshIcon /> Try again</button>
            {failure.kind !== 'unavailable' && (
              <button type="button" className="btn-secondary h-9" onClick={flip}>
                <FlipCameraIcon className="h-4 w-4" /> {facing === 'user' ? 'Back camera' : 'Front camera'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
