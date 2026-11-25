// Group sessions by working directory (project). Groups and their sessions are sorted by
// most recent update, both descending; sessions without a cwd land in a trailing null group.
// WorkBuddy's generated date-time directories only affect grouping — the session keeps its real cwd.

const WORKBUDDY_DEFAULT_PROJECT = 'workbuddy-default';
const WORKBUDDY_SYSTEM_DIR_RE = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;

function projectKey(session) {
  const cwd = session.cwd;
  if (session.agent !== 'workbuddy' || typeof cwd !== 'string' || !cwd) return cwd ?? '';
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return WORKBUDDY_SYSTEM_DIR_RE.test(base) ? WORKBUDDY_DEFAULT_PROJECT : cwd;
}

function latestUpdatedAt(group) {
  return group.sessions.reduce((max, session) => Math.max(max, session.updatedAt ?? 0), 0);
}

export function groupSessionsByProject(sessions) {
  const groups = new Map();

  for (const session of sessions) {
    const key = projectKey(session);
    let group = groups.get(key);
    if (!group) {
      group = { cwd: key || null, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  result.sort((a, b) => {
    if (a.cwd === null) return b.cwd === null ? 0 : 1;
    if (b.cwd === null) return -1;
    return latestUpdatedAt(b) - latestUpdatedAt(a);
  });

  return result;
}
