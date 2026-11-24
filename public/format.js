// 安全的前端渲染工具：先转义，再应用受控的 Markdown 子集。
// 本模块不依赖浏览器 API，可直接被 Node 测试导入。

import { isLocalFilePath } from './links.js';

const INLINE_CODE_PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;
const SAFE_HREF_RE = /^(https?:\/\/|mailto:|\/|\.\/|#)/i;

export function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInline(escaped) {
  const codes = [];
  let text = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, alt, src) => {
    // 只接受 http(s)、data:image 或无协议的本地路径；其余（javascript:、file: 等）保持原文。
    if (!/^(?:https?:\/\/|data:image\/|[^:]*$)/i.test(src)) return match;
    return `<img class="message-image" data-image-src="${src}" alt="${alt}" loading="lazy">`;
  });
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    if (isLocalFilePath(href)) {
      return `<a class="file-link" data-file-href="${href}" title="${href}">${label}</a>`;
    }
    if (!SAFE_HREF_RE.test(href)) return match;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  return text.replace(INLINE_CODE_PLACEHOLDER_RE, (_, index) => `<code>${codes[Number(index)]}</code>`);
}

function isBlockStart(line) {
  return /^\s*```/.test(line) ||
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line);
}

export function renderMarkdown(input) {
  if (typeof input !== 'string' || !input.trim()) return '';

  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      html.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      const body = renderInline(escapeHtml(quoted.join('\n'))).replaceAll('\n', '<br>');
      html.push(`<blockquote>${body}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(renderInline(escapeHtml(lines[i].replace(/^\s*[-*+]\s+/, ''))));
        i++;
      }
      html.push(`<ul>${items.map(item => `<li>${item}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(renderInline(escapeHtml(lines[i].replace(/^\s*\d+[.)]\s+/, ''))));
        i++;
      }
      html.push(`<ol>${items.map(item => `<li>${item}</li>`).join('')}</ol>`);
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paragraph.push(renderInline(escapeHtml(lines[i])));
      i++;
    }
    // 防御：以块语法开头但未被上面的分支消费的行（例如不完整的 ``` 围栏），
    // 按普通段落处理，保证每轮至少前进一行，避免死循环撑爆数组。
    if (paragraph.length === 0) {
      paragraph.push(renderInline(escapeHtml(lines[i])));
      i++;
    }
    html.push(`<p>${paragraph.join('<br>')}</p>`);
  }

  return html.join('\n');
}

export function formatMaybeJson(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return null;
  try {
    const value = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object') return null;
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}
