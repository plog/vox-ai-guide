import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/** Location of "managed" settings (deployed by IT, cannot be overridden). */
export function managedDir(): string {
  switch (process.platform) {
    case 'darwin':
      return '/Library/Application Support/ClaudeCode';
    case 'win32':
      return 'C:\\Program Files\\ClaudeCode';
    default:
      return '/etc/claude-code';
  }
}

export function claudeUserDir(): string {
  return path.join(os.homedir(), '.claude');
}

/**
 * Claude Code stores transcripts under ~/.claude/projects/<encoded path>/.
 * The encoding replaces every non-alphanumeric character with a dash:
 *   /Users/you/Sites/some.project  ->  -Users-you-Sites-some-project
 */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Resolves a workspace's transcript directory, falling back to a lenient search. */
export function projectTranscriptDir(workspaceRoot: string): string | undefined {
  const root = path.join(claudeUserDir(), 'projects');
  const exact = path.join(root, encodeProjectDir(workspaceRoot));
  if (fs.existsSync(exact)) {
    return exact;
  }
  // Fallback: the encoding may have changed across versions. Look for the directory
  // whose name ends with the workspace name.
  const base = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9]/g, '-');
  try {
    const match = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith(base))
      .map((d) => path.join(root, d.name));
    return match[0];
  } catch {
    return undefined;
  }
}

/**
 * VSCode "User" directories on this machine, one per installed product variant.
 * `workspaceStorage/<hash>/chatSessions/` under these is where VSCode itself archives
 * Copilot chats — the only local trace of Copilot usage.
 */
export function vscodeUserDirs(): string[] {
  const home = os.homedir();
  const base =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  return ['Code', 'Code - Insiders', 'VSCodium']
    .map((product) => path.join(base, product, 'User'))
    .filter(exists);
}

export function codexUserDir(): string {
  return path.join(os.homedir(), '.codex');
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function countLines(p: string): number {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').length;
  } catch {
    return 0;
  }
}

/** Reads JSON, tolerating a missing file. Returns {} when unreadable. */
export function readJson(p: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Writes JSON with 2-space indentation, creating a .bak backup first. */
export function writeJson(p: string, data: unknown): void {
  if (exists(p)) {
    fs.copyFileSync(p, `${p}.bak`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
