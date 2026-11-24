import { createHash } from 'node:crypto';

// Stable short id for a session, derived from its key rather than a database rowid,
// so it survives --rebuild and stays the same across machines for the same key.
export function sessionId(key = '') {
  return createHash('sha1').update(String(key)).digest('hex').slice(0, 8);
}
