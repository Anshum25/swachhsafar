// One photograph of a group, every face in it found and named, and a supervisor who confirms the naming.
//
// What this does and does not prove. A per-person capture watches a live camera for a blink before it
// takes the still, because a photograph of a face does not blink; that is what stops someone marking a
// colleague present with a picture of them. A group photo cannot do this -- there is one frame and many
// faces, and no face in it has been watched over time. So this screen proves something weaker and says
// so: that a named supervisor, at a known place and time, photographed these people and attested that
// they were present. The photo and every automatic suggestion are kept with the records, including the
// ones the supervisor overrode, so a wrong attestation is answerable afterwards.
//
// The camera is used rather than the gallery, so the frame is at least taken here and now; the
// identification never decides on its own (see identifyFaces for the margin and the one-face-one-person
// rule), and each row has to be confirmed.
import { useCallback, useEffect, useRef, useState } from 'react';
import { GROUP_INPUT_SIZE, cropFace, describeAll, loadFaceEngine } from './faceEngine.js';
import { identifyFaces, similarityPercent } from './faceMatch.js';
import { Select } from '../components/ui.jsx';
import { CameraSolidIcon, RefreshIcon, UsersIcon } from '../components/Icons.jsx';

const CAMERA_ERRORS = {
  NotAllowedError: 'Camera permission is needed to photograph the group. Allow it and try again.',
  NotFoundError: 'No camera was found on this device.',
  NotReadableError: 'The camera is in use by another app. Close it and try again.',
};

const STATUS_NOTE = {
  identified: ['text-success', 'Recognised'],
  ambiguous: ['text-amber-700', 'Not sure — confirm who this is'],
  unknown: ['text-slate-500', 'Not recognised — choose a name'],
};

// A detected face, its suggestion, and the name the supervisor settled on.
function FaceRow({ row, crop, candidates, assigned, takenBy, onAssign }) {
  const [tone, note] = STATUS_NOTE[row.status];
  // Someone already named against another face cannot be chosen here as well: one person is present once.
  const options = [{ value: '', label: 'Not present / skip' },
    ...candidates.filter((c) => !takenBy.has(c.employee_id) || c.employee_id === assigned)
      .map((c) => ({ value: c.employee_id, label: `${c.name} · ${c.emp_id}` }))];
  return (
    <li className="flex gap-3 rounded-2xl p-2.5 ring-1 ring-slate-200">
      <img src={crop} alt="" className="h-20 w-20 shrink-0 rounded-xl object-cover ring-1 ring-line" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className={`text-xs font-semibold ${tone}`}>
          {note}
          {row.distance != null && <span className="font-normal text-slate-500"> {'·'} {similarityPercent(row.distance)}% similar</span>}
        </p>
        {row.small && <p className="text-xs text-amber-700">This face is small in the photo, so the suggestion is weak. Take a closer photo or confirm by name.</p>}
        <Select aria-label="Who is this" value={assigned ?? ''} options={options} onChange={(v) => onAssign(row.index, v || null)} />
      </div>
    </li>
  );
}

export default function GroupPhotoCapture({ candidates, profiles, threshold, onChange }) {
  const video = useRef(null);
  const stream = useRef(null);
  const runId = useRef(0);
  const [phase, setPhase] = useState('idle');   // idle | starting | live | reading | review | failed
  const [error, setError] = useState(null);
  const [facing, setFacing] = useState('environment');  // a group is normally photographed with the rear camera
  const [photo, setPhoto] = useState(null);
  const [rows, setRows] = useState([]);
  const [crops, setCrops] = useState([]);
  const [assigned, setAssigned] = useState({});  // face index -> employee_id

  const stop = useCallback(() => {
    runId.current += 1;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);
  useEffect(() => stop, [stop]);

  // The parent is told the confirmed naming, never the raw suggestion: what it submits is what a person
  // put their name to. `suggested_id` travels with it so the record can keep both.
  useEffect(() => {
    onChange?.({
      photo,
      faces: rows.length,
      members: rows
        .filter((r) => assigned[r.index])
        .map((r) => ({
          employee_id: assigned[r.index], crop: crops[r.index] ?? null, distance: r.distance,
          suggested_id: r.userId, status: r.status,
          // Whether a human had to put this name in. The identification is only evidence when the machine
          // reached it and the supervisor agreed; otherwise it is the supervisor's word alone.
          confirmed: r.status === 'identified' && r.userId === assigned[r.index] ? 'matched' : 'manual',
        })),
    });
  }, [rows, assigned, crops, photo, onChange]);

  async function startCamera(useCamera = facing) {
    setError(null);
    setPhase('starting');
    stop();
    const myRun = (runId.current += 1);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: useCamera, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      if (myRun !== runId.current) { stream.current?.getTracks().forEach((t) => t.stop()); return; }
      video.current.srcObject = stream.current;
      await video.current.play();
      await loadFaceEngine();
      setPhase('live');
    } catch (e) {
      stop();
      setPhase('failed');
      setError(CAMERA_ERRORS[e.name] ?? e.message ?? 'The camera could not start.');
    }
  }

  async function shoot() {
    const canvas = document.createElement('canvas');
    canvas.width = video.current.videoWidth || 1280;
    canvas.height = video.current.videoHeight || 720;
    canvas.getContext('2d').drawImage(video.current, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    stop();
    setPhoto(dataUrl);
    setPhase('reading');
    try {
      const { faces } = await describeAll(canvas, { inputSize: GROUP_INPUT_SIZE });
      if (!faces.length) {
        setPhase('failed');
        setError('No faces were found in the photo. Take it again with everyone facing the camera.');
        return;
      }
      const found = identifyFaces({ faces, profiles, threshold });
      // `small` belongs to the detection, not the identification, and the row carries both.
      const merged = found.map((r) => ({ ...r, small: faces[r.index].small }));
      setCrops(await Promise.all(faces.map((f) => cropFace(canvas, f.box))));
      setRows(merged);
      // Only a clear recognition is pre-filled. An ambiguous one is left blank on purpose: a name already
      // in the box is a name that gets submitted without being read.
      setAssigned(Object.fromEntries(merged.filter((r) => r.status === 'identified').map((r) => [r.index, r.userId])));
      setPhase('review');
    } catch (e) {
      setPhase('failed');
      setError(e.message ?? 'The photo could not be read.');
    }
  }

  function retake() {
    setPhoto(null); setRows([]); setCrops([]); setAssigned({});
    startCamera();
  }

  const taken = new Set(Object.values(assigned).filter(Boolean));
  const named = taken.size;

  if (phase === 'review') {
    return (
      <div className="space-y-2">
        <div className="relative overflow-hidden rounded-2xl ring-1 ring-line">
          <img src={photo} alt="Group photo" className="max-h-56 w-full object-cover" />
          <button type="button" className="btn-secondary absolute bottom-2 right-2" onClick={retake}>Retake</button>
        </div>
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <UsersIcon className="h-4 w-4" />
          {rows.length} {rows.length === 1 ? 'face' : 'faces'} found {'·'} {named} named
        </p>
        <p className="text-xs text-muted">
          Check every name before marking attendance. A group photo cannot show that each person was there
          in the moment the way a live face check does, so these records are saved as your attestation.
        </p>
        <ul className="space-y-2">
          {rows.map((r) => (
            <FaceRow key={r.index} row={r} crop={crops[r.index]} candidates={candidates}
              assigned={assigned[r.index] ?? null} takenBy={taken}
              onAssign={(i, v) => setAssigned((a) => ({ ...a, [i]: v }))} />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className={`relative overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-line ${phase === 'idle' ? 'hidden' : ''}`}>
        <video ref={video} playsInline muted className="aspect-video w-full object-cover" />
        {phase === 'live' && (
          <>
            <button type="button" className="btn-primary absolute bottom-2 left-1/2 -translate-x-1/2" onClick={shoot}>
              Take group photo
            </button>
            <button type="button" aria-label="Switch camera"
              className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white"
              onClick={() => { const next = facing === 'user' ? 'environment' : 'user'; setFacing(next); startCamera(next); }}>
              <RefreshIcon className="h-4.5 w-4.5" />
            </button>
          </>
        )}
        {phase === 'reading' && (
          <p className="absolute inset-x-2 bottom-2 rounded-lg bg-black/60 px-2 py-1.5 text-center text-sm font-semibold text-white">
            Reading faces{'…'}
          </p>
        )}
      </div>
      {phase === 'reading' && photo && <img src={photo} alt="Group photo" className="max-h-56 w-full rounded-2xl object-cover ring-1 ring-line" />}
      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {(phase === 'idle' || phase === 'failed') && (
        <button type="button" className="btn-secondary w-full" onClick={() => startCamera()}>
          <CameraSolidIcon className="mr-1.5 h-4 w-4" />{phase === 'failed' ? 'Try again' : 'Open camera'}
        </button>
      )}
    </div>
  );
}
