import { t, resolveLanguage } from './i18n.js';

const params = new URLSearchParams(location.search);
const requested = params.get('path') ?? '';
const sessionKey = params.get('session') ?? '';

const nameEl = document.querySelector('#file-name');
const metaEl = document.querySelector('#file-meta');
const pathEl = document.querySelector('#file-path');
const noticeEl = document.querySelector('#notice');
const contentEl = document.querySelector('#file-content');
const backLabelEl = document.querySelector('#viewer-back-label');

let lang = resolveLanguage('auto', navigator.language);

function fileNameOf(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setNotice(text, tone = '') {
  noticeEl.hidden = !text;
  noticeEl.textContent = text ?? '';
  noticeEl.className = `viewer-notice${tone ? ' ' + tone : ''}`;
}

function parseLineRange(hash) {
  const match = /^#L(\d+)(?:-L?(\d+))?$/i.exec(hash ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1) return null;
  return { start, end: Math.max(start, end) };
}

function renderLines(content, range) {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) {
    contentEl.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'empty', textContent: t(lang, 'viewer.empty')
    }));
    return 0;
  }

  const fragment = document.createDocumentFragment();
  lines.forEach((text, index) => {
    const number = index + 1;
    const row = document.createElement('div');
    row.className = 'viewer-line';
    row.id = `L${number}`;
    if (range && number >= range.start && number <= range.end) row.classList.add('highlight');
    const lineNo = document.createElement('span');
    lineNo.className = 'viewer-ln';
    lineNo.textContent = String(number);
    const code = document.createElement('span');
    code.className = 'viewer-code';
    code.textContent = text;
    row.append(lineNo, code);
    fragment.append(row);
  });
  contentEl.replaceChildren(fragment);
  return lines.length;
}

async function loadLanguage() {
  try {
    const info = await fetch('/api/settings').then(res => res.json());
    lang = resolveLanguage(info.settings?.language ?? 'auto', info.systemLanguage || navigator.language);
  } catch {
    lang = resolveLanguage('auto', navigator.language);
  }
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  backLabelEl.textContent = t(lang, 'viewer.back');
}

async function loadFile() {
  if (!requested) {
    setNotice(t(lang, 'viewer.loadFailed', { message: t(lang, 'error.pathRequired') }), 'error');
    return;
  }
  nameEl.textContent = fileNameOf(requested);
  pathEl.textContent = requested;
  document.title = `${fileNameOf(requested)} · ${t(lang, 'viewer.title')}`;
  contentEl.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'empty', textContent: t(lang, 'viewer.loading')
  }));

  const query = new URLSearchParams({ path: requested });
  if (sessionKey) query.set('session', sessionKey);

  let body;
  try {
    const res = await fetch(`/api/file?${query}`);
    body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setNotice(t(lang, 'viewer.loadFailed', { message: body.error ?? res.status }), 'error');
      contentEl.replaceChildren();
      return;
    }
  } catch (error) {
    setNotice(t(lang, 'viewer.loadFailed', { message: error.message }), 'error');
    return;
  }

  nameEl.textContent = body.name;
  pathEl.textContent = body.path;
  if (body.binary) {
    metaEl.textContent = formatSize(body.size);
    setNotice(t(lang, 'viewer.binary'));
    contentEl.replaceChildren();
    return;
  }
  const count = renderLines(body.content ?? '', parseLineRange(location.hash));
  metaEl.textContent = [formatSize(body.size), t(lang, 'viewer.lines', { count })].filter(Boolean).join(' · ');
  if (body.truncated) setNotice(t(lang, 'viewer.truncated'));
  const target = document.querySelector('.viewer-line.highlight');
  if (target) target.scrollIntoView({ block: 'center' });
}

await loadLanguage();
await loadFile();
