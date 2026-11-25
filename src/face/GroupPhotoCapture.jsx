// Point the camera at the crew; it watches every face for a blink or a head movement, takes the photo itself
// once one person in the crew has blinked or moved, works out who is in it, and hands back the names. Built
// for a crew of ten to fifteen people.
//
// How the shutter decides: the crew's own blinks and movement. Nobody is asked to do anything special; people
// blink every few seconds, shift, glance around and turn as they settle. The preview follows every face from
// frame to frame. A blink is read from the pixels of each face's eyes on a fast timer, as in solo attendance
// (faceEngine.eyeOpenness, liveness.js); a real head moving shows 3-D depth -- the nose moves off the plane of
// the eyes, brows and mouth (groupLiveness.js, depthCheck.js). A printed photo, or a photo of a face on a
// phone held up to the camera, neither blinks nor shows depth. ONE face seen blinking or moving is enough: it
// shows the camera is looking at a live crew, and everyone recognised in the photo is marked. (Weaker than
// asking every face: a picture held up beside a live person would be read too. The supervisor taking the
// photo is answerable for it.)
//
// The photo is NOT taken while people are moving: a face turned away is a face that cannot be recognised.
// It is taken at the first moment after that when every face in view is looking at the camera and the
// crew is steady -- one still, at full resolution. If nobody moves, the photo is still taken (on a frame
// where everyone faces the camera) after a while, and nobody is marked if nobody blinked or moved either.
//
// What it reads. The still is read with the thorough detector (SSD MobileNet, faceEngine.describeAll),
// whole and in tiles so back-row faces are found, each face from its own enlarged close-up.
//
// Recognition never guesses (faceMatch.identifyFaces): once someone blinked or moved, everyone recognised
// clearly is marked present at once, with nothing to press. A face whose closest match does not clearly beat
// the runner-up, or that matched nobody, is never marked; the screen says why under its picture.
import { useCallback, useEffect, useRef, useState } from 'react';
import { GROUP_INPUT_SIZE, analyseFaces, cropFace, describeAll, eyeOpenness, loadFaceEngine } from './faceEngine.js';
import { createGroupLiveness, liveTrackFor } from './groupLiveness.js';
import { createLiveness } from './liveness.js';
import { RECOMMENDED_THRESHOLD, identifyFaces, isStrict, requiredPercent, similarityPercent } from './faceMatch.js';
import { RefreshIcon, UsersIcon } from '../components/Icons.jsx';

// Why a face was not marked, in one short line under its picture.
function whyNot(r, nameOf, threshold) {
  if (r.small) return 'Too small or unclear to read. Come closer.';
  if (r.status === 'identified' && !r.live) return `Looks like ${nameOf(r.userId)}, but nobody was seen blinking or moving (or it is a photo).`;
  if (r.status === 'ambiguous') return `Looks like ${nameOf(r.userId)} or ${nameOf(r.runnerUpId)}; too close to tell apart.`;
  if (r.distance == null) return 'Nobody registered to compare with.';
  return `Closest match ${similarityPercent(r.distance)}%; needs ${requiredPercent(threshold)}%.`;
}

const CAMERA_ERRORS = {
  NotAllowedError: 'Camera permission is needed to photograph the crew. Allow it and try again.',
  NotFoundError: 'No camera was found on this device.',
  NotReadableError: 'The camera is in use by another app. Close it and try again.',
};

// Once everyone has moved, the face count has to hold still for this long, over at least this many
// detections, so the photo is not taken with the phone moving.
const STEADY_MS = 600;
const STEADY_FRAMES = 3;
// A face is "looking at the camera" when its nose sits within this many inter-eye distances of the middle
// of its eyes; this many frames in a row of everyone looking is the moment to shoot. A face turned further
// than this is read far worse (a side view matched 49% where the same person face-on matches well).
const FRONTAL_YAW = 0.12;
const FRONTAL_FRAMES = 2;
// How long the preview waits for the whole crew to be in view before shooting on whoever is there.
const WAIT_FOR_ALL_MS = 6000;
// Below this share of the frame height a face is too small to count at all.
const MIN_FACE_SHARE = 0.02;
// Below this share the faces are found but too small to recognise reliably: the screen asks to come closer.
const GOOD_FACE_SHARE = 0.05;
// How long the crew is given to move. After this the photo is taken anyway -- still on a frame where
// everyone faces the camera, if one comes within the grace period; only faces seen moving are marked.
const LIVE_PATIENCE_MS = 15000;
const FRONTAL_GRACE_MS = 5000;
// Stills larger than this are scaled down: plenty for recognition, and keeps the phone responsive.
const MAX_WIDTH = 3000;
// The eyes are read from the pixels on their own timer, much faster than the detector runs: a blink lasts
// about two tenths of a second. Only faces at least this tall (video pixels) are watched for a blink:
// smaller eyes are a few pixels across, too few to tell open from shut.
const EYE_SAMPLE_MS = 50;
const BLINK_FACE_PX = 70;
const blinkDetector = () => createLiveness({
  challenges: ['blink'],
  options: { timeoutMs: 600_000, minFaceSize: 0, turnYaw: 0.35, frontYaw: 0.30, blinkDip: 0.13, jitterDips: 1.8, blinkRecover: 0.65, baselineFrames: 2 },
});

export default function GroupPhotoCapture({ candidates, profiles, threshold, onChange }) {
  const video = useRef(null);
  const stream = useRef(null);
  const runId = useRef(0);
  const [phase, setPhase] = useState('starting');   // starting | looking | reading | done | failed
  const [error, setError] = useState(null);
  const [facing, setFacing] = useState('environment');  // a crew is normally photographed with the rear camera
  const [seen, setSeen] = useState(0);              // faces in the live preview
  const [liveSeen, setLiveSeen] = useState({ live: 0, total: 0 });
  const [tooSmall, setTooSmall] = useState(false);  // faces in view, but too small to recognise well
  const [looking, setLooking] = useState(false);    // every face in view is looking at the camera
  const [holdLeft, setHoldLeft] = useState(null);   // ms of the steady hold still to go
  const [progress, setProgress] = useState(null);   // { done, total } while reading
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

  const crew = candidates ?? [];
  const byId = new Map(crew.map((c) => [c.employee_id, c]));
  const nameOf = (id) => byId.get(id)?.name ?? 'Unknown';

  // Who each face is. Only a clear recognition of a face seen moving counts: it is marked present
  // automatically. Anything else is never marked -- the screen says why, so the crew can fix it and retake.
  const resolved = rows.map((r) => ({ ...r, who: r.status === 'identified' && r.live && byId.has(r.userId) ? r.userId : null }));
  const assigned = new Set(resolved.filter((r) => r.who).map((r) => r.who));
  const named = resolved.filter((r) => r.who && !byId.get(r.who).completed);
  const finished = resolved.filter((r) => r.who && byId.get(r.who).completed);
  const missed = resolved.filter((r) => !r.who);
  const unplaced = crew.filter((c) => !assigned.has(c.employee_id));

  // The parent is told who was recognised as soon as it is known, and marks them straight away.
  useEffect(() => {
    onChange?.({
      photo,
      faces: rows.length,
      recognised: named.length,
      ready: phase === 'done',
      members: named.map((r) => ({
        employee_id: r.who, crop: crops[r.index] ?? null, distance: r.distance, confirmed: 'matched', liveness: 'passed',
      })),
    });
    // `named` is derived from `rows`, which is the dependency that matters.
  }, [rows, crops, photo, phase, onChange]);   // eslint-disable-line react-hooks/exhaustive-deps

  const read = useCallback(async (canvas, myRun, liveCtx) => {
    setPhase('reading');
    setProgress(null);
    try {
      const { faces } = await describeAll(canvas, {
        inputSize: GROUP_INPUT_SIZE,
        onProgress: (done, total) => { if (myRun === runId.current) setProgress({ done, total }); },
      });
      if (myRun !== runId.current) return;
      if (!faces.length) {
        setPhase('failed');
        setError('No faces could be read from the photo. Hold the phone steady with everyone facing the camera.');
        return;
      }
      // One face seen blinking or moving makes the crew live; every face then counts as seen live.
      const crewLive = liveCtx.blinked || liveCtx.tracks.some((t) => t.live);
      const found = identifyFaces({ faces, profiles, threshold })
        .map((r) => ({ ...r, small: faces[r.index].small,
          moved: !!liveTrackFor(liveCtx.tracks, faces[r.index].box, { sx: liveCtx.sx, sy: liveCtx.sy }),
          live: crewLive }));
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
    setPhoto(null); setRows([]); setCrops([]); setSeen(0); setProgress(null); setTooSmall(false); setLooking(false);
    setLiveSeen({ live: 0, total: 0 });
    const liveness = createGroupLiveness();
    let liveState = liveness.snapshot();
    // Blinks: one detector per tracked face, fed by the fast eye sampler below.
    const blinkers = new Map();
    let watched = [];      // [{ id, eyes, yaw, size }] from the latest detection
    let blinked = false;
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

    // Takes the full-resolution still and hands it to the slow pass.
    let shooting = false;
    const shoot = async () => {
      if (shooting || myRun !== runId.current) return;
      shooting = true;
      const canvas = document.createElement('canvas');
      // A real still from the sensor where the browser allows it: several times the pixels of a video
      // frame, which is what lets a back-row face be recognised at all.
      let still = null;
      try {
        const track = stream.current?.getVideoTracks()[0];
        if (track && window.ImageCapture) still = await createImageBitmap(await new window.ImageCapture(track).takePhoto());
      } catch { still = null; }
      const vw = video.current.videoWidth || 1280;
      const vh = video.current.videoHeight || 720;
      // The movement checks were made on preview coordinates; a sensor still with a different framing
      // (another aspect ratio) could not be matched back to them, so the preview frame is used instead.
      if (still && Math.abs(still.width / still.height - vw / vh) > 0.02) still = null;
      const srcW = still?.width || vw;
      const srcH = still?.height || vh;
      const k = Math.min(1, MAX_WIDTH / srcW);
      canvas.width = Math.round(srcW * k);
      canvas.height = Math.round(srcH * k);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(still ?? video.current, 0, 0, canvas.width, canvas.height);
      still?.close?.();
      setPhoto(canvas.toDataURL('image/jpeg', 0.9));
      release();                  // the preview has done its job; free the camera before the slow pass
      await read(canvas, myRun, { tracks: liveState.tracks, blinked, sx: canvas.width / vw, sy: canvas.height / vh });
    };

    let steady = 0;
    let since = null;
    let lastCount = -1;
    let frontalRun = 0;
    const startedAt = Date.now();
    const want = crew.length;

    const look = async () => {
      if (shooting || myRun !== runId.current || !video.current) return;
      const found = await analyseFaces(video.current).catch(() => []);
      if (shooting || myRun !== runId.current || !video.current) return;
      const height = video.current.videoHeight || 720;
      liveState = liveness.feed(found);
      // The faces big enough to watch for a blink, under their track ids (a track's box is the face's own box).
      const frameW = video.current.videoWidth || 1;
      watched = found.filter((f) => f.eyes && f.box.height >= BLINK_FACE_PX).map((f) => ({
        id: liveState.tracks.find((t) => t.box === f.box)?.id, eyes: f.eyes, yaw: f.yaw, size: f.box.width / frameW,
      })).filter((w) => w.id != null);
      // Anyone seen blinking or moving so far counts, even if they have since turned away or stepped behind
      // someone.
      const movedSoFar = liveState.tracks.filter((t) => t.live).length + (blinked ? 1 : 0);
      setLiveSeen({ live: movedSoFar, total: liveState.total });
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
      // Everyone in view looking at the camera, for a couple of frames in a row.
      const frontal = usable.length > 0 && usable.every((f) => Math.abs(f.yaw) <= FRONTAL_YAW);
      frontalRun = frontal ? frontalRun + 1 : 0;
      setLooking(frontal);
      // One person in view has to have blinked or moved like a real person before the photo is taken.
      const someoneLive = movedSoFar >= 1;
      // The whole crew in view, or long enough waited for the rest.
      const enough = usable.length >= want || t - startedAt >= WAIT_FOR_ALL_MS;
      setHoldLeft(someoneLive && since != null ? Math.max(0, STEADY_MS - (t - since)) : null);
      const settled = someoneLive && enough && frontalRun >= FRONTAL_FRAMES
        && steady >= STEADY_FRAMES && since != null && t - since >= STEADY_MS;
      // Out of patience: take the photo anyway, on a frame where everyone faces the camera if one comes
      // soon. Faces not seen moving are reported, never marked.
      const late = t - startedAt;
      const impatient = usable.length > 0 && late >= LIVE_PATIENCE_MS
        && (frontalRun >= FRONTAL_FRAMES || late >= LIVE_PATIENCE_MS + FRONTAL_GRACE_MS);
      if (settled || impatient) { await shoot(); return; }
      setTimeout(look, 0);
    };
    // Fast: read every watched face's eyes and look for a blink. No model runs here, so it keeps its own pace.
    const sample = () => {
      if (shooting || myRun !== runId.current || !video.current) return;
      if (!blinked) {
        for (const w of watched) {
          const openness = eyeOpenness(video.current, w.eyes);
          if (openness == null) continue;
          if (!blinkers.has(w.id)) blinkers.set(w.id, blinkDetector());
          const r = blinkers.get(w.id).feed({ count: 1, size: w.size, yaw: w.yaw, ear: openness });
          if (r.status === 'passed') { blinked = true; break; }
        }
      }
      setTimeout(sample, EYE_SAMPLE_MS);
    };
    look();
    sample();
  }, [read, release, stop]);

  // Opens by itself: the camera is the whole screen, so there is nothing to press first.
  useEffect(() => { start(facing); }, [facing]);   // eslint-disable-line react-hooks/exhaustive-deps

  const flip = () => setFacing((f) => (f === 'user' ? 'environment' : 'user'));

  const shot = phase === 'done' || phase === 'reading';

  const previewText = phase === 'starting' ? 'Starting the camera…'
    : phase === 'failed' ? 'The camera stopped'
      : seen === 0 ? 'Point the camera at the crew'
        : tooSmall ? `${seen} ${seen === 1 ? 'face' : 'faces'} in view — come closer, the faces are too small`
          : liveSeen.live === 0
            ? 'Waiting for someone to blink or move'
            : !looking ? 'Everyone look at the camera'
              : `Hold still${holdLeft ? ` · ${(holdLeft / 1000).toFixed(1)}s` : ''}`;

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

      {phase === 'looking' && (
        <p className="text-xs text-muted">
          Stand 2{'–'}3 metres from the crew, in two rows at most, in good light. Once anyone blinks or
          moves, the photo is taken by itself the moment everyone is looking at the camera.
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
            {rows.length} {rows.length === 1 ? 'face' : 'faces'} {'·'} {assigned.size} recognised
            {finished.length > 0 && <span className="font-normal text-sky-700">{'·'} {finished.length} already completed</span>}
            {missed.length > 0 && <span className="font-normal text-amber-700">{'·'} {missed.length} not marked</span>}
          </p>
          {isStrict(threshold) && missed.some((r) => r.status === 'unknown' && r.distance != null) && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
              This office{'’'}s face match strictness is {threshold} (a face must reach {requiredPercent(threshold)}%),
              stricter than the recommended {RECOMMENDED_THRESHOLD} ({requiredPercent(RECOMMENDED_THRESHOLD)}%). Clear photos of
              the right person are often refused at this setting. An administrator can change it in Master data {'→'} Division Policy.
            </p>
          )}
          {missed.length > 0 && unplaced.length > 0 && (
            <p className="text-xs text-amber-700">
              Not yet marked: {unplaced.map((c) => c.name).join(', ')}. Retake with everyone in view and looking
              at the camera, or mark them one at a time.
            </p>
          )}
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {resolved.map((r) => {
              const person = r.who ? byId.get(r.who) : null;
              const ring = person?.completed ? 'ring-sky-400' : person ? 'ring-success' : 'ring-amber-400';
              return (
                <li key={r.index} className="min-w-0 text-center">
                  <img src={crops[r.index]} alt="" className={`aspect-square w-full rounded-xl object-cover ring-2 ${ring}`} />
                  {person ? (
                    <>
                      <p className={`mt-1 truncate text-xs font-semibold ${person.completed ? 'text-sky-700' : 'text-success'}`} title={person.name}>{person.name}</p>
                      <p className="text-[11px] text-slate-500">{person.completed ? 'Attendance completed' : `${similarityPercent(r.distance)}% match`}</p>
                    </>
                  ) : (
                    <>
                      <p className="mt-1 text-xs font-semibold text-amber-700">Not marked</p>
                      <p className="text-[11px] leading-tight text-slate-500">{whyNot(r, nameOf, threshold)}</p>
                    </>
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
