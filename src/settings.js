import { LANGUAGE_PREFERENCES } from '../web/i18n.js';

export const SUPPORTED_AGENTS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'dsh', name: 'DeepSeek Harness' },
  { id: 'workbuddy', name: 'WorkBuddy' }
];

const AGENT_IDS = SUPPORTED_AGENTS.map(agent => agent.id);
const AGENT_ID_SET = new Set(AGENT_IDS);
const LANGUAGE_SET = new Set(LANGUAGE_PREFERENCES);
const SETTINGS_KEY = 'app';

export const DEFAULT_SETTINGS = Object.freeze({
  showEmptySessions: false,
  showTempSessions: false,
  enabledAgents: Object.freeze([...AGENT_IDS]),
  language: 'auto'
});

function invalid(code, params = {}) {
  const error = new Error(code);
  error.statusCode = 400;
  error.code = code;
  error.i18nKey = code;
  error.i18nParams = params;
  return error;
}

function defaults() {
  return {
    showEmptySessions: DEFAULT_SETTINGS.showEmptySessions,
    showTempSessions: DEFAULT_SETTINGS.showTempSessions,
    enabledAgents: [...DEFAULT_SETTINGS.enabledAgents],
    language: DEFAULT_SETTINGS.language
  };
}

function validAgents(value) {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(agent => typeof agent === 'string' && AGENT_ID_SET.has(agent)) &&
    new Set(value).size === value.length;
}

function normalizeStored(value) {
  const settings = defaults();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return settings;
  if (typeof value.showEmptySessions === 'boolean') {
    settings.showEmptySessions = value.showEmptySessions;
  }
  if (typeof value.showTempSessions === 'boolean') {
    settings.showTempSessions = value.showTempSessions;
  }
  if (validAgents(value.enabledAgents)) {
    settings.enabledAgents = [...value.enabledAgents];
  }
  if (LANGUAGE_SET.has(value.language)) {
    settings.language = value.language;
  }
  return settings;
}

export function getSettings(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
  if (!row) return defaults();
  try {
    return normalizeStored(JSON.parse(row.value));
  } catch {
    return defaults();
  }
}

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw invalid('settings.error.invalidFormat');
  }

  const next = {};
  for (const key of Object.keys(patch)) {
    if (key === 'showEmptySessions' || key === 'showTempSessions') {
      if (typeof patch[key] !== 'boolean') {
        throw invalid('settings.error.boolean', { key });
      }
      next[key] = patch[key];
    } else if (key === 'enabledAgents') {
      if (!validAgents(patch.enabledAgents)) throw invalid('settings.error.agents');
      next.enabledAgents = [...patch.enabledAgents];
    } else if (key === 'language') {
      if (!LANGUAGE_SET.has(patch.language)) throw invalid('settings.error.language');
      next.language = patch.language;
    } else {
      throw invalid('settings.error.unknownKey', { key });
    }
  }
  return next;
}

export function saveSettings(db, patch) {
  const next = { ...getSettings(db), ...validatePatch(patch) };
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
