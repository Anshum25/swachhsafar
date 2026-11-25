// Feedback question banks (backend: GET/POST /feedback/question-banks, POST /feedback/question-banks/{id}/activate).
// Banks are immutable versions: a change is made by saving a revised version and activating it, which
// retires the previously active bank of the same division (or default scope) and audience.
import { useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { Badge, DataState, Dialog, ErrorNote, Field, Panel, RatingFace, RatingScale, Select, SubmitBar, Table, label } from '../../../components/ui.jsx';
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

// Answer options, worst first. Each gets a face (frown → smile) and is shown grey until the passenger picks it.
function OptionsEditor({ options, errors, onChange }) {
  const [preview, setPreview] = useState(undefined);
  const set = (i, v) => onChange(options.map((o, k) => (k === i ? v : o)));
  return (
    <section className="rounded-2xl p-3 ring-1 ring-slate-200">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold">Answer options <span className="font-normal text-slate-500">(worst first)</span></span>
        <span className="flex gap-3 text-xs">
          <button type="button" className="btn-link" onClick={() => onChange([...DEFAULT_OPTIONS])}>Use standard 5</button>
          <button type="button" className="btn-link" disabled={options.length >= 10} onClick={() => onChange([...options, ''])}>Add option</button>
        </span>
      </div>
      <ol className="space-y-2">
        {options.map((o, i) => (
          <li key={i} className="flex items-center gap-2">
            <RatingFace k={i} n={options.length} selected className="h-8 w-8 shrink-0" />
            <input className="input h-10" value={o} maxLength={30} aria-label={`Answer option ${i + 1}`} onChange={(e) => set(i, e.target.value)} />
            <button type="button" className="btn-link text-red-600" disabled={options.length <= 2} onClick={() => onChange(options.filter((_, k) => k !== i))}
              aria-label={`Remove answer option ${i + 1}`}>Remove</button>
          </li>
        ))}
      </ol>
      {errors.option_labels && <p className="mt-1 text-xs text-red-600">{errors.option_labels}</p>}
      <p className="mb-1 mt-3 text-xs text-slate-500">Preview — tap a face to see it selected:</p>
      <RatingScale min={1} max={options.length} options={options.map((o, i) => o.trim() || `Option ${i + 1}`)} value={preview} onChange={setPreview} label="Preview" />
    </section>
  );
}

function BankForm({ source, divisionId, onClose, onSaved }) {
  const { api } = useSession();
  const [f, setF] = useState(() => fromBank(source));
  const [errors, setErrors] = useState({});
  const save = useSave(onSaved);
  const setQ = (i, q) => setF((x) => ({ ...x, questions: x.questions.map((old, k) => (k === i ? q : old)) }));
  const move = (i, d) => setF((x) => {
    const qs = [...x.questions];
    [qs[i], qs[i + d]] = [qs[i + d], qs[i]];
    return { ...x, questions: qs };
  });

  function submit(e) {
    e.preventDefault();
    const found = validateBank(f);
    setErrors(found);
    if (Object.keys(found).length) return;
    save.run(() => api.post('/feedback/question-banks', bankPayload(f, divisionId)), 'Question bank saved as an inactive version. Activate it to use it for new feedback.');
  }

  const general = errors.questions;
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <ErrorNote error={save.error} />
      {Object.keys(errors).length > 0 && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">Please fix the highlighted fields.</p>}
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

export default function QuestionBanks({ divisionId }) {
  const { api } = useSession();
  const [scope, setScope] = useState('division');
  const scopeDivision = scope === 'division' ? divisionId : null;
  const access = useMasterAccess('questionBanks', scopeDivision);
  const res = useResource(scope === 'division' && !divisionId ? null : '/feedback/question-banks', scope === 'division' ? { division_id: divisionId } : {});
  const [filter, setFilter] = useState({ q: '', status: '', audience: '' });
  const [view, setView] = useState(null);
  const [form, setForm] = useState(null); // { source } — null source = new bank
  const [activating, setActivating] = useState(null);
  const activate = useSave(() => { setActivating(null); res.reload(); });

  return (
    <Panel title="Feedback question banks" actions={access.canEdit && (
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
        {form && <BankForm source={form.source} divisionId={scopeDivision} onClose={() => setForm(null)} onSaved={() => { setForm(null); res.reload(); }} />}
      </Dialog>
      <ConfirmDialog open={!!activating} onClose={() => { setActivating(null); activate.setError(null); }} busy={activate.busy} error={activate.error}
        title="Activate question bank" confirmLabel="Activate"
        message={`"${activating?.name}" becomes the active ${activating?.audience} bank${scopeDivision ? ' for this division' : ' for divisions without their own bank'}. The currently active ${activating?.audience} bank of this scope is retired; feedback already collected keeps its answers.`}
        onConfirm={() => activate.run(() => api.post(`/feedback/question-banks/${activating.id}/activate`), `${activating.name} is now active.`)} />
    </Panel>
  );
}
