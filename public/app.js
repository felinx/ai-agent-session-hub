const state = {
  agent: 'all',
  q: '',
  chat: '',
  cwd: '',
  since: '',
  selected: null,
  sessions: [],
  facets: { agents: [], chats: [], cwds: [] },
  detailSignature: null,
  loadingSessions: false
};

const $ = (selector) => document.querySelector(selector);
const listEl = $('#session-list');
const emptyEl = $('#list-empty');
const errorEl = $('#list-error');
const detailEl = $('#session-detail');
const statusEl = $('#status');
const searchEl = $('#search');
const chipsEl = $('#agent-chips');
const filtersEl = $('#filters');

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function relativeTime(ms) {
  if (!ms) return '未知时间';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ms).toLocaleDateString();
}

function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '未知';
}

function writeHash() {
  const params = new URLSearchParams();
  if (state.agent !== 'all') params.set('agent', state.agent);
  if (state.q) params.set('q', state.q);
  if (state.chat) params.set('chat', state.chat);
  if (state.cwd) params.set('cwd', state.cwd);
  if (state.since) params.set('since', state.since);
  if (state.selected) params.set('session', state.selected);
  const next = params.toString();
  const target = next ? `#${next}` : location.pathname;
  history.replaceState(null, '', target);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.agent = params.get('agent') || 'all';
  state.q = params.get('q') || '';
  state.chat = params.get('chat') || '';
  state.cwd = params.get('cwd') || '';
  state.since = params.get('since') || '';
  state.selected = params.get('session') || null;
  searchEl.value = state.q;
}

function renderChips() {
  chipsEl.replaceChildren();
  const agents = state.facets.agents ?? [];
  const total = agents.reduce((sum, item) => sum + item.count, 0);
  const entries = [{ agent: 'all', count: total }, ...agents];
  for (const entry of entries) {
    const isActive = state.agent === entry.agent;
    chipsEl.append(el('button', {
      class: `chip${isActive ? ' active' : ''}`,
      type: 'button',
      'aria-pressed': String(isActive),
      onclick: () => {
        state.agent = entry.agent;
        writeHash();
        loadSessions();
      }
    }, [
      entry.agent === 'all' ? null : el('span', { class: `dot ${entry.agent}` }),
      `${entry.agent === 'all' ? '全部' : entry.agent} ${entry.count}`
    ]));
  }
}

function selectEl(name, options, value) {
  const select = el('select', {
    class: 'filter-select',
    'aria-label': name,
    onchange: (event) => {
      state[name] = event.target.value;
      writeHash();
      loadSessions();
    }
  });
  for (const [optionValue, label] of options) {
    select.append(el('option', {
      value: optionValue,
      selected: optionValue === value ? '' : undefined,
      text: label
    }));
  }
  return select;
}

function renderFilters() {
  const chats = state.facets.chats ?? [];
  const cwds = state.facets.cwds ?? [];

  filtersEl.replaceChildren(
    selectEl('chat', [
      ['', '所有 chat'],
      ...chats.map(item => [item.chatId, item.chatId])
    ], state.chat),
    selectEl('cwd', [
      ['', '所有目录'],
      ...cwds.map(item => [item.cwd, `${item.cwd} (${item.count})`])
    ], state.cwd),
    selectEl('since', [
      ['', '所有时间'],
      ['86400000', '24 小时内'],
      ['604800000', '7 天内'],
      ['2592000000', '30 天内']
    ], state.since)
  );
}

function renderList() {
  listEl.replaceChildren();
  emptyEl.hidden = state.sessions.length > 0;

  for (const session of state.sessions) {
    const item = el('li', {
      class: `session-item${state.selected === session.key ? ' active' : ''}`,
      tabindex: '0',
      role: 'button',
      onclick: () => openSession(session.key),
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') openSession(session.key);
      }
    }, [
      el('div', { class: 'session-title-row' }, [
        el('span', { class: `dot ${session.agent}` }),
        el('strong', { class: 'session-title', text: session.title }),
        el('span', { class: 'session-time', text: relativeTime(session.updatedAt) })
      ]),
      el('div', { class: 'session-meta' }, [
        el('span', { class: 'badge', text: session.agent }),
        el('span', { text: session.chatId || '本地会话' }),
        el('span', { text: `${session.messageCount} 条消息` })
      ]),
      el('div', { class: 'session-cwd', text: session.cwd || '（无 cwd）' })
    ]);
    listEl.append(item);
  }
}

function statusLine(health) {
  if (!health) return `${state.sessions.length} 个会话`;
  const parts = [`${health.sessions} 个会话`];
  if (health.scanning) parts.push('同步中…');
  else if (health.lastSyncAt) parts.push(`上次同步 ${relativeTime(health.lastSyncAt)}`);
  if (health.warnings?.length) parts.push(`${health.warnings.length} 条警告`);
  return parts.join(' · ');
}

async function loadSessions() {
  if (state.loadingSessions) return;
  state.loadingSessions = true;

  const params = new URLSearchParams();
  if (state.agent !== 'all') params.set('agent', state.agent);
  if (state.q) params.set('q', state.q);
  if (state.chat) params.set('chat', state.chat);
  if (state.cwd) params.set('cwd', state.cwd);
  if (state.since) params.set('since', String(Date.now() - Number(state.since)));

  try {
    const [sessionsRes, healthRes] = await Promise.all([
      fetch(`/api/sessions?${params}`),
      fetch('/api/health')
    ]);
    if (!sessionsRes.ok) throw new Error(`HTTP ${sessionsRes.status}`);
    const body = await sessionsRes.json();
    state.sessions = body.sessions;
    state.facets = body.facets ?? state.facets;
    const health = healthRes.ok ? await healthRes.json() : null;

    errorEl.hidden = true;
    renderChips();
    renderFilters();
    renderList();
    statusEl.textContent = statusLine(health);
    statusEl.title = health?.warnings?.join('\n') ?? '';
  } catch (error) {
    errorEl.hidden = false;
    errorEl.textContent = `加载失败：${error.message}`;
    statusEl.textContent = '连接失败';
  } finally {
    state.loadingSessions = false;
  }
}

function detailsBlock(summary, bodyNode) {
  return el('details', {}, [el('summary', { text: summary }), bodyNode]);
}

function renderMessage(message) {
  const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? 'Agent' : message.role;
  const body = el('div', { class: 'message-body' });

  if (message.thinking) {
    body.append(detailsBlock('思考', el('pre', { class: 'thinking', text: message.thinking })));
  }
  if (message.text) {
    body.append(el('div', { class: 'message-text', text: message.text }));
  }
  for (const call of message.toolCalls ?? []) {
    body.append(detailsBlock(
      `工具调用 · ${call.name ?? 'unknown'}`,
      el('pre', { class: 'tool', text: JSON.stringify(call.input, null, 2) })
    ));
  }
  for (const result of message.toolResults ?? []) {
    body.append(detailsBlock(
      `工具结果${result.isError ? ' · 错误' : ''}`,
      el('pre', { class: 'tool', text: result.output })
    ));
  }

  return el('article', { class: `message ${message.role}` }, [
    el('div', { class: 'message-head' }, [
      el('span', { class: 'badge', text: role }),
      el('span', { class: 'message-time', text: message.at ? formatTime(message.at) : '' })
    ]),
    body
  ]);
}

function renderDetail(detail) {
  const session = detail.session;
  detailEl.replaceChildren(
    el('header', { class: 'detail-head' }, [
      el('h2', { text: session.title }),
      el('div', { class: 'detail-meta' }, [
        el('span', { class: `badge ${session.agent}`, text: session.agent }),
        el('span', { text: session.chatId ? `chat ${session.chatId}` : '本地会话' }),
        el('span', { text: `更新于 ${formatTime(session.updatedAt)}` }),
        el('span', { text: `${session.messageCount} 条消息` }),
        session.archived ? el('span', { class: 'badge', text: '已归档' }) : null
      ]),
      el('div', { class: 'detail-cwd', text: session.cwd || '（无 cwd）' })
    ]),
    el('div', { class: 'messages' }, detail.messages.map(renderMessage))
  );
}

async function openSession(key) {
  state.selected = key;
  state.detailSignature = null;
  writeHash();
  renderList();

  detailEl.replaceChildren(el('p', { class: 'empty', text: '加载中…' }));
  await refreshDetail();
}

async function refreshDetail() {
  if (!state.selected) return;
  try {
    const res = await fetch(`/api/session?key=${encodeURIComponent(state.selected)}`);
    if (res.status === 404) {
      detailEl.replaceChildren(el('p', { class: 'empty', text: '会话不存在或已被移除' }));
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = await res.json();
    const signature = `${detail.session.updatedAt}:${detail.session.messageCount}`;
    if (signature === state.detailSignature) return;
    state.detailSignature = signature;
    renderDetail(detail);
  } catch (error) {
    detailEl.replaceChildren(el('p', { class: 'error', text: `加载详情失败：${error.message}` }));
  }
}

let searchTimer;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = searchEl.value.trim();
    writeHash();
    loadSessions();
  }, 300);
});

readHash();
loadSessions();
if (state.selected) openSession(state.selected);

setInterval(loadSessions, 5000);
setInterval(refreshDetail, 3000);
