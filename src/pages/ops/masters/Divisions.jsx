// Divisions: an office's headquarters and stations. Backend: GET/POST /divisions, PATCH /divisions/{id}.
// Used twice: Master data -> Divisions lists every office's, and an office's own page (Clients & Credits ->
// Manage) lists only its own, with new ones created inside that office.
//
// The type matters beyond the label: role rights can be set for every station, or every headquarters, of
// an office at once (Role rights; role_permissions.division_kind).
import { useState } from 'react';
import StationPicker from './StationPicker.jsx';
import { useResource, useSession } from '../../../app/session.jsx';
import { Badge, DataState, Dialog, ErrorNote, Field, Panel, Select, SubmitBar, Table } from '../../../components/ui.jsx';
import { PlusIcon } from '../../../components/Icons.jsx';
import { useSave } from './common.jsx';

export const DIVISION_KINDS = [{ value: 'station', label: 'Station' }, { value: 'headquarters', label: 'Headquarters' }];
export const kindLabel = (kind) => (kind === 'headquarters' ? 'Headquarters' : 'Station');

// `clientId`: show and create only this office's divisions. `onChanged`: told after any change, so a page
// holding its own copy of the list can reload it.
export default function Divisions({ clientId = null, onChanged }) {
  const { api, can } = useSession();
  const res = useResource('/divisions');
  // Every division belongs to a client (office): whose wallet its journeys spend and whose module
  // subscription its users see. Only a Super Admin creates divisions, and they can read every client.
  const manage = can('divisions.manage');
  const clients = useResource(manage && !clientId ? '/clients' : null);
  const [creating, setCreating] = useState(false);
  const blank = { code: '', name: '', client_id: clientId ?? '', kind: 'station', stations: [] };
  const [f, setF] = useState(blank);
  const changed = () => { res.reload(); onChanged?.(); };
  const save = useSave(() => { setCreating(false); setF(blank); changed(); });
  const setKind = useSave(changed);
  // Picked railway stations each become a division (code and name from the station); none picked, the
  // code and name typed in make one, as before.
  const submit = (e) => {
    e.preventDefault();
    const Label = what === 'station' ? 'Station' : 'Division';
    if (!f.stations.length) {
      save.run(() => api.post('/divisions', { code: f.code.toUpperCase(), name: f.name, client_id: f.client_id, kind: f.kind }), `${Label} created.`);
      return;
    }
    save.run(async () => {
      const out = await api.post('/divisions/stations', { client_id: f.client_id, kind: f.kind, station_codes: f.stations.map((s) => s.code) });
      if (!out.created.length) throw new Error(`Already ${what}s of this office: ${out.existing.join(', ')}`);
      return out;
    }, (out) => `${out.created.length} ${out.created.length > 1 ? `${what}s` : what} created.`
      + (out.existing.length ? ` Already there: ${out.existing.join(', ')}.` : ''));
  };
  const officeName = (id) => {
    const c = (clients.data ?? []).find((x) => x.id === id);
    return c ? `${c.office_id} — ${c.name}` : '';
  };
  const what = clientId ? 'station' : 'division';
  // The full list (Master data -> Divisions) can be narrowed to one office; an office's own page is already.
  const [office, setOffice] = useState('');
  const only = clientId || office;
  const shownRows = (rows) => (only ? rows.filter((d) => d.client_id === only) : rows);

  return (
    <Panel title={clientId ? 'Headquarters and stations' : 'Divisions'}
      actions={manage && <button type="button" className="btn-secondary" onClick={() => { setF({ ...blank, client_id: clientId ?? office }); setCreating(true); }}><PlusIcon /> Add {what}</button>}>
      {!clientId && (clients.data?.length ?? 0) > 1 && (
        <div className="mb-3 max-w-xs">
          <Select value={office} onChange={setOffice} aria-label="Office"
            options={[{ value: '', label: 'All offices' }, ...clients.data.map((c) => ({ value: c.id, label: `${c.office_id} — ${c.name}` }))]} />
        </div>
      )}
      <DataState res={res} isEmpty={(rows) => !shownRows(rows).length}
        empty={clientId ? 'This office has no headquarters or stations yet. Add one to give its users somewhere to work.'
          : office ? 'This office has no divisions yet.' : 'No divisions.'}>
        {(rows) => (
          <Table rows={shownRows(rows)} columns={[
            { key: 'code', label: 'Code', render: (d) => <span className="font-semibold">{d.code}</span> },
            { key: 'name', label: 'Name' },
            ...(!clientId && clients.data?.length ? [{ key: 'client_id', label: 'Office', render: (d) => officeName(d.client_id) }] : []),
            { key: 'kind', label: 'Type', render: (d) => (manage ? (
              <Select value={d.kind ?? 'station'} options={DIVISION_KINDS} aria-label={`Type of ${d.name}`}
                onChange={(v) => setKind.run(() => api.patch(`/divisions/${d.id}`, { kind: v }), `${d.name} is now ${v === 'headquarters' ? 'a headquarters' : 'a station'}.`)} />
            ) : <Badge tone={d.kind === 'headquarters' ? 'brand' : 'slate'}>{kindLabel(d.kind)}</Badge>) },
            { key: 'is_active', label: 'Status', render: (d) => <Badge tone={d.is_active ? 'green' : 'slate'}>{d.is_active ? 'Active' : 'Inactive'}</Badge> },
          ]} />
        )}
      </DataState>
      <ErrorNote error={setKind.error} />
      <Dialog open={creating} title={`Add ${what}`} onClose={() => setCreating(false)}>
        <form onSubmit={submit} className="space-y-3">
          <ErrorNote error={save.error} />
          <StationPicker picked={f.stations} onChange={(stations) => setF({ ...f, stations })} />
          {!f.stations.length && (
            <>
              <Field label="Code" hint="Uppercase letters, digits, underscore"><input className="input" required pattern="[A-Za-z0-9_]{2,16}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
              <Field label="Name"><input className="input" required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            </>
          )}
          {!clientId && (
            <Field label="Client (office)" hint="Whose modules and credits this division uses">
              <Select value={f.client_id} onChange={(v) => setF({ ...f, client_id: v })} placeholder="Select an office"
                options={(clients.data ?? []).map((c) => ({ value: c.id, label: `${c.office_id} — ${c.name}` }))} />
            </Field>
          )}
          <Field label="Type" hint="Role rights can be set for all stations or the headquarters of an office at once">
            <Select value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={DIVISION_KINDS} />
          </Field>
          <SubmitBar busy={save.busy} disabled={!f.client_id} onCancel={() => setCreating(false)}
            label={f.stations.length > 1 ? `Create ${f.stations.length} ${what}s` : 'Create'} />
        </form>
      </Dialog>
    </Panel>
  );
}
