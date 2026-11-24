// Point the camera at the crew; it takes the photo itself, works out who is in it, and hands back the
// names. Built for a crew of ten to fifteen people in one shot.
//
// How the shutter decides. The preview runs a fast detection-only pass many times a second and counts the
// faces big enough to recognise. It waits until the count has held steady for a moment AND the whole crew
// is in view (everyone allocated to the journey); if some faces never show up in the fast pass it waits a
// little longer and then shoots anyway. The supervisor can also press "Take photo now" at any time.
//
// What it reads. Not one frame but a short burst: three stills a fraction of a second apart. One frame
// catches someone mid-blink, half-turned or blurred, and that person is lost; across three, each face is
// found in whichever frames show it and its readings are averaged (faceEngine.describeBurst), which is what
// makes a fifteen-person photo come out with most people named.
//
// What this proves, which is less than a per-person capture. A live per-person capture watches one face
// for a blink before taking the still, because a photograph of a face does not blink; that is what stops
// someone being marked present with a picture of them. A group photo cannot do that for anyone in it. So
// the record says how it was made -- identified_by="group_photo" -- it is accepted only from the journey
// supervisor or a reviewer, and the photo is kept with every record.
//
// Recognition never guesses (faceMatch.identifyFaces): a face whose closest match does not clearly beat the
// runner-up is shown to the supervisor as "Which one is this?" with both names, and a face nobody matched
// can be named from the crew list. A face the supervisor settles is recorded as named by them.
import { useCallback, useEffect, useRef, useState } from 'react';
import { GROUP_INPUT_SIZE, cropFace, describeBurst, detectFaces, loadFaceEngine } from './faceEngine.js';
import { identifyFaces, similarityPercent } from './faceMatch.js';
import { CameraIcon, RefreshIcon, UsersIcon } from '../components/Icons.jsx';

const CAMERA_ERRORS = {
  NotAllowedError: 'Camera permission is needed to photograph the crew. Allow it and try again.',
  NotFoundError: 'No camera was found on this device.',
  NotReadableError: 'The camera is in use by another app. Close it and try again.',
};

// The face count has to hold still for this long, over at least this many detections, before the photo is
// taken. Short enough that nobody is made to pose, long enough to skip the frames from a phone in motion.
const STEADY_MS = 1200;
const STEADY_FRAMES = 6;
// Below this share of the frame height a face is too small to count at all.
const MIN_FACE_SHARE = 0.02;
// Below this share the faces are found but too small to recognise reliably: the screen asks to come closer.
const GOOD_FACE_SHARE = 0.05;
// How long the preview waits for the whole crew to be in view before settling for whoever is steady, and
// how long before it shoots on whatever is there.
const WAIT_FOR_ALL_MS = 6000;
const PATIENCE_MS = 12000;
// The burst: this many stills, this far apart.
const BURST = 3;
const BURST_GAP_MS = 200;
// Stills larger than this are scaled down: plenty for recognition, and keeps the phone responsive with
// three of them in memory.
const MAX_WIDTH = 2560;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export default function GroupPhotoCapture({ candidates, profiles, threshold, onChange }) {
  const video = useRef(null);
  const stream = useRef(null);
  const runId = useRef(0);
  const shootNow = useRef(null);
  const [phase, setPhase] = useState('starting');   // starting | looking | shooting | reading | done | failed
  const [error, setError] = useState(null);
  const [facing, setFacing] = useState('environment');  // a crew is normally photographed with the rear camera
  const [seen, setSeen] = useState(0);              // faces in the live preview
  const [tooSmall, setTooSmall] = useState(false);  // faces in view, but too small to recognise well
  const [holdLeft, setHoldLeft] = useState(null);   // ms of the steady hold still to go
  const [shots, setShots] = useState(0);            // stills of the burst taken so far
  const [progress, setProgress] = useState(null);   // { done, total } while reading
  const [photo, setPhoto] = useState(null);
  const [rows, setRows] = useState([]);
  const [crops, setCrops] = useState([]);
  const [choices, setChoices] = useState({});       // face index -> userId the supervisor chose, or '' for nobody

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

  const crew = candidates ?? [];
  const byId = new Map(crew.map((c) => [c.employee_id, c]));
  const nameOf = (id) => byId.get(id)?.name ?? 'Unknown';

  // Who each face is, after the supervisor's choices. A clear recognition stands on its own; an ambiguous
  // or unknown face is settled only by the supervisor.
  const machine = new Set(rows.filter((r) => r.status === 'identified' && byId.has(r.userId)).map((r) => r.userId));
  const resolved = rows.map((r) => {
    if (r.status === 'identified' && byId.has(r.userId)) return { ...r, who: r.userId, by: 'matched' };
    const pick = choices[r.index];
    if (!pick) return { ...r, who: null, by: pick === '' ? 'skipped' : 'pending' };
    // The distance is evidence only when it is the distance to the person chosen and within the threshold.
    const d = pick === r.userId ? r.distance : pick === r.runnerUpId ? r.runnerUp : null;
    return { ...r, who: pick, by: 'supervisor', distance: d != null && d <= threshold ? d : null };
  });
  const assigned = new Set(resolved.filter((r) => r.who).map((r) => r.who));
  const named = resolved.filter((r) => r.who && !byId.get(r.who).completed);
  const finished = resolved.filter((r) => r.who && byId.get(r.who).completed);
  // A face waiting on the supervisor. Ambiguous faces always ask; an unknown face asks only while someone
  // in the crew is still unaccounted for (otherwise it is a passer-by, and there is nobody to name).
  const unplaced = crew.filter((c) => !assigned.has(c.employee_id));
  const asks = (r) => r.by === 'pending' && (r.status === 'ambiguous' || (unplaced.length > 0 && !r.small));
  const pending = resolved.filter(asks).length;

  // The parent is told who is in the photo as soon as it is known, and whether the supervisor still has
  // faces to settle (then it waits for them instead of marking straight away).
  useEffect(() => {
    onChange?.({
      photo,
      faces: rows.length,
      recognised: named.length,
      ready: phase === 'done',
      needsReview: pending > 0,
      // The supervisor settled at least one face by hand: the parent asks them to confirm, never marks by itself.
      reviewed: Object.keys(choices).some((k) => choices[k] !== undefined),
      members: named.map((r) => ({
        employee_id: r.who, crop: crops[r.index] ?? null, distance: r.distance ?? null, confirmed: r.by,
      })),
    });
    // `named` and `pending` are derived from `rows` and `choices`, which are the dependencies that matter.
  }, [rows, crops, photo, phase, choices, onChange]);   // eslint-disable-line react-hooks/exhaustive-deps

  const read = useCallback(async (frames, myRun) => {
    setPhase('reading');
    setProgress(null);
    try {
      const { faces } = await describeBurst(frames, {
        inputSize: GROUP_INPUT_SIZE,
        onProgress: (done, total) => { if (myRun === runId.current) setProgress({ done, total }); },
      });
      if (myRun !== runId.current) return;
      if (!faces.length) {
        setPhase('failed');
        setError('No faces could be read from the photo. Hold the phone steady with everyone facing the camera.');
        return;
      }
      const found = identifyFaces({ faces, profiles, threshold })
        .map((r) => ({ ...r, small: faces[r.index].small }));
      const cut = await Promise.all(faces.map((f) => cropFace(frames[0], f.box)));
      if (myRun !== runId.current) return;
      setCrops(cut);
      setRows(found);
      setChoices({});
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
    setPhoto(null); setRows([]); setCrops([]); setChoices({}); setSeen(0); setShots(0); setProgress(null); setTooSmall(false);
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

    // One still, drawn into a canvas of the burst's size so every frame shares one coordinate system.
    let size = null;
    let capture = window.ImageCapture && stream.current?.getVideoTracks()[0]
      ? new window.ImageCapture(stream.current.getVideoTracks()[0]) : null;
    const grab = async () => {
      // A real still from the sensor where the browser allows it: several times the pixels of a video
      // frame, which is what lets a back-row face be recognised at all.
      let still = null;
      if (capture) {
        try { still = await createImageBitmap(await capture.takePhoto()); } catch { capture = null; still = null; }
      }
      if (!size) {
        const srcW = still?.width || video.current.videoWidth || 1280;
        const srcH = still?.height || video.current.videoHeight || 720;
        const k = Math.min(1, MAX_WIDTH / srcW);
        size = { w: Math.round(srcW * k), h: Math.round(srcH * k) };
      }
      const canvas = document.createElement('canvas');
      canvas.width = size.w;
      canvas.height = size.h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(still ?? video.current, 0, 0, size.w, size.h);
      still?.close?.();
      return canvas;
    };

    // Takes the burst and hands it to the slow pass.
    let shooting = false;
    const shoot = async () => {
      if (shooting || myRun !== runId.current) return;
      shooting = true;
      setPhase('shooting');
      const frames = [];
      for (let i = 0; i < BURST; i += 1) {
        if (myRun !== runId.current || !video.current) return;
        frames.push(await grab());
        setShots(i + 1);
        if (i === 0) setPhoto(frames[0].toDataURL('image/jpeg', 0.9));
        if (i < BURST - 1) await sleep(BURST_GAP_MS);
      }
      release();                  // the preview has done its job; free the camera before the slow pass
      await read(frames, myRun);
    };
    shootNow.current = shoot;

    let steady = 0;
    let since = null;
    let lastCount = -1;
    const startedAt = Date.now();
    const want = crew.length;

    const look = async () => {
      if (shooting || myRun !== runId.current || !video.current) return;
      const found = await detectFaces(video.current).catch(() => []);
      if (shooting || myRun !== runId.current || !video.current) return;
      const height = video.current.videoHeight || 720;
      // Only faces big enough to recognise are counted, so the shutter never fires on a crowd in the
      // distance that the slow pass would fail to identify anyway.
      const usable = found.filter((f) => f.box.height / height >= MIN_FACE_SHARE);
      setSeen(usable.length);
      const shares = usable.map((f) => f.box.height / height).sort((a, b) => a - b);
      setTooSmall(shares.length > 0 && shares[Math.floor(shares.length / 2)] < GOOD_FACE_SHARE);
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
      // The whole crew in view, or long enough waited for the rest.
      const enough = usable.length >= want || t - startedAt >= WAIT_FOR_ALL_MS;
      // Out of patience: take whatever is in view rather than stand here.
      const impatient = usable.length > 0 && t - startedAt >= PATIENCE_MS;
      if ((settled && enough) || impatient) { await shoot(); return; }
      setTimeout(look, 0);
    };
    look();
  }, [read, release, stop, crew.length]);

  // Opens by itself: the camera is the whole screen, so there is nothing to press first.
  useEffect(() => { start(facing); }, [facing]);   // eslint-disable-line react-hooks/exhaustive-deps

  const flip = () => setFacing((f) => (f === 'user' ? 'environment' : 'user'));
  const choose = (index, userId) => setChoices((c) => ({ ...c, [index]: userId }));

  const shot = phase === 'done' || phase === 'reading';
  const skipped = resolved.filter((r) => !r.who && !asks(r)).length;

  const previewText = phase === 'starting' ? 'Starting the camera…'
    : phase === 'failed' ? 'The camera stopped'
      : phase === 'shooting' ? `Hold still — taking photo ${Math.max(1, shots)} of ${BURST}`
        : seen === 0 ? 'Point the camera at the crew'
          : tooSmall ? `${seen} ${seen === 1 ? 'face' : 'faces'} in view — come closer, the faces are too small`
            : `Hold still — ${seen}${crew.length ? ` of ${crew.length}` : ''} ${seen === 1 ? 'face' : 'faces'} in view${holdLeft != null ? ` · ${(holdLeft / 1000).toFixed(1)}s` : ''}`;

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
          <p className={`absolute inset-x-2 bottom-2 rounded-lg px-2 py-1.5 text-center text-sm font-semibold text-white ${tooSmall && phase === 'looking' ? 'bg-amber-600/85' : 'bg-black/60'}`} aria-live="polite">
            {previewText}
          </p>
        )}
      </div>

      {phase === 'looking' && seen > 0 && (
        <button type="button" className="btn-secondary w-full" onClick={() => shootNow.current?.()}>
          <CameraIcon className="h-4 w-4" /> Take photo now
        </button>
      )}
      {phase === 'looking' && (
        <p className="text-xs text-muted">
          Stand 2{'–'}3 metres from the crew, in two rows at most, everyone facing the camera in good light.
        </p>
      )}

      {phase === 'reading' && (
        <div className="space-y-1">
          <p className="text-sm font-semibold text-muted">
            {'Working out who is in the photo…'}
            {progress && ` ${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`}
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-brand-600 transition-all"
              style={{ width: `${progress ? (progress.done / Math.max(1, progress.total)) * 100 : 5}%` }} />
          </div>
        </div>
      )}

      {phase === 'done' && (
        <>
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            <UsersIcon className="h-4 w-4" />
            {rows.length} {rows.length === 1 ? 'face' : 'faces'} {'·'} {machine.size} recognised
            {finished.length > 0 && <span className="font-normal text-sky-700">{'·'} {finished.length} already completed</span>}
            {pending > 0 && <span className="font-normal text-amber-700">{'·'} {pending} to confirm</span>}
          </p>
          {pending > 0 && (
            <p className="text-xs text-amber-700">
              Tap the right name under each highlighted face, or {'“'}Not in crew{'”'}. Nobody is marked
              until these are settled.
            </p>
          )}
          {unplaced.length > 0 && pending === 0 && skipped > 0 && (
            <p className="text-xs text-amber-700">
              Not found in the photo: {unplaced.map((c) => c.name).join(', ')}. Retake from closer, or mark them one at a time.
            </p>
          )}
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {resolved.map((r) => {
              const person = r.who ? byId.get(r.who) : null;
              const ask = asks(r);
              const ring = person?.completed ? 'ring-sky-400' : person ? 'ring-success' : ask ? 'ring-amber-400' : 'ring-slate-300';
              return (
                <li key={r.index} className="min-w-0 text-center">
                  <img src={crops[r.index]} alt="" className={`aspect-square w-full rounded-xl object-cover ring-2 ${ring}`} />
                  {person ? (
                    <>
                      <p className={`mt-1 truncate text-xs font-semibold ${person.completed ? 'text-sky-700' : 'text-success'}`} title={person.name}>{person.name}</p>
                      <p className="text-[11px] text-slate-500">
                        {person.completed ? 'Attendance completed'
                          : r.by === 'supervisor' ? 'Chosen by you'
                            : `${similarityPercent(r.distance)}% match`}
                      </p>
                      {r.by === 'supervisor' && (
                        <button type="button" className="btn-link text-[11px]" onClick={() => choose(r.index, undefined)}>Change</button>
                      )}
                    </>
                  ) : ask ? (
                    <div className="mt-1 space-y-1">
                      {r.status === 'ambiguous' ? (
                        <>
                          <p className="text-[11px] font-semibold text-amber-700">Which one is this?</p>
                          {[r.userId, r.runnerUpId].filter((id) => id && byId.has(id) && !assigned.has(id)).map((id) => (
                            <button key={id} type="button" className="btn-secondary w-full truncate px-1 py-1 text-[11px]" onClick={() => choose(r.index, id)}>
                              {nameOf(id)}
                            </button>
                          ))}
                        </>
                      ) : (
                        <select className="input w-full px-1 py-1 text-[11px]" value="" aria-label="Who is this?"
                          onChange={(e) => choose(r.index, e.target.value)}>
                          <option value="" disabled>Who is this?</option>
                          {unplaced.map((c) => <option key={c.employee_id} value={c.employee_id}>{c.name}</option>)}
                        </select>
                      )}
                      <button type="button" className="btn-link text-[11px]" onClick={() => choose(r.index, '')}>Not in crew</button>
                    </div>
                  ) : (
                    <p className="mt-1 text-[11px] text-slate-500">{r.small ? 'Too small to read' : 'Not in crew'}</p>
                  )}
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
