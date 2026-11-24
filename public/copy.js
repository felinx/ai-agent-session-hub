function formatValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function messagePlainText(message = {}) {
  const parts = [];
  if (message.thinking) parts.push(message.thinking);
  if (message.text) parts.push(message.text);
  for (const call of message.toolCalls ?? []) {
    const header = `工具调用 · ${call.name ?? 'unknown'}`;
    const input = formatValue(call.input);
    parts.push(input ? `${header}\n${input}` : header);
  }
  for (const result of message.toolResults ?? []) {
    const header = `工具结果${result.isError ? ' · 错误' : ''}`;
    const output = formatValue(result.output);
    parts.push(output ? `${header}\n${output}` : header);
  }
  return parts.join('\n\n');
}

export function toolResultPlainText(result) {
  return formatValue(result?.output);
}
