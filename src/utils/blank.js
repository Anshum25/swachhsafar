// Whether a response is "nothing to show": an empty list ([]), or a page whose items are []. A single record
// (one office, one journey, an overview) is never blank -- treating it as blank once hid the office page
// behind Manage, and the Super Admin overview before that. Used by DataState (components/ui.jsx).
export function isBlank(data) {
  if (data == null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (Array.isArray(data.items)) return data.items.length === 0;
  return false;
}
