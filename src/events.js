// Event envelope helpers: the wire format is unit-testable without HTTP.

export const EVENT_VERSION = 1;

// Stored rows carry the type-specific payload separately; the envelope merges it back
// into the top level so consumers see one object.
export function eventEnvelope(row) {
  let payload = {};
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
  }
  return {
    v: EVENT_VERSION,
    seq: row.seq,
    type: row.type,
    at: row.at,
    ...payload
  };
}

export function serializeEvent(envelope) {
  return JSON.stringify(envelope);
}

// "now" / "-1" mean "only future events"; 0 or omitted means "oldest retained".
export function resolveSince(value, head) {
  if (value === null || value === undefined || value === '') return 0;
  if (value === 'now' || value === '-1') return head;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return number;
}
