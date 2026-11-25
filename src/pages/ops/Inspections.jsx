import { useMemo, useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import JourneyPicker from '../../components/JourneyPicker.jsx';
import MediaPreview from '../../components/MediaPreview.jsx';
import ReviewPanel from '../../components/ReviewPanel.jsx';
import { GpsCapture, PhotoCapture, VideoCapture, mediaItem, outcomeToast, savedLocally } from '../../components/Capture.jsx';
import {
  Badge, DataState, DetailList, Dialog, Empty, ErrorNote, Field, FilterBar, Loading, PageHeader, Pager, Panel, STATE_TONE, Segmented, Select,
  StaleNote, SubmitBar, SyncBadge, SyncState, Table, Tabs, fmtDateTime, label,
} from '../../components/ui.jsx';
import { CheckBoldIcon, MessageIcon, TrainSolidIcon } from '../../components/Icons.jsx';
import { canAct } from '../../services/authorization.js';
import { deviceTimestamp } from '../../utils/capture.js';
import { COACH_CLASSES, classLabel } from '../../utils/coaches.js';
import { useSecurityGate } from '../../security/SecurityProvider.jsx';

const PHASES = { B: 'Before', A: 'After' };
const CLASSES = [{ value: '', label: 'All coaches' }, ...COACH_CLASSES];
const VERIFICATION = [{ value: 'pending', label: 'Pending review' }, { value: 'verified', label: 'Verified' }, { value: 'rejected', label: 'Rejected' }];

function InspectDialog({ target, journey, onClose, onDone }) {
  const { queue } = useSession();
  const notify = useNotify();
  const [gps, setGps] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [video, setVideo] = useState(null);
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);
  const gate = useSecurityGate('location');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const mediaId = crypto.randomUUID();
    const videoId = video ? crypto.randomUUID() : null;
    const outcome = await queue.submit({
      type: 'inspection.create',
      payload: {
        id: crypto.randomUUID(), journey_id: journey.id, coach_code: target.coach, day: target.day, round: target.round,
        phase: target.phase, comments: comments.trim() || null, device_timestamp: deviceTimestamp(), ...gps, photo_media_id: mediaId, video_media_id: videoId,
        ...gate.evidence(),
      },
      media: [
        { id: mediaId, division_id: journey.division_id, kind: 'inspection_photo', dataUrl: photo },
        ...(video ? [await mediaItem(video, { id: videoId, kind: 'inspection_video', divisionId: journey.division_id })] : []),
      ],
    });
    setBusy(false);
    outcomeToast(notify, outcome, 'Inspection');
    onDone(outcome);
  }

  return (
    <Dialog open title={`${target.coach} (${PHASES[target.phase]} Journey)`} onClose={onClose} onSubmit={submit}
      footer={<SubmitBar busy={busy} disabled={!gps || !photo || !gate.allowed} label="Save Now" icon={<CheckBoldIcon />} onCancel={onClose} flush />}>
      <div className="space-y-4">
        <p className="-mt-1 text-center text-xs font-medium text-muted">Day {target.day} · Round {target.round} · {journey.train_no}</p>
        <PhotoCapture value={photo} onChange={setPhoto} required />
        <Field label={<span className="inline-flex items-center gap-1.5 font-semibold text-ink"><MessageIcon className="h-4 w-4 text-ink" />Summary</span>}>
          <textarea className="input" rows={3} maxLength={2000} placeholder="Summary of the inspection: cleanliness, issues found, work done…" value={comments} onChange={(e) => setComments(e.target.value)} />
        </Field>
        <GpsCapture value={gps} onChange={setGps} />
        {gate.notice}
        <VideoCapture value={video} onChange={setVideo} />
      </div>
    </Dialog>
  );
}

// Coach × day × round × phase grid: one card per coach, a column per day, a B (before) and A (after) cell
// per round. Every cell of an open day can be inspected, in any order (photo + summary); each cell once,
// enforced by the local repository and by the server.
// Reference matrix: a plain letter for a slot that is done (green) or was missed (red), a solid blue tile for
// the slot that can be inspected now, amber for one saved on this device, grey for one not open yet.
const CELL_STYLE = {
  taken: 'text-success bg-success/10',
  pending: 'bg-amber-400 text-white',
  open: 'bg-brand-700 text-white shadow-[0_2px_6px_rgba(7,89,214,0.35)] hover:bg-brand-800 active:scale-90',
  missed: 'text-red-500',
  locked: 'text-slate-400',
};
const LEGEND = [['taken', 'Done'], ['open', 'Inspect now'], ['pending', 'Saved on device'], ['missed', 'Missed'], ['locked', 'Not open']];

function InspectionGrid({ journey: j, grid }) {
  const { can } = useSession();
  const [cls, setCls] = useState('');
  const [target, setTarget] = useState(null);
  const [local, setLocal] = useState({});

  const phases = [j.before_inspection_enabled && 'B', j.after_inspection_enabled && 'A'].filter(Boolean);
  const rounds = Array.from({ length: j.inspection_rounds_per_day }, (_, i) => i + 1);
  const classOf = (code) => j.coaches.find((c) => c.code === code)?.classification;
  const rows = useMemo(() => (grid.data ?? []).filter((c) => !cls || j.coaches.find((x) => x.code === c.coach_code)?.classification === cls), [grid.data, cls, j.coaches]);
  const byCoach = useMemo(() => {
    const m = new Map();
    for (const c of rows) m.set(c.coach_code, [...(m.get(c.coach_code) ?? []), c]);
    return [...m.entries()].map(([coach, days]) => [coach, days.sort((a, b) => a.day - b.day)]);
  }, [rows]);
  const done = rows.reduce((n, c) => n + c.done, 0);
  const required = rows.reduce((n, c) => n + c.required, 0);
  const openDay = (grid.data ?? []).find((c) => c.day_open)?.day;
  // A locked slot of a day that has passed (or of a finished journey) was missed, not merely not open yet.
  const finished = j.state === 'history' || j.state === 'cancelled';
  const missed = (day) => finished || (openDay != null && day < openDay);
  const classes = [...new Set(j.coaches.map((c) => c.classification))].length > 1;

  return (
    <>
      <StaleNote stale={grid.stale} />
      <div className="card mb-4 space-y-3 py-3.5">
        <div>
          <div className="flex justify-between text-[13px]"><span className="font-semibold text-ink">Completion{openDay ? ` · today is Day ${openDay}` : ''}</span><span className="font-semibold tabular-nums text-brand-700">{done}/{required}</span></div>
          <div className="mt-1.5 h-2 rounded-full bg-brand-100"><div className="h-2 rounded-full bg-brand-600 transition-[width] duration-500" style={{ width: `${required ? (done / required) * 100 : 0}%` }} /></div>
        </div>
        {classes && <Segmented label="Coach class" value={cls} onChange={setCls} options={CLASSES} />}
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-[11.5px] font-medium text-muted">
          {LEGEND.map(([k, t]) => (
            <span key={k} className="inline-flex items-center gap-1.5"><span className={`grid h-4.5 w-4.5 place-items-center rounded text-[10px] font-bold ${CELL_STYLE[k]}`}>A</span>{t}</span>
          ))}
        </div>
      </div>
      {byCoach.length === 0 ? <Empty title="No coaches to inspect." /> : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
          {byCoach.map(([coach, days]) => (
            <section key={coach} className="card px-3 pb-3 pt-2.5" aria-label={`Coach ${coach}`}>
              <div className="relative mb-2 text-center">
                <h3 className="text-[17px] font-extrabold text-brand-900">{coach}</h3>
                <span className="absolute right-0 top-1/2 -translate-y-1/2 rounded-full bg-canvas px-2 py-0.5 text-[11px] font-semibold text-muted">
                  {classLabel(classOf(coach))} · {days.reduce((n, d) => n + d.done, 0)}/{days.reduce((n, d) => n + d.required, 0)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <div className="grid min-w-full gap-x-1 gap-y-1.5" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(3.6rem, 1fr))` }}>
                  {days.map((d) => (
                    <p key={d.day} className={`text-center text-[12.5px] font-semibold ${d.day_open ? 'text-brand-700' : 'text-ink'}`}>Day {d.day}{d.day_open && <span className="ml-0.5 inline-block h-1.5 w-1.5 -translate-y-0.5 rounded-full bg-brand-600" />}</p>
                  ))}
                  {rounds.map((r) => days.map((d) => (
                    <div key={`${r}:${d.day}`} className="flex justify-center gap-1.5">
                      {phases.map((ph) => {
                        const cell = d.cells.find((x) => x.round === r && x.phase === ph);
                        const key = `${coach}:${d.day}:${r}:${ph}`;
                        const status = local[key] ? 'pending' : cell?.status ?? 'locked';
                        const look = status === 'locked' && missed(d.day) ? 'missed' : status;
                        const clickable = can('inspections.submit') && status === 'open';
                        return (
                          <button key={ph} type="button" disabled={!clickable}
                            onClick={() => setTarget({ coach, day: d.day, round: r, phase: ph, key })}
                            className={`grid h-[26px] w-[26px] place-items-center rounded-[5px] text-[13px] font-extrabold transition duration-150 ${CELL_STYLE[look]}`}
                            aria-label={`Coach ${coach} day ${d.day} round ${r} ${PHASES[ph]} ${status}`}
                            title={`Day ${d.day} · Round ${r} · ${PHASES[ph]} · ${status === 'pending' ? 'saved on device' : look}`}>
                            {ph}
                          </button>
                        );
                      })}
                    </div>
                  )))}
                </div>
              </div>
              {rounds.length > 1 && <p className="mt-2 text-center text-[11px] text-slate-400">One row per round (1–{rounds.length}) · B = before, A = after</p>}
            </section>
          ))}
        </div>
      )}
      {target && (
        <InspectDialog target={target} journey={j} onClose={() => setTarget(null)}
          onDone={(outcome) => {
            if (savedLocally(outcome) && outcome.status !== 'synced') setLocal((l) => ({ ...l, [target.key]: true }));
            setTarget(null);
            grid.reload();
          }} />
      )}
    </>
  );
}

function InspectionDetail({ record, journey, onClose, onChanged }) {
  const { me, ops } = useSession();
  const inspector = [...(journey.supervisor_id ? [{ user_id: journey.supervisor_id, name: journey.supervisor_name }] : []), ...journey.staff].find((s) => s.user_id === record.created_by_id)?.name;
  return (
    <Dialog open title={`Coach ${record.coach_code} · Day ${record.day} · R${record.round} · ${PHASES[record.phase]}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2"><SyncBadge status={record.sync_status} error={record.last_sync_error} />
          {record.coach_class && <Badge>{classLabel(record.coach_class)}</Badge>}</div>
        {record.origin === 'server' && !record.device_timestamp && <p className="text-xs text-slate-500">Recorded on the server; its details are shown when online.</p>}
        <DetailList items={[
          ['Captured (device)', record.device_timestamp ? fmtDateTime(record.device_timestamp) : null],
          ['Received (server)', record.server_timestamp ? fmtDateTime(record.server_timestamp) : null],
          ['GPS', record.latitude != null ? `${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}${record.gps_accuracy_m != null ? ` ±${Math.round(record.gps_accuracy_m)} m` : ''}` : null],
          ['Inspector', inspector ?? (record.created_by_id ? 'Other user' : null)],
          ['Summary', record.comments],
        ]} />
        <div className="grid gap-3 sm:grid-cols-2">
          {record.photo_media_id && <MediaPreview id={record.photo_media_id} label="Inspection photo" />}
          {record.video_media_id && <MediaPreview id={record.video_media_id} kind="video" label="Inspection video" />}
        </div>
        <ReviewPanel record={record} allowed={canAct(me, 'inspection.review', record)}
          onReview={(status, remarks) => ops.inspections.review(record.id, status, remarks)} onDone={onChanged} />
      </div>
    </Dialog>
  );
}

// Journey-wise and coach-wise inspection records (GET /inspections) and their review.
function InspectionRecords({ journey: j }) {
  const [coach, setCoach] = useState('');
  const [day, setDay] = useState('');
  const [phase, setPhase] = useState('');
  const [verification, setVerification] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [open, setOpen] = useState(null);
  const res = useResource('/inspections', {
    journey_id: j.id, coach_code: coach, day, phase, verification_status: verification, page: pageNo, page_size: 50,
  });
  const filter = (fn) => (v) => { fn(v); setPageNo(1); };
  return (
    <Panel title="Inspection records">
      <FilterBar>
        <Field label="Coach"><Select value={coach} onChange={filter(setCoach)} placeholder="All coaches" options={j.coaches.map((c) => ({ value: c.code, label: c.code }))} /></Field>
        <Field label="Day"><Select value={day} onChange={filter(setDay)} placeholder="All days" options={Array.from({ length: j.daywise ? j.operational_days : 1 }, (_, i) => ({ value: String(i + 1), label: `Day ${i + 1}` }))} /></Field>
        <Field label="Phase"><Select value={phase} onChange={filter(setPhase)} placeholder="Both" options={Object.entries(PHASES).map(([value, l]) => ({ value, label: l }))} /></Field>
        <Field label="Verification"><Select value={verification} onChange={filter(setVerification)} placeholder="Any" options={VERIFICATION} /></Field>
      </FilterBar>
      <DataState res={res} empty="No inspections match.">
        {(page) => (
          <>
            <Table rows={page.items} onRowClick={setOpen} columns={[
              { key: 'coach', label: 'Coach', render: (r) => <span className="font-semibold">{r.coach_code}</span> },
              { key: 'slot', label: 'Day · round · phase', render: (r) => `D${r.day} · R${r.round} · ${PHASES[r.phase]}` },
              { key: 'when', label: 'Captured', render: (r) => fmtDateTime(r.device_timestamp ?? r.server_timestamp) },
              { key: 'sync', label: 'Sync', render: (r) => <SyncState record={r} /> },
              { key: 'verification', label: 'Verification', render: (r) => (r.verification_status ? <Badge tone={STATE_TONE[r.verification_status]}>{label(r.verification_status)}</Badge> : '—') },
            ]} />
            <Pager data={page} onPage={setPageNo} />
          </>
        )}
      </DataState>
      {open && <InspectionDetail record={open} journey={j} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); res.reload(); }} />}
    </Panel>
  );
}

function JourneyInspection({ id }) {
  const { can } = useSession();
  const journey = useResource(`/journeys/${id}`);
  const grid = useResource(`/inspections/journeys/${id}/status`);
  const [tab, setTab] = useState('grid');
  const j = journey.data;

  if ((journey.loading && !j) || (grid.loading && !grid.data)) return <Loading />;
  if (!j || !grid.data) return <ErrorNote error={journey.error ?? grid.error} onRetry={() => { journey.reload(); grid.reload(); }} />;
  const tabs = [{ value: 'grid', label: 'Inspect' }, ...(can('inspections.read') ? [{ value: 'records', label: 'Records' }] : [])];

  return (
    <>
      <PageHeader back={`#/journeys/${j.id}`} title="Inspection" />
      <p className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-brand-900">
        <TrainSolidIcon className="h-4.5 w-4.5 text-brand-700" /><span className="truncate">{j.train_name} · {j.train_no}</span>
      </p>
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      {tab === 'records' ? <InspectionRecords journey={j} /> : <InspectionGrid journey={j} grid={grid} />}
    </>
  );
}

export default function Inspections({ parts }) {
  if (parts[0]) return <JourneyInspection id={parts[0]} key={parts[0]} />;
  return (
    <>
      <PageHeader title="Inspection" subtitle="Day-wise photo inspections: any round, before or after, in any order" />
      <JourneyPicker base="/inspections" />
    </>
  );
}
