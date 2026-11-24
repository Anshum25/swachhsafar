// An office's stations and trains, set up from the railway network. Backend: app/services/railway.py.
//
//   1. The Super Admin sets the office's state and city (AreaEditor, on the office's page).
//   2. The office's Admin -- or the Super Admin -- ticks that city's stations (step 1), then, for each, the
//      trains that start there, read from RailRadar (step 2), and saves. Each station becomes one of the
//      office's stations and each train one of its trains.
//   3. Journeys are then planned for those trains every day, three days ahead, with no supervisor until
//      somebody assigns one. Each is paid for (one journey's credits) the moment it is created; one the
//      wallet cannot pay for is not created, and is tried again the next day.
import { useEffect, useMemo, useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { navigate } from '../../../app/router.js';
import { Badge, DataState, ErrorNote, Field, Panel, Select } from '../../../components/ui.jsx';
import { ConfirmDialog, useSave } from './common.jsx';
import { useNetworkStatus } from '../../../hooks/useNetworkStatus.js';
import { filterStations, initialPicks, runDaysLabel, setupBody, stationsWithoutTrains } from './officeSetup.js';
import { coachText } from '../../../utils/coaches.js';

const SUPER_ADMIN = 1;

// ---- the office's state and city (Super Admin) ---------------------------------------------------------

// State, then city, from the railway station list. Used when creating an office (Clients.jsx) and on its page.
export function StateCityFields({ state, city, onChange }) {
  const states = useResource('/railway/states');
  const cities = useResource(state ? '/railway/cities' : null, state ? { state } : null);
  return (
    <>
      <Field label="State">
        <Select value={state} onChange={(v) => onChange({ state: v, city: '' })} placeholder="Choose a state"
          options={(states.data ?? []).map((s) => ({ value: s, label: s }))} />
      </Field>
      <Field label="City" hint="Its stations are the ones this office can set up (a big city includes its suburbs)">
        <Select value={city} onChange={(v) => onChange({ state, city: v })} placeholder={state ? 'Choose a city' : 'Choose a state first'}
          disabled={!state} options={(cities.data ?? []).map((c) => ({ value: c, label: c }))} />
      </Field>
    </>
  );
}

export function AreaEditor({ client, onSaved }) {
  const { api, me } = useSession();
  const online = useNetworkStatus();
  const canEdit = me?.user?.role_id === SUPER_ADMIN && online;
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState(client.state ?? '');
  const [city, setCity] = useState(client.city ?? '');
  const save = useSave(() => { setEditing(false); onSaved?.(); });
  const changed = state !== (client.state ?? '') || city !== (client.city ?? '');

  return (
    <Panel title="Where this office works" actions={canEdit && !editing && (
      <button type="button" className="btn-secondary h-9 text-xs" onClick={() => setEditing(true)}>{client.state ? 'Change' : 'Set state and city'}</button>
    )}>
      {!editing ? (
        client.state && client.city
          ? <p className="text-sm text-ink"><span className="font-semibold">{client.city}</span>, {client.state}</p>
          : <p className="text-sm text-muted">Not set yet. The office's Admin can pick its stations and trains once the Super Admin sets its state and city.</p>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.run(() => api.patch(`/clients/${client.id}`, { state, city }), 'State and city saved.'); }}>
          <ErrorNote error={save.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <StateCityFields state={state} city={city} onChange={(v) => { setState(v.state); setCity(v.city); }} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary h-10" onClick={() => { setEditing(false); setState(client.state ?? ''); setCity(client.city ?? ''); }}>Cancel</button>
            <button type="submit" className="btn-primary h-10" disabled={!state || !city || !changed || save.busy}>Save</button>
          </div>
        </form>
      )}
    </Panel>
  );
}

// ---- step 2: one station's trains ----------------------------------------------------------------------

// `onPatch(trainNo, patch)` merges into this station's picks from the latest state, so the coaches that arrive
// after a tick never overwrite a change made in the meantime.
function StationTrains({ code, name, picks, onPatch }) {
  const { api } = useSession();
  const res = useResource(`/railway/stations/${code}/trains`);
  const [fetching, setFetching] = useState({}); // train_no -> 'loading' | 'none'
  const set = (trainNo, patch) => onPatch(trainNo, patch);
  // Ticking a train with no coaches typed fills them from RailEngine (backend GET /railway/trains/{no}/coaches).
  // If that cannot be had the box stays empty: saving tries again, and coaches can always be typed.
  const tick = (trainNo, checked) => {
    set(trainNo, { checked });
    if (!checked || picks[trainNo]?.coaches) return;
    setFetching((f) => ({ ...f, [trainNo]: 'loading' }));
    api.get(`/railway/trains/${trainNo}/coaches`)
      .then((cs) => {
        if (cs?.length) set(trainNo, { coaches: coachText(cs), auto: true });
        setFetching((f) => ({ ...f, [trainNo]: cs?.length ? undefined : 'none' }));
      })
      .catch(() => setFetching((f) => ({ ...f, [trainNo]: 'none' })));
  };
  return (
    <Panel title={`${name} (${code})`} actions={res.data?.stale && <Badge tone="amber">Saved copy: RailRadar unreachable</Badge>}>
      <DataState res={res} isEmpty={(d) => !d.trains.length} empty="No train starts at this station.">
        {(board) => (
          <ul className="divide-y divide-slate-100">
            {board.trains.map((t) => {
              const pick = picks[t.train_no] ?? { checked: false, coaches: '' };
              return (
                <li key={t.train_no} className="py-2.5">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-700" checked={pick.checked}
                      onChange={(e) => tick(t.train_no, e.target.checked)} aria-label={`Plan ${t.train_no} ${t.name ?? ''}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink">{t.train_no} · {t.name ?? 'Unnamed train'}</span>
                      <span className="block text-xs text-slate-600">
                        Departs {t.departure} → {t.destination_name ?? t.destination_code ?? 'destination not published'} · {runDaysLabel(t.run_days)}
                      </span>
                    </span>
                  </label>
                  {pick.checked && (
                    <div className="ml-7 mt-2">
                      <input className="input h-9 text-sm" placeholder={fetching[t.train_no] === 'loading' ? 'Fetching coaches…' : 'Coaches, e.g. B1 AC, B2 AC, S1, S2'} value={pick.coaches}
                        aria-label={`Coaches of ${t.train_no}`} onChange={(e) => set(t.train_no, { coaches: e.target.value, auto: false })} />
                      <p className="mt-1 text-[11px] text-muted">
                        {fetching[t.train_no] === 'loading' ? 'Fetching this train\'s coaches…'
                          : pick.auto ? 'Filled in from the train\'s composition (RailEngine). Edit if this office works on fewer coaches.'
                            : fetching[t.train_no] === 'none' ? 'Could not fetch the coaches: type them, or add them later on the train.'
                              : 'Add AC after air-conditioned coaches.'}
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DataState>
    </Panel>
  );
}

// ---- the wizard ----------------------------------------------------------------------------------------

export function SetupWizard({ clientId, clientName }) {
  const { api, me } = useSession();
  const online = useNetworkStatus();
  const setup = useResource(`/clients/${clientId}/setup`);
  const [step, setStep] = useState('stations');
  const [chosen, setChosen] = useState(null); // station codes
  const [picks, setPicks] = useState({});
  const [term, setTerm] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const save = useSave((r) => { setConfirming(false); setResult(r); setStep('done'); setup.reload(); });

  // Start from what is saved: the stations already set up, their planned trains ticked.
  useEffect(() => {
    if (setup.data && chosen === null) {
      setChosen(setup.data.stations.filter((s) => s.selected).map((s) => s.code));
      setPicks(initialPicks(setup.data));
    }
  }, [setup.data, chosen]);

  const stations = setup.data?.stations ?? [];
  const byCode = useMemo(() => Object.fromEntries(stations.map((s) => [s.code, s])), [stations]);
  const shown = filterStations(stations, term);
  const picked = chosen ?? [];
  const toggle = (code) => setChosen((c) => (c.includes(code) ? c.filter((x) => x !== code) : [...c, code]));
  const body = setupBody(picked, picks);
  const empty = stationsWithoutTrains(picked, picks);
  const trainCount = body.stations.reduce((n, s) => n + s.trains.length, 0);

  return (
    <DataState res={setup} isEmpty={() => false}>
      {(s) => {
        if (!s.state || !s.city) {
          return (
            <Panel title="Stations & trains">
              <p className="text-sm text-muted">
                {me?.user?.role_id === SUPER_ADMIN
                  ? 'Set this office\'s state and city first (Details & credits tab).'
                  : 'The Super Admin has not set your office\'s state and city yet. Once they do, you can pick your stations and trains here.'}
              </p>
            </Panel>
          );
        }
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold text-ink">Stations & trains{clientName ? ` · ${clientName}` : ''}</h2>
                <p className="text-sm text-muted">{s.city}, {s.state} · {s.planned} journeys planned ahead
                  {s.without_supervisor ? <>, <span className="font-semibold text-amber-700">{s.without_supervisor} without a supervisor</span></> : ''}</p>
              </div>
              <ol className="flex gap-2 text-xs font-semibold" aria-label="Steps">
                {[['stations', '1 Stations'], ['trains', '2 Trains'], ['done', '3 Done']].map(([k, l]) => (
                  <li key={k} className={`rounded-full px-3 py-1 ring-1 ${step === k ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white text-slate-600 ring-line'}`}>{l}</li>
                ))}
              </ol>
            </div>

            {step === 'stations' && (
              <Panel title={`Stations of ${s.city}`} actions={<span className="text-sm text-muted">{picked.length} selected</span>}>
                <input className="input mb-3 h-10" type="search" placeholder="Search by name or code" value={term}
                  onChange={(e) => setTerm(e.target.value)} aria-label="Search stations" />
                <ul className="max-h-[26rem] divide-y divide-slate-100 overflow-auto">
                  {shown.map((st) => (
                    <li key={st.code}>
                      <label className="flex cursor-pointer items-center gap-3 py-2">
                        <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={picked.includes(st.code)} onChange={() => toggle(st.code)} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-ink">{st.name} <span className="font-normal text-slate-500">({st.code})</span></span>
                          {st.city && st.city !== s.city && <span className="block text-xs text-muted">{st.city}</span>}
                        </span>
                        {st.selected && <Badge tone="green">Set up</Badge>}
                      </label>
                    </li>
                  ))}
                  {!shown.length && <li className="py-6 text-center text-sm text-muted">No station matches.</li>}
                </ul>
                <div className="mt-3 flex justify-end">
                  <button type="button" className="btn-primary h-10" disabled={!picked.length || !online} onClick={() => setStep('trains')}>
                    Next: choose trains
                  </button>
                </div>
              </Panel>
            )}

            {step === 'trains' && (
              <>
                <p className="text-sm text-muted">Tick the trains this office works on. Journeys are planned for them every day, three days ahead, on the days they run; each costs one journey's credits when it is created.</p>
                {picked.map((code) => (
                  <StationTrains key={code} code={code} name={byCode[code]?.name ?? code} picks={picks[code] ?? {}}
                    onPatch={(trainNo, patch) => setPicks((all) => ({
                      ...all, [code]: { ...all[code], [trainNo]: { checked: false, coaches: '', ...(all[code] ?? {})[trainNo], ...patch } },
                    }))} />
                ))}
                <div className="sticky bottom-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-white p-3 shadow-raised ring-1 ring-line">
                  <span className="text-sm text-ink">{trainCount} train{trainCount === 1 ? '' : 's'} at {body.stations.length} station{body.stations.length === 1 ? '' : 's'}</span>
                  <span className="flex gap-2">
                    <button type="button" className="btn-secondary h-10" onClick={() => setStep('stations')}>Back</button>
                    <button type="button" className="btn-primary h-10" disabled={!online} onClick={() => setConfirming(true)}>Save and plan journeys</button>
                  </span>
                </div>
              </>
            )}

            {step === 'done' && result && (
              <Panel title="Saved">
                <p className="text-sm text-ink">
                  {result.trains_planned} train{result.trains_planned === 1 ? '' : 's'} planned
                  {result.divisions_created ? `, ${result.divisions_created} new station${result.divisions_created === 1 ? '' : 's'}` : ''};
                  {' '}{result.journeys_created} journey{result.journeys_created === 1 ? '' : 's'} created for the next days, each paid for from the wallet.
                </p>
                {result.coaches_auto?.length > 0 && (
                  <p className="mt-1 text-sm text-ink">Coaches filled in automatically for {result.coaches_auto.join(', ')}.</p>
                )}
                {result.coaches_missing?.length > 0 && (
                  <p className="mt-1 text-sm font-semibold text-amber-800">
                    No coaches yet for {result.coaches_missing.join(', ')}: add them under Master data → Trains & Coaches before inspections.
                  </p>
                )}
                {result.journeys_skipped > 0 && (
                  <p className="mt-1 text-sm font-semibold text-red-700">
                    {result.journeys_skipped} more could not be created: not enough credits. They are created automatically once credits are added.
                  </p>
                )}
                <p className="mt-1 text-sm text-amber-800">They have no supervisor yet. Assign one to each journey in Journeys before it departs; each station needs its own supervisors under Users.</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" className="btn-primary h-10" onClick={() => navigate('/journeys')}>Open Journeys</button>
                  <button type="button" className="btn-secondary h-10" onClick={() => setStep('stations')}>Change stations or trains</button>
                </div>
              </Panel>
            )}

            <ConfirmDialog open={confirming} busy={save.busy} error={save.error} title="Save stations and trains"
              confirmLabel="Save" onClose={() => { setConfirming(false); save.setError(null); }}
              message={`${trainCount} train${trainCount === 1 ? '' : 's'} at ${body.stations.length} station${body.stations.length === 1 ? '' : 's'} will be planned every day.`
                + (empty.length ? ` ${empty.join(', ')} ha${empty.length === 1 ? 's' : 've'} no train ticked and will not be set up.` : '')
                + ' Trains no longer ticked stop being planned; journeys already planned for them stay.'}
              onConfirm={() => save.run(() => api.put(`/clients/${clientId}/setup`, body), 'Stations and trains saved.')} />
          </div>
        );
      }}
    </DataState>
  );
}

// ---- Master data -> Stations & trains ------------------------------------------------------------------

// An office's Admin sets up their own office; the Super Admin picks which office first.
export default function OfficeSetupSection() {
  const { me, client } = useSession();
  const isSuper = me?.user?.role_id === SUPER_ADMIN;
  const clients = useResource(isSuper ? '/clients' : null);
  const [picked, setPicked] = useState('');
  if (!isSuper) {
    return client ? <SetupWizard clientId={client.id} /> : <Panel title="Stations & trains"><p className="text-sm text-muted">Your account does not belong to an office.</p></Panel>;
  }
  const chosen = (clients.data ?? []).find((c) => c.id === picked);
  return (
    <div className="space-y-4">
      <Panel title="Which office?">
        <Select value={picked} onChange={setPicked} placeholder="Choose an office" aria-label="Office"
          options={(clients.data ?? []).map((c) => ({ value: c.id, label: `${c.office_id} — ${c.name}${c.city ? ` (${c.city})` : ''}` }))} />
      </Panel>
      {chosen && <SetupWizard key={chosen.id} clientId={chosen.id} clientName={chosen.name} />}
    </div>
  );
}
