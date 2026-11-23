// The client (office) and division a manager is currently looking at. Field staff normally have exactly one
// of each. A Super Admin works across offices: they pick the office first, and the division list then
// shows only that office's divisions, so every screen built on a division is one office at a time.
import { useEffect, useState } from 'react';
import { useResource, useSession } from './session.jsx';
import { firstDivisionOf, resolveDivisionScope } from './divisionScope.js';

const KEY = 'swachh.division';
const CLIENT_KEY = 'swachh.client';

const load = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const save = (key, value) => {
  try {
    if (value) localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
};

export function useDivision() {
  const { divisions, can } = useSession();
  const res = useResource('/divisions');
  const [id, setId] = useState(() => load(KEY));
  const [clientChoice, setClientChoice] = useState(() => load(CLIENT_KEY));
  const list = res.data ?? divisions.map((d) => ({ id: d, name: d.slice(0, 8), code: '' }));

  const { clientIds, multiClient, clientId, shown, divisionId: valid } = resolveDivisionScope({
    list, openable: divisions, divisionId: id, clientChoice,
  });
  const clientsRes = useResource(multiClient && can('clients.read') ? '/clients' : null);
  const clients = clientIds.map((cid) => {
    const c = clientsRes.data?.find((x) => x.id === cid);
    return { id: cid, name: c ? `${c.office_id} — ${c.name}` : `Office ${cid.slice(0, 8)}` };
  }).sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => save(KEY, valid), [valid]);
  useEffect(() => save(CLIENT_KEY, multiClient ? clientId : null), [multiClient, clientId]);

  const setClientId = (cid) => {
    setClientChoice(cid);
    setId(firstDivisionOf({ list, openable: divisions, clientId: cid }));
  };

  return {
    divisionId: valid,
    setDivisionId: setId,
    // Every division the user may see, across offices (a user's division can be changed to any of them).
    divisions: list,
    // The divisions of the office in view: what the division picker offers.
    clientDivisions: shown,
    current: list.find((d) => d.id === valid),
    clients: multiClient ? clients : [],
    clientId,
    client: clients.find((c) => c.id === clientId) ?? null,
    setClientId,
  };
}

// "OFF-001 — Default Office · Headquarters" where the user sees more than one office, else just the name.
export function divisionLabel(division, d) {
  const client = division.clients.find((c) => c.id === d.client_id);
  return client ? `${client.name} · ${d.name}` : d.name;
}

export function DivisionPicker({ division }) {
  const showClients = division.clients.length > 1;
  const showDivisions = division.clientDivisions.length > 1;
  if (!showClients && !showDivisions) return null;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {showClients && (
        <select className="input h-10 w-auto max-w-[16rem] text-sm" value={division.clientId ?? ''} onChange={(e) => division.setClientId(e.target.value)} aria-label="Client (office)">
          {division.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      {showDivisions && (
        <select className="input h-10 w-auto text-sm" value={division.divisionId ?? ''} onChange={(e) => division.setDivisionId(e.target.value)} aria-label="Division">
          {division.clientDivisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      )}
    </span>
  );
}
