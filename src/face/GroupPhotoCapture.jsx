// Point the camera at the crew; it takes the photo itself, works out who is in it, and hands back the
// names. No shutter, no list to tick: the only thing anyone does is hold the phone up.
//
// How the shutter decides. A frame is worth reading when the same number of faces has been in view, all
// big enough to recognise, for a short while -- people walking past or a phone still being raised produce
// a face count that keeps changing, and reading those frames wastes the slow pass and returns worse
// answers. So the preview runs a detection-only pass many times a second (no descriptors, which is what
// makes reading a group photo slow), waits for that count to hold steady, and only then captures at full
// resolution and runs the real recognition.
//
// What this proves, which is less than a per-person capture. A live per-person capture watches one face
// for a blink before taking the still, because a photograph of a face does not blink; that is what stops
// someone being marked present with a picture of them. One frame holding many faces cannot do that for
// anyone in it. So the record says how it was made -- identified_by="group_photo" -- it is accepted only
// from the journey supervisor or a reviewer, and the photo is kept with every record. Recognition itself
// never guesses: a face whose closest match does not clearly beat the runner-up, or which is too small to
// carry a usable descriptor, is reported as unrecognised rather than named (see identifyFaces).
import { useCallback, useEffect, useRef, useState } from 'react';
import { GROUP_INPUT_SIZE, cropFace, describeAll, detectFaces, loadFaceEngine } from './faceEngine.js';
import { identifyFaces, similarityPercent } from './faceMatch.js';
import { RefreshIcon, UsersIcon } from '../components/Icons.jsx';

const CAMERA_ERRORS = {
  NotAllowedError: 'Camera permission is needed to photograph the crew. Allow it and try again.',
  NotFoundError: 'No camera was found on this device.',
  NotReadableError: 'The camera is in use by another app. Close it and try again.',
};

// The face count has to hold still for this long, over at least this many detections, before the photo is
// taken. Short enough that nobody is made to pose, long enough to skip the frames from a phone in motion.
// The crew holds still for a full second (shown as a countdown) before the shutter fires.
const STEADY_MS = 1000;
const STEADY_FRAMES = 6;
// Below this share of the frame height a face carries too little detail to recognise, so the preview waits
// rather than taking a picture it cannot read.
const MIN_FACE_SHARE = 0.02;
// If the crew never settles, the photo is taken anyway on whatever is in view: a usable answer late beats
// no answer at all, and the supervisor can retake it.
const PATIENCE_MS = 4000;

export default function GroupPhotoCapture({ candidates, profiles, threshold, onChange }) {
  const video = useRef(null);
  const stream = useRef(null);
  const runId = useRef(0);
  const [phase, setPhase] = useState('starting');   // starting | looking | reading | done | failed
  const [error, setError] = useState(null);
  const [facing, setFacing] = useState('environment');  // a crew is normally photographed with the rear camera
  const [seen, setSeen] = useState(0);              // faces in the live preview
  const [holdLeft, setHoldLeft] = useState(null);   // ms of the steady hold still to go
  const [photo, setPhoto] = useState(null);
  const [rows, setRows] = useState([]);
  const [crops, setCrops] = useState([]);

  // Frees the camera. Leaves the run id alone: the slow pass that follows the shutter is still this run.
  const release = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);
  // Abandons whatever is in flight as well, so a restart or an unmount cannot have its result land later.
  const stop = useCallback(() => {
    runId.current += 1;
    release();
  }, [release]);
  useEffect(() => stop, [stop]);

  const byId = new Map((candidates ?? []).map((c) => [c.employee_id, c]));
  const known = rows.filter((r) => r.status === 'identified' && byId.has(r.userId));
  // Recognised, but already finished all five stages: shown as completed, never marked again.
  const finished = known.filter((r) => byId.get(r.userId).completed);
  const named = known.filter((r) => !byId.get(r.userId).completed);

  // The parent is told who was recognised, as soon as it is known. Only a clear recognition counts; a face
  // the app is unsure about is reported to the supervisor on screen but never marked present.
  useEffect(() => {
    onChange?.({
      photo,
      faces: rows.length,
      recognised: named.length,
      ready: phase === 'done',
      members: named.map((r) => ({
        employee_id: r.userId, crop: crops[r.index] ?? null, distance: r.distance, confirmed: 'matched',
      })),
    });
    // `named` and `crops` are derived from `rows`, so `rows` is the dependency that matters.
  }, [rows, crops, photo, phase, onChange]);   // eslint-disable-line react-hooks/exhaustive-deps

  const read = useCallback(async (canvas, myRun) => {
    setPhase('reading');
    try {
      const { faces } = await describeAll(canvas, { inputSize: GROUP_INPUT_SIZE });
      if (myRun !== runId.current) return;
      if (!faces.length) {
        setPhase('failed');
        setError('No faces could be read from the photo. Hold the phone steady with everyone facing the camera.');
        return;
      }
      const found = identifyFaces({ faces, profiles, threshold })
        .map((r) => ({ ...r, small: faces[r.index].small }));
      const cut = await Promise.all(faces.map((f) => cropFace(canvas, f.box)));
      if (myRun !== runId.current) return;
      setCrops(cut);
      setRows(found);
      setPhase('done');
    } catch (e) {
      if (myRun !== runId.current) return;
      setPhase('failed');
      setError(e.message ?? 'The photo could not be read.');
    }
  }, [profiles, threshold]);

  const start = useCallback(async (useCamera) => {
    setError(null);
    setPhase('starting');
    setPhoto(null); setRows([]); setCrops([]); setSeen(0);
    stop();
    const myRun = (runId.current += 1);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: useCamera, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      if (myRun !== runId.current) { stream.current?.getTracks().forEach((t) => t.stop()); return; }
      video.current.srcObject = stream.current;
      await video.current.play();
      await loadFaceEngine();
      if (myRun !== runId.current) return;
    } catch (e) {
      stop();
      setPhase('failed');
      setError(CAMERA_ERRORS[e.name] ?? e.message ?? 'The camera could not start.');
      return;
    }
    setPhase('looking');

    // Takes the full-resolution frame and hands it to the slow pass.
    const shoot = async () => {
      const canvas = document.createElement('canvas');
      // A real still from the sensor where the browser allows it: several times the pixels of a video
      // frame, which is what lets a back-row face be recognised at all.
      let still = null;
      try {
        const track = stream.current?.getVideoTracks()[0];
        if (track && window.ImageCapture) still = await createImageBitmap(await new window.ImageCapture(track).takePhoto());
      } catch { still = null; }
      // Very large stills are scaled to 3000px wide: plenty for recognition, and keeps the phone responsive.
      const srcW = still?.width || video.current.videoWidth || 1280;
      const srcH = still?.height || video.current.videoHeight || 720;
      const k = Math.min(1, 3000 / srcW);
      canvas.width = Math.round(srcW * k);
      canvas.height = Math.round(srcH * k);
      canvas.getContext('2d').drawImage(still ?? video.current, 0, 0, canvas.width, canvas.height);
      setPhoto(canvas.toDataURL('image/jpeg', 0.9));
      release();                  // the preview has done its job; free the camera before the slow pass
      await read(canvas, myRun);
    };

    let steady = 0;
    let since = null;
    let lastCount = -1;
    const startedAt = Date.now();

    const look = async () => {
      if (myRun !== runId.current || !video.current) return;
      const found = await detectFaces(video.current).catch(() => []);
      if (myRun !== runId.current || !video.current) return;
      const height = video.current.videoHeight || 720;
      // Only faces big enough to recognise are counted, so the shutter never fires on a crowd in the
      // distance that the slow pass would fail to identify anyway.
      const usable = found.filter((f) => f.box.height / height >= MIN_FACE_SHARE);
      setSeen(usable.length);
      const t = Date.now();

      if (usable.length !== lastCount || usable.length === 0) {
        lastCount = usable.length;
        steady = usable.length ? 1 : 0;
        since = usable.length ? t : null;
      } else {
        steady += 1;
      }
      setHoldLeft(since != null ? Math.max(0, STEADY_MS - (t - since)) : null);
      const settled = usable.length > 0 && steady >= STEADY_FRAMES && since != null && t - since >= STEADY_MS;
      // Out of patience: take whatever is in view rather than stand here.
      const impatient = usable.length > 0 && t - startedAt >= PATIENCE_MS;
      if (settled || impatient) { await shoot(); return; }
      setTimeout(look, 0);
    };
    look();
  }, [read, release, stop]);

  // Opens by itself: the camera is the whole screen, so there is nothing to press first.
  useEffect(() => { start(facing); }, [facing, start]);

  const flip = () => setFacing((f) => (f === 'user' ? 'environment' : 'user'));

  const shot = phase === 'done' || phase === 'reading';
  const unknown = rows.length - named.length - finished.length;

  return (
    <div className="space-y-2">
      {/* The preview and the photo occupy the same place; the video element is never unmounted, so a
          retake always has it to hand. */}
      <div className="relative overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-line">
        <video ref={video} playsInline muted
          className={`aspect-video w-full object-cover ${shot ? 'hidden' : ''}`} />
        {shot && <img src={photo} alt="Crew photo" className="aspect-video w-full object-cover" />}
        {!shot && (
          <button type="button" aria-label="Switch camera"
            className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white"
            onClick={flip}>
            <RefreshIcon className="h-4.5 w-4.5" />
          </button>
        )}
        {shot ? (
          phase === 'done' && (
            <button type="button" className="btn-secondary absolute bottom-2 right-2" onClick={() => start(facing)}>Retake</button>
          )
        ) : (
          <p className="absolute inset-x-2 bottom-2 rounded-lg bg-black/60 px-2 py-1.5 text-center text-sm font-semibold text-white" aria-live="polite">
            {phase === 'starting' ? 'Starting the camera\u2026'
              : phase === 'failed' ? 'The camera stopped'
                : seen === 0 ? 'Point the camera at the crew'
                  : `Hold still \u2014 ${seen} ${seen === 1 ? 'face' : 'faces'} in view${holdLeft != null ? ` · ${(holdLeft / 1000).toFixed(1)}s` : ''}`}
          </p>
        )}
      </div>

      {phase === 'reading' && <p className="text-sm font-semibold text-muted">{'Working out who is in the photo\u2026'}</p>}

      {phase === 'done' && (
        <>
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            <UsersIcon className="h-4 w-4" />
            {rows.length} {rows.length === 1 ? 'face' : 'faces'} {'\u00b7'} {named.length} recognised
            {finished.length > 0 && <span className="font-normal text-sky-700">{'·'} {finished.length} already completed</span>}
            {unknown > 0 && <span className="font-normal text-amber-700">{'\u00b7'} {unknown} not recognised</span>}
          </p>
          {unknown > 0 && (
            <p className="text-xs text-amber-700">
              Only the people the app recognised are marked present. For anyone it could not place, retake
              the photo from closer, or mark them one at a time from the stage grid.
            </p>
          )}
          <ul className="flex flex-wrap gap-2">
            {rows.map((r) => {
              const person = byId.get(r.userId);
              const ok = r.status === 'identified' && person;
              const complete = ok && person.completed;
              if (complete) {
                return (
                  <li key={r.index} className="w-24 text-center">
                    <img src={crops[r.index]} alt="" className="h-24 w-24 rounded-xl object-cover ring-2 ring-sky-400" />
                    <p className="mt-1 truncate text-xs font-semibold text-sky-700" title={person.name}>{person.name}</p>
                    <p className="text-xs text-sky-700">Attendance completed</p>
                  </li>
                );
              }
              return (
                <li key={r.index} className="w-24 text-center">
                  <img src={crops[r.index]} alt="" className={`h-24 w-24 rounded-xl object-cover ring-2 ${ok ? 'ring-success' : 'ring-amber-400'}`} />
                  <p className={`mt-1 truncate text-xs font-semibold ${ok ? 'text-success' : 'text-amber-700'}`}
                    title={ok ? person.name : undefined}>
                    {ok ? person.name : 'Not recognised'}
                  </p>
                  {ok && <p className="text-xs text-slate-500">{similarityPercent(r.distance)}%</p>}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {phase === 'failed' && (
        <button type="button" className="btn-secondary w-full" onClick={() => start(facing)}>Try again</button>
      )}
    </div>
  );
}
