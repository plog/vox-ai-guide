import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { claudeUserDir, countLines, exists, managedDir, readJson } from './paths';

/**
 * Who reads the file. 'other' covers the rest of the ecosystem — Cursor, Windsurf, Cline,
 * Gemini, Codex, Zed, Aider, Junie. None of them is installed here necessarily; they are
 * listed because a repo carries these files for the whole team, and because knowing the
 * landscape is half of what this panel teaches.
 */
export type Reader = 'claude' | 'copilot' | 'both' | 'other';

export interface InstructionFile {
  label: string;
  file: string;
  reader: Reader;
  scope: string;
  /** VSCode setting that gates whether the file is read, when applicable. */
  gatedBy?: string;
  present: boolean;
  loaded: boolean;
  /**
   * Read only when something calls for it — a skill invoked, a sub-agent spawned, a slash
   * command typed. The distinction matters more than presence: an always-loaded file is
   * re-sent on every single turn and you pay for it every time, an on-demand one costs
   * nothing until it is used. It is the whole argument for moving bulk out of CLAUDE.md.
   */
  onDemand?: boolean;
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
    // Loaded on demand. Claude Code keeps only the name and description of each skill,
    // sub-agent and command in the always-on context; the body arrives when one is used.
    // People write huge CLAUDE.md files precisely because nobody told them these exist.
    {
      label: 'Skills (project)',
      file: ws('.claude/skills'),
      reader: 'claude',
      scope: 'Team — one SKILL.md per folder, body read when the skill runs',
      loaded: true,
      onDemand: true,
    },
    {
      label: 'Skills (personal)',
      file: path.join(home, 'skills'),
      reader: 'claude',
      scope: 'You, all projects',
      loaded: true,
      onDemand: true,
    },
    {
      label: 'Sub-agents (project)',
      file: ws('.claude/agents'),
      reader: 'claude',
      scope: 'Team — each .md is a separate agent with its own prompt',
      loaded: true,
      onDemand: true,
    },
    {
      label: 'Sub-agents (personal)',
      file: path.join(home, 'agents'),
      reader: 'claude',
      scope: 'You, all projects',
      loaded: true,
      onDemand: true,
    },
    {
      label: 'Slash commands (project)',
      file: ws('.claude/commands'),
      reader: 'claude',
      scope: 'Team — .md read only when you type /its-name',
      loaded: true,
      onDemand: true,
    },
    {
      label: 'Slash commands (personal)',
      file: path.join(home, 'commands'),
      reader: 'claude',
      scope: 'You, all projects',
      loaded: true,
      onDemand: true,
    },
    {
      label: 'Prompt files (Copilot)',
      file: ws('.github/prompts'),
      reader: 'copilot',
      scope: 'Team — *.prompt.md, run from the chat box',
      loaded: true,
      onDemand: true,
    },
    {
      label: 'Chat modes (Copilot)',
      file: ws('.github/chatmodes'),
      reader: 'copilot',
      scope: 'Team — *.chatmode.md, picked in the chat mode menu',
      loaded: true,
      onDemand: true,
    },
    {
      label: "Claude's automatic memory",
      file: path.join(home, 'projects', '<project>', 'memory', 'MEMORY.md'),
      reader: 'claude',
      scope: 'Written by Claude — first 200 lines loaded',
      loaded: true,
    },
    // The rest of the ecosystem. Nobody has every one of these tools installed — the point
    // is the opposite: these files travel in the repo, so a teammate on Cursor or Windsurf
    // is being steered by a file you may never have opened. And a stale one still counts:
    // Zed picks the FIRST match in its own order, so a leftover .cursorrules silently wins
    // over the AGENTS.md someone carefully wrote.
    { label: 'Cursor rules', file: ws('.cursor/rules'), reader: 'other', scope: 'Cursor — *.mdc, each with its own glob', loaded: true, onDemand: true },
    { label: '.cursorrules (legacy)', file: ws('.cursorrules'), reader: 'other', scope: 'Cursor — deprecated, still read', loaded: true, note: 'Deprecated in favour of .cursor/rules — and it takes priority over AGENTS.md in some editors.' },
    { label: 'Windsurf rules', file: ws('.windsurf/rules'), reader: 'other', scope: 'Windsurf — multi-file form', loaded: true, onDemand: true },
    { label: '.windsurfrules (legacy)', file: ws('.windsurfrules'), reader: 'other', scope: 'Windsurf — single file', loaded: true },
    { label: '.clinerules', file: ws('.clinerules'), reader: 'other', scope: 'Cline — file or folder', loaded: true },
    { label: 'Roo rules', file: ws('.roo/rules'), reader: 'other', scope: 'Roo Code', loaded: true, onDemand: true },
    { label: 'Continue rules', file: ws('.continue/rules'), reader: 'other', scope: 'Continue', loaded: true, onDemand: true },
    { label: 'GEMINI.md', file: ws('GEMINI.md'), reader: 'other', scope: 'Gemini CLI / Code Assist', loaded: true },
    { label: 'Gemini style guide', file: ws('.gemini/styleguide.md'), reader: 'other', scope: 'Gemini Code Assist — review style', loaded: true },
    { label: '.aiexclude', file: ws('.aiexclude'), reader: 'other', scope: 'Gemini — files kept out of context', loaded: true },
    { label: 'Zed rules', file: ws('.rules'), reader: 'other', scope: 'Zed — first match of its own list wins', loaded: true },
    { label: 'CONVENTIONS.md', file: ws('CONVENTIONS.md'), reader: 'other', scope: 'Aider — added with --read', loaded: true },
    { label: 'Junie guidelines', file: ws('.junie/guidelines.md'), reader: 'other', scope: 'JetBrains Junie', loaded: true },
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
