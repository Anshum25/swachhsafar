// Which office (client) and division a screen shows, from the divisions the user may see and what they last
// chose. Pure, so it is tested without rendering (tests/unit/divisionScope.test.js); useDivision() wraps it.
//
// list         division rows ({ id, name, client_id? }) from /divisions
// openable     ids of the divisions /auth/me lets this user open
// divisionId   the division last chosen (may be stale, or in another office)
// clientChoice the office last chosen (may be stale)
export function resolveDivisionScope({ list, openable, divisionId, clientChoice }) {
  const canOpen = list.filter((d) => openable.includes(d.id));
  // Rows read from the device's own database carry no client_id; then there is nothing to group by and the
  // picker is the plain division list.
  const clientIds = [...new Set(canOpen.map((d) => d.client_id).filter(Boolean))];
  const multiClient = clientIds.length > 1;
  const stored = canOpen.find((d) => d.id === divisionId);
  // The office: the one chosen, else the chosen division's, else the first with a division to open.
  const clientId = !multiClient ? (clientIds[0] ?? null)
    : clientIds.includes(clientChoice) ? clientChoice
      : stored?.client_id ?? canOpen[0]?.client_id ?? null;
  const shown = canOpen.filter((d) => !multiClient || d.client_id === clientId);
  const division = shown.some((d) => d.id === divisionId) ? divisionId
    : shown[0]?.id ?? (divisionId && openable.includes(divisionId) ? divisionId : openable[0] ?? null);
  return { clientIds, multiClient, clientId, shown, divisionId: division };
}

// The division to open on switching to office `clientId`: its first one the user may open.
export function firstDivisionOf({ list, openable, clientId }) {
  return list.find((d) => d.client_id === clientId && openable.includes(d.id))?.id ?? null;
}
