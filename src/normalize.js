const BRIDGE_CONTEXT_RE = /<bridge_(context|instructions)>[\s\S]*?<\/bridge_\1>/g;

const SYNTHETIC_PREFIX_RE =
  /^<(environment_context|recommended_plugins|user_instructions|local-command-caveat|local-command-stdout|command-name|system-reminder)\b/;

export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text'))
    .map(block => block.text ?? '')
    .filter(text => text !== '')
    .join('\n');
}

export function stripBridgeContext(text) {
  if (typeof text !== 'string') return '';
  const withoutMeta = text.replace(BRIDGE_CONTEXT_RE, '');

  const userInput = withoutMeta.match(/<user_input>([\s\S]*?)<\/user_input>/);
  if (userInput) {
    const inner = userInput[1].trim();
    try {
      const parsed = JSON.parse(inner);
      if (parsed && typeof parsed.text === 'string') return parsed.text.trim();
    } catch {}
    return inner;
  }

  return withoutMeta.trim();
}

export function isSyntheticUserText(text) {
  if (typeof text !== 'string') return false;
  return SYNTHETIC_PREFIX_RE.test(text.replace(/^﻿/, '').trim());
}

export function truncate(text, n) {
  if (typeof text !== 'string') return '';
  return text.slice(0, n);
}

// First non-empty trimmed line, truncated — used for log and status one-line summaries.
export function oneLine(text, limit = 100) {
  if (typeof text !== 'string') return '';
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '') ?? '';
  return line.slice(0, limit);
}

export function deriveTitle(text, fallback = '') {
  const stripped = stripBridgeContext(text);
  const line = stripped.split('\n').map(l => l.trim()).find(l => l !== '') ?? '';
  return line ? truncate(line, 80) : fallback;
}

export function toEpochMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
