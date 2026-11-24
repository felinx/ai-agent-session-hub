import { renderMarkdown, formatMaybeJson } from './format.js';
import { groupSessionsByProject } from './group.js';
import { messagePlainText, toolResultPlainText } from './copy.js';

const state = {
  agent: 'all',
  q: '',
  since: '',
  selected: null,
  sessions: [],
  facets: { agents: [], chats: [], cwds: [] },
  detailSignature: null,
  listSignature: null,
  loadingSessions: false
};

const STORAGE_PREFIX = 'session-hub:';

function loadKeySet(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveKeySet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {}
}

// 项目默认全部收起；记住用户展开过的项目与手动收起的区块。
const expandedProjects = loadKeySet(`${STORAGE_PREFIX}expanded-projects`);
const closedSections = loadKeySet(`${STORAGE_PREFIX}closed-sections`);

const FOLDER_CLOSED_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6c.4 0 .78.16 1.06.44L10.1 5.9H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';

const FOLDER_OPEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';

const CHEVRON_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 4l4 4-4 4"/></svg>';

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
    else if (key === 'html') node.innerHTML = value;
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

function agentIcon(agent, alt = '') {
  return el('img', {
    class: 'agent-icon',
    src: `/icons/${agent}.png`,
    alt
  });
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

const COPY_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="7" y="7" width="9" height="10" rx="2"/>' +
  '<path d="M13 4H6a2 2 0 0 0-2 2v8"/></svg>';

function copyButton(readText) {
  let timer;
  const button = el('button', {
    class: 'copy-btn',
    type: 'button',
    'data-tooltip': '复制',
    'aria-label': '复制',
    html: COPY_ICON,
    onclick: async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = typeof readText === 'function' ? readText() : readText;
      const ok = await copyToClipboard(text ?? '');
      button.dataset.tooltip = ok ? '已复制' : '复制失败';
      button.setAttribute('aria-label', ok ? '已复制' : '复制失败');
      button.classList.toggle('copied', ok);
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.dataset.tooltip = '复制';
        button.setAttribute('aria-label', '复制');
        button.classList.remove('copied');
      }, 1500);
    }
  });
  return button;
}

function relativeTime(ms) {  if (!ms) return '未知时间';
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
      entry.agent === 'all' ? null : agentIcon(entry.agent),
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
  filtersEl.replaceChildren(
    selectEl('since', [
      ['', '所有时间'],
      ['86400000', '24 小时内'],
      ['604800000', '7 天内'],
      ['2592000000', '30 天内']
    ], state.since)
  );
}

function sessionItem(session) {
  return el('li', {
    class: `session-item${state.selected === session.key ? ' active' : ''}`,
    tabindex: '0',
    role: 'button',
    title: session.title,
    onclick: () => openSession(session.key),
    onkeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') openSession(session.key);
    }
  }, [
    el('div', { class: 'session-title-row' }, [
      agentIcon(session.agent, session.agent),
      el('span', { class: 'session-title', text: session.title }),
      el('span', { class: 'session-time', text: relativeTime(session.updatedAt) })
    ])
  ]);
}

function projectLabel(cwd) {
  if (!cwd) return '未归类';
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1) || cwd;
}

function sidebarSection(label, bodyNode) {
  const key = `${STORAGE_PREFIX}closed-sections`;
  const details = el('details', {
    class: 'section',
    ...(closedSections.has(label) ? {} : { open: '' })
  }, [
    el('summary', { class: 'section-head' }, [
      label,
      el('span', { class: 'chevron', html: CHEVRON_ICON })
    ]),
    bodyNode
  ]);
  details.addEventListener('toggle', () => {
    if (details.open) closedSections.delete(label);
    else closedSections.add(label);
    saveKeySet(key, closedSections);
  });
  return el('li', { class: 'sidebar-section' }, [details]);
}

function projectNode(group) {
  const key = group.cwd ?? '';
  const details = el('details', {
    class: 'project',
    ...(expandedProjects.has(key) ? { open: '' } : {})
  }, [
    el('summary', { class: 'project-head' }, [
      el('span', { class: 'project-icon' }, [
        el('span', { class: 'folder folder-closed', html: FOLDER_CLOSED_ICON }),
        el('span', { class: 'folder folder-open', html: FOLDER_OPEN_ICON })
      ]),
      el('span', { class: 'project-name', title: group.cwd || '未归类', text: projectLabel(group.cwd) })
    ]),
    el('ul', { class: 'session-list project-sessions' }, group.sessions.map(sessionItem))
  ]);
  details.addEventListener('toggle', () => {
    if (details.open) expandedProjects.add(key);
    else expandedProjects.delete(key);
    saveKeySet(`${STORAGE_PREFIX}expanded-projects`, expandedProjects);
  });
  return el('li', { class: 'project-group' }, [details]);
}

function renderList() {
  listEl.replaceChildren();
  emptyEl.hidden = state.sessions.length > 0;
  if (!state.sessions.length) return;

  const projectGroups = groupSessionsByProject(state.sessions).map(projectNode);

  listEl.append(
    sidebarSection('项目', el('ul', { class: 'project-groups' }, projectGroups)),
    sidebarSection('最近', el('ul', { class: 'session-list recent-sessions' }, state.sessions.map(sessionItem)))
  );
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
    const listSignature = state.sessions
      .map(session => `${session.key}:${session.updatedAt}:${session.title}`)
      .join('\n');
    if (listSignature !== state.listSignature) {
      state.listSignature = listSignature;
      renderList();
    }
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

function detailsBlock(summary, bodyNode, copyText) {
  return el('details', {}, [
    el('summary', { class: 'detail-toggle' }, [summary, copyButton(copyText)]),
    bodyNode
  ]);
}

// renderMarkdown 先转义全部文本，只产出受控标签；这里注入的 HTML 不含未转义的用户输入。
function markdownBlock(text, className) {
  const html = renderMarkdown(text);
  if (!html) return el('div', { class: className, text });
  return el('div', { class: `${className} markdown`, html });
}

function jsonText(value) {
  if (typeof value === 'string') return formatMaybeJson(value) ?? value;
  if (value === undefined || value === null) return '（无参数）';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderToolResult(result) {
  const pretty = typeof result.output === 'string' ? formatMaybeJson(result.output) : null;
  if (pretty) return el('pre', { class: 'tool', text: pretty });
  return markdownBlock(result.output ?? '', 'tool-output');
}

function renderMessage(message) {
  const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? 'Agent' : message.role;
  const body = el('div', { class: 'message-body' });

  if (message.thinking) {
    body.append(detailsBlock(
      '思考',
      markdownBlock(message.thinking, 'thinking'),
      message.thinking
    ));
  }
  if (message.text) {
    body.append(markdownBlock(message.text, 'message-text'));
  }
  for (const call of message.toolCalls ?? []) {
    body.append(detailsBlock(
      `工具调用 · ${call.name ?? 'unknown'}`,
      el('pre', { class: 'tool', text: jsonText(call.input) }),
      jsonText(call.input)
    ));
  }
  for (const result of message.toolResults ?? []) {
    body.append(detailsBlock(
      `工具结果${result.isError ? ' · 错误' : ''}`,
      renderToolResult(result),
      () => toolResultPlainText(result)
    ));
  }

  return el('article', { class: `message ${message.role}` }, [
    el('div', { class: 'message-head' }, [
      el('span', { class: 'badge', text: role }),
      el('span', { class: 'message-time', text: message.at ? formatTime(message.at) : '' }),
      copyButton(() => messagePlainText(message))
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
        el('span', { class: 'agent-label' }, [
          agentIcon(session.agent),
          el('span', { text: session.agent })
        ]),
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
