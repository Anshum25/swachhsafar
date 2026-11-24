// Railway stations picked by state and city (backend GET /railway/states, /railway/cities, /railway/stations).
// Picks are kept while the state or city changes, so one office can be given stations of several cities in
// different states (Ahmedabad and Jabalpur) in one go.
import { useState } from 'react';
import { useResource } from '../../../app/session.jsx';
import { Field, Select } from '../../../components/ui.jsx';
import { XIcon } from '../../../components/Icons.jsx';

// `picked`: [{code, name, city, state}]; `onChange` gets the new list.
export default function StationPicker({ picked, onChange }) {
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [q, setQ] = useState('');
  const states = useResource('/railway/states');
  const cities = useResource(state ? '/railway/cities' : null, state ? { state } : null);
  const stations = useResource(state && city ? '/railway/stations' : null, state && city ? { state, city } : null);

  const has = new Set(picked.map((s) => s.code));
  const toggle = (s) => onChange(has.has(s.code) ? picked.filter((x) => x.code !== s.code)
    : [...picked, { code: s.code, name: s.name, city: s.city || city, state: s.state || state }]);
  const needle = q.trim().toLowerCase();
  const shown = (stations.data ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.code.toLowerCase().includes(needle));
  const allShown = shown.length > 0 && shown.every((s) => has.has(s.code));
  const toggleAll = () => {
    if (allShown) onChange(picked.filter((p) => !shown.some((s) => s.code === p.code)));
    else onChange([...picked, ...shown.filter((s) => !has.has(s.code)).map((s) => ({ code: s.code, name: s.name, city: s.city || city, state: s.state || state }))]);
  };

  return (
    <div className="space-y-3 rounded-2xl bg-slate-50 p-3 ring-1 ring-line">
      <p className="text-[13px] font-medium text-slate-600">
        Railway stations <span className="font-normal text-muted">— optional; each one picked becomes a division</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="State">
          <Select value={state} onChange={(v) => { setState(v); setCity(''); setQ(''); }} placeholder="Choose a state"
            options={(states.data ?? []).map((s) => ({ value: s, label: s }))} />
        </Field>
        <Field label="City">
          <Select value={city} onChange={(v) => { setCity(v); setQ(''); }} disabled={!state}
            placeholder={state ? (cities.loading ? 'Loading…' : 'Choose a city') : 'Choose a state first'}
            options={(cities.data ?? []).map((c) => ({ value: c, label: c }))} />
        </Field>
      </div>

      {state && city && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <input className="input h-9 flex-1" placeholder="Filter stations by name or code" aria-label="Filter stations"
              value={q} onChange={(e) => setQ(e.target.value)} />
            {shown.length > 1 && (
              <button type="button" className="btn-link shrink-0 text-xs" onClick={toggleAll}>{allShown ? 'Clear all' : 'Select all'}</button>
            )}
          </div>
          <div className="max-h-48 overflow-y-auto rounded-xl bg-white ring-1 ring-line">
            {stations.loading && <p className="p-3 text-sm text-muted">Loading stations…</p>}
            {stations.error && <p className="p-3 text-sm text-red-700">Could not load stations: {stations.error.message}</p>}
            {!stations.loading && !stations.error && !shown.length && <p className="p-3 text-sm text-muted">No stations found.</p>}
            {shown.map((s) => (
              <label key={s.code} className="flex cursor-pointer items-center gap-3 border-b border-line/60 px-3 py-2 text-sm last:border-0 hover:bg-slate-50">
                <input type="checkbox" checked={has.has(s.code)} onChange={() => toggle(s)} />
                <span className="w-14 shrink-0 font-semibold">{s.code}</span>
                <span className="min-w-0 truncate">{s.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {picked.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-muted">{picked.length} picked</p>
          <div className="flex flex-wrap gap-1.5">
            {picked.map((s) => (
              <span key={s.code} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pl-2.5 pr-1 text-xs font-medium text-brand-800 ring-1 ring-brand-200"
                title={[s.name, s.city, s.state].filter(Boolean).join(', ')}>
                {s.code} · {s.city || s.name}
                <button type="button" className="rounded-full p-0.5 hover:bg-brand-100" aria-label={`Remove ${s.name}`}
                  onClick={() => onChange(picked.filter((x) => x.code !== s.code))}><XIcon className="h-3.5 w-3.5" /></button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
