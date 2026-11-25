function formatValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// Default labels are language-neutral English; callers pass localized labels when they have them.
const DEFAULT_LABELS = {
  toolCall: name => `tool call · ${name ?? 'unknown'}`,
  toolResult: 'tool result',
  errorSuffix: ' · error'
};

export function messagePlainText(message = {}, labels = {}) {
  const { toolCall, toolResult, errorSuffix } = { ...DEFAULT_LABELS, ...labels };
  const parts = [];
  if (message.thinking) parts.push(message.thinking);
  if (message.text) parts.push(message.text);
  for (const call of message.toolCalls ?? []) {
    const header = toolCall(call.name);
    const input = formatValue(call.input);
    parts.push(input ? `${header}\n${input}` : header);
  }
  for (const result of message.toolResults ?? []) {
    const header = `${toolResult}${result.isError ? errorSuffix : ''}`;
    const output = formatValue(result.output);
    parts.push(output ? `${header}\n${output}` : header);
  }
  return parts.join('\n\n');
}

export function toolResultPlainText(result) {
  return formatValue(result?.output);
}
