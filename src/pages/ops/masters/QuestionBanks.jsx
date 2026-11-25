// Feedback question banks (backend: GET/POST /feedback/question-banks, POST /feedback/question-banks/{id}/activate).
// Banks are immutable versions: a change is made by saving a revised version and activating it, which
// retires the previously active bank of the same division (or default scope) and audience.
import { useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { divisionLabel } from '../../../app/division.jsx';
import { canManageMaster } from '../../../services/authorization.js';
import { Badge, DataState, Dialog, ErrorNote, Field, Panel, Select, SubmitBar, Table, label } from '../../../components/ui.jsx';
import { PlusIcon } from '../../../components/Icons.jsx';
import { bankPayload, validateBank } from '../../../utils/masterValidation.js';
import { ActiveBadge, ConfirmDialog, FilterBar, OfflineWriteNote, matches, useMasterAccess, useSave } from './common.jsx';

const AUDIENCES = [{ value: 'passenger', label: 'Passenger' }, { value: 'railway', label: 'Railway official' }];
const blankQuestion = () => ({ text_en: '', text_hi: '', applies_ac: true, applies_non_ac: true, applies_gen: true, required: true, psi_weight: '' });

export const DEFAULT_OPTIONS = ['Poor', 'Average', 'Good', 'Very Good', 'Excellent'];

// Answer labels of an existing bank; a numbered 1–5 bank gets the standard labels, other numbered ones their numbers.
function optionsOf(bank) {
  if (bank.option_labels?.length) return [...bank.option_labels];
  if (bank.scale_min === 1 && bank.scale_max === 5) return [...DEFAULT_OPTIONS];
  return Array.from({ length: bank.scale_max - bank.scale_min + 1 }, (_, i) => String(bank.scale_min + i));
}

function fromBank(bank) {
  if (!bank) return { name: '', audience: 'passenger', option_labels: [...DEFAULT_OPTIONS], questions: [blankQuestion()] };
  return {
    name: `${bank.name} (revised)`.slice(0, 100), audience: bank.audience, option_labels: optionsOf(bank),
    questions: bank.questions.map((q) => ({ ...q, text_hi: q.text_hi ?? '', psi_weight: q.psi_weight ?? '' })),
  };
}

function QuestionEditor({ q, i, count, errors, onChange, onMove, onRemove }) {
  const set = (k) => (e) => onChange({ ...q, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const err = (k) => errors[`q${i}.${k}`];
  return (
    <li className="rounded-2xl p-3 ring-1 ring-slate-200" data-testid="question-row">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold">Question {i + 1}</span>
        <span className="flex gap-1 text-xs">
          <button type="button" className="btn-link" disabled={i === 0} onClick={() => onMove(i, -1)} aria-label={`Move question ${i + 1} up`}>Up</button>
          <button type="button" className="btn-link" disabled={i === count - 1} onClick={() => onMove(i, 1)} aria-label={`Move question ${i + 1} down`}>Down</button>
          <button type="button" className="btn-link text-red-600" disabled={count === 1} onClick={() => onRemove(i)} aria-label={`Remove question ${i + 1}`}>Remove</button>
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={`Question ${i + 1} (English)`} error={err('text_en')}><input className="input" value={q.text_en} onChange={set('text_en')} /></Field>
        <Field label={`Question ${i + 1} (Hindi, optional)`} error={err('text_hi')}><input className="input" value={q.text_hi} onChange={set('text_hi')} /></Field>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={q.applies_ac} onChange={set('applies_ac')} /> AC coaches</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={q.applies_non_ac} onChange={set('applies_non_ac')} /> Non-AC coaches</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={q.applies_gen ?? q.applies_non_ac} onChange={set('applies_gen')} /> General coaches</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={q.required} onChange={set('required')} /> Mandatory</label>
        <label className="flex items-center gap-2">PSI weight
          <input className="input h-9 w-24" inputMode="decimal" aria-label={`Question ${i + 1} PSI weight`} value={q.psi_weight} onChange={set('psi_weight')} />
        </label>
      </div>
      {(err('applies') || err('psi_weight')) && <p className="mt-1 text-xs text-red-600">{err('applies') ?? err('psi_weight')}</p>}
    </li>
  );
}

// Where a bank applies, chosen in the form: every office (a default bank, Super Admin only) or one station
// (division) of one office. Only stations this person may manage question banks for are offered.
function BankScope({ division, me, value, onChange, error }) {
  const canDefault = canManageMaster(me, 'questionBanks', null);
  const stations = division.divisions.filter((d) => canManageMaster(me, 'questionBanks', d.id));
  const offices = division.clients.filter((c) => stations.some((d) => d.client_id === c.id));
  const officeOf = (id) => stations.find((d) => d.id === id)?.client_id ?? '';
  const [office, setOffice] = useState(() => officeOf(value) || offices[0]?.id || '');
  const officeStations = offices.length ? stations.filter((d) => d.client_id === office) : stations;
  const pickOffice = (cid) => {
    setOffice(cid);
    onChange(stations.find((d) => d.client_id === cid)?.id ?? '');
  };
  const all = value === null;
  return (
    <fieldset className="rounded-2xl p-3 ring-1 ring-slate-200">
      <legend className="px-1 text-sm font-semibold">Applies to</legend>
      {canDefault && (
        <div className="mb-2 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="bank-scope" checked={!all} onChange={() => onChange(officeStations[0]?.id ?? stations[0]?.id ?? '')} /> One office and station</label>
          <label className="flex items-center gap-2"><input type="radio" name="bank-scope" checked={all} onChange={() => onChange(null)} /> All offices (default bank)</label>
        </div>
      )}
      {all ? (
        <p className="text-xs text-slate-500">Used by every station that has no active bank of its own for this audience.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {offices.length > 0 && (
            <Field label="Office"><Select value={office} onChange={pickOffice} aria-label="Bank office"
              options={offices.map((c) => ({ value: c.id, label: c.name }))} /></Field>
          )}
          <Field label="Station" error={error}><Select value={value ?? ''} onChange={onChange} aria-label="Bank station"
            options={[{ value: '', label: 'Choose a station' }, ...officeStations.map((d) => ({ value: d.id, label: d.code ? `${d.code} — ${d.name}` : d.name }))]} /></Field>
        </div>
      )}
    </fieldset>
  );
}

function BankForm({ source, divisionId, division, onClose, onSaved }) {
  const { api, me } = useSession();
  const [f, setF] = useState(() => fromBank(source));
  // A new version stays where its bank applies; a new bank starts where the page is looking.
  const [where, setWhere] = useState(() => {
    const start = source ? source.division_id ?? null : divisionId ?? null;
    if (start !== null || canManageMaster(me, 'questionBanks', null)) return start;
    return division.divisions.find((d) => canManageMaster(me, 'questionBanks', d.id))?.id ?? '';
  });
  const [errors, setErrors] = useState({});
  const save = useSave(() => onSaved(where));
  const setQ = (i, q) => setF((x) => ({ ...x, questions: x.questions.map((old, k) => (k === i ? q : old)) }));
  const move = (i, d) => setF((x) => {
    const qs = [...x.questions];
    [qs[i], qs[i + d]] = [qs[i + d], qs[i]];
    return { ...x, questions: qs };
  });

  function submit(e) {
    e.preventDefault();
    const found = validateBank(f);
    if (where === '') found.where = 'Choose the station this bank is for';
    setErrors(found);
    if (Object.keys(found).length) return;
    const station = division.divisions.find((d) => d.id === where);
    const place = where === null ? 'for all offices' : `for ${station ? divisionLabel(division, station) : 'the station'}`;
    save.run(() => api.post('/feedback/question-banks', bankPayload(f, where)),
      `Question bank saved as an inactive version ${place}. Activate it to use it for new feedback.`);
  }

  const general = errors.questions;
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <ErrorNote error={save.error} />
      {Object.keys(errors).length > 0 && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">Please fix the highlighted fields.</p>}
      <BankScope division={division} me={me} value={where} onChange={setWhere} error={errors.where} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bank name" error={errors.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Audience" error={errors.audience}><Select value={f.audience} onChange={(v) => setF({ ...f, audience: v })} options={AUDIENCES} /></Field>
      </div>
      <OptionsEditor options={f.option_labels} errors={errors} onChange={(option_labels) => setF((x) => ({ ...x, option_labels }))} />
      <p className="text-xs text-slate-500">Every question is answered by picking one of these options. Questions are shown in this order.</p>
      {general && <p className="text-xs text-red-600">{general}</p>}
      <ol className="space-y-2">
        {f.questions.map((q, i) => (
          <QuestionEditor key={i} q={q} i={i} count={f.questions.length} errors={errors} onChange={(nq) => setQ(i, nq)} onMove={move}
            onRemove={(k) => setF((x) => ({ ...x, questions: x.questions.filter((_, j) => j !== k) }))} />
        ))}
      </ol>
      <button type="button" className="btn-secondary" disabled={f.questions.length >= 20} onClick={() => setF((x) => ({ ...x, questions: [...x.questions, blankQuestion()] }))}>
        <PlusIcon /> Add question
      </button>
      <SubmitBar busy={save.busy} label="Save new version" onCancel={onClose} />
    </form>
  );
}

function BankQuestions({ bank }) {
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <ActiveBadge active={bank.is_active} />
        <Badge>{label(bank.audience)}</Badge>
        <Badge>{bank.option_labels?.length ? bank.option_labels.join(' · ') : `Rating ${bank.scale_min}–${bank.scale_max}`}</Badge>
        <Badge>{bank.division_id ? 'Division bank' : 'Default bank (all divisions)'}</Badge>
      </div>
      <Table rows={bank.questions} columns={[
        { key: 'position', label: '#' },
        { key: 'text', label: 'Question', render: (q) => <>{q.text_en}{q.text_hi && <span className="block text-xs text-slate-500">{q.text_hi}</span>}</> },
        { key: 'applies', label: 'Coaches', render: (q) => [q.applies_ac && 'AC', q.applies_non_ac && 'Non-AC', (q.applies_gen ?? q.applies_non_ac) && 'General'].filter(Boolean).join(', ') },
        { key: 'required', label: 'Mandatory', render: (q) => (q.required ? 'Yes' : 'No') },
        { key: 'psi_weight', label: 'PSI weight', render: (q) => q.psi_weight ?? '—' },
      ]} />
    </>
  );
}

export default function QuestionBanks({ division }) {
  const { api, me } = useSession();
  const divisionId = division.divisionId;
  const [scope, setScope] = useState('division');
  const scopeDivision = scope === 'division' ? divisionId : null;
  const access = useMasterAccess('questionBanks', scopeDivision);
  // A new bank can go to any station this person manages, not only the one in view.
  const canCreate = access.online && (canManageMaster(me, 'questionBanks', null)
    || division.divisions.some((d) => canManageMaster(me, 'questionBanks', d.id)));
  // After saving, show the list the bank went into.
  const showSaved = (where) => {
    setForm(null);
    if (where === null) {
      if (scope === 'default') res.reload();
      setScope('default');
      return;
    }
    const station = division.divisions.find((d) => d.id === where);
    if (where === divisionId && scope === 'division') res.reload();
    if (station && station.client_id && station.client_id !== division.current?.client_id && division.clients.length) division.setClientId(station.client_id);
    division.setDivisionId(where);
    setScope('division');
  };
  const res = useResource(scope === 'division' && !divisionId ? null : '/feedback/question-banks', scope === 'division' ? { division_id: divisionId } : {});
  const [filter, setFilter] = useState({ q: '', status: '', audience: '' });
  const [view, setView] = useState(null);
  const [form, setForm] = useState(null); // { source } — null source = new bank
  const [activating, setActivating] = useState(null);
  const activate = useSave(() => { setActivating(null); res.reload(); });

  return (
    <Panel title="Feedback question banks" actions={canCreate && (
      <button type="button" className="btn-secondary" onClick={() => setForm({ source: null })}><PlusIcon /> New bank</button>
    )}>
      <OfflineWriteNote access={access} />
      <FilterBar filter={filter} setFilter={setFilter} placeholder="Search bank name or question text">
        <div className="w-44"><Select value={filter.audience} onChange={(v) => setFilter((f) => ({ ...f, audience: v }))} aria-label="Audience filter"
          options={[{ value: '', label: 'All audiences' }, ...AUDIENCES]} /></div>
        <div className="w-52"><Select value={scope} onChange={setScope} aria-label="Bank scope"
          options={[{ value: 'division', label: 'This division' }, { value: 'default', label: 'Default (all divisions)' }]} /></div>
      </FilterBar>
      <DataState res={res} empty={scope === 'division' ? 'This division has no question banks of its own; feedback uses the default banks.' : 'No default question banks.'}>
        {(rows) => {
          const shown = rows.filter((b) => (!filter.audience || b.audience === filter.audience)
            && matches(b, filter, [(x) => x.name, (x) => x.questions.map((q) => `${q.text_en} ${q.text_hi ?? ''}`).join(' ')]));
          if (!shown.length) return <p className="py-6 text-center text-sm text-slate-500">No question banks match the filters.</p>;
          return (
            <Table rows={shown} onRowClick={setView} columns={[
              { key: 'name', label: 'Bank', render: (b) => <span className="font-medium">{b.name}</span> },
              { key: 'audience', label: 'Audience', render: (b) => label(b.audience) },
              { key: 'scale', label: 'Answers', render: (b) => (b.option_labels?.length ? `${b.option_labels.length} options` : `${b.scale_min}–${b.scale_max}`) },
              { key: 'questions', label: 'Questions', render: (b) => b.questions.length },
              { key: 'is_active', label: 'Status', render: (b) => <ActiveBadge active={b.is_active} /> },
              { key: 'actions', label: '', render: (b) => access.canEdit && (
                <span className="flex gap-3" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="btn-link" onClick={() => setForm({ source: b })}>New version</button>
                  {!b.is_active && <button type="button" className="btn-link" onClick={() => setActivating(b)}>Activate</button>}
                </span>
              ) },
            ]} />
          );
        }}
      </DataState>
      <Dialog open={!!view} title={view?.name ?? ''} onClose={() => setView(null)} wide>{view && <BankQuestions bank={view} />}</Dialog>
      <Dialog open={!!form} title={form?.source ? 'New version of question bank' : 'New question bank'} onClose={() => setForm(null)} wide>
        {form && <BankForm source={form.source} divisionId={scopeDivision} division={division} onClose={() => setForm(null)} onSaved={showSaved} />}
      </Dialog>
      <ConfirmDialog open={!!activating} onClose={() => { setActivating(null); activate.setError(null); }} busy={activate.busy} error={activate.error}
        title="Activate question bank" confirmLabel="Activate"
        message={`"${activating?.name}" becomes the active ${activating?.audience} bank${scopeDivision ? ' for this division' : ' for divisions without their own bank'}. The currently active ${activating?.audience} bank of this scope is retired; feedback already collected keeps its answers.`}
        onConfirm={() => activate.run(() => api.post(`/feedback/question-banks/${activating.id}/activate`), `${activating.name} is now active.`)} />
    </Panel>
  );
}
