import { renderMarkdown, formatMaybeJson } from './format.js';
import { groupSessionsByProject } from './group.js';
import { messagePlainText, toolResultPlainText } from './copy.js';
import { t, resolveLanguage } from './i18n.js';
import { jumpButtonState, jumpScrollBehavior } from './scroll.js';
import { resolveImageSource } from './images.js';
import { viewerUrl } from './links.js';

const state = {
  agent: 'all',
  q: '',
  since: '',
  selected: null,
  view: 'chat',
  lang: resolveLanguage('auto', navigator.language),
  languagePreference: 'auto',
  systemLanguage: navigator.language,
  sessions: [],
  facets: { agents: [], chats: [], cwds: [] },
  health: null,
  detailSignature: null,
  listSignature: null,
  pendingScrollBottom: false,
  loadingSessions: false,
  settingsInfo: null,
  settingsSaving: false,
  settingsStatus: '',
  settingsStatusKind: '',
  statusInfo: null
};

function tr(key, params) {
  return t(state.lang, key, params);
}

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

// Projects start collapsed; remember which projects the user expanded and which sections they closed manually.
const expandedProjects = loadKeySet(`${STORAGE_PREFIX}expanded-projects`);
const closedSections = loadKeySet(`${STORAGE_PREFIX}closed-sections`);
// Compatibility with storage written before the keys were localized: the legacy localized
// section keys map to the current 'projects' / 'recent'. Kept only to migrate existing data.
if (closedSections.has('项目') || closedSections.has('最近')) {
  if (closedSections.delete('项目')) closedSections.add('projects');
  if (closedSections.delete('最近')) closedSections.add('recent');
  saveKeySet(`${STORAGE_PREFIX}closed-sections`, closedSections);
}

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
const jumpEl = $('#detail-jump');
const jumpTopEl = $('#jump-top');
const jumpBottomEl = $('#jump-bottom');
const settingsEl = $('#settings-view');
const settingsButtonEl = $('#settings-button');
const statusViewEl = $('#status-view');
const statusButtonEl = $('#status-button');
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
    src: `/assets/icons/${agent}.png`,
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
    'data-tooltip': tr('copy.copy'),
    'aria-label': tr('copy.copy'),
    html: COPY_ICON,
    onclick: async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = typeof readText === 'function' ? readText() : readText;
      const ok = await copyToClipboard(text ?? '');
      const label = ok ? tr('copy.copied') : tr('copy.failed');
      button.dataset.tooltip = label;
      button.setAttribute('aria-label', label);
      button.classList.toggle('copied', ok);
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.dataset.tooltip = tr('copy.copy');
        button.setAttribute('aria-label', tr('copy.copy'));
        button.classList.remove('copied');
      }, 1500);
    }
  });
  return button;
}

function localeTag() {
  return state.lang === 'zh' ? 'zh-CN' : 'en-US';
}

function relativeTime(ms) {
  if (!ms) return tr('common.unknownTime');
  const diff = Date.now() - ms;
  if (diff < 60_000) return tr('time.justNow');
  if (diff < 3_600_000) return tr('time.minutesAgo', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return tr('time.hoursAgo', { count: Math.floor(diff / 3_600_000) });
  if (diff < 30 * 86_400_000) return tr('time.daysAgo', { count: Math.floor(diff / 86_400_000) });
  return new Date(ms).toLocaleDateString(localeTag());
}

function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString(localeTag()) : tr('common.unknown');
}

function writeHash() {
  const params = new URLSearchParams();
  if (state.agent !== 'all') params.set('agent', state.agent);
  if (state.q) params.set('q', state.q);
  if (state.since) params.set('since', state.since);
  if (state.selected) params.set('session', state.selected);
  if (state.view !== 'chat') params.set('view', state.view);
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
  const view = params.get('view');
  state.view = view === 'settings' || view === 'status' ? view : 'chat';
  searchEl.value = state.q;
}

function renderView() {
  const settingsOpen = state.view === 'settings';
  const statusOpen = state.view === 'status';
  detailEl.hidden = settingsOpen || statusOpen;
  settingsEl.hidden = !settingsOpen;
  statusViewEl.hidden = !statusOpen;
  settingsButtonEl.classList.toggle('active', settingsOpen);
  settingsButtonEl.setAttribute('aria-pressed', String(settingsOpen));
  statusButtonEl.classList.toggle('active', statusOpen);
  statusButtonEl.setAttribute('aria-pressed', String(statusOpen));
  updateJumpButtons();
}

function updateJumpButtons() {
  if (state.view !== 'chat' || !state.selected) {
    jumpEl.hidden = true;
    return;
  }
  const { visible, showTop, showBottom } = jumpButtonState({
    scrollTop: detailEl.scrollTop,
    scrollHeight: detailEl.scrollHeight,
    clientHeight: detailEl.clientHeight
  });
  jumpEl.hidden = !visible;
  jumpTopEl.hidden = !showTop;
  jumpBottomEl.hidden = !showBottom;
}

function scrollDetailTo(where, behavior) {
  const top = where === 'top' ? 0 : detailEl.scrollHeight;
  const mode = behavior ?? jumpScrollBehavior({
    from: detailEl.scrollTop,
    to: top,
    clientHeight: detailEl.clientHeight
  });
  if (typeof detailEl.scrollTo === 'function') {
    detailEl.scrollTo({ top, behavior: mode });
  } else {
    detailEl.scrollTop = top;
  }
  if (mode === 'auto') updateJumpButtons();
}

function applyLanguage() {
  state.lang = resolveLanguage(state.languagePreference, state.systemLanguage);
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  document.title = tr('app.title');
  searchEl.placeholder = tr('search.placeholder');
  searchEl.setAttribute('aria-label', tr('search.aria'));
  chipsEl.setAttribute('aria-label', tr('chip.aria'));
  const settingsLabel = settingsButtonEl.querySelector('span');
  if (settingsLabel) settingsLabel.textContent = tr('settings.button');
  const statusLabel = statusButtonEl.querySelector('span');
  if (statusLabel) statusLabel.textContent = tr('status.button');
  emptyEl.textContent = tr('list.empty');
  renderFilters();
  if (state.listSignature !== null) {
    renderList();
    renderChips();
  }
  if (state.health) statusEl.textContent = statusLine(state.health);
  jumpTopEl.dataset.tooltip = tr('detail.jumpTop');
  jumpTopEl.setAttribute('aria-label', tr('detail.jumpTop'));
  jumpBottomEl.dataset.tooltip = tr('detail.jumpBottom');
  jumpBottomEl.setAttribute('aria-label', tr('detail.jumpBottom'));
  if (state.view === 'settings' && state.settingsInfo) {
    renderSettings();
  }
  if (state.view === 'status' && state.statusInfo) {
    renderStatus();
  }
  if (state.selected) {
    state.detailSignature = null;
    if (state.view === 'chat') refreshDetail();
  } else if (state.view === 'chat') {
    detailEl.replaceChildren(el('p', { class: 'empty', text: tr('detail.pick') }));
  }
  updateJumpButtons();
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
      `${entry.agent === 'all' ? tr('common.all') : entry.agent} ${entry.count}`
    ]));
  }
}

function selectEl(name, options, value, ariaLabel = name) {
  const select = el('select', {
    class: 'filter-select',
    name,
    'aria-label': ariaLabel,
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
      ['', tr('filter.allTime')],
      ['86400000', tr('filter.24h')],
      ['604800000', tr('filter.7d')],
      ['2592000000', tr('filter.30d')]
    ], state.since, tr('filter.aria'))
  );
}

function sessionItem(session) {
  const title = sessionTitle(session);
  return el('li', {
    class: `session-item${state.selected === session.key ? ' active' : ''}`,
    tabindex: '0',
    role: 'button',
    title,
    onclick: () => openSession(session.key),
    onkeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') openSession(session.key);
    }
  }, [
    el('div', { class: 'session-title-row' }, [
      agentIcon(session.agent, session.agent),
      el('span', { class: 'session-title', text: title }),
      el('span', { class: 'session-time', text: relativeTime(session.updatedAt) })
    ])
  ]);
}

// Titles stored by versions that wrote a fixed Chinese "untitled session" string.
// Kept only so old rows still render through i18n instead of showing the raw legacy text.
const LEGACY_UNTITLED_RE = /^未命名会话(?: · (.+))?$/;

function sessionTitle(session) {
  const title = session?.title ?? '';
  const legacy = LEGACY_UNTITLED_RE.exec(title);
  if (legacy) {
    return legacy[1] ? tr('session.untitledWithId', { id: legacy[1] }) : tr('session.untitled');
  }
  if (title) return title;
  const id = session?.nativeId ? String(session.nativeId).slice(0, 8) : '';
  return id ? tr('session.untitledWithId', { id }) : tr('session.untitled');
}

function projectLabel(cwd) {
  if (!cwd) return tr('project.uncategorized');
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1) || cwd;
}

function sidebarSection(storageKey, label, bodyNode) {
  const key = `${STORAGE_PREFIX}closed-sections`;
  const details = el('details', {
    class: 'section',
    ...(closedSections.has(storageKey) ? {} : { open: '' })
  }, [
    el('summary', { class: 'section-head' }, [
      label,
      el('span', { class: 'chevron', html: CHEVRON_ICON })
    ]),
    bodyNode
  ]);
  details.addEventListener('toggle', () => {
    if (details.open) closedSections.delete(storageKey);
    else closedSections.add(storageKey);
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
      el('span', { class: 'project-name', title: group.cwd || tr('project.uncategorized'), text: projectLabel(group.cwd) })
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
    sidebarSection('projects', tr('sidebar.projects'), el('ul', { class: 'project-groups' }, projectGroups)),
    sidebarSection('recent', tr('sidebar.recent'), el('ul', { class: 'session-list recent-sessions' }, state.sessions.map(sessionItem)))
  );
}

function statusLine(health) {
  if (!health) return tr('status.sessions', { count: state.sessions.length });
  const parts = [tr('status.sessions', { count: health.sessions })];
  if (health.scanning) parts.push(tr('status.scanning'));
  else if (health.lastSyncAt) parts.push(tr('status.lastSync', { time: relativeTime(health.lastSyncAt) }));
  if (health.warnings?.length) parts.push(tr('status.warnings', { count: health.warnings.length }));
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
    state.health = health;

    if (state.agent !== 'all' && !(state.facets.agents ?? []).some(item => item.agent === state.agent)) {
      state.agent = 'all';
      writeHash();
      state.loadingSessions = false;
      setTimeout(loadSessions, 0);
      return;
    }

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
    errorEl.textContent = tr('list.loadFailed', { message: error.message });
    statusEl.textContent = tr('status.connectionFailed');
  } finally {
    state.loadingSessions = false;
  }
}

function detailsBlock(summary, bodyNode, copyText) {
  // The copy button cannot live inside <summary>: interactive elements there are not
  // consistently accessible (Chrome reports an issue for every block), so it is a sibling
  // absolutely positioned over the summary row.
  return el('details', { class: 'detail-block' }, [
    el('summary', { class: 'detail-toggle' }, [
      el('span', { class: 'chevron', html: CHEVRON_ICON }),
      el('span', { class: 'detail-toggle-label', text: summary })
    ]),
    el('span', { class: 'detail-copy' }, [copyButton(copyText)]),
    bodyNode
  ]);
}

// renderMarkdown escapes all text first and only emits a controlled tag set; the HTML injected
// here contains no unescaped user input.
function markdownBlock(text, className) {
  const html = renderMarkdown(text);
  if (!html) return el('div', { class: className, text });
  const block = el('div', { class: `${className} markdown`, html });
  hydrateImages(block);
  hydrateFileLinks(block);
  return block;
}

// Local file links get the viewer URL after rendering, keeping line fragments such as #L58-L62.
function hydrateFileLinks(container) {
  for (const link of container.querySelectorAll('a[data-file-href]')) {
    const href = link.dataset.fileHref;
    link.removeAttribute('data-file-href');
    const url = viewerUrl(state.selected, href);
    if (!url) continue;
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}

const MISSING_IMAGE_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="4" width="14" height="12" rx="2"/>' +
  '<path d="m4.5 13 3.5-3.5 2.5 2.5 2-2 3 3"/><circle cx="12.5" cy="7.5" r="1"/>' +
  '<path d="M3 3l14 14"/></svg>';

function showMissingImage(img, source) {
  const label = tr('image.missing', { path: source });
  img.replaceWith(el('span', { class: 'image-missing', title: label }, [
    el('span', { class: 'image-missing-icon', html: MISSING_IMAGE_ICON }),
    el('span', { class: 'image-missing-text' }, [
      tr('image.missingLabel'),
      el('code', { text: source })
    ])
  ]));
}

// Images are emitted as data-image-src first and resolved to a read-only asset URL for the
// current session after rendering; a failed load (for example a deleted file) becomes a placeholder.
function hydrateImages(container) {
  const sessionKey = state.selected;
  for (const img of container.querySelectorAll('img[data-image-src]')) {
    const source = img.dataset.imageSrc;
    const resolved = resolveImageSource(sessionKey, source);
    img.removeAttribute('data-image-src');
    if (!resolved) {
      showMissingImage(img, source);
      continue;
    }
    if (!img.alt) img.alt = tr('image.alt');
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => showMissingImage(img, source), { once: true });
    img.src = resolved;
  }
}

function jsonText(value) {
  if (typeof value === 'string') return formatMaybeJson(value) ?? value;
  if (value === undefined || value === null) return tr('message.noArgs');
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

function messageLabels() {
  return {
    toolCall: name => tr('message.toolCall', { name: name ?? 'unknown' }),
    toolResult: tr('message.toolResult'),
    errorSuffix: tr('message.errorSuffix')
  };
}

function renderMessage(message) {
  const role = message.role === 'user' ? tr('role.user') : message.role === 'assistant' ? tr('role.assistant') : message.role;
  const body = el('div', { class: 'message-body' });

  if (message.thinking) {
    body.append(detailsBlock(
      tr('message.thinking'),
      markdownBlock(message.thinking, 'thinking'),
      message.thinking
    ));
  }
  if (message.text) {
    body.append(markdownBlock(message.text, 'message-text'));
  }
  for (const call of message.toolCalls ?? []) {
    body.append(detailsBlock(
      tr('message.toolCall', { name: call.name ?? 'unknown' }),
      el('pre', { class: 'tool', text: jsonText(call.input) }),
      jsonText(call.input)
    ));
  }
  for (const result of message.toolResults ?? []) {
    body.append(detailsBlock(
      `${tr('message.toolResult')}${result.isError ? tr('message.errorSuffix') : ''}`,
      renderToolResult(result),
      () => toolResultPlainText(result)
    ));
  }

  return el('article', { class: `message ${message.role}` }, [
    el('div', { class: 'message-head' }, [
      el('span', { class: 'badge', text: role }),
      el('span', { class: 'message-time', text: message.at ? formatTime(message.at) : '' }),
      copyButton(() => messagePlainText(message, messageLabels()))
    ]),
    body
  ]);
}

function renderDetail(detail) {
  const session = detail.session;
  detailEl.replaceChildren(
    el('header', { class: 'detail-head' }, [
      el('h2', { text: sessionTitle(session) }),
      el('div', { class: 'detail-meta' }, [
        el('span', { class: 'agent-label' }, [
          agentIcon(session.agent),
          el('span', { text: session.agent })
        ]),
        session.id
          ? el('span', {
              class: 'session-id',
              title: tr('detail.sessionId', { id: session.id }),
              text: `#${session.id}`
            })
          : null,
        el('span', { text: session.chatId ? tr('detail.chat', { chatId: session.chatId }) : tr('detail.localSession') }),
        el('span', { text: tr('detail.updatedAt', { time: formatTime(session.updatedAt) }) }),
        el('span', { text: tr('detail.messageCount', { count: session.messageCount }) }),
        session.archived ? el('span', { class: 'badge', text: tr('detail.archived') }) : null
      ]),
      el('div', { class: 'detail-cwd', text: session.cwd || tr('detail.noCwd') })
    ]),
    el('div', { class: 'messages' }, detail.messages.map(renderMessage))
  );
  updateJumpButtons();
}

async function openSession(key) {
  state.selected = key;
  state.view = 'chat';
  state.detailSignature = null;
  renderView();
  writeHash();
  renderList();

  detailEl.replaceChildren(el('p', { class: 'empty', text: tr('detail.loading') }));
  detailEl.scrollTop = 0;
  state.pendingScrollBottom = true;
  await refreshDetail();
  if (state.pendingScrollBottom) {
    state.pendingScrollBottom = false;
    scrollDetailTo('bottom', 'auto');
  }
}

async function refreshDetail() {
  if (state.view !== 'chat') return;
  if (!state.selected) return;
  try {
    const res = await fetch(`/api/session?key=${encodeURIComponent(state.selected)}`);
    if (res.status === 404) {
      detailEl.replaceChildren(el('p', { class: 'empty', text: tr('detail.notFound') }));
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = await res.json();
    const signature = `${detail.session.updatedAt}:${detail.session.messageCount}`;
    if (signature === state.detailSignature) return;
    state.detailSignature = signature;
    renderDetail(detail);
  } catch (error) {
    detailEl.replaceChildren(el('p', { class: 'error', text: tr('detail.loadFailed', { message: error.message }) }));
  }
}

const ROOT_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
  workbuddy: 'WorkBuddy',
  larkChannel: 'Lark Channel'
};

let settingsStatusTimer;

function switchControl(checked, onchange, { disabled = false, label = '', name = '' } = {}) {
  return el('input', {
    class: 'switch',
    type: 'checkbox',
    name: name || undefined,
    role: 'switch',
    checked: checked ? '' : undefined,
    disabled: disabled ? '' : undefined,
    'aria-label': label,
    onchange
  });
}

function settingRow(label, hint, control, icon = null) {
  return el('label', { class: 'setting-row' }, [
    el('div', { class: 'setting-main' }, [
      icon ? el('span', { class: 'setting-icon' }, [icon]) : null,
      el('div', { class: 'setting-copy' }, [
        el('span', { class: 'setting-label', text: label }),
        hint ? el('span', { class: 'setting-hint', text: hint }) : null
      ])
    ]),
    control
  ]);
}

function pathRow(label, value) {
  const text = value || tr('settings.rootUnavailable');
  return el('div', { class: 'path-row' }, [
    el('div', { class: 'path-copy' }, [
      el('span', { class: 'path-label', text: label }),
      el('code', { class: 'path-value', title: text, text })
    ]),
    value ? copyButton(value) : null
  ]);
}

function settingsSection(title, hint, children) {
  return el('section', { class: 'settings-card' }, [
    el('h3', { text: title }),
    hint ? el('p', { class: 'settings-card-hint', text: hint }) : null,
    el('div', { class: 'settings-rows' }, children)
  ]);
}

function setSettingsStatus(text, kind = '') {
  state.settingsStatus = text;
  state.settingsStatusKind = kind;
  const node = settingsEl.querySelector('.settings-status');
  if (!node) return;
  node.textContent = text;
  node.className = `settings-status${kind ? ` ${kind}` : ''}`;
}

function toggleAgent(id, enabled) {
  const info = state.settingsInfo;
  if (!info || state.settingsSaving) return;
  const current = info.settings.enabledAgents;
  const next = enabled ? [...current, id] : current.filter(agent => agent !== id);
  const order = info.agents.map(agent => agent.id);
  next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (!next.length) {
    renderSettings();
    return;
  }
  updateSettings({ enabledAgents: next });
}

function languageRow(settings, disabled) {
  const select = el('select', {
    class: 'filter-select language-select',
    name: 'language',
    'aria-label': tr('settings.language'),
    disabled: disabled ? '' : undefined,
    onchange: (event) => updateSettings({ language: event.target.value })
  });
  for (const [value, key] of [
    ['auto', 'settings.languageAuto'],
    ['zh', 'settings.languageZh'],
    ['en', 'settings.languageEn']
  ]) {
    select.append(el('option', {
      value,
      selected: settings.language === value ? '' : undefined,
      text: tr(key)
    }));
  }
  return settingRow(tr('settings.language'), tr('settings.languageHint'), select);
}

function renderSettings() {
  const info = state.settingsInfo;
  if (!info) {
    settingsEl.replaceChildren(el('p', { class: 'empty', text: tr('settings.loading') }));
    return;
  }

  const { settings, agents, dbPath, roots } = info;
  const saving = state.settingsSaving;
  const visibilityHint = saving ? tr('settings.saving') : '';

  const agentRows = agents.map(agent => {
    const enabled = settings.enabledAgents.includes(agent.id);
    const lastEnabled = enabled && settings.enabledAgents.length === 1;
    return settingRow(
      agent.name,
      lastEnabled ? tr('settings.agentLast')
        : enabled ? tr('settings.agentEnabled') : tr('settings.agentDisabled'),
      switchControl(enabled, (event) => toggleAgent(agent.id, event.target.checked), {
        disabled: saving || lastEnabled,
        label: tr('settings.enableAgent', { name: agent.name }),
        name: `agent-${agent.id}`
      }),
      agentIcon(agent.id)
    );
  });

  const rootRows = Object.entries(roots || {}).map(([key, value]) =>
    pathRow(key === 'larkChannel' ? tr('settings.larkChannel') : (ROOT_LABELS[key] ?? key), value)
  );

  settingsEl.replaceChildren(
    el('div', { class: 'settings-inner' }, [
      el('header', { class: 'settings-head' }, [
        el('div', {}, [
          el('h2', { text: tr('settings.title') })
        ]),
        el('button', { class: 'settings-back', type: 'button', onclick: closeSettings }, [
          el('span', { class: 'back-icon', html: CHEVRON_ICON }),
          tr('settings.back')
        ])
      ]),
      el('p', { class: 'settings-intro', text: tr('settings.intro') }),
      settingsSection(tr('settings.language'), '', [
        languageRow(settings, saving)
      ]),
      settingsSection(tr('settings.display'), visibilityHint || tr('settings.displayHint'), [
        settingRow(
          tr('settings.showEmpty'),
          tr('settings.showEmptyHint'),
          switchControl(settings.showEmptySessions, (event) =>
            updateSettings({ showEmptySessions: event.target.checked }), {
            disabled: saving,
            label: tr('settings.showEmpty'),
            name: 'showEmptySessions'
          })
        ),
        settingRow(
          tr('settings.showTemp'),
          tr('settings.showTempHint'),
          switchControl(settings.showTempSessions, (event) =>
            updateSettings({ showTempSessions: event.target.checked }), {
            disabled: saving,
            label: tr('settings.showTemp'),
            name: 'showTempSessions'
          })
        )
      ]),
      settingsSection(tr('settings.agents'), tr('settings.agentsHint'), agentRows),
      settingsSection(tr('settings.data'), tr('settings.dataHint'), [
        pathRow(tr('settings.database'), dbPath),
        ...rootRows
      ]),
      el('p', {
        class: `settings-status${state.settingsStatusKind ? ` ${state.settingsStatusKind}` : ''}`,
        role: 'status',
        text: state.settingsStatus
      })
    ])
  );
}

function statusAgentCard(stat) {
  const latest = stat.latest;
  return el('section', { class: 'settings-card status-card' }, [
    el('header', { class: 'status-card-head' }, [
      el('span', { class: 'agent-label' }, [
        agentIcon(stat.agent),
        el('span', { text: stat.agent })
      ]),
      el('span', {
        class: 'status-card-sync',
        text: stat.lastSyncAt ? tr('status.agentLastSync', { time: formatTime(stat.lastSyncAt) }) : tr('status.neverScan')
      })
    ]),
    el('p', { class: 'status-card-stats' }, [
      el('span', { text: tr('status.totalSessions', { count: stat.sessions }) }),
      el('span', { text: tr('status.totalMessages', { count: stat.messages }) })
    ]),
    latest
      ? el('div', { class: 'status-latest' }, [
          el('p', { class: 'status-latest-label', text: tr('status.latestTitle') }),
          el('button', {
            class: 'status-latest-link',
            type: 'button',
            title: tr('status.openLatest'),
            onclick: () => openSession(latest.key)
          }, [
            el('span', { class: 'session-id', text: `#${latest.id}` }),
            el('span', {
              class: 'status-latest-summary',
              text: latest.summary || tr('status.noSummary')
            })
          ])
        ])
      : el('p', { class: 'empty', text: tr('status.latestEmpty') })
  ]);
}

function renderStatus() {
  const info = state.statusInfo;
  if (!info) {
    statusViewEl.replaceChildren(el('p', { class: 'empty', text: tr('status.loading') }));
    return;
  }

  const scanText = info.scanning
    ? tr('status.scanActive')
    : info.lastSyncAt ? tr('status.lastScan', { time: formatTime(info.lastSyncAt) }) : tr('status.neverScan');

  statusViewEl.replaceChildren(
    el('div', { class: 'settings-inner' }, [
      el('header', { class: 'settings-head' }, [
        el('div', {}, [
          el('h2', { text: tr('status.title') })
        ]),
        el('button', { class: 'settings-back', type: 'button', onclick: closeStatus }, [
          el('span', { class: 'back-icon', html: CHEVRON_ICON }),
          tr('status.back')
        ])
      ]),
      el('p', { class: 'settings-intro', text: tr('status.intro') }),
      el('div', { class: 'status-summary' }, [
        el('span', { class: 'status-pill', text: tr('status.totalSessions', { count: info.totals.sessions }) }),
        el('span', { class: 'status-pill', text: tr('status.totalMessages', { count: info.totals.messages }) }),
        el('span', { class: 'status-pill', text: scanText })
      ]),
      el('div', { class: 'status-grid' }, info.agents.map(statusAgentCard))
    ])
  );
}

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.statusInfo = await res.json();
    if (state.view === 'status') renderStatus();
  } catch (error) {
    if (state.view === 'status') {
      statusViewEl.replaceChildren(el('p', {
        class: 'error',
        text: tr('status.loadFailed', { message: error.message })
      }));
    }
  }
}

async function fetchSettings() {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function adoptSettings(info) {
  state.settingsInfo = info;
  state.languagePreference = info.settings.language ?? 'auto';
  state.systemLanguage = info.systemLanguage || navigator.language;
  applyLanguage();
}

async function hydrateSettings() {
  try {
    adoptSettings(await fetchSettings());
  } catch {
    // Fall back to the system language; other settings keep their defaults.
  }
}

async function loadSettings() {
  try {
    adoptSettings(await fetchSettings());
    state.settingsStatus = '';
    state.settingsStatusKind = '';
    renderSettings();
  } catch (error) {
    settingsEl.replaceChildren(el('p', {
      class: 'error',
      text: tr('settings.loadFailed', { message: error.message })
    }));
  }
}

function openSettings() {
  state.view = 'settings';
  writeHash();
  renderView();
  settingsEl.scrollTop = 0;
  if (state.settingsInfo) renderSettings();
  else loadSettings();
}

function closeSettings() {
  state.view = 'chat';
  writeHash();
  renderView();
  if (!state.selected) {
    detailEl.replaceChildren(el('p', { class: 'empty', text: tr('detail.pick') }));
  } else {
    refreshDetail();
  }
}

function openStatus() {
  state.view = 'status';
  writeHash();
  renderView();
  statusViewEl.scrollTop = 0;
  if (state.statusInfo) renderStatus();
  else {
    statusViewEl.replaceChildren(el('p', { class: 'empty', text: tr('status.loading') }));
    loadStatus();
  }
}

function closeStatus() {
  closeSettings();
}

async function updateSettings(patch) {
  if (state.settingsSaving) return;
  state.settingsSaving = true;
  clearTimeout(settingsStatusTimer);
  setSettingsStatus(tr('settings.saving'));
  renderSettings();

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    state.settingsInfo = { ...state.settingsInfo, settings: body.settings };
    state.settingsSaving = false;
    state.languagePreference = body.settings.language ?? 'auto';
    if (state.agent !== 'all' && !body.settings.enabledAgents.includes(state.agent)) {
      state.agent = 'all';
    }
    state.listSignature = null;
    writeHash();
    applyLanguage();
    setSettingsStatus(tr('settings.saved'), 'ok');
    loadSessions();

    clearTimeout(settingsStatusTimer);
    settingsStatusTimer = setTimeout(() => {
      setSettingsStatus('');
    }, 2000);
  } catch (error) {
    state.settingsSaving = false;
    renderSettings();
    setSettingsStatus(tr('settings.saveFailed', { message: error.message }), 'error');
  }
}

settingsButtonEl.addEventListener('click', () => {
  if (state.view === 'settings') closeSettings();
  else openSettings();
});

statusButtonEl.addEventListener('click', () => {
  if (state.view === 'status') closeStatus();
  else openStatus();
});

jumpTopEl.addEventListener('click', () => scrollDetailTo('top'));
jumpBottomEl.addEventListener('click', () => scrollDetailTo('bottom'));
detailEl.addEventListener('scroll', updateJumpButtons, { passive: true });
window.addEventListener('resize', updateJumpButtons);

let searchTimer;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = searchEl.value.trim();
    writeHash();
    loadSessions();
  }, 300);
});

async function init() {
  readHash();
  await hydrateSettings();
  applyLanguage();
  renderView();
  loadSessions();
  if (state.view === 'settings') loadSettings();
  else if (state.view === 'status') loadStatus();
  else if (state.selected) openSession(state.selected);

  setInterval(loadSessions, 5000);
  setInterval(refreshDetail, 3000);
  setInterval(() => {
    if (state.view === 'status') loadStatus();
  }, 5000);
}

init();
