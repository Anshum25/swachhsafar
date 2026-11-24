import { useCallback, useEffect, useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import JourneyPicker from '../../components/JourneyPicker.jsx';
import MediaPreview from '../../components/MediaPreview.jsx';
import ReviewPanel from '../../components/ReviewPanel.jsx';
import { GpsCapture, PhotoCapture, outcomeToast, savedLocally } from '../../components/Capture.jsx';
import {
  Badge, DataState, DetailList, Dialog, Empty, Field, FilterBar, Loading, PageHeader, Pager, Panel, STATE_TONE, Select, SubmitBar, SyncBadge,
  SyncState, Table, Tabs, fmtDateTime, label,
} from '../../components/ui.jsx';
import { CameraSolidIcon, CheckBoldIcon, CheckIcon, LockSolidIcon, RefreshIcon, TrainSolidIcon, UserSolidIcon, UsersIcon } from '../../components/Icons.jsx';
import { canAct } from '../../services/authorization.js';
import { deviceTimestamp, stampLines } from '../../utils/capture.js';
import { FaceCheckNote, faceFields, useFaceCheck } from '../../face/FaceCheck.jsx';
import { FingerprintButton, FingerprintCheckNote, useFingerprintCheck } from '../../fingerprint/FingerprintCheck.jsx';
import { DEFAULT_MATCH_SCORE, fingerprintFields } from '../../fingerprint/fingerprintMatch.js';
import LiveFaceCapture from '../../face/LiveFaceCapture.jsx';
import GroupPhotoCapture from '../../face/GroupPhotoCapture.jsx';
import { FACE_MODEL } from '../../face/faceMatch.js';
import { useSecurityGate } from '../../security/SecurityProvider.jsx';
import { nextStageFor } from '../../database/attendanceRepository.js';

export const STAGES = ['Source', 'Enroute 1', 'Destination', 'Enroute 2', 'End'];
// Reference labels under the five stage icons.
const STAGE_LABEL = ['Source', 'Enroute', 'DEST', 'Enroute', 'END'];

// Stage mark (reference: green check = taken, purple camera = capture now, grey lock = not open yet);
// amber = saved on this device, waiting to sync.
const MARK = {
  taken: { label: 'text-success', node: <span className="grid h-8 w-8 place-items-center rounded-full bg-success text-white shadow-[0_3px_8px_rgba(37,180,90,0.35)]"><CheckBoldIcon className="h-4.5 w-4.5" /></span> },
  pending: { label: 'text-amber-700', node: <span className="grid h-8 w-8 place-items-center rounded-full bg-amber-400 text-white"><RefreshIcon className="h-4.5 w-4.5" /></span> },
  next: { label: 'text-camera', node: <span className="grid h-8 w-8 place-items-center rounded-xl bg-camera/12 text-camera"><CameraSolidIcon className="h-6 w-6" /></span> },
  locked: { label: 'text-slate-500', node: <span className="grid h-8 w-8 place-items-center text-locked"><LockSolidIcon className="h-6 w-6" /></span> },
};
const LegendDot = ({ state, children }) => (
  <span className="inline-flex items-center gap-1.5"><span className="inline-block origin-left scale-[0.6]">{MARK[state].node}</span><span className="-ml-3">{children}</span></span>
);

const VERIFICATION = [{ value: 'pending', label: 'Pending review' }, { value: 'verified', label: 'Verified' }, { value: 'rejected', label: 'Rejected' }];
// How each record established identity (attendance.identified_by); group records share a submission id.
const METHOD = { group_photo: 'Group photo', face: 'Face', fingerprint: 'Fingerprint' };
const methodOf = (r) => METHOD[r.identified_by] ?? (r.group_submission_id ? 'Group' : 'Individual');
const gpsText = (r) => (r.latitude != null ? `${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}${r.gps_accuracy_m != null ? ` ±${Math.round(r.gps_accuracy_m)} m` : ''}` : null);

function CaptureDialog({ target, journey, onClose, onDone }) {
  const { queue } = useSession();
  const notify = useNotify();
  const [gps, setGps] = useState(null);
  const [address, setAddress] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const policy = useResource(`/divisions/${journey.division_id}/policy`);
  const faceOn = policy.data?.attendance_face_verification === true;
  // `cameraOn`: the photo is taken by the app from the live camera, never chosen from the gallery, and
  // a blink has to be seen before it is taken -- a photograph of a face, on paper or on another phone,
  // does not blink, and without that anyone could mark anyone else present with a picture of them.
  // `liveOn`: a head turn as well, which a division asks for with face_liveness_required.
  const cameraOn = faceOn || policy.data?.face_liveness_required === true;
  const liveOn = policy.data?.face_liveness_required === true;
  const [liveness, setLiveness] = useState(cameraOn ? null : 'not_required');
  const face = useFaceCheck({ photo, employeeId: target.staff.employee_id, enabled: faceOn, threshold: policy.data?.face_match_threshold ?? 0.5 });
  // Fingerprint is an alternative to the face check, never a replacement: the scanner can be absent or
  // broken, so a matched fingerprint satisfies the division instead of the face, and nothing more is
  // demanded of a phone that has no scanner.
  const fingerprintOn = policy.data?.attendance_fingerprint_verification === true;
  const finger = useFingerprintCheck({ employeeId: target.staff.employee_id, enabled: fingerprintOn,
    threshold: policy.data?.fingerprint_match_score ?? DEFAULT_MATCH_SCORE });
  const fingerOk = fingerprintOn && finger.status === 'matched';
  const faceOk = fingerOk || !faceOn || face.status === 'matched';
  // A photo is what the face check compares against; a fingerprint capture does not need one of its own.
  const photoNeeded = (policy.data?.attendance_photo_required !== false || faceOn) && !fingerOk;
  const gate = useSecurityGate('attendance');
  // Liveness is a property of the face photo, so a capture proved by fingerprint is not asked for it --
  // matching the server, which only requires it of a capture verified by face.
  const liveOk = fingerOk || !cameraOn || liveness === 'passed';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const mediaId = photo ? crypto.randomUUID() : null;
    const outcome = await queue.submit({
      type: 'attendance.create',
      payload: {
        id: crypto.randomUUID(), journey_id: journey.id, employee_id: target.staff.employee_id, stage: target.stage,
        device_timestamp: deviceTimestamp(), ...gps, photo_media_id: mediaId,
        ...(fingerOk ? fingerprintFields(finger) : faceFields(face)),
        ...gate.evidence({ liveness: cameraOn && !fingerOk ? liveness : 'not_required', faceModel: faceOn && !fingerOk ? FACE_MODEL : null }),
      },
      media: photo ? [{ id: mediaId, division_id: journey.division_id, kind: 'attendance_photo', dataUrl: photo }] : [],
    });
    setBusy(false);
    outcomeToast(notify, outcome, 'Attendance');
    onDone(outcome);
  }

  return (
    <Dialog open title={`${target.staff.name} · ${STAGES[target.stage - 1]}`} onClose={onClose} onSubmit={submit}
      footer={<SubmitBar busy={busy} disabled={!gps || (photoNeeded && !photo) || policy.loading || !faceOk || !liveOk || !gate.allowed} label="Mark attendance" onCancel={onClose} flush />}>
      <div className="space-y-3">
        <p className="text-center text-xs font-medium text-muted">{target.staff.emp_id} · Stage {target.stage} of 5 · {journey.train_no}</p>
        {cameraOn ? (
          photo ? (
            <div className="relative overflow-hidden rounded-2xl ring-1 ring-line">
              <img src={photo} alt="Live check photo" className="max-h-60 w-full object-cover" />
              <button type="button" className="btn-secondary absolute bottom-2 right-2"
                onClick={() => { setPhoto(null); setLiveness(cameraOn ? null : 'not_required'); }}>
                Retake
              </button>
            </div>
          )
            : <LiveFaceCapture name={target.staff.name} mode={liveOn ? 'challenge' : 'presence'}
                onDone={(r) => { setLiveness(r.liveness); setPhoto(r.photo); }} />
        ) : <PhotoCapture value={photo} onChange={setPhoto} required stamp={stampLines({ ...gps, address })} />}
        <GpsCapture value={gps} onChange={setGps} auto onAddress={setAddress} map />
        <FingerprintButton check={finger} name={target.staff.name} />
        <FaceCheckNote check={face} name={target.staff.name} />
        <FingerprintCheckNote check={finger} name={target.staff.name} />
        {gate.notice}
      </div>
    </Dialog>
  );
}

// Group attendance: one shared capture (one photo, GPS fix and capture time) for several staff, but stage
// progression is per employee -- each selected person is recorded at THEIR OWN next pending stage, never
// one stage forced on the whole group. As on the server (backend attendance.create_group), it is one
// attendance record per member sharing a group_submission_id, and each member succeeds or fails
// independently. Each record is an ordinary 'attendance.create' operation, so the whole group works
// offline, is delivered exactly once, and is checked for stage order and duplicates locally and again
// by the server.
function MemberFaceCheck({ photo, member, enabled, threshold, onResult }) {
  const check = useFaceCheck({ photo, employeeId: member.employee_id, enabled, threshold });
  useEffect(() => { onResult(member.employee_id, check); }, [check, member.employee_id, onResult]);
  return <FaceCheckNote check={check} name={member.name} />;
}

const StagePill = ({ stage }) => (
  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-camera/10 px-2 py-0.5 text-[11px] font-semibold text-camera">
    <CameraSolidIcon className="h-3 w-3" /> {stage} · {STAGES[stage - 1]}
  </span>
);

function GroupDialog({ journey, rows, local, onClose, onDone }) {
  const { queue, store, user, canIn } = useSession();
  const notify = useNotify();
  const policy = useResource(`/divisions/${journey.division_id}/policy`);
  // Photo required unless the division policy relaxes it (the strict default while it is loading).
  const photoRequired = policy.data?.attendance_photo_required !== false;
  // Every employee's own next stage. Staff who have finished all five are not offered.
  const members = rows
    .map((r) => ({ ...r, stage: nextStageFor(r, (st) => local[`${r.employee_id}:${st}`]) }))
    .filter((r) => r.stage != null);
  const byId = new Map(members.map((m) => [m.employee_id, m]));
  const [picked, setPicked] = useState({});
  const [photos, setPhotos] = useState({});
  const [gps, setGps] = useState(null);
  const [address, setAddress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [faces, setFaces] = useState({});
  const faceOn = policy.data?.attendance_face_verification === true;
  const liveOn = faceOn && policy.data?.face_liveness_required === true;
  const [live, setLive] = useState({});
  const gate = useSecurityGate('attendance');
  const threshold = policy.data?.face_match_threshold ?? 0.5;
  // One group photograph for the whole crew, where the division allows it. It is offered only to whoever
  // can be held to the attestation -- the same people the server accepts it from -- so the choice never
  // appears to someone whose submission would then be refused.
  const mayAttest = journey.supervisor_id === user?.id || canIn('attendance.review', journey.division_id);
  const mode = policy.data?.attendance_group_photo === true && mayAttest ? 'photo' : 'each';
  const [group, setGroup] = useState(null);           // what the camera recognised
  const [plainPhoto, setPlainPhoto] = useState(null); // fallback: an ordinary photo, staff named by hand
  const [usePlain, setUsePlain] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const onFace = useCallback((id, check) => setFaces((f) => (f[id] === check ? f : { ...f, [id]: check })), []);
  const chosen = members.filter((m) => picked[m.employee_id]);
  // Faces are loaded for EVERY allocated staff member, finished or not: someone who has completed all five
  // stages still turns up in the crew photo, and must be recognised (and shown as completed) rather than
  // left as an unknown face or mistaken for a colleague.
  const memberIds = rows.map((r) => r.employee_id).join(',');
  const candidates = rows.map((r) => ({ ...r, completed: !byId.has(r.employee_id) }));
  useEffect(() => {
    if (mode !== 'photo' || !memberIds) { setProfiles([]); return undefined; }
    let cancelled = false;
    store.masters.faceProfilesFor(memberIds.split(',')).then((r) => !cancelled && setProfiles(r), () => !cancelled && setProfiles([]));
    return () => { cancelled = true; };
  }, [mode, memberIds, store]);

  // Fully automatic with the face camera: once the photo is read and there is a location fix, everyone
  // recognised is marked at THEIR OWN next stage -- nothing to choose, nothing to press. The ordinary-photo
  // fallback (no recognition) still needs the supervisor to tick who is in it.
  const recognised = new Map((group?.members ?? []).map((r) => [r.employee_id, r]));
  const autoMembers = members.filter((m) => recognised.has(m.employee_id));
  const groupPhoto = usePlain ? plainPhoto : (group?.ready ? group.photo : null);
  const photoReady = mode === 'photo' && !usePlain && gps && group?.ready && autoMembers.length > 0 && !policy.loading && gate.allowed
    && !group.needsReview;
  // Marked straight away only when the camera placed everyone itself; once the supervisor has settled a face
  // by hand they confirm with a button, so a mis-tap can still be corrected.
  const autoReady = photoReady && !group.reviewed;
  useEffect(() => {
    if (!autoReady || busy || done) return;
    submit(null, autoMembers);
    // `submit` closes over this render's values, which are the ones `autoReady` was computed from.
  }, [autoReady]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ready = mode === 'photo'
    ? gps && groupPhoto && chosen.length > 0 && !policy.loading && gate.allowed
    : gps && chosen.length && !policy.loading && gate.allowed
      && (!liveOn || chosen.every((m) => live[m.employee_id] === 'passed'))
      && (!(photoRequired || faceOn) || chosen.every((m) => photos[m.employee_id]))
      && (!faceOn || chosen.every((m) => faces[m.employee_id]?.status === 'matched'));

  async function submit(e, list = chosen) {
    e?.preventDefault();
    if (busy || done || !(ready || list !== chosen)) return;
    setBusy(true);
    setDone(true);   // before the first await: a re-render mid-submission cannot start a second round
    const submission = crypto.randomUUID();
    const at = deviceTimestamp();
    const results = [];
    for (const m of list) {
      let extra;
      let media = [];
      if (mode === 'photo') {
        const hit = !usePlain ? recognised.get(m.employee_id) : null;
        const mediaId = crypto.randomUUID();
        extra = {
          group_photo: true, photo_media_id: mediaId,
          // The distance is evidence only where the device recognised this person and the supervisor
          // agreed. Where the supervisor supplied the name, nothing is claimed about a match.
          ...(hit && typeof hit.distance === 'number' ? { face_distance: hit.distance, face_model: FACE_MODEL } : {}),
          // A single frame cannot show that this face blinked, so no liveness is claimed for it either.
          ...gate.evidence({ liveness: 'not_required', faceModel: hit ? FACE_MODEL : null }),
        };
        // Each record keeps this person's own face cut out of the group photo; a person named by hand
        // keeps the whole photograph.
        media = [{ id: mediaId, division_id: journey.division_id, kind: 'attendance_photo', dataUrl: hit?.crop ?? groupPhoto }];
      } else {
        const photo = photos[m.employee_id];
        const mediaId = photo ? crypto.randomUUID() : null;
        extra = {
          photo_media_id: mediaId, ...(faceOn ? faceFields(faces[m.employee_id] ?? {}) : {}),
          ...gate.evidence({ liveness: liveOn ? live[m.employee_id] ?? 'failed' : 'not_required', faceModel: faceOn ? FACE_MODEL : null }),
        };
        media = photo ? [{ id: mediaId, division_id: journey.division_id, kind: 'attendance_photo', dataUrl: photo }] : [];
      }
      const outcome = await queue.submit({
        type: 'attendance.create',
        payload: {
          id: crypto.randomUUID(), journey_id: journey.id, employee_id: m.employee_id,
          stage: m.stage,   // this employee's own next stage, not a group-wide one
          device_timestamp: at, ...gps, group_submission_id: submission, ...extra,
        },
        media,
      });
      results.push({ member: m, outcome });
    }
    finish(results);
  }

  // Each member succeeds or fails on their own, as on the server, so the report names whoever was refused
  // rather than calling the whole group a failure.
  function finish(results) {
    setBusy(false);
    const saved = results.filter((r) => savedLocally(r.outcome));
    const synced = saved.filter((r) => r.outcome.status === 'synced').length;
    const refused = results.filter((r) => !savedLocally(r.outcome));
    if (saved.length) notify(synced === saved.length ? 'success' : 'warning', synced === saved.length
      ? `Group attendance saved and synchronized for ${synced} staff.`
      : `Group attendance saved on this device for ${saved.length} staff. It will sync when the server is reachable.`);
    for (const r of refused) notify('error', `${r.member.name} (${STAGES[r.member.stage - 1]}): ${r.outcome.message}`);
    onDone(saved.filter((r) => r.outcome.status !== 'synced').map((r) => [r.member.employee_id, r.member.stage]));
  }

  const toggle = (id, on) => setPicked((p) => ({ ...p, [id]: on }));
  const selectAll = () => setPicked(Object.fromEntries(members.map((m) => [m.employee_id, true])));
  const sourceOf = (id) => (!usePlain && recognised.has(id) ? 'Recognised' : 'Named by hand');

  return (
    <Dialog open title="Group attendance" onClose={onClose} wide>
      {!members.length ? <Empty title="Every allocated staff member has completed all five stages." /> : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs text-muted">Each person is recorded at their own next stage.</p>
          <GpsCapture value={gps} onChange={setGps} auto onAddress={setAddress} map />
          {mode === 'photo' ? (
            <>
              {usePlain ? (
                <PhotoCapture value={plainPhoto} onChange={setPlainPhoto} required stamp={stampLines({ ...gps, address })} />
              ) : (
                <GroupPhotoCapture key={profiles.length} candidates={candidates} profiles={profiles}
                  threshold={threshold} onChange={setGroup} />
              )}
              <button type="button" className="btn-link text-xs"
                onClick={() => { setUsePlain((u) => !u); setPicked({}); setPlainPhoto(null); setGroup(null); }}>
                {usePlain ? 'Use the face recognition camera' : 'Take an ordinary photo and select staff by hand'}
              </button>
              {!usePlain && (
                <p className="text-sm font-medium text-muted" aria-live="polite">
                  {busy ? `Marking ${autoMembers.length} present…`
                    : done ? `Done. ${autoMembers.map((m) => `${m.name}: ${STAGES[m.stage - 1]}`).join(' · ')}`
                      : !gps ? 'Waiting for the location fix…'
                        : !group?.ready ? 'Hold the phone steady; the photo is taken and read automatically.'
                          : group.needsReview ? 'Confirm the highlighted faces to continue.'
                            : group.reviewed && autoMembers.length ? `Ready to mark ${autoMembers.length} present.`
                          : 'Nobody due was recognised. Retake the photo.'}
                </p>
              )}
              {usePlain && groupPhoto && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="text-xs font-medium uppercase text-slate-500">Confirm who is in the photo ({chosen.length}/{members.length})</p>
                    <button type="button" className="btn-link text-xs" onClick={selectAll}>Select all</button>
                  </div>
                  <ul className="divide-y divide-line rounded-2xl ring-1 ring-slate-200" aria-label="Group attendance review">
                    {members.map((m) => (
                      <li key={m.employee_id}>
                        <label className="flex items-center gap-3 p-3 text-sm">
                          <input type="checkbox" className="h-5 w-5" checked={!!picked[m.employee_id]} onChange={(e) => toggle(m.employee_id, e.target.checked)} />
                          <span className="min-w-0 flex-1 truncate"><span className="font-medium">{m.name}</span><span className="text-slate-500"> · {m.emp_id}</span></span>
                          <StagePill stage={m.stage} />
                          <span className={`hidden w-36 shrink-0 text-right text-[11px] font-semibold sm:inline ${picked[m.employee_id] ? 'text-success' : 'text-slate-400'}`}>
                            {picked[m.employee_id] ? `Ready · ${sourceOf(m.employee_id)}` : 'Not marked'}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase text-slate-500">Staff with a stage due ({chosen.length}/{members.length} selected)</p>
                <button type="button" className="btn-link text-xs" onClick={selectAll}>Select all</button>
              </div>
              <ul className="space-y-2">
                {members.map((m) => (
                  <li key={m.employee_id} className="rounded-2xl p-3 ring-1 ring-slate-200">
                    <label className="flex items-center gap-3 text-sm">
                      <input type="checkbox" className="h-5 w-5" checked={!!picked[m.employee_id]} onChange={(e) => toggle(m.employee_id, e.target.checked)} />
                      <span className="min-w-0 flex-1 truncate"><span className="font-medium">{m.name}</span><span className="text-slate-500"> · {m.emp_id}</span></span>
                      <StagePill stage={m.stage} />
                    </label>
                    {picked[m.employee_id] && (
                      <div className="mt-2 space-y-2">
                        {liveOn && !photos[m.employee_id] ? (
                          <LiveFaceCapture name={m.name} onDone={(r) => { setLive((l) => ({ ...l, [m.employee_id]: r.liveness })); setPhotos((p) => ({ ...p, [m.employee_id]: r.photo })); }} />
                        ) : (
                          <PhotoCapture value={photos[m.employee_id]} required={photoRequired || faceOn}
                            stamp={stampLines({ ...gps, address })}
                            onChange={(v) => { setLive((l) => ({ ...l, [m.employee_id]: liveOn ? null : l[m.employee_id] })); setPhotos((p) => ({ ...p, [m.employee_id]: liveOn ? null : v })); }} />
                        )}
                        <MemberFaceCheck photo={photos[m.employee_id]} member={m} enabled={faceOn} threshold={threshold} onResult={onFace} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {gate.notice}
          {mode === 'photo' && !usePlain ? (
            <div className="flex justify-end gap-2 border-t border-line pt-3">
              <button type="button" className="btn-secondary" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
              {group?.reviewed && !done && (
                <button type="button" className="btn-primary" disabled={!photoReady || busy}
                  onClick={() => submit(null, autoMembers)}>
                  {`Mark ${autoMembers.length} present`}
                </button>
              )}
            </div>
          ) : (
            <SubmitBar busy={busy} disabled={!ready || done}
              label={chosen.length ? `Confirm attendance for ${chosen.length}` : 'Confirm attendance'}
              onCancel={onClose} />
          )}
        </form>
      )}
    </Dialog>
  );
}

// The five-stage grid of every allocated staff member (stage order and one record per stage are
// enforced by the local repository and the server).
function StageGrid({ journey: j, status }) {
  const { can } = useSession();
  const [target, setTarget] = useState(null);
  // Records captured offline aren't in the server's status yet: show them as pending locally.
  const [local, setLocal] = useState({});
  const [groupOpen, setGroupOpen] = useState(false);
  const submit = can('attendance.submit');

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] font-medium text-muted">
        <LegendDot state="taken">Taken</LegendDot>
        <LegendDot state="next">Capture now</LegendDot>
        <LegendDot state="pending">Saved on device</LegendDot>
        <LegendDot state="locked">Locked</LegendDot>
      </div>
      <DataState res={status} empty="No staff allocated to this journey.">
        {(rows) => (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
            {rows.map((s) => (
              <li key={s.employee_id} className="card px-3.5 pb-3 pt-3">
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-700 text-white"><UserSolidIcon className="h-4.5 w-4.5" /></span>
                  <p className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{s.emp_id} - {s.name}</p>
                  {s.completed && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success"><CheckIcon className="h-3 w-3" /> Complete</span>}
                </div>
                <div className="grid grid-cols-5">
                  {s.stages.map((c) => {
                    const pending = local[`${s.employee_id}:${c.stage}`] || c.status === 'pending';
                    const state = pending ? 'pending' : MARK[c.status] ? c.status : 'locked';
                    const clickable = submit && c.status === 'next' && !pending && j;
                    return (
                      <button key={c.stage} type="button" disabled={!clickable} onClick={() => setTarget({ staff: s, stage: c.stage })}
                        className="flex min-w-0 flex-col items-center gap-1.5 rounded-xl py-1 transition duration-150 enabled:hover:bg-camera/5 enabled:active:scale-90"
                        aria-label={`${s.name} stage ${c.stage} ${pending ? 'pending sync' : c.status}`} title={STAGES[c.stage - 1]}>
                        {MARK[state].node}
                        <span className={`text-[11px] font-semibold leading-none ${MARK[state].label}`}>{STAGE_LABEL[c.stage - 1]}</span>
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </DataState>
      {submit && j && (status.data ?? []).length > 1 && (
        <button type="button" className="btn-secondary mt-4 h-11 w-full sm:w-auto" onClick={() => setGroupOpen(true)}><UsersIcon /> Group attendance</button>
      )}
      {groupOpen && j && (
        <GroupDialog journey={j} rows={status.data ?? []} local={local} onClose={() => setGroupOpen(false)}
          onDone={(pending) => {
            setLocal((l) => ({ ...l, ...Object.fromEntries(pending.map(([id, stage]) => [`${id}:${stage}`, true])) }));
            setGroupOpen(false);
            status.reload();
          }} />
      )}
      {target && j && (
        <CaptureDialog target={target} journey={j} onClose={() => setTarget(null)}
          onDone={(outcome) => {
            if (savedLocally(outcome) && outcome.status !== 'synced') setLocal((l) => ({ ...l, [`${target.staff.employee_id}:${target.stage}`]: true }));
            setTarget(null);
            status.reload();
          }} />
      )}
    </>
  );
}

function AttendanceDetail({ record, staffName, onClose, onChanged }) {
  const { me, ops } = useSession();
  return (
    <Dialog open title={`${staffName(record.employee_id)} · ${STAGES[record.stage - 1]}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2"><SyncBadge status={record.sync_status} error={record.last_sync_error} />
          {record.verification_status && <Badge tone={STATE_TONE[record.verification_status]}>{label(record.verification_status)}</Badge>}</div>
        {record.origin === 'server' && !record.device_timestamp && (
          <p className="text-xs text-slate-500">Recorded on the server; its details are shown when online.</p>
        )}
        <DetailList items={[
          ['Stage', `${record.stage} · ${STAGES[record.stage - 1]}`],
          ['Captured (device)', record.device_timestamp ? fmtDateTime(record.device_timestamp) : null],
          ['Received (server)', record.server_timestamp ? fmtDateTime(record.server_timestamp) : null],
          ['GPS', gpsText(record)],
          ['Capture method', methodOf(record)],
          ['Group capture', record.group_submission_id ? `${record.group_submission_id.slice(0, 8)} (one photo, several staff)` : null],
          ['Recorded by', record.created_by_id ? staffName(record.created_by_id) : null],
          ['Review remarks', record.review_remarks],
        ]} />
        {record.photo_media_id && <MediaPreview id={record.photo_media_id} label="Attendance photo" />}
        <ReviewPanel record={record} allowed={canAct(me, 'attendance.review', record)}
          onReview={(status, remarks) => ops.attendance.review(record.id, status, remarks)} onDone={onChanged} />
      </div>
    </Dialog>
  );
}

// Journey-wise and staff-wise attendance records (GET /attendance), with evidence and review.
function AttendanceRecords({ journey: j }) {
  const [employee, setEmployee] = useState('');
  const [stage, setStage] = useState('');
  const [verification, setVerification] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [open, setOpen] = useState(null);
  const res = useResource('/attendance', {
    journey_id: j.id, employee_id: employee, stage, verification_status: verification, page: pageNo, page_size: 50,
  });
  const people = [...(j.supervisor_id ? [{ user_id: j.supervisor_id, name: j.supervisor_name }] : []), ...j.staff];
  const staffName = (id) => people.find((s) => s.user_id === id)?.name ?? 'Unknown user';
  const filter = (fn) => (v) => { fn(v); setPageNo(1); };

  return (
    <Panel title="Attendance records">
      <FilterBar>
        <Field label="Staff"><Select value={employee} onChange={filter(setEmployee)} placeholder="All staff" options={j.staff.filter((s) => !s.removed_at).map((s) => ({ value: s.user_id, label: s.name }))} /></Field>
        <Field label="Stage"><Select value={stage} onChange={filter(setStage)} placeholder="All stages" options={STAGES.map((n, i) => ({ value: String(i + 1), label: `${i + 1} · ${n}` }))} /></Field>
        <Field label="Verification"><Select value={verification} onChange={filter(setVerification)} placeholder="Any" options={VERIFICATION} /></Field>
      </FilterBar>
      <DataState res={res} empty="No attendance records match.">
        {(page) => (
          <>
            <Table rows={page.items} onRowClick={setOpen} columns={[
              { key: 'employee', label: 'Staff', render: (r) => staffName(r.employee_id) },
              { key: 'stage', label: 'Stage', render: (r) => STAGES[r.stage - 1] },
              { key: 'when', label: 'Captured', render: (r) => fmtDateTime(r.device_timestamp ?? r.server_timestamp) },
              { key: 'method', label: 'Method', render: (r) => methodOf(r) },
              { key: 'gps', label: 'GPS', render: (r) => (r.latitude != null ? 'Yes' : '—') },
              { key: 'status', label: 'Sync', render: (r) => <SyncState record={r} /> },
              { key: 'verification', label: 'Verification', render: (r) => (r.verification_status ? <Badge tone={STATE_TONE[r.verification_status]}>{label(r.verification_status)}</Badge> : '—') },
            ]} />
            <Pager data={page} onPage={setPageNo} />
          </>
        )}
      </DataState>
      {open && <AttendanceDetail record={open} staffName={staffName} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); res.reload(); }} />}
    </Panel>
  );
}

function JourneyAttendance({ id }) {
  const { can } = useSession();
  const journey = useResource(`/journeys/${id}`);
  const status = useResource(`/attendance/journeys/${id}/status`);
  const [tab, setTab] = useState('stages');

  if (journey.loading && !journey.data) return <Loading />;
  const j = journey.data;
  const tabs = [{ value: 'stages', label: 'Stages' }, ...(can('attendance.read') && j ? [{ value: 'records', label: 'Records' }] : [])];

  return (
    <>
      <PageHeader back={j ? `#/journeys/${j.id}` : '#/attendance'} title="Attendance" />
      {j && (
        <p className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-brand-900">
          <TrainSolidIcon className="h-4.5 w-4.5 text-brand-700" /><span className="truncate">{j.train_name} · {j.train_no}</span>
        </p>
      )}
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      {tab === 'records' && j ? <AttendanceRecords journey={j} /> : <StageGrid journey={j} status={status} />}
    </>
  );
}

export default function Attendance({ parts }) {
  if (parts[0]) return <JourneyAttendance id={parts[0]} key={parts[0]} />;
  return (
    <>
      <PageHeader title="Attendance" subtitle="GPS and photo verified staff attendance" />
      <JourneyPicker base="/attendance" />
    </>
  );
}
