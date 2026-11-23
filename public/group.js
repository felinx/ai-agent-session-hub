// 按工作目录（项目）分组会话。组间按组内最近更新时间倒序，组内同样倒序；
// 没有 cwd 的会话归入末尾的 null 分组。

function latestUpdatedAt(group) {
  return group.sessions.reduce((max, session) => Math.max(max, session.updatedAt ?? 0), 0);
}

export function groupSessionsByProject(sessions) {
  const groups = new Map();

  for (const session of sessions) {
    const key = session.cwd ?? '';
    let group = groups.get(key);
    if (!group) {
      group = { cwd: session.cwd ?? null, sessions: [] };
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
