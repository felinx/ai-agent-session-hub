import os from 'node:os';
import path from 'node:path';

export function loadConfig(env = process.env, argv = process.argv.slice(2)) {
  const rawPort = Number(env.SESSION_HUB_PORT);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 7317;
  const home = os.homedir();

  return {
    host: env.SESSION_HUB_HOST || '127.0.0.1',
    port,
    dbPath: env.SESSION_HUB_DB || path.join(home, '.session-hub', 'hub.db'),
    rebuild: argv.includes('--rebuild'),
    roots: {
      claude: env.CLAUDE_HOME || path.join(home, '.claude'),
      codex: env.CODEX_HOME || path.join(home, '.codex'),
      dsh: env.DSH_HOME || path.join(home, '.dsh'),
      larkChannel: env.LARK_CHANNEL_HOME || path.join(home, '.lark-channel')
    }
  };
}
