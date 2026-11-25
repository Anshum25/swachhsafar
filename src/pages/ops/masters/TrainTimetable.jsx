// Train Master: the passenger feedback settings of a train, and its timetable in both directions as read
// from RailRadar (GET /trains/{id}/timetable, POST /trains/{id}/timetable/refresh). Each direction is its
// own train's timetable; the return is never the outbound reversed.
import { useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { useNotify } from '../../../app/Layout.jsx';
import { Badge, DataState, ErrorNote, Field, fmtDateTime, label } from '../../../components/ui.jsx';
import { Spinner } from '../../../components/Icons.jsx';
import { useNetworkStatus } from '../../../hooks/useNetworkStatus.js';

export const SCHEDULE_TONE = { ok: 'green', failed: 'red', rejected: 'amber' };
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export function ScheduleBadge({ train }) {
  const s = train.schedule_status;
  if (!s) return <Badge tone="slate">Timetable not read</Badge>;
  return <Badge tone={SCHEDULE_TONE[s] ?? 'slate'}>{s === 'ok' ? 'Timetable OK' : `Timetable ${label(s).toLowerCase()}`}</Badge>;
}

export const routeText = (t) => (t.origin_code ? `${t.origin_code} → ${t.destination_code ?? '?'}` : '—');

const duration = (m) => (m == null ? null : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`);

// The feedback part of the train form. `f`/`set` are the form's state and field setter.
export const FEEDBACK_DEFAULTS = (t) => ({
  feedback_enabled: t?.feedback_enabled ?? true,
  feedback_daily_target: t?.feedback_daily_target ?? '',
  feedback_coach_daily_target: t?.feedback_coach_daily_target ?? '',
  feedback_min_daily: t?.feedback_min_daily ?? '',
  feedback_from_day: t?.feedback_from_day ?? 1,
  feedback_to_day: t?.feedback_to_day ?? '',
  feedback_days: t?.feedback_days ?? 'all',
  feedback_targets_active: t?.feedback_targets_active ?? true,
});

// Empty number fields mean "no value" (null), never 0.
export function feedbackFields(f) {
  const n = (v) => (v === '' || v == null ? null : Number(v));
  return {
    feedback_enabled: !!f.feedback_enabled, feedback_daily_target: n(f.feedback_daily_target),
    feedback_coach_daily_target: n(f.feedback_coach_daily_target), feedback_min_daily: n(f.feedback_min_daily),
    feedback_from_day: n(f.feedback_from_day) ?? 1, feedback_to_day: n(f.feedback_to_day), feedback_days: f.feedback_days,
    feedback_targets_active: !!f.feedback_targets_active,
  };
}

export function FeedbackSettings({ f, setF, operationalDays }) {
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const target = Number(f.feedback_daily_target) || 0;
  const from = Number(f.feedback_from_day) || 1;
  const to = Number(f.feedback_to_day) || operationalDays || from;
  const days = Math.max(0, Math.min(to, operationalDays || to) - from + 1);
  return (
    <fieldset className="space-y-3 rounded-2xl border border-line p-3">
      <legend className="px-1 text-sm font-semibold text-ink">Passenger feedback</legend>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.feedback_enabled} onChange={set('feedback_enabled')} /> Collect passenger feedback</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.feedback_targets_active} onChange={set('feedback_targets_active')} disabled={!f.feedback_enabled} /> Targets active</label>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Feedback per day" hint="Whole train, each journey day">
          <input type="number" min={1} max={500} className="input" value={f.feedback_daily_target} onChange={set('feedback_daily_target')} disabled={!f.feedback_enabled} />
        </Field>
        <Field label="Per coach per day" hint="Optional; separate from the daily target">
          <input type="number" min={1} max={100} className="input" value={f.feedback_coach_daily_target} onChange={set('feedback_coach_daily_target')} disabled={!f.feedback_enabled} />
        </Field>
        <Field label="Daily minimum" hint="Optional; below it a day is “short”">
          <input type="number" min={1} max={500} className="input" value={f.feedback_min_daily} onChange={set('feedback_min_daily')} disabled={!f.feedback_enabled} />
        </Field>
        <Field label="Collect from day"><input type="number" min={1} max={30} className="input" value={f.feedback_from_day} onChange={set('feedback_from_day')} disabled={!f.feedback_enabled} /></Field>
        <Field label="Collect until day" hint="Empty = last journey day"><input type="number" min={1} max={30} className="input" value={f.feedback_to_day} onChange={set('feedback_to_day')} disabled={!f.feedback_enabled} /></Field>
        <Field label="Target on">
          <select className="input" value={f.feedback_days} onChange={set('feedback_days')} disabled={!f.feedback_enabled}>
            <option value="all">Every journey day</option>
            <option value="running">Only days a train runs (not layovers)</option>
          </select>
        </Field>
      </div>
      {f.feedback_enabled && target > 0 && f.feedback_targets_active && (
        <p className="text-xs text-muted" data-testid="feedback-target-preview">
          {target} a day{operationalDays ? ` × ${days} day${days === 1 ? '' : 's'} = ${target * days} per journey` : ''}. Days already under way keep the target they had; feedback already collected is never changed.
        </p>
      )}
    </fieldset>
  );
}

function Direction({ d, title }) {
  if (!d) return <p className="text-sm text-muted">{title}: no return train is known for this train.</p>;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-ink">{title} · {d.train_no} {d.train_name}</h3>
        <Badge tone={SCHEDULE_TONE[d.schedule_status] ?? 'slate'}>{d.schedule_status ? label(d.schedule_status) : 'Not read'}</Badge>
      </div>
      <p className="text-xs text-muted">
        {d.origin_name ?? d.origin_code ?? '?'} → {d.destination_name ?? d.destination_code ?? '?'}
        {d.departure ? ` · leaves ${d.departure}` : ''}{d.arrival ? `, arrives ${d.arrival}` : ''}
        {d.journey_days != null ? ` (day ${d.journey_days})` : ''}
        {duration(d.duration_minutes) ? ` · ${duration(d.duration_minutes)}` : ''}{d.distance_km != null ? ` · ${d.distance_km} km` : ''}
      </p>
      <p className="text-xs text-muted">Runs: {d.run_days ? DAYS.filter((x) => d.run_days.includes(x)).map(label).join(', ') : 'not known (every day assumed)'}
        {d.schedule_synced_at ? ` · read ${fmtDateTime(d.schedule_synced_at)}` : ''}</p>
      {d.schedule_error && <p className="text-xs text-red-700">Last read: {d.schedule_error}</p>}
      {d.stops.length ? (
        <div className="max-h-72 overflow-auto rounded-xl ring-1 ring-line">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-canvas text-slate-500"><tr><th className="px-2 py-1.5">#</th><th className="px-2">Station</th><th className="px-2">Arr.</th><th className="px-2">Dep.</th><th className="px-2">Day</th><th className="px-2">Halt</th><th className="px-2">km</th></tr></thead>
            <tbody className="divide-y divide-line/70">
              {d.stops.map((s, i) => (
                <tr key={s.seq}>
                  <td className="px-2 py-1 tabular-nums text-slate-500">{i + 1}</td>
                  <td className="px-2"><b>{s.code}</b> <span className="text-slate-500">{s.name}</span></td>
                  <td className="px-2 tabular-nums">{s.arrival ?? '—'}</td><td className="px-2 tabular-nums">{s.departure ?? '—'}</td>
                  <td className="px-2 tabular-nums">{s.day}</td><td className="px-2 tabular-nums">{s.halt_minutes != null ? `${s.halt_minutes}′` : ''}</td>
                  <td className="px-2 tabular-nums">{s.distance_km ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-xs text-muted">No stops stored yet.</p>}
    </section>
  );
}

export function TrainTimetable({ train, canManage, onChanged }) {
  const { api } = useSession();
  const notify = useNotify();
  const online = useNetworkStatus();
  const res = useResource(`/trains/${train.id}/timetable`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.post(`/trains/${train.id}/timetable/refresh`);
      const text = { updated: 'Timetable updated.', unchanged: 'Timetable checked: no change.', failed: 'RailRadar could not be read; the stored timetable is kept.', rejected: 'The timetable read was incomplete; the stored timetable is kept.' }[out.outcome];
      notify(out.outcome === 'updated' || out.outcome === 'unchanged' ? 'success' : 'error', `${text}${out.message ? ` ${out.message}` : ''}`);
      res.reload();
      onChanged?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      {canManage && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary" disabled={busy || !online} onClick={refresh}>{busy && <Spinner />} Refresh from RailRadar</button>
          <p className="text-xs text-muted">Reads this train and its return train, each from its own RailRadar page.{online ? '' : ' Needs a connection.'}</p>
        </div>
      )}
      <DataState res={res}>
        {(t) => (
          <>
            <Direction d={t.outbound} title="Direction 1 (outbound)" />
            <Direction d={t.inbound} title="Direction 2 (return)" />
            {t.runs.length > 0 && (
              <section>
                <h3 className="mb-1 text-sm font-bold text-ink">Recent reads</h3>
                <ul className="divide-y divide-line/70 text-xs">
                  {t.runs.map((r) => (
                    <li key={r.id} className="flex flex-wrap gap-x-2 py-1.5">
                      <span className="tabular-nums text-slate-500">{fmtDateTime(r.started_at)}</span>
                      <b>{r.train_no}</b>
                      <Badge tone={{ updated: 'green', unchanged: 'slate', failed: 'red', rejected: 'amber' }[r.outcome]}>{label(r.outcome)}</Badge>
                      <span className="text-slate-500">{label(r.trigger)}</span>
                      {r.message && <span className="text-red-700">{r.message}</span>}
                      {r.changes && Object.keys(r.changes).length > 0 && <span className="text-slate-600">{Object.entries(r.changes).map(([k, v]) => `${label(k)}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? `${v.from ?? '—'} → ${v.to ?? '—'}` : v}`).join(' · ')}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </DataState>
    </div>
  );
}

export function BulkRefreshButton({ divisionId, onDone }) {
  const { api } = useSession();
  const notify = useNotify();
  const online = useNetworkStatus();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const out = await api.post('/trains/timetable/refresh', { division_id: divisionId || null });
      notify(out.accepted ? 'info' : 'success', out.message);
      onDone?.();
    } catch (e) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="btn-secondary" disabled={busy || !online} onClick={run} title={online ? 'Read every train’s timetable from RailRadar' : 'Needs a connection'}>
      {busy && <Spinner />} Refresh timetables
    </button>
  );
}
