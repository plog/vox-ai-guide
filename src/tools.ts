import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Every AI tool leaves traces on the machine, and each one invents its own layout.
 *
 * Hard-coding Claude and Copilot paths covered two tools out of a dozen: a developer on
 * Cursor, Continue or Aider was scanned for nothing at all. Worse, some of those traces are
 * whole conversations in clear text — `~/.continue/sessions/*.json` runs to hundreds of KB
 * of everything that was said and pasted, the same exposure as Claude's transcripts, with
 * nobody watching it.
 *
 * So the catalogue is declarative and lives here, alone. Adding a tool is adding an entry.
 */

export type TraceKind =
  /** Loaded into the prompt on every turn: costs tokens, and leaks whatever it contains. */
  | 'instructions'
  /** Executable config: the usual home of API keys. */
  | 'config'
  /** Conversation logs in clear text: everything that hit the screen, kept on disk. */
  | 'history';

export interface TracePattern {
  kind: TraceKind;
  base: 'home' | 'workspace';
  /** Relative path. A single `*` segment is supported — no glob dependency needed. */
  rel: string;
  /** Why this file matters, in the user's words. */
  note?: string;
}

export interface AiTool {
  id: string;
  name: string;
  traces: TracePattern[];
}

/**
 * Paths verified on a real machine where the tool was installed, or taken from the tool's
 * own documentation. An entry that turns out to be wrong shows up as "not detected", never
 * as a false alarm — which is the right way to be wrong here.
 */
export const AI_TOOLS: AiTool[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    traces: [
      { kind: 'config', base: 'home', rel: '.claude/settings.json', note: 'may hold an env block' },
      { kind: 'config', base: 'home', rel: '.claude.json' },
      { kind: 'instructions', base: 'home', rel: '.claude/CLAUDE.md' },
      { kind: 'instructions', base: 'home', rel: '.claude/rules/*.md' },
      { kind: 'config', base: 'home', rel: '.claude/agents/*.md' },
      { kind: 'instructions', base: 'workspace', rel: 'CLAUDE.md' },
      { kind: 'instructions', base: 'workspace', rel: 'CLAUDE.local.md' },
      { kind: 'instructions', base: 'workspace', rel: '.claude/CLAUDE.md' },
      { kind: 'instructions', base: 'workspace', rel: '.claude/rules/*.md' },
      { kind: 'config', base: 'workspace', rel: '.claude/settings.json' },
      { kind: 'config', base: 'workspace', rel: '.claude/settings.local.json' },
      { kind: 'config', base: 'workspace', rel: '.mcp.json', note: 'designed to be committed' },
    ],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    traces: [
      { kind: 'config', base: 'home', rel: '.copilot/config.json' },
      { kind: 'history', base: 'home', rel: '.copilot/logs/*.log' },
      { kind: 'instructions', base: 'workspace', rel: '.github/copilot-instructions.md' },
      { kind: 'instructions', base: 'workspace', rel: '.github/instructions/*.md' },
      { kind: 'instructions', base: 'workspace', rel: 'AGENTS.md' },
      {
        kind: 'config',
        base: 'workspace',
        rel: '.vscode/settings.json',
        note: 'version-controlled by default',
      },
      { kind: 'config', base: 'workspace', rel: '.vscode/mcp.json' },
    ],
  },
  {
    id: 'continue',
    name: 'Continue',
    traces: [
      { kind: 'config', base: 'home', rel: '.continue/config.yaml', note: 'model API keys live here' },
      { kind: 'config', base: 'home', rel: '.continue/config.json', note: 'model API keys live here' },
      {
        kind: 'history',
        base: 'home',
        rel: '.continue/sessions/*.json',
        note: 'full conversations in clear text',
      },
      { kind: 'instructions', base: 'workspace', rel: '.continuerules' },
      { kind: 'config', base: 'workspace', rel: '.continue/config.yaml' },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    traces: [
      { kind: 'config', base: 'home', rel: '.cursor/mcp.json' },
      { kind: 'instructions', base: 'workspace', rel: '.cursorrules' },
      { kind: 'instructions', base: 'workspace', rel: '.cursor/rules/*.mdc' },
      { kind: 'config', base: 'workspace', rel: '.cursor/mcp.json' },
    ],
  },
  {
    id: 'windsurf',
    name: 'Windsurf / Codeium',
    traces: [
      { kind: 'config', base: 'home', rel: '.codeium/config.json' },
      { kind: 'instructions', base: 'workspace', rel: '.windsurfrules' },
      { kind: 'instructions', base: 'workspace', rel: '.windsurf/rules/*.md' },
    ],
  },
  {
    id: 'aider',
    name: 'Aider',
    traces: [
      { kind: 'config', base: 'home', rel: '.aider.conf.yml' },
      { kind: 'config', base: 'workspace', rel: '.aider.conf.yml' },
      {
        kind: 'history',
        base: 'workspace',
        rel: '.aider.chat.history.md',
        note: 'sits in the project — check it is gitignored',
      },
      { kind: 'history', base: 'workspace', rel: '.aider.input.history' },
      { kind: 'instructions', base: 'workspace', rel: 'CONVENTIONS.md' },
    ],
  },
  {
    id: 'cline',
    name: 'Cline / Roo',
    traces: [
      { kind: 'instructions', base: 'workspace', rel: '.clinerules' },
      { kind: 'instructions', base: 'workspace', rel: '.clinerules/*.md' },
      { kind: 'instructions', base: 'workspace', rel: '.roorules' },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    traces: [
      { kind: 'config', base: 'home', rel: '.gemini/settings.json' },
      { kind: 'instructions', base: 'home', rel: '.gemini/GEMINI.md' },
      { kind: 'instructions', base: 'workspace', rel: 'GEMINI.md' },
      { kind: 'config', base: 'workspace', rel: '.gemini/settings.json' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    traces: [
      { kind: 'config', base: 'home', rel: '.codex/config.toml' },
      { kind: 'config', base: 'home', rel: '.codex/auth.json', note: 'holds the account token' },
      { kind: 'history', base: 'home', rel: '.codex/history.jsonl' },
      { kind: 'instructions', base: 'home', rel: '.codex/AGENTS.md' },
    ],
  },
  {
    id: 'amazon-q',
    name: 'Amazon Q',
    traces: [
      { kind: 'config', base: 'home', rel: '.aws/amazonq/mcp.json' },
      { kind: 'instructions', base: 'workspace', rel: '.amazonq/rules/*.md' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    traces: [{ kind: 'config', base: 'home', rel: '.ollama/config.json' }],
  },
];

// --- Resolution -------------------------------------------------------------

/** Expands the one `*` segment we support. Returns real paths only. */
function expand(base: string, rel: string): string[] {
  const star = rel.indexOf('*');
  if (star < 0) {
    const p = path.join(base, rel);
    return fs.existsSync(p) ? [p] : [];
  }

  const dir = path.join(base, path.dirname(rel));
  const pattern = path.basename(rel);
  const [prefix, suffix] = pattern.split('*');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) => e.isFile() && e.name.startsWith(prefix ?? '') && e.name.endsWith(suffix ?? ''),
      )
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

export interface Trace {
  tool: string;
  toolId: string;
  kind: TraceKind;
  file: string;
  note?: string;
  /** Instructions are sent to the model on every turn; the rest is not. */
  loadedInPrompt: boolean;
}

export interface DetectedTool {
  id: string;
  name: string;
  /** A tool with no trace still gets a row: an absent tool is a result, not a blank. */
  detected: boolean;
  traces: Trace[];
}

/**
 * Walks the catalogue and returns what actually exists. This is the automatic detection:
 * no tool list to maintain in the UI, no path repeated across modules.
 */
export function detectTraces(workspaceRoot?: string): DetectedTool[] {
  const home = os.homedir();

  return AI_TOOLS.map((tool) => {
    const traces: Trace[] = [];
    for (const p of tool.traces) {
      const root = p.base === 'home' ? home : workspaceRoot;
      if (!root) {
        continue;
      }
      for (const file of expand(root, p.rel)) {
        traces.push({
          tool: tool.name,
          toolId: tool.id,
          kind: p.kind,
          file,
          note: p.note,
          loadedInPrompt: p.kind === 'instructions',
        });
      }
    }
    return { id: tool.id, name: tool.name, detected: traces.length > 0, traces };
  });
}

/** Flat list, for the scanners. `history` is excluded: those files are huge, scanned on demand. */
export function scannableTraces(workspaceRoot?: string): Trace[] {
  return detectTraces(workspaceRoot)
    .flatMap((t) => t.traces)
    .filter((t) => t.kind !== 'history');
}

/** Conversation logs, in clear text, from every detected tool. */
export function historyTraces(workspaceRoot?: string): Trace[] {
  return detectTraces(workspaceRoot)
    .flatMap((t) => t.traces)
    .filter((t) => t.kind === 'history');
}
