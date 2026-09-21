import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Which conversation is open in front of the user.
 *
 * Claude Code exposes no API for this, and VSCode's own tab API deliberately hides a
 * webview's identity: `TabInputWebview` carries a `viewType` and nothing else, so two chat
 * tabs are indistinguishable through it. Matching on the tab *title* does not work either —
 * a transcript often has no slug, in which case its name is the opening words of the first
 * message, which is not what the tab shows.
 *
 * What does work: the Claude Code extension records its open chat tabs in VSCode's own
 * workspace state database, under its publisher key, as a list of `{sessionId, title}` in
 * tab order. Crossing that list with the *position* of the active chat tab identifies the
 * session — an index, not a name.
 *
 * This reads another extension's private storage, so it is written to fail silently: any
 * rename on their side, any schema change, any locked database, and every function here
 * returns undefined and the caller falls back to its previous behaviour.
 */

const STATE_KEY = 'Anthropic.claude-code';

function storageRoot(): string | undefined {
  const home = os.homedir();
  // Only stable VSCode is checked: Insiders and forks use their own product folder, and a
  // wrong guess here would silently describe another installation's tabs.
  const dir =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')
      : process.platform === 'win32'
        ? path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage')
        : path.join(home, '.config', 'Code', 'User', 'workspaceStorage');
  return fs.existsSync(dir) ? dir : undefined;
}

/** The storage folder VSCode allocated to this workspace, found by its recorded folder uri. */
function workspaceStorageDir(workspaceRoot: string): string | undefined {
  const root = storageRoot();
  if (!root) {
    return undefined;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, entry.name, 'workspace.json'), 'utf8'));
      const folder = typeof meta?.folder === 'string' ? decodeURIComponent(meta.folder) : '';
      if (folder.replace(/^file:\/\//, '') === workspaceRoot) {
        return path.join(root, entry.name);
      }
    } catch {
      // Not a folder workspace, or metadata we do not understand: keep looking.
    }
  }
  return undefined;
}

interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

/**
 * One value out of VSCode's state database, read-only, through `node:sqlite` — the same
 * mechanism `codexSpend()` already uses in `usage.ts`, so this adds no dependency and no
 * external binary. Resolved at call time: an older Node inside VSCode simply yields nothing.
 */
function readStateValue(dir: string, key: string): string | undefined {
  const file = path.join(dir, 'state.vscdb');
  if (!fs.existsSync(file)) {
    return undefined;
  }
  let db: SqliteDb | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true }) as SqliteDb;
    const rows = db.prepare('SELECT value FROM ItemTable WHERE key = ?').all(key) as {
      value?: unknown;
    }[];
    const value = rows[0]?.value;
    return typeof value === 'string' ? value : undefined;
  } catch {
    // No node:sqlite, database busy, or the row is absent: the caller falls back.
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a database that never opened is not an error worth reporting.
    }
  }
}

/**
 * The open chat tabs, as the Claude Code extension itself records them: session id and the
 * tab title it gave each one. The title is the join key, not the position — the stored list
 * reorders as tabs are moved or reopened, so an index silently points at the wrong chat.
 * The title, by contrast, is the very string VSCode shows on the tab, ellipsis included,
 * because both come from the same extension.
 */
export function openChatTabs(workspaceRoot: string): { sessionId: string; title: string }[] {
  const dir = workspaceStorageDir(workspaceRoot);
  if (!dir) {
    return [];
  }
  const raw = readStateValue(dir, STATE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const tabs = JSON.parse(raw)?.panelTabSessions;
    if (!Array.isArray(tabs)) {
      return [];
    }
    return tabs
      .map((t: { sessionId?: unknown; title?: unknown }) => ({
        sessionId: typeof t?.sessionId === 'string' ? t.sessionId : '',
        title: typeof t?.title === 'string' ? t.title : '',
      }))
      .filter((t) => t.sessionId && t.title);
  } catch {
    // Their schema changed under us: say nothing and let the caller fall back.
    return [];
  }
}
