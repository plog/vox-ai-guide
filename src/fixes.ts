import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { claudeUserDir, exists, readJson, writeJson } from './paths';
import { Slot, Template, templateById, templatesFor } from './library';
import { Finding } from './secrets';

export interface FixContext {
  workspaceRoot?: string;
}

/**
 * What the user is shown *before* anything is written. Nothing in this extension edits a
 * file the user has not seen described first — and, like everywhere else, a preview never
 * carries a secret value: `before` is a description, never a copy of the line.
 */
export interface FixPreview {
  /** What gets touched, named the way the user would name it. */
  target: string;
  before: string;
  after: string;
  /** Reassurances specific to this fix (backup kept, reversibility, …). */
  notes: string[];
}

/**
 * Where a fix lands. This is the same distinction the extension teaches for secrets:
 * `personal` touches only this machine; `project` writes a version-controlled file that
 * goes out to the whole team — and, on a client repo, to the client. The two can never be
 * offered in the same list.
 */
export type FixScope = 'personal' | 'project';

export interface Fix {
  id: string;
  title: string;
  scope: FixScope;
  /**
   * Set when the fix writes a file whose content comes from the library. The review screen
   * then offers the alternatives and lets the text be edited before anything is written.
   */
  slot?: Slot;
  /** Why it costs tokens — always shown; this is the whole point of the extension. */
  why: string;
  gain: string;
  /** True when the fix is relevant (i.e. not applied yet). */
  applicable(ctx: FixContext): boolean;
  /** The before/after shown on the review screen. */
  preview(ctx: FixContext, draft?: string): FixPreview;
  /** `draft` is the text as edited on the review screen — what you saw is what gets written. */
  apply(ctx: FixContext, draft?: string): Promise<string>;
  /**
   * Where to edit the fix once its effect is in place. "Editable afterwards" is a promise
   * this extension makes; without this, an applied fix simply vanished from every list and
   * the promise was a lie. Returns undefined while the fix is not in effect.
   */
  inPlace?(ctx: FixContext): EditTarget | undefined;
}

/** A door back into something the extension wrote or set. One of `file` / `settingKey`. */
export interface EditTarget {
  label: string;
  file?: string;
  settingKey?: string;
}


const NEW_FILE_NOTES = ['Nothing existing is overwritten', 'Delete the file to undo'];
/** Shown on every `project` fix: this file leaves your machine. */
const PROJECT_NOTES = [
  'This file is version-controlled: it goes out to everyone on the repo',
  'On a client repo, review the wording before committing',
];
const SETTING_NOTES = ['Written to your User Settings', 'Editable at any time in VS Code'];
const LIBRARY_NOTE = 'Pick another entry or edit the text below — what you see is what gets written';

/** The text to write: what the user edited, else the entry they picked, else the first one. */
function content(slot: Slot, draft?: string, templateId?: string, workspaceRoot?: string): string {
  return draft ?? templateById(slot, templateId, workspaceRoot)?.body ?? '';
}





/**
 * The one file that should carry the response style in this repo — always the most
 * cross-AI option available. An existing CLAUDE.md wins (Claude natively, Copilot via
 * chat.useClaudeMdFile); else an existing AGENTS.md (Copilot and Codex natively, Claude
 * via a bridge); else a fresh AGENTS.md plus a one-line CLAUDE.md bridge covers all three.
 * Never `.github/copilot-instructions.md`: only Copilot reads it.
 */
function styleTarget(root: string): { file: string; create: boolean } {
  const claude = path.join(root, 'CLAUDE.md');
  if (exists(claude)) {
    return { file: claude, create: false };
  }
  const agents = path.join(root, 'AGENTS.md');
  return { file: agents, create: !exists(agents) };
}

/** The `## Response style` heading doubles as the applied-marker for the style fix. */
function hasStyleSection(file: string): boolean {
  try {
    return /^##\s+Response style/im.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * What gets appended to an existing file: the template minus its `# Project instructions`
 * title, so the section slots into the document instead of restarting it.
 */
function styleBlock(draft?: string, workspaceRoot?: string): string {
  if (draft) {
    return draft;
  }
  return content('copilot-instructions', undefined, undefined, workspaceRoot).replace(/^#\s[^\n]*\n+/, '');
}

/** Open tab count past which the Copilot context starts to get diluted. */
const TAB_THRESHOLD = 12;

function openTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs);
}

function updateVsCodeSetting(key: string, value: unknown): Promise<void> {
  return Promise.resolve(
    vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global),
  );
}

export const FIXES: Fix[] = [
  {
    id: 'copilot-reads-claude-md',
    scope: 'personal',
    title: 'Make Copilot read CLAUDE.md',
    why:
      'Claude Code reads CLAUDE.md, Copilot reads AGENTS.md and .github/copilot-instructions.md. Without this ' +
      'setting you maintain two instruction files that drift apart — and developers end up keeping neither up to date.',
    gain: 'A single instruction file per repo, read by both tools.',
    applicable: () => vscode.workspace.getConfiguration().get<boolean>('chat.useClaudeMdFile') !== true,
    preview: () => ({
      target: 'VS Code setting — chat.useClaudeMdFile',
      before: 'off — Copilot ignores CLAUDE.md',
      after: 'on — Copilot reads CLAUDE.md like Claude does',
      notes: [...SETTING_NOTES, 'No file in your repo is modified'],
    }),
    apply: async () => {
      await updateVsCodeSetting('chat.useClaudeMdFile', true);
      return 'chat.useClaudeMdFile = true (User Settings)';
    },
    inPlace: () =>
      vscode.workspace.getConfiguration().get<boolean>('chat.useClaudeMdFile') === true
        ? { label: 'chat.useClaudeMdFile — on', settingKey: 'chat.useClaudeMdFile' }
        : undefined,
  },
  {
    id: 'agents-md-bridge',
    scope: 'project',
    title: 'Bridge AGENTS.md to Claude Code',
    why:
      'This repo has an AGENTS.md but no CLAUDE.md: Claude Code starts with no project instructions at all. ' +
      'It knows neither how you build nor your conventions — so it searches, it guesses wrong, it starts over.',
    gain: 'Claude stops rediscovering the project on every session.',
    applicable: (ctx) =>
      !!ctx.workspaceRoot &&
      exists(path.join(ctx.workspaceRoot, 'AGENTS.md')) &&
      !exists(path.join(ctx.workspaceRoot, 'CLAUDE.md')),
    preview: () => ({
      target: 'New file — CLAUDE.md, at the root of this project',
      before: 'no CLAUDE.md — Claude starts each session knowing nothing about this project',
      after: '@AGENTS.md',
      notes: [
        ...NEW_FILE_NOTES,
        'One line: it points at AGENTS.md instead of duplicating it',
        ...PROJECT_NOTES,
      ],
    }),
    apply: async (ctx) => {
      const target = path.join(ctx.workspaceRoot!, 'CLAUDE.md');
      fs.writeFileSync(target, '@AGENTS.md\n', 'utf8');
      return 'CLAUDE.md created, importing AGENTS.md';
    },
    inPlace: (ctx) =>
      ctx.workspaceRoot &&
      exists(path.join(ctx.workspaceRoot, 'AGENTS.md')) &&
      exists(path.join(ctx.workspaceRoot, 'CLAUDE.md'))
        ? { label: 'CLAUDE.md — bridges to AGENTS.md', file: path.join(ctx.workspaceRoot, 'CLAUDE.md') }
        : undefined,
  },
  {
    id: 'explore-on-haiku',
    scope: 'personal',
    title: 'Move code search off the most expensive model',
    why:
      'Built-in subagents (Explore, general-purpose) inherit the conversation\'s model. ' +
      'If you work on Opus, every file search runs on Opus. It is the single largest cost driver ' +
      'in most sessions.',
    gain: 'Searches move to Haiku, reasoning stays on your model.',
    slot: 'agent-explore',
    applicable: () => !exists(path.join(claudeUserDir(), 'agents', 'Explore.md')),
    preview: (_ctx, draft) => ({
      target: 'New file — ~/.claude/agents/Explore.md',
      before: 'helpers inherit your conversation\'s model — search runs on whatever you are on',
      after: content('agent-explore', draft),
      notes: [...NEW_FILE_NOTES, 'Applies to every project on this machine', LIBRARY_NOTE],
    }),
    apply: async (_ctx, draft) => {
      const dir = path.join(claudeUserDir(), 'agents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Explore.md'), content('agent-explore', draft), 'utf8');
      return '~/.claude/agents/Explore.md created';
    },
    inPlace: () => {
      const f = path.join(claudeUserDir(), 'agents', 'Explore.md');
      return exists(f) ? { label: 'Explore agent — search runs on a small model', file: f } : undefined;
    },
  },
  {
    id: 'general-purpose-on-sonnet',
    scope: 'personal',
    title: 'Calibrate the general-purpose agent on Sonnet',
    why:
      'Same mechanism: the general-purpose agent inherits your model. It gets called for search and ' +
      'execution work where Sonnet is more than enough.',
    gain: 'Cost divided with no noticeable loss on that kind of task.',
    slot: 'agent-general',
    applicable: () => !exists(path.join(claudeUserDir(), 'agents', 'general-purpose.md')),
    preview: (_ctx, draft) => ({
      target: 'New file — ~/.claude/agents/general-purpose.md',
      before: 'the general-purpose helper inherits your model too',
      after: content('agent-general', draft),
      notes: [...NEW_FILE_NOTES, 'Applies to every project on this machine', LIBRARY_NOTE],
    }),
    apply: async (_ctx, draft) => {
      const dir = path.join(claudeUserDir(), 'agents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'general-purpose.md'), content('agent-general', draft), 'utf8');
      return '~/.claude/agents/general-purpose.md created';
    },
    inPlace: () => {
      const f = path.join(claudeUserDir(), 'agents', 'general-purpose.md');
      return exists(f) ? { label: 'general-purpose agent — calibrated model', file: f } : undefined;
    },
  },
  {
    id: 'effort-level',
    scope: 'personal',
    title: 'Bring reasoning effort back to "medium"',
    why:
      'effortLevel "high" or "xhigh" makes the model think at length on *every* turn, including to ' +
      'rename a variable. You pay for reasoning on questions that do not need any. ' +
      'Raise it on demand with /effort when the task deserves it.',
    gain: 'Fewer reasoning tokens on trivial turns.',
    applicable: () => {
      const lvl = readJson(path.join(claudeUserDir(), 'settings.json'))['effortLevel'];
      return lvl === 'high' || lvl === 'xhigh';
    },
    preview: () => {
      const lvl = readJson(path.join(claudeUserDir(), 'settings.json'))['effortLevel'];
      return {
        target: 'Claude setting — ~/.claude/settings.json',
        before: `"effortLevel": "${String(lvl)}"`,
        after: '"effortLevel": "medium"',
        notes: [
          'A backup of the file is kept (.bak)',
          'Raise it per task with /effort when it deserves it',
        ],
      };
    },
    apply: async () => {
      const p = path.join(claudeUserDir(), 'settings.json');
      const s = readJson(p);
      const before = s['effortLevel'];
      s['effortLevel'] = 'medium';
      writeJson(p, s);
      return `effortLevel: ${String(before)} -> medium (.bak backup created)`;
    },
    inPlace: () => {
      const p = path.join(claudeUserDir(), 'settings.json');
      const lvl = readJson(p)['effortLevel'];
      return lvl !== undefined && lvl !== 'high' && lvl !== 'xhigh'
        ? { label: `effortLevel — ${String(lvl)}`, file: p }
        : undefined;
    },
  },
  {
    id: 'auto-compact',
    scope: 'personal',
    title: 'Let long chats compact themselves',
    why:
      'Every message re-sends the whole conversation. Past a certain size you are paying for the same ' +
      'history again and again. Auto-compact summarises the older part of the chat instead of resending ' +
      'it verbatim, so a long session stops costing more with every turn.',
    gain: 'Long chats stop growing linearly in price.',
    applicable: () => readJson(path.join(claudeUserDir(), 'settings.json'))['autoCompactEnabled'] === false,
    preview: () => ({
      target: 'Setting — ~/.claude/settings.json, autoCompactEnabled',
      before: 'false — the full history is resent on every message, however long the chat gets',
      after: 'true — older turns get summarised automatically once the chat grows',
      notes: [
        'A .bak copy is written before the change',
        'You keep control: /compact still works on demand',
        'Applies to every project on this machine',
      ],
    }),
    apply: async () => {
      const p = path.join(claudeUserDir(), 'settings.json');
      const cfg = readJson(p);
      cfg['autoCompactEnabled'] = true;
      writeJson(p, cfg);
      return 'autoCompactEnabled = true (.bak backup created)';
    },
    inPlace: () => {
      const p = path.join(claudeUserDir(), 'settings.json');
      return readJson(p)['autoCompactEnabled'] === true
        ? { label: 'autoCompactEnabled — on', file: p }
        : undefined;
    },
  },
  {
    id: 'concision-rule',
    scope: 'personal',
    title: 'Ask for answers without filler',
    why:
      'Preambles, closing summaries and tables of discarded options are pure output tokens. ' +
      'On a subagent, that prose also flows back into the main conversation\'s context: ' +
      'it is billed twice. Code and commands stay intact.',
    gain: 'Shorter output, parent context that grows more slowly. Cost: zero.',
    applicable: () => !exists(path.join(claudeUserDir(), 'rules', 'concision.md')),
    slot: 'claude-rule',
    preview: (_ctx, draft) => ({
      target: 'New file — ~/.claude/rules/concision.md',
      before: 'no style rule — every answer re-explains what you already know',
      after: content('claude-rule', draft),
      notes: [...NEW_FILE_NOTES, 'Code and error messages stay complete', LIBRARY_NOTE],
    }),
    apply: async (_ctx, draft) => {
      const dir = path.join(claudeUserDir(), 'rules');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'concision.md'), content('claude-rule', draft), 'utf8');
      return '~/.claude/rules/concision.md created';
    },
    inPlace: () => {
      const f = path.join(claudeUserDir(), 'rules', 'concision.md');
      return exists(f) ? { label: 'Concision rule — active on every chat', file: f } : undefined;
    },
  },
  {
    id: 'agent-max-requests',
    scope: 'personal',
    title: 'Cap Copilot agent loops',
    why:
      'chat.agent.maxRequests caps how many tool turns the agent chains on a single prompt. ' +
      'Set too high, an agent sent off on a vague instruction digs for 150 turns before stopping — ' +
      'wasted time and a saturated context for a result you will throw away.',
    gain: 'The agent hands back control sooner, so you rephrase instead of letting it drift.',
    applicable: () => (vscode.workspace.getConfiguration().get<number>('chat.agent.maxRequests') ?? 25) > 50,
    preview: () => ({
      target: 'VS Code setting — chat.agent.maxRequests',
      before: `${vscode.workspace.getConfiguration().get<number>('chat.agent.maxRequests') ?? 25} tool turns per prompt`,
      after: '25 tool turns per prompt',
      notes: [...SETTING_NOTES, 'The agent hands back control, it does not stop working'],
    }),
    apply: async () => {
      await updateVsCodeSetting('chat.agent.maxRequests', 25);
      return 'chat.agent.maxRequests = 25 (User Settings)';
    },
    inPlace: () => {
      const v = vscode.workspace.getConfiguration().inspect<number>('chat.agent.maxRequests');
      return v?.globalValue !== undefined && v.globalValue <= 50
        ? { label: `chat.agent.maxRequests — ${v.globalValue}`, settingKey: 'chat.agent.maxRequests' }
        : undefined;
    },
  },
  {
    id: 'copilot-instructions',
    scope: 'project',
    title: 'Set the response style once and for all',
    why:
      'With no shared instructions, every AI answer re-explains what you already know. Those output ' +
      'tokens are billed, and they flow back into the context on the next turn. The style belongs in ' +
      'the one file every tool reads — your existing CLAUDE.md or AGENTS.md — not in a Copilot-only ' +
      '`.github/copilot-instructions.md`. A repo with neither gets an AGENTS.md (read by Copilot and ' +
      'Codex) plus a one-line CLAUDE.md bridge so Claude reads it too.',
    gain: 'Shorter answers across the whole team, from a single file every tool reads.',
    applicable: (ctx) => {
      if (!ctx.workspaceRoot) {
        return false;
      }
      if (exists(path.join(ctx.workspaceRoot, '.github', 'copilot-instructions.md'))) {
        return false; // instructions already exist — respect them, do not add a rival file
      }
      const t = styleTarget(ctx.workspaceRoot);
      return t.create || !hasStyleSection(t.file);
    },
    slot: 'copilot-instructions',
    preview: (ctx, draft) => {
      const t = styleTarget(ctx.workspaceRoot!);
      const name = path.basename(t.file);
      return t.create
        ? {
            target: 'New file — AGENTS.md, at the root of this project',
            before: 'no instruction file at all — every tool starts from zero, every answer re-explains the basics',
            after: content('copilot-instructions', draft, undefined, ctx.workspaceRoot),
            notes: [
              ...NEW_FILE_NOTES,
              'Also writes a one-line CLAUDE.md (`@AGENTS.md`) so Claude Code reads the same file',
              'Turns on chat.useAgentsMdFile so Copilot reads it — Codex reads it natively',
              ...PROJECT_NOTES,
              LIBRARY_NOTE,
            ],
          }
        : {
            target: `Existing file — ${name}, a section is appended at the end`,
            before: `${name} exists but has no "Response style" section — the answer style is left to chance`,
            after: styleBlock(draft, ctx.workspaceRoot),
            notes: [
              'Appended at the end — nothing already in the file is touched',
              'Delete the section to undo',
              ...PROJECT_NOTES,
              LIBRARY_NOTE,
            ],
          };
    },
    apply: async (ctx, draft) => {
      const t = styleTarget(ctx.workspaceRoot!);
      if (t.create) {
        fs.writeFileSync(t.file, content('copilot-instructions', draft, undefined, ctx.workspaceRoot), 'utf8');
        const bridge = path.join(ctx.workspaceRoot!, 'CLAUDE.md');
        if (!exists(bridge)) {
          fs.writeFileSync(bridge, '@AGENTS.md\n', 'utf8');
        }
        if (vscode.workspace.getConfiguration().get<boolean>('chat.useAgentsMdFile') !== true) {
          await updateVsCodeSetting('chat.useAgentsMdFile', true);
        }
        const doc = await vscode.workspace.openTextDocument(t.file);
        await vscode.window.showTextDocument(doc, { preview: false });
        return 'AGENTS.md created, CLAUDE.md bridge in place — fill in your conventions';
      }
      fs.appendFileSync(t.file, `\n${styleBlock(draft, ctx.workspaceRoot).trimEnd()}\n`, 'utf8');
      const doc = await vscode.workspace.openTextDocument(t.file);
      await vscode.window.showTextDocument(doc, { preview: false });
      return `Response style appended to ${path.basename(t.file)}`;
    },
    inPlace: (ctx) => {
      if (!ctx.workspaceRoot) {
        return undefined;
      }
      const legacy = path.join(ctx.workspaceRoot, '.github', 'copilot-instructions.md');
      if (exists(legacy)) {
        return { label: 'Copilot instructions — Copilot-only file, already in place', file: legacy };
      }
      const t = styleTarget(ctx.workspaceRoot);
      return !t.create && hasStyleSection(t.file)
        ? { label: `Response style — in ${path.basename(t.file)}, read by every tool`, file: t.file }
        : undefined;
    },
  },
  {
    id: 'close-stale-tabs',
    scope: 'personal',
    title: 'Close the tabs polluting your context',
    why:
      'Copilot draws on your open editors to build context. Twenty tabs left over from ' +
      "yesterday's task, and every question ships with noise that dilutes the answer — " +
      'which makes you retry, and a retry ships the whole context again, consuming credits on input.',
    gain: 'Cleaner context, fewer rephrasings.',
    applicable: () => openTabs().length > TAB_THRESHOLD,
    preview: () => {
      const stale = openTabs().filter((t) => !t.isActive && !t.isDirty && !t.isPinned);
      return {
        target: 'Your open editors',
        before: `${openTabs().length} tabs open — all of them feed Copilot's context`,
        after: `${openTabs().length - stale.length} kept, ${stale.length} closed`,
        notes: [
          'Unsaved and pinned tabs are kept',
          'The active tab is kept',
          'Nothing is written to disk',
        ],
      };
    },
    apply: async () => {
      const stale = openTabs().filter((t) => !t.isActive && !t.isDirty && !t.isPinned);
      await vscode.window.tabGroups.close(stale, false);
      return `${stale.length} tab(s) closed — modified and pinned ones were kept`;
    },
  },
];

/**
 * Habits no setting can fix for you. The title is an instruction, not a topic: read on its own
 * it is already actionable, and the `why` stays folded until someone wants it. A list of
 * paragraphs would be an article — this extension proposes moves.
 */
export interface Tip {
  /** Imperative, self-sufficient. */
  title: string;
  /** The reason, unfolded on demand. Two sentences at most. */
  why: string;
}

export const TIPS: Tip[] = [
  {
    title: 'Select the code before you ask',
    why:
      'Highlight the function, then ask. Select `parseInvoice()` and ask "why does this fail on ' +
      'negative amounts?" — the answer targets those 20 lines. With nothing selected, Copilot ' +
      'ships the whole file plus every open tab as context: slower, costlier, and it can answer ' +
      'about the wrong function entirely.',
  },
  {
    title: 'Start a new chat when you change task',
    why:
      'Bugfix done, moving on to the CSS? Type `/clear` on Claude, click New Chat (+) on Copilot. ' +
      'Every message re-sends the entire thread: keep three tasks in one chat and, by the third, ' +
      'every single message re-pays the first two. One task, one chat.',
  },
  {
    title: 'Use Ask for a question, Agent for a project',
    why:
      '"What does this regex match?" — Ask mode: one request, one answer. "Add pagination to the ' +
      'invoices page" — Agent mode: it reads, edits and re-checks files on its own. A simple ' +
      'question sent to Agent mode burns several tool turns to land where Ask lands in one.',
  },
  {
    title: 'Pick the model for the job, not the best one',
    why:
      'Rename, reformat, boilerplate, tests: a fast model. Architecture, a bug that resists, a ' +
      'migration: the big one. Since 1 June 2026 Copilot bills every model at its own token rate ' +
      'from a credit pool shared by the whole organisation — a reasoning model on a variable ' +
      'rename costs twice over, more tokens at a higher rate. Inline completions stay free ' +
      'whatever you pick.',
  },
  {
    title: 'Look at what a turn costs you — once',
    why:
      'Copilot: the chat\'s "…" menu, then "Show Chat Debug View" — the exact prompt that was sent, ' +
      'files included. Claude: `/context` shows what fills the window, `/usage` the session total. ' +
      'Do it once on a chat that has lasted all afternoon: seeing 140k of history ride behind a ' +
      'one-line question is what makes every other habit on this list stick.',
  },
];

// --- Actions on a detected secret -------------------------------------------
// Deliberately separate from FIXES: they act on a specific finding, and none of them
// rewrites a file containing a secret. On this ground, taking the human to the right
// place is safer than editing blind.

/** Opens the file at the offending line. The default action. */
export async function revealSecret(f: Finding): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(f.file);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const pos = new vscode.Position(Math.max(0, f.line - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/**
 * Where each kind of credential is revoked. Keyed on the detector label from `secrets.ts`.
 * Opening one of these is a user-initiated navigation in their own browser — it carries no
 * finding, no file name and no value, and the extension itself still makes no request.
 */
const REVOCATION_PAGES: { match: RegExp; url: string }[] = [
  { match: /^Anthropic/, url: 'https://console.anthropic.com/settings/keys' },
  { match: /^OpenAI/, url: 'https://platform.openai.com/api-keys' },
  { match: /^GitHub token \(classic\)/, url: 'https://github.com/settings/tokens' },
  { match: /^GitHub token \(fine-grained\)/, url: 'https://github.com/settings/personal-access-tokens' },
  { match: /^AWS/, url: 'https://console.aws.amazon.com/iam/home#/security_credentials' },
  { match: /^Slack/, url: 'https://api.slack.com/apps' },
  { match: /^GitLab/, url: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
  { match: /^Google/, url: 'https://console.cloud.google.com/apis/credentials' },
  { match: /^npm/, url: 'https://www.npmjs.com/settings/~/tokens' },
  { match: /^DigitalOcean/, url: 'https://cloud.digitalocean.com/account/api/tokens' },
];

/** The provider page where this credential is revoked, when we recognise the issuer. */
export function revocationUrl(f: Finding): string | undefined {
  return REVOCATION_PAGES.find((p) => p.match.test(f.what))?.url;
}

export async function openRevocationGuide(f: Finding): Promise<string> {
  const url = revocationUrl(f);
  if (!url) {
    return (
      `We could not tell which provider issued this ${f.what.toLowerCase()}. ` +
      'Open the service it belongs to and revoke the credential there, then replace it.'
    );
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
  return 'Revoke the key on the page that just opened, then create a new one.';
}

/**
 * Adds the file to .gitignore. Never claims to have solved the problem when the file is
 * already tracked: in that case the secret went out with a push, and only revocation counts.
 */
export async function gitignoreSecret(f: Finding, workspaceRoot?: string): Promise<string> {
  if (!workspaceRoot) {
    return 'No folder open — nothing to ignore.';
  }
  const rel = path.relative(workspaceRoot, f.file).split(path.sep).join('/');
  if (rel.startsWith('..')) {
    return 'This file sits outside the open folder: its .gitignore does not apply.';
  }

  const target = path.join(workspaceRoot, '.gitignore');
  const current = exists(target) ? fs.readFileSync(target, 'utf8') : '';
  if (current.split('\n').some((l) => l.trim() === rel)) {
    return `${rel} was already in .gitignore.`;
  }
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(target, `${current}${sep}${rel}\n`, 'utf8');

  return f.tracked
    ? `${rel} added to .gitignore — BUT it is already tracked by git. The secret is in the history: revoke it.`
    : `${rel} added to .gitignore.`;
}

export function applicableFixes(ctx: FixContext): Fix[] {
  return FIXES.filter((f) => {
    try {
      return f.applicable(ctx);
    } catch {
      return false;
    }
  });
}

/** Fixes whose effect is in place, each with its door back in. */
export function inPlaceFixes(ctx: FixContext): Array<{ fix: Fix; target: EditTarget }> {
  return FIXES.flatMap((fix) => {
    try {
      const target = fix.inPlace?.(ctx);
      return target ? [{ fix, target }] : [];
    } catch {
      return [];
    }
  });
}
