// Shared turn-detection helpers. A source's completion marker can be written before the
// last line of a turn, so inference waits for the source file to stop changing.
export const SETTLE_MS = 5000;

export function isSettled(mtimeMs, now = Date.now()) {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return false;
  return now - mtimeMs >= SETTLE_MS;
}
