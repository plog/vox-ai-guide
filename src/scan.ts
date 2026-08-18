import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { claudeUserDir, countLines, exists, managedDir, readJson } from './paths';

export type Reader = 'claude' | 'copilot' | 'both';

export interface InstructionFile {
  label: string;
  file: string;
  reader: Reader;
  scope: string;
  /** VSCode setting that gates whether the file is read, when applicable. */
  gatedBy?: string;
  present: boolean;
  loaded: boolean;
  lines: number;
  note?: string;
}

export interface SettingsLayer {
  label: string;
  file: string;
  rank: number; // 1 = strongest
  present: boolean;
}

/** A VSCode setting, with the layer that wins — and the ones that lose. */
export interface VsCodeSetting {
  key: string;
  /** Why this setting matters for consumption or exposure. */
  matters: string;
  effective: unknown;
  origin: 'default' | 'user' | 'workspace' | 'folder';
  /** Layers that are set but overridden — the number one source of confusion. */
  overridden: string[];
}

export interface Tooling {
  copilot: boolean;
  copilotChat: boolean;
  claudeCode: boolean;
  codex: boolean;
}

/**
 * One MCP declaration file and the servers it names. Names only, never the `env` blocks —
 * same invariant as `Finding`: what is not carried cannot be displayed.
 */
export interface McpSource {
  label: string;
  file: string;
  servers: string[];
}

/** What ~/.codex/config.toml says about the knobs that cost tokens. */
export interface CodexInfo {
  configPresent: boolean;
  reasoningEffort?: string;
  autoCompactLimit?: number;
  mcpServers: string[];
}

export interface ScanResult {
  workspaceRoot?: string;
  instructions: InstructionFile[];
  settings: SettingsLayer[];
  vscode: VsCodeSetting[];
  tooling: Tooling;
  mcp: McpSource[];
  codex: CodexInfo;
  warnings: string[];
}

/** Settings that decide what gets loaded — hence what it costs and what leaks. */
const WATCHED: Array<{ key: string; matters: string }> = [
  { key: 'chat.useClaudeMdFile', matters: "Makes Copilot read the repo's CLAUDE.md" },
  { key: 'chat.useAgentsMdFile', matters: 'Makes Copilot read AGENTS.md' },
  { key: 'chat.useNestedAgentsMdFiles', matters: 'Extends reading to AGENTS.md in subfolders' },
  { key: 'chat.agent.maxRequests', matters: "Caps a Copilot agent's tool turns" },
  {
    key: 'claudeCode.environmentVariables',
    matters: 'Variables passed to Claude Code — a classic leak vector when set at workspace level',
  },
];

/**
 * `get()` returns the effective value without saying where it comes from; `inspect()`
 * separates the layers. That is what lets us flag a user setting overridden by the
 * workspace — and, for claudeCode.environmentVariables, that it lives in a tracked file.
 */
export function vscodeSettings(): VsCodeSetting[] {
  const cfg = vscode.workspace.getConfiguration();
  return WATCHED.map(({ key, matters }) => {
    const i = cfg.inspect<unknown>(key);
    const layers: Array<[string, unknown, VsCodeSetting['origin']]> = [
      ['default', i?.defaultValue, 'default'],
      ['user', i?.globalValue, 'user'],
      ['workspace', i?.workspaceValue, 'workspace'],
      ['folder', i?.workspaceFolderValue, 'folder'],
    ];
    const defined = layers.filter(([, v]) => v !== undefined);
    const winner = defined[defined.length - 1];
    return {
      key,
      matters,
      effective: winner?.[1],
      origin: winner?.[2] ?? 'default',
      // Everything set below the winner, excluding the default value.
      overridden: defined.slice(0, -1).filter(([n]) => n !== 'default').map(([n]) => n),
    };
  });
}

/** Do not offer a Copilot fix to someone who does not have Copilot. */
export function tooling(): Tooling {
  const has = (id: string) => vscode.extensions.getExtension(id) !== undefined;
  return {
    copilot: has('GitHub.copilot'),
    copilotChat: has('GitHub.copilot-chat'),
    claudeCode: has('anthropic.claude-code'),
    codex: has('openai.chatgpt'),
  };
}

/**
 * Every declared MCP server ships its tools' names, descriptions and JSON schemas inside
 * every request — the cost exists even on turns that never touch the server. Counting the
 * declarations is free: they live in the same files the secret scan already reads.
 */
export function mcpSources(workspaceRoot?: string): McpSource[] {
  const names = (v: unknown): string[] =>
    v && typeof v === 'object' ? Object.keys(v as Record<string, unknown>) : [];
  const out: McpSource[] = [];

  if (workspaceRoot) {
    const projMcp = path.join(workspaceRoot, '.mcp.json');
    out.push({ label: 'Project .mcp.json (Claude, committed)', file: projMcp, servers: names(readJson(projMcp).mcpServers) });
    const vscodeMcp = path.join(workspaceRoot, '.vscode', 'mcp.json');
    out.push({ label: '.vscode/mcp.json (Copilot)', file: vscodeMcp, servers: names(readJson(vscodeMcp).servers) });
  }

  const claudeJson = path.join(os.homedir(), '.claude.json');
  const personal = readJson(claudeJson);
  const global = names(personal.mcpServers);
  // ~/.claude.json also keeps per-project server lists; only this workspace's matters here.
  const projects = personal.projects as Record<string, { mcpServers?: unknown }> | undefined;
  const perProject = workspaceRoot ? names(projects?.[workspaceRoot]?.mcpServers) : [];
  out.push({
    label: 'Personal ~/.claude.json (Claude, all projects)',
    file: claudeJson,
    servers: [...new Set([...global, ...perProject])],
  });

  return out;
}

/**
 * Codex shares one config between its CLI and its VSCode extension: ~/.codex/config.toml.
 * A full TOML parser for three keys would be overkill — line-level matching is enough, and
 * wrong at worst by staying silent.
 */
export function codexInfo(): CodexInfo {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  const info: CodexInfo = { configPresent: false, mcpServers: [] };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return info;
  }
  info.configPresent = true;
  const effort = /^\s*model_reasoning_effort\s*=\s*"?([a-z]+)"?/m.exec(text);
  if (effort) {
    info.reasoningEffort = effort[1];
  }
  const compact = /^\s*model_auto_compact_token_limit\s*=\s*(\d+)/m.exec(text);
  if (compact) {
    info.autoCompactLimit = Number(compact[1]);
  }
  for (const m of text.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]/gm)) {
    info.mcpServers.push(m[1]);
  }
  return info;
}

/**
 * Lists both tools' instruction locations and says, for each, whether it exists AND
 * whether it is actually loaded (several depend on a VSCode setting).
 */
export function scan(workspaceRoot?: string): ScanResult {
  const home = claudeUserDir();
  const managed = managedDir();

  // One read of the settings, two uses: the loaded/ignored state below, and the layer
  // breakdown in the panel. `effective` already folds in the real default value — no more
  // guessing it the way `!== false` used to.
  const vscodeCfg = vscodeSettings();
  const effective = (key: string): unknown => vscodeCfg.find((s) => s.key === key)?.effective;

  const useClaudeMd = effective('chat.useClaudeMdFile') === true;
  const useAgentsMd = effective('chat.useAgentsMdFile') === true;
  const useNestedAgentsMd = effective('chat.useNestedAgentsMdFiles') === true;

  const ws = (rel: string) => (workspaceRoot ? path.join(workspaceRoot, rel) : '');

  const raw: Array<Omit<InstructionFile, 'present' | 'lines'>> = [
    {
      label: 'Managed CLAUDE.md (IT)',
      file: path.join(managed, 'CLAUDE.md'),
      reader: 'claude',
      scope: 'Whole machine — cannot be disabled',
      loaded: true,
    },
    {
      label: 'Personal CLAUDE.md',
      file: path.join(home, 'CLAUDE.md'),
      reader: 'claude',
      scope: 'You, all projects',
      loaded: true,
    },
    {
      label: 'Personal rules',
      file: path.join(home, 'rules'),
      reader: 'claude',
      scope: 'You, all projects (.md files in the folder)',
      loaded: true,
    },
    {
      label: 'Project CLAUDE.md',
      file: ws('CLAUDE.md'),
      reader: useClaudeMd ? 'both' : 'claude',
      scope: 'Team, version-controlled',
      gatedBy: 'chat.useClaudeMdFile (for Copilot)',
      loaded: true,
    },
    {
      label: 'Project CLAUDE.md (.claude/ variant)',
      file: ws('.claude/CLAUDE.md'),
      reader: 'claude',
      scope: 'Team, version-controlled',
      loaded: true,
    },
    {
      label: 'CLAUDE.local.md',
      file: ws('CLAUDE.local.md'),
      reader: 'claude',
      scope: 'You, this project — should be gitignored',
      loaded: true,
    },
    {
      label: 'Project rules',
      file: ws('.claude/rules'),
      reader: 'claude',
      scope: 'Team — loadable by glob via `paths:`',
      loaded: true,
    },
    {
      label: 'Copilot instructions',
      file: ws('.github/copilot-instructions.md'),
      reader: 'copilot',
      scope: 'Team, automatic',
      loaded: true,
    },
    {
      label: 'Targeted Copilot instructions',
      file: ws('.github/instructions'),
      reader: 'copilot',
      scope: 'Team — by glob via `applyTo:`',
      loaded: true,
    },
    {
      label: 'AGENTS.md',
      file: ws('AGENTS.md'),
      reader: 'copilot',
      scope: 'Workspace root',
      gatedBy: 'chat.useAgentsMdFile',
      loaded: useAgentsMd,
      note: 'Claude Code does NOT read AGENTS.md — you need a CLAUDE.md that imports it.',
    },
    {
      label: 'Nested AGENTS.md',
      file: ws('AGENTS.md (sous-dossiers)'),
      reader: 'copilot',
      scope: 'Subfolders, experimental',
      gatedBy: 'chat.useNestedAgentsMdFiles',
      loaded: useNestedAgentsMd,
    },
    {
      label: "Claude's automatic memory",
      file: path.join(home, 'projects', '<project>', 'memory', 'MEMORY.md'),
      reader: 'claude',
      scope: 'Written by Claude — first 200 lines loaded',
      loaded: true,
    },
  ];

  const instructions: InstructionFile[] = raw.map((r) => {
    // Descriptive entries (paths with <project> or parentheses) cannot be tested.
    const testable = r.file !== '' && !r.file.includes('<') && !r.file.includes('(');
    const present = testable ? exists(r.file) : false;
    return {
      ...r,
      present,
      lines: present && !r.file.endsWith('rules') && !r.file.endsWith('instructions') ? countLines(r.file) : 0,
    };
  });

  const settings: SettingsLayer[] = [
    { label: 'Managed (IT) — overrides everything', file: path.join(managed, 'managed-settings.json'), rank: 1, present: false },
    { label: 'Project-local', file: ws('.claude/settings.local.json'), rank: 3, present: false },
    { label: 'Project (version-controlled)', file: ws('.claude/settings.json'), rank: 4, present: false },
    { label: 'Personal', file: path.join(home, 'settings.json'), rank: 5, present: false },
  ].map((s) => ({ ...s, present: s.file !== '' && exists(s.file) }));

  return {
    workspaceRoot,
    instructions,
    settings,
    vscode: vscodeCfg,
    tooling: tooling(),
    mcp: mcpSources(workspaceRoot),
    codex: codexInfo(),
    warnings: warnings(workspaceRoot, instructions),
  };
}

function warnings(workspaceRoot: string | undefined, files: InstructionFile[]): string[] {
  const out: string[] = [];
  const find = (label: string) => files.find((f) => f.label === label);

  const claudeMd = find('Project CLAUDE.md');
  const agentsMd = find('AGENTS.md');
  const copilotMd = find('Copilot instructions');

  // One sentence each: what we found, then the move. Anything longer stops being read.
  if (copilotMd?.present && claudeMd?.present) {
    out.push(
      'Two instruction files to keep in sync — `CLAUDE.md` and `.github/copilot-instructions.md`. ' +
        'Turn on `chat.useClaudeMdFile` and keep one.',
    );
  }
  if (agentsMd?.present && !claudeMd?.present) {
    out.push(
      'An `AGENTS.md` but no `CLAUDE.md`: Claude reads nothing here. A `CLAUDE.md` containing ' +
        '`@AGENTS.md` reconciles both tools.',
    );
  }

  const userClaudeMd = find('Personal CLAUDE.md');
  if (userClaudeMd?.present && userClaudeMd.lines > 200) {
    out.push(
      `Your personal CLAUDE.md is ${userClaudeMd.lines} lines, re-sent on every turn of every project. ` +
        'Move what is not always relevant into `~/.claude/rules/`.',
    );
  }

  const projClaudeMd = claudeMd?.present ? claudeMd : find('Project CLAUDE.md (.claude/ variant)');
  if (projClaudeMd?.present && projClaudeMd.lines > 200) {
    out.push(
      `The project CLAUDE.md is ${projClaudeMd.lines} lines, re-sent on every turn. Guidance that only ` +
        'concerns some files belongs in `.github/instructions/*.instructions.md`, whose `applyTo:` glob ' +
        'loads it only for those files.',
    );
  }

  if (!workspaceRoot) {
    out.push('No folder open: the diagnostic covers your personal configuration only.');
  }
  return out;
}

/** Reads the personal Claude settings relevant to the diagnostic. */
export function claudeUserSettings(): Record<string, unknown> {
  return readJson(path.join(claudeUserDir(), 'settings.json'));
}
