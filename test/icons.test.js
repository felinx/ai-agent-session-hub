import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test('三类 agent 的图标文件存在且为 PNG', () => {
  for (const agent of ['claude', 'codex', 'dsh']) {
    const file = path.join(ROOT, 'public', 'icons', `${agent}.png`);
    const buffer = readFileSync(file);
    assert.ok(buffer.length > 0, `${agent} 图标为空`);
    assert.deepEqual([...buffer.subarray(0, 8)], PNG_MAGIC, `${agent} 不是 PNG`);
  }
});
