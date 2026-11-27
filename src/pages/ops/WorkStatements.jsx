// The railway's work-statement reports: Inspection list, PSI work statement, Attendance summary and Journey
// report, each for a period and (optionally) one train. Every report is built once as a grid
// (src/utils/exporters.js) that is shown on screen and downloaded as Excel (.xlsx) or PDF, unchanged.
import { useState } from 'react';
import { useResource } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import MediaPreview from '../../components/MediaPreview.jsx';
import { Badge, DataState, Dialog, Field, Select, label } from '../../components/ui.jsx';
import { cellOf, exportGrid, place } from '../../utils/exporters.js';

// ---- formatting ------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parts = (d) => (d ? String(d).slice(0, 10).split('-') : null);
export const dmy = (d) => {
  const p = parts(d);
  return p ? `${p[2]}-${p[1]}-${p[0]}` : '—';
};
export const dMonY = (d) => {
  const p = parts(d);
  return p ? `${p[2]}-${MONTHS[Number(p[1]) - 1]}-${p[0]}` : '—';
};
const two = (n) => String(n).padStart(2, '0');
export const stamp = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()} : ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};
const fixed = (v) => (v == null ? '—' : Number(v).toFixed(2));
const pair = (a, b) => `${a} | ${b ?? '—'}`;
const trainTitle = (data, fallback = 'ALL TRAINS') => (data.train ? `${data.train.train_no} (${data.train.name})` : fallback);
const period = (q) => `${dmy(q.date_from)} to ${dmy(q.date_to)}`;

// ---- shared pieces ---------------------------------------------------------------------------------------

export function ExportButtons({ grid, name, disabled }) {
  const notify = useNotify();
  const [busy, setBusy] = useState(null);
  const run = async (kind) => {
    setBusy(kind);
    try {
      notify('success', await exportGrid(grid(), kind, name));
    } catch (e) {
      notify('error', `Could not create the ${kind === 'pdf' ? 'PDF' : 'Excel file'}: ${e.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" disabled={disabled || !!busy} onClick={() => run('xlsx')}>
        {busy === 'xlsx' ? 'Preparing…' : 'Excel'}
      </button>
      <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" disabled={disabled || !!busy} onClick={() => run('pdf')}>
        {busy === 'pdf' ? 'Preparing…' : 'PDF'}
      </button>
    </div>
  );
}

const TONE_CLASS = { bad: 'text-red-600 bg-red-50', mark: 'bg-yellow-100' };

// Draws a grid as an HTML table, spans included.
export function GridTable({ grid }) {
  const row = (cells, head) => cells.map((raw, i) => {
    const c = cellOf(raw);
    const Tag = head ? 'th' : 'td';
    return (
      <Tag key={i} rowSpan={c.rowSpan} colSpan={c.colSpan}
        className={`border border-slate-300 px-2 py-1 align-middle ${head ? 'bg-slate-100 text-center font-semibold' : ''} ${TONE_CLASS[c.tone] ?? ''}`}>
        {c.render ?? c.content ?? ''}
      </Tag>
    );
  });
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
      <table className="min-w-full border-collapse text-xs text-slate-800">
        <thead>{grid.head.map((r, i) => <tr key={i}>{row(r, true)}</tr>)}</thead>
        <tbody>{grid.body.map((r, i) => <tr key={i}>{row(r, false)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function TrainPicker({ divisionId, value, onChange }) {
  const res = useResource('/trains', { ...(divisionId ? { division_id: divisionId } : {}), page_size: 200 });
  const trains = res.data?.items ?? [];
  return (
    <Field label="Train">
      <Select value={value} onChange={onChange} placeholder={res.loading ? 'Loading trains…' : 'All trains'}
        options={[...trains].sort((a, b) => a.train_no.localeCompare(b.train_no)).map((t) => ({ value: t.id, label: `${t.train_no} - ${t.name}` }))} />
    </Field>
  );
}

function Header({ title, children }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {children}
    </div>
  );
}

// ---- grids -----------------------------------------------------------------------------------------------

export function inspectionGrid(data, q) {
  return {
    title: `INSPECTIONS LIST FOR ${trainTitle(data)} — ${period(q)}`,
    sheet: 'Inspections',
    head: [['Sr', 'Time', 'Train No', 'Coach', 'B_A', 'Day / Round', 'Comments', 'Inspector', 'Status', 'Image / Video']],
    body: data.items.map((r, i) => [
      i + 1, stamp(r.at), r.train_no, r.coach_code, r.phase, `D${r.day} / R${r.round}`, r.comments ?? '', r.inspector ?? '',
      { content: label(r.verification_status), tone: r.verification_status === 'rejected' ? 'bad' : undefined },
      [r.photo_media_id && 'Photo', r.video_media_id && 'Video'].filter(Boolean).join(' + ') || '—',
    ]),
  };
}

export function psiGrid(data, q) {
  const dirs = data.directions;
  const head = [
    [{ content: 'Date', rowSpan: 2 }, { content: 'Train No', rowSpan: 2 }, 'AC', 'NAC',
      { content: 'Target Janitor deploy for each trip (Except EHK)', rowSpan: 2 }, { content: 'No of Coaches', rowSpan: 2 },
      { content: 'Coach No', rowSpan: 2 }, { content: 'PSI %', colSpan: dirs.length }, { content: 'Avg of PSI', rowSpan: 2 }],
    [{ content: 'Total No of Coaches', colSpan: 2 }, ...dirs],
  ];
  const body = [];
  for (const j of data.journeys) {
    const n = Math.max(1, j.coaches.length);
    const lead = [{ content: dMonY(j.journey_date), rowSpan: n }, { content: j.train, rowSpan: n }, { content: j.ac, rowSpan: n },
      { content: j.nac, rowSpan: n }, { content: j.target_janitors, rowSpan: n }];
    if (!j.coaches.length) {
      body.push([...lead, { content: 'No coaches on this journey', colSpan: 3 + dirs.length }]);
      continue;
    }
    j.coaches.forEach((c, i) => body.push([...(i ? [] : lead), c.sr, c.coach_code, ...dirs.map((d) => fixed(c.psi[d])),
      c.average == null ? '—' : Number(c.average.toFixed(2))]));
  }
  const names = data.journeys[0] ? `${data.journeys[0].train} (${data.journeys[0].train_name})` : trainTitle(data);
  return { title: `WORK STATEMENT FOR THE PERIOD ${dMonY(q.date_from)} to ${dMonY(q.date_to)} FOR TRAIN NO- ${data.train ? names : 'ALL TRAINS'}`,
    sheet: 'PSI', head, body };
}

export function attendanceGrid(data, q) {
  const lists = data.journeys.map((j) => j.stages.map((s) => s.label));
  const same = lists.every((l) => l.join('|') === lists[0]?.join('|'));
  const width = Math.max(0, ...lists.map((l) => l.length));
  const stageHead = same && lists[0] ? lists[0] : Array.from({ length: width }, (_, i) => `Stage ${i + 1}`);
  const head = [['Date', 'Train No', 'Days', 'Target Janitor deploy for each trip (With EHK)', 'Present', 'Coach No', 'Name', ...stageHead]];
  const body = [];
  for (const j of data.journeys) {
    const n = Math.max(1, j.staff.length);
    const lead = [{ content: dMonY(j.journey_date), rowSpan: n }, { content: j.train, rowSpan: n }, { content: j.days, rowSpan: n },
      { content: j.target, rowSpan: n }, { content: j.present, rowSpan: n }];
    if (!j.staff.length) {
      body.push([...lead, { content: 'No staff allocated', colSpan: 2 + width }]);
      continue;
    }
    j.staff.forEach((s, i) => {
      const marks = Array.from({ length: width }, (_, k) => (k < s.stages.length
        ? (s.stages[k] ? 'Yes' : { content: 'No', tone: 'bad' }) : '—'));
      const tone = s.slot === 'EHK' ? undefined : 'mark';
      body.push([...(i ? [] : lead), { content: s.slot, tone }, { content: `${s.name} (${s.emp_id})`, tone }, ...marks]);
    });
  }
  return { title: `ATTENDANCE SUMMARY FOR THE PERIOD ${dMonY(q.date_from)} to ${dMonY(q.date_to)} FOR TRAIN NO- ${trainTitle(data)}`,
    subtitle: same ? undefined : 'Journeys in this period have different attendance stations: columns are stage numbers in route order.',
    sheet: 'Attendance', head, body };
}

export function journeyGrid(data, q, onOpen) {
  // On screen each figure is a link to the detailed report for that journey's train and dates.
  const link = (j, kind, text) => (onOpen && j.train_id ? {
    content: text,
    render: <button type="button" className="font-semibold text-brand-700 underline-offset-2 hover:underline"
      onClick={() => onOpen(kind, { trainId: j.train_id, from: j.journey_date, to: j.end_date })}>{text}</button>,
  } : text);
  return {
    title: `JOURNEY REPORT FOR ${trainTitle(data)} — ${period(q)}`,
    subtitle: 'Each pair is done | expected (feedback: counted | Train Master target).',
    sheet: 'Journeys',
    head: [['Sr.no', 'Train', 'AC/Non AC', 'Date', 'Staff', 'Attendance', 'Feedback', 'Inspections']],
    body: data.journeys.map((j) => [j.sr, j.train, pair(j.ac, j.nac), `${dmy(j.journey_date)} to ${dmy(j.end_date)}`, j.staff,
      link(j, 'attendance-summary', pair(j.attendance_done, j.attendance_expected)),
      link(j, 'psi-statement', pair(j.feedback_done, j.feedback_target)),
      link(j, 'inspection-list', pair(j.inspections_done, j.inspections_required))]),
  };
}

// A plain list report (the existing summary tabs) as a grid.
export function listGrid(title, columns, rows) {
  return {
    title, sheet: 'Report',
    head: [columns.map((c) => c.label)],
    body: rows.map((r) => columns.map((c) => {
      const v = c.value ? c.value(r) : r[c.key];
      return v == null ? '' : typeof v === 'object' ? String(v) : v;
    })),
  };
}

// ---- inspection list (with the photo / video viewer) -------------------------------------------------------

function InspectionList({ data, q, name }) {
  const [open, setOpen] = useState(null);
  const grid = () => inspectionGrid(data, q);
  return (
    <>
      <Header title={`${data.items.length} inspection(s) — ${trainTitle(data)}`}><ExportButtons grid={grid} name={name} /></Header>
      {data.truncated && <p className="mb-2 text-xs text-amber-700">Showing the newest {data.items.length}; choose a train or a shorter period to see all.</p>}
      <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
        <table className="min-w-full text-left text-xs text-slate-800">
          <thead className="bg-slate-50 text-slate-600">
            <tr>{['Sr', 'Time', 'Train No', 'Coach', 'B_A', 'Day / Round', 'Comments', 'Inspector', 'Status', 'Image / Video']
              .map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.items.map((r, i) => (
              <tr key={r.id}>
                <td className="px-3 py-2">{i + 1}</td>
                <td className="whitespace-nowrap px-3 py-2">{stamp(r.at)}</td>
                <td className="px-3 py-2">{r.train_no}</td>
                <td className="px-3 py-2">{r.coach_code}</td>
                <td className="px-3 py-2">{r.phase}</td>
                <td className="whitespace-nowrap px-3 py-2">D{r.day} / R{r.round}</td>
                <td className="max-w-xs px-3 py-2">{r.comments ?? ''}</td>
                <td className="px-3 py-2">{r.inspector}</td>
                <td className="px-3 py-2"><Badge tone={r.verification_status === 'rejected' ? 'red' : r.verification_status === 'verified' ? 'green' : 'slate'}>{label(r.verification_status)}</Badge></td>
                <td className="whitespace-nowrap px-3 py-2">
                  {r.photo_media_id || r.video_media_id
                    ? <button type="button" className="btn-link text-xs" onClick={() => setOpen(r)}>View {r.video_media_id ? (r.photo_media_id ? 'photo + video' : 'video') : 'photo'}</button>
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={!!open} title={open ? `Coach ${open.coach_code} · ${open.phase === 'B' ? 'Before' : 'After'} · ${stamp(open.at)}` : ''} onClose={() => setOpen(null)}>
        {open && (
          <div className="space-y-3">
            {open.photo_media_id && <MediaPreview id={open.photo_media_id} label="Inspection photo" />}
            {open.video_media_id && <MediaPreview id={open.video_media_id} kind="video" label="Inspection video" />}
            {open.comments && <p className="text-sm text-slate-700">{open.comments}</p>}
          </div>
        )}
      </Dialog>
    </>
  );
}

// ---- the four reports ------------------------------------------------------------------------------------

const STATEMENTS = {
  'inspection-list': { path: '/reports/inspection-list', empty: 'No inspections in this period.', isEmpty: (d) => !d.items.length, grid: inspectionGrid },
  'psi-statement': { path: '/reports/psi-statement', empty: 'No journeys in this period.', isEmpty: (d) => !d.journeys.length, grid: psiGrid },
  'attendance-summary': { path: '/reports/attendance-summary', empty: 'No journeys in this period.', isEmpty: (d) => !d.journeys.length, grid: attendanceGrid },
  'journey-report': { path: '/reports/journey-report', empty: 'No journeys in this period.', isEmpty: (d) => !d.journeys.length, grid: journeyGrid },
};
export const STATEMENT_TABS = Object.keys(STATEMENTS);

export function WorkStatement({ kind, q, initialTrain = '', onOpen }) {
  const [trainId, setTrainId] = useState(initialTrain);
  const spec = STATEMENTS[kind];
  const query = { date_from: q.date_from, date_to: q.date_to, ...(q.division_id ? { division_id: q.division_id } : {}), ...(trainId ? { train_id: trainId } : {}) };
  const res = useResource(spec.path, query);
  const name = (data) => `swachh-safar-${kind}-${data.train?.train_no ?? 'all-trains'}-${q.date_from}-to-${q.date_to}`;
  return (
    <>
      <div className="mb-3 sm:max-w-sm"><TrainPicker divisionId={q.division_id} value={trainId} onChange={setTrainId} /></div>
      <DataState res={{ ...res, stale: false }} isEmpty={spec.isEmpty} empty={spec.empty}>
        {(data) => {
          if (kind === 'inspection-list') return <InspectionList data={data} q={q} name={name(data)} />;
          const grid = spec.grid(data, q, onOpen);
          return (
            <>
              <Header title={grid.title}><ExportButtons grid={() => grid} name={name(data)} /></Header>
              {res.cachedAt && <p className="mb-2 text-xs text-amber-700">Offline — report as last loaded on this device.</p>}
              {grid.subtitle && <p className="mb-2 text-xs text-slate-500">{grid.subtitle}</p>}
              <GridTable grid={grid} />
            </>
          );
        }}
      </DataState>
    </>
  );
}

// Used by tests: the column positions a grid resolves to.
export const _place = place;
