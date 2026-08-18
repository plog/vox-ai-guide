import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import {
  applicableFixes,
  Fix,
  FIXES,
  FixContext,
  gitignoreSecret,
  inPlaceFixes,
  openRevocationGuide,
  revealSecret,
  TIPS,
} from './fixes';
import { detectStack, Slot, templateById, templatesFor } from './library';
import { InstructionFile, scan, ScanResult } from './scan';
import { Finding, scanSecrets } from './secrets';
import { currentUsage, isExpensiveModel, SessionUsage, spendBreakdown } from './usage';

/**
 * The panel is where things happen. The sidebar answers "is anything wrong?" in a word and
 * sends you here; every decision that writes to disk is taken on this surface, because a
 * before/after does not fit in 340px. Nothing is written without going through `review`.
 */
export type Tab = 'report' | 'secrets' | 'fixes' | 'files' | 'settings' | 'habits';

export type PanelFocus =
  | { mode: 'map'; tab?: Tab }
  | { mode: 'review'; fixId: string };

/**
 * One page carrying five unrelated subjects is a scroll, not a document. Each tab answers
 * one question, and the tab bar doubles as a table of contents: you see what the panel
 * knows about without reading it.
 */
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'report', label: 'Tune-up' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'fixes', label: 'Fixes' },
  { id: 'files', label: 'Instruction files' },
  { id: 'settings', label: 'Settings layers' },
  { id: 'habits', label: 'Habits' },
];

let panel: vscode.WebviewPanel | undefined;
/** Findings from the last render — the webview only ever sends back an index, never data. */
let lastFindings: Finding[] = [];
let extensionUri: vscode.Uri | undefined;
let focus: PanelFocus = { mode: 'map' };

export function initPanel(uri: vscode.Uri): void {
  extensionUri = uri;
}

export function showDoctor(target: PanelFocus = { mode: 'map' }): void {
  focus = target;
  if (panel) {
    // No column argument: reveal the panel where the user left it instead of dragging it back.
    panel.reveal();
  } else {
    panel = vscode.window.createWebviewPanel('voxAiGuide', 'Vox AI Guide', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // Required to serve the logos to the webview.
      localResourceRoots: extensionUri ? [vscode.Uri.joinPath(extensionUri, 'media')] : [],
    });
    panel.onDidDispose(() => (panel = undefined));
    panel.webview.onDidReceiveMessage((msg) => onMessage(msg));
  }
  render();
}

/** Library entry picked on the review screen, per slot. Reset once the fix is applied. */
let chosenTemplate: Partial<Record<Slot, string>> = {};

async function onMessage(msg: {
  command?: string;
  id?: string;
  idx?: number;
  draft?: string;
  path?: string;
}): Promise<void> {
  const ctx = context();
  try {
    switch (msg?.command) {
      case 'review':
        // A fix is never applied straight from a list: you read the before/after first.
        focus = { mode: 'review', fixId: msg.id ?? '' };
        break;
      case 'cancel':
        focus = { mode: 'map', tab: 'fixes' };
        break;
      case 'tab':
        focus = { mode: 'map', tab: (msg.id as Tab) ?? 'secrets' };
        break;
      case 'refresh':
        // Nothing to change: render() below re-runs every scan and measurement.
        break;
      case 'template': {
        // Only meaningful while a review is open: it swaps the text being reviewed.
        if (focus.mode === 'review') {
          const wanted = focus.fixId;
          const fix = FIXES.find((f) => f.id === wanted);
          if (fix?.slot) {
            chosenTemplate[fix.slot] = msg.id;
          }
        }
        break;
      }
      case 'apply': {
        const fix = FIXES.find((f) => f.id === msg.id);
        if (!fix) {
          return;
        }
        // What was on screen is what gets written — edits included.
        vscode.window.showInformationMessage(`Vox AI: ${await fix.apply(ctx, msg.draft)}`);
        chosenTemplate = {};
        focus = { mode: 'map', tab: 'fixes' };
        break;
      }
      case 'reveal': {
        const f = lastFindings[msg.idx ?? -1];
        if (f) {
          await revealSecret(f);
        }
        return; // focus just went to the editor: leave the panel as it is
      }
      case 'revoke': {
        const f = lastFindings[msg.idx ?? -1];
        if (f) {
          vscode.window.showWarningMessage(`Vox AI: ${await openRevocationGuide(f)}`);
        }
        return;
      }
      case 'edit': {
        // The way back into an applied fix: the file it wrote, or the setting it changed.
        const target = inPlaceFixes(ctx).find((e) => e.fix.id === msg.id)?.target;
        if (target?.file) {
          const doc = await vscode.workspace.openTextDocument(target.file);
          await vscode.window.showTextDocument(doc, { preview: false });
        } else if (target?.settingKey) {
          await vscode.commands.executeCommand('workbench.action.openSettings', target.settingKey);
        }
        return;
      }
      case 'setting':
        await vscode.commands.executeCommand('workbench.action.openSettings', msg.id ?? '');
        return;
      case 'trimPrompt': {
        // The dev should not need to learn `paths:` and `applyTo:` — the AI already knows
        // them. We hand over a precise work order instead of a lesson.
        const loaded = scan(ctx.workspaceRoot)
          .instructions.filter((f) => f.present && f.loaded && f.lines > 0)
          .sort((a, b) => b.lines - a.lines);
        const fat = loaded[0];
        if (!fat) {
          return;
        }
        await vscode.env.clipboard.writeText(
          `Trim my always-loaded AI instruction file: ${fat.file} (${fat.lines} lines, ` +
            `re-sent with every message).\n` +
            `1. Read it and split its content in two: (a) what matters on EVERY request — ` +
            `keep it in place, aim for under 100 lines; (b) what only matters for specific ` +
            `files, stacks or rare tasks.\n` +
            `2. Move (b) into scoped files that load on demand: for Claude Code, ` +
            `.claude/rules/<topic>.md with a \`paths:\` frontmatter glob; for Copilot, ` +
            `.github/instructions/<topic>.instructions.md with an \`applyTo:\` glob.\n` +
            `3. Move, never delete or reword — commands, paths and facts stay intact.\n` +
            `4. When done, show me the per-file line counts, before and after.`,
        );
        vscode.window.showInformationMessage(
          'Vox AI: prompt copied — paste it into Claude Code or Copilot chat in this project.',
        );
        return;
      }
      case 'open': {
        // Only paths the diet table itself rendered — still, never trust the webview blindly.
        if (msg.path && fs.existsSync(msg.path)) {
          const doc = await vscode.workspace.openTextDocument(msg.path);
          await vscode.window.showTextDocument(doc, { preview: false });
        }
        return;
      }
      case 'gitignore': {
        const f = lastFindings[msg.idx ?? -1];
        if (f) {
          vscode.window.showWarningMessage(`Vox AI: ${await gitignoreSecret(f, ctx.workspaceRoot)}`);
        }
        break;
      }
      default:
        return;
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Vox AI: failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  render();
}

function context(): FixContext {
  return { workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath };
}

function render(): void {
  if (!panel) {
    return;
  }
  const ctx = context();

  if (focus.mode === 'review') {
    const wanted = focus.fixId;
    const fix = FIXES.find((f) => f.id === wanted);
    if (fix) {
      // The review screen stands alone: no map behind it, nothing else to click.
      panel.webview.html = shell(reviewScreen(fix, ctx, logos()));
      return;
    }
    focus = { mode: 'map' };
  }

  const result = scan(ctx.workspaceRoot);
  const usage = ctx.workspaceRoot ? currentUsage(ctx.workspaceRoot) : undefined;
  lastFindings = scanSecrets(ctx.workspaceRoot);
  const tab = (focus.mode === 'map' && focus.tab) || (lastFindings.length ? 'secrets' : 'report');
  panel.webview.html = html(result, applicableFixes(ctx), usage, lastFindings, logos(), tab, inPlaceFixes(ctx));
}

/**
 * Here, unlike the activity bar, the logo shows in colour and both variants are usable:
 * VSCode puts `vscode-light` / `vscode-dark` on the body and the CSS picks. Without the
 * panel, these files would have no use at all.
 */
function logos(): { light: string; dark: string } | undefined {
  if (!extensionUri || !panel) {
    return undefined;
  }
  const uri = (name: string) =>
    panel!.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri!, 'media', name)).toString();
  return { light: uri('logo-vox-light.svg'), dark: uri('logo-vox-dark.svg') };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The place a file lives, named the way the user's complaint names it: ".claude, .github,
 * .vscode…". The path alone answers half the maze — a chip per row makes it visible.
 */
function zoneOf(file: string): { label: string; cls: string } {
  if (!file) {
    return { label: '—', cls: 'z-none' };
  }
  if (/Application Support\/ClaudeCode|^\/etc\/claude-code|Program Files[\\/]+ClaudeCode/.test(file)) {
    return { label: 'IT managed', cls: 'z-it' };
  }
  const home = os.homedir();
  if (file.startsWith(home)) {
    const rest = file.slice(home.length);
    if (rest.startsWith('/.claude') || rest.startsWith('\\.claude')) {
      return { label: '~/.claude', cls: 'z-home' };
    }
    if (rest.includes('.codex')) {
      return { label: '~/.codex', cls: 'z-home' };
    }
    return { label: 'home (~)', cls: 'z-home' };
  }
  if (/[\\/]\.github[\\/]/.test(file)) {
    return { label: 'repo · .github', cls: 'z-repo' };
  }
  if (/[\\/]\.vscode[\\/]/.test(file)) {
    return { label: 'repo · .vscode', cls: 'z-repo' };
  }
  if (/[\\/]\.claude[\\/]/.test(file)) {
    return { label: 'repo · .claude', cls: 'z-repo' };
  }
  return { label: 'repo root', cls: 'z-repo' };
}

function zoneChip(file: string): string {
  const z = zoneOf(file);
  return `<span class="zone ${z.cls}">${esc(z.label)}</span>`;
}

function readerBadge(f: InstructionFile): string {
  const map = { claude: 'Claude', copilot: 'Copilot', both: 'Both' };
  return `<span class="badge ${f.reader}">${map[f.reader]}</span>`;
}

function fileState(f: InstructionFile): string {
  return !f.present
    ? '<span class="dim">missing</span>'
    : f.loaded
      ? `<span class="ok">loaded</span>${f.lines ? ` <span class="dim">${f.lines} ln</span>` : ''}`
      : '<span class="warn">present but ignored</span>';
}

/**
 * One reading chain. `ordered: true` numbers the rows — Claude glues the files together
 * top to bottom, so position is a fact. Copilot combines its files with no documented
 * order, so its chain shows a "+" instead of inventing ranks.
 */
function chainRows(files: InstructionFile[], ordered: boolean): string {
  const rows = files.map((f, i) => {
    const gate = f.gatedBy ? `<div class="dim small">only if <code>${esc(f.gatedBy)}</code> is on</div>` : '';
    const note = f.note ? `<div class="dim small">${esc(f.note)}</div>` : '';
    const shared = f.reader === 'both' ? ` ${readerBadge(f)}` : '';
    return `<tr class="${f.present && f.loaded ? '' : 'chain-off'}">
      <td class="rank"><span class="rankn">${ordered ? i + 1 : '+'}</span></td>
      <td>${zoneChip(f.file)} <strong>${esc(f.label)}</strong>${shared}<div class="dim small mono">${esc(f.file || '—')}</div>${gate}${note}</td>
      <td class="scope">${esc(f.scope)}</td>
      <td class="state">${fileState(f)}</td>
    </tr>`;
  });
  const lines = files.filter((f) => f.present && f.loaded).reduce((n, f) => n + f.lines, 0);
  rows.push(`<tr class="chain-sum">
    <td class="rank"><span class="rankn sum">=</span></td>
    <td colspan="3">one single prompt${lines ? ` — <strong>${lines.toLocaleString('en-GB')} lines</strong> from the files above` : ''}, sent again on <em>every</em> turn</td>
  </tr>`);
  return rows.join('');
}

const EXPOSURE_LABEL: Record<Finding['exposure'], string> = {
  git: 'pushed out',
  context: 'sent to the model',
  both: 'push + model',
  local: 'this machine only',
};

/**
 * Renders a finding. No secret value is available here: the `Finding` type does not carry
 * one. That invariant is what makes this webview safe to display and to share.
 */
function secretRows(findings: Finding[]): string {
  return findings
    .map((f, i) => {
      const cls = f.severity === 'critical' ? 'sev-crit' : f.severity === 'high' ? 'sev-high' : 'sev-low';
      const why = f.tracked
        ? 'Tracked by git: if the repo has been pushed, this secret is already public to anyone with access.'
        : f.loadedInPrompt
          ? 'This file is sent to the model on every turn, and rewritten into local transcripts.'
          : f.ignored
            ? 'Ignored by git. Still readable by any process running under your session.'
            : 'Present on this machine. Make sure it will not go out in a commit.';
      return `<tr>
        <td><span class="sev ${cls}">${esc(f.severity)}</span></td>
        <td><strong>${esc(f.what)}</strong>
          <div class="dim small mono">${esc(f.file)}:${f.line} → <code>${esc(f.where)}</code></div>
          <div class="dim small">${esc(why)}</div></td>
        <td class="scope"><span class="badge">${esc(EXPOSURE_LABEL[f.exposure])}</span></td>
        <td class="state">
          <button data-reveal="${i}">Open</button>
          ${f.ignored ? '' : `<button data-gitignore="${i}" class="ghost">Ignore</button>`}
        </td>
      </tr>`;
    })
    .join('');
}

function secretsSection(findings: Finding[]): string {
  if (!findings.length) {
    return `<h2>Secrets in your config</h2>
      <div class="callout ok-callout">No credentials or personal data (emails, phone numbers,
      bank accounts, plain-text passwords) found in your AI configuration files.</div>`;
  }
  const creds = findings.filter((f) => f.kind === 'credential');
  const personal = findings.filter((f) => f.kind === 'personal');
  const crit = findings.filter((f) => f.severity === 'critical').length;
  const what = [
    creds.length ? `${creds.length} credential(s)` : '',
    personal.length ? `${personal.length} personal detail(s)` : '',
  ]
    .filter(Boolean)
    .join(' and ');
  return `<h2>⚠ Secrets in your config</h2>
    <div class="callout danger">
      <strong>${what} found${crit ? `, ${crit} critical` : ''}.</strong>
      The value is never shown here — this page can end up in a screenshot or in an agent's context.
    </div>
    <table>${secretRows(findings)}</table>
    ${
      creds.length
        ? `<div class="callout danger">
      <strong>A committed secret is a burned secret.</strong> Adding it to <code>.gitignore</code> does not
      remove it from history, and does not undo the clones already made. The only remedy is
      <strong>revocation</strong>:
      <a href="https://github.com/settings/tokens">GitHub tokens</a> ·
      <a href="https://console.anthropic.com/settings/keys">Anthropic keys</a> ·
      <a href="https://platform.openai.com/api-keys">OpenAI keys</a> ·
      <a href="https://console.aws.amazon.com/iam/home#/security_credentials">AWS credentials</a>.
      Revoke first, clean up afterwards.
    </div>`
        : ''
    }
    ${
      personal.length
        ? `<div class="callout">
      <strong>Personal data has nothing to revoke.</strong> Remove it from the file — a config
      loaded into the prompt sends it to the provider on every message, and a committed file
      keeps it in the repo's history. If it was pushed, assume it has been read.
    </div>`
        : ''
    }`;
}

/**
 * The review screen — the only door to writing anything. It exists here and not in the
 * sidebar because a before/after needs width, and because the decision to commit a file to
 * a team repo deserves a full page rather than a 340px column.
 */
function reviewScreen(fix: Fix, ctx: FixContext, _logo?: { light: string; dark: string }): string {
  const picked = fix.slot
    ? templateById(fix.slot, chosenTemplate[fix.slot], ctx.workspaceRoot)?.body
    : undefined;
  const p = fix.preview(ctx, picked);
  const isProject = fix.scope === 'project';

  // A two-column before/after only works when both sides are comparable. Here "before" is a
  // sentence and "after" is thirty lines of Markdown — side by side, that reads as a broken
  // layout. So a file gets a full-width editor under a one-line statement of the current
  // state, and only a setting gets the compact old → new pair.
  const body = fix.slot
    ? `<div class="was">Today: ${esc(p.before)}</div>
       ${picker(fix.slot, ctx.workspaceRoot)}
       <textarea id="draft" spellcheck="false">${esc(p.after)}</textarea>`
    : `<div class="swap">
         <span class="was">${esc(p.before)}</span>
         <span class="arrow">→</span>
         <span class="will">${esc(p.after)}</span>
       </div>`;

  return `<button class="back" data-cancel>← Fixes</button>

    <h1 class="review-title">${esc(fix.title)}</h1>
    <p class="lede why">${esc(fix.why)}</p>

    <div class="target${isProject ? ' target-shared' : ''}">
      <div class="target-file">${esc(p.target)}</div>
      <div class="target-note">${
        isProject
          ? 'Version-controlled — this file goes out to everyone on the repo.'
          : 'Only this machine. Nothing in your repo is touched.'
      }</div>
    </div>

    ${body}

    <ul class="notes">${p.notes.map((n: string) => `<li>${esc(n)}</li>`).join('')}</ul>

    <div class="actions">
      <button data-apply="${esc(fix.id)}">Apply</button>
      <button data-cancel class="ghost">Cancel</button>
    </div>`;
}

/** The library entries available for this slot. Yours first, ours as a fallback. */
function picker(slot: Slot, workspaceRoot?: string): string {
  const list = templatesFor(slot, workspaceRoot);
  const stack = detectStack(workspaceRoot);
  if (list.length < 2) {
    return '';
  }
  return `<div class="picker">
      <label>Starting point</label>
      <select id="tpl">${list
        .map(
          (t) =>
            `<option value="${esc(t.id)}">${esc(t.title)}${
              t.origin === 'library' ? ' — yours' : t.stack && t.stack === stack ? ' — matches this project' : ''
            }</option>`,
        )
        .join('')}</select>
      <div class="dim small">${esc(list[0].summary)}</div>
    </div>`;
}

function vscodeRows(settings: ScanResult['vscode']): string {
  return settings
    .map((s) => {
      const val = s.effective === undefined ? '—' : JSON.stringify(s.effective);
      const over = s.overridden.length
        ? `<div class="warn small">overrides: ${esc(s.overridden.join(', '))}</div>`
        : '';
      return `<tr>
        <td><span class="badge">${esc(s.origin)}</span></td>
        <td><strong class="mono">${esc(s.key)}</strong><div class="dim small">${esc(s.matters)}</div>${over}</td>
        <td class="state mono">${esc(val.length > 60 ? `${val.slice(0, 60)}…` : val)}
          <button class="ghost" data-setting="${esc(s.key)}">Edit</button></td>
      </tr>`;
    })
    .join('');
}

/**
 * The settings tab used to be an inventory; nobody optimises off an inventory. This is the
 * bill instead: the files each tool re-sends on every single request, fattest first, so the
 * first line is the first thing to trim.
 */
function dietSection(result: ScanResult): string {
  const loaded = result.instructions
    .filter((f) => f.present && f.loaded && f.lines > 0)
    .sort((a, b) => b.lines - a.lines);

  const total = (reader: 'claude' | 'copilot') =>
    loaded.filter((f) => f.reader === reader || f.reader === 'both').reduce((n, f) => n + f.lines, 0);
  const claude = total('claude');
  const copilot = total('copilot');

  // Tuner-style verdict per file: measured, thresholded, marked. ~12 tokens per line is a
  // rough but honest order of magnitude for prose-and-code instruction files.
  const rows = loaded
    .map((f) => {
      const heavy = f.lines > 100;
      return `<tr>
        <td class="state mono">${heavy ? '<span class="warn">[!!]</span>' : '<span class="ok">[OK]</span>'}</td>
        <td>${readerBadge(f)} <strong>${esc(f.label)}</strong>
          <div class="dim small mono">${esc(f.file)}</div></td>
        <td class="state"><span class="${heavy ? 'warn' : 'dim'}">${f.lines} ln</span>
          <span class="dim">≈ ${(Math.round((f.lines * 12) / 100) / 10).toFixed(1)}k tok/msg</span>
          <button class="ghost" data-open="${esc(f.file)}">Open</button></td>
      </tr>`;
    })
    .join('');

  const effective = (key: string): unknown => result.vscode.find((s) => s.key === key)?.effective;
  const claudeMd = result.instructions.find((f) => f.label === 'Project CLAUDE.md');
  const agentsMd = result.instructions.find((f) => f.label === 'AGENTS.md');
  const doubleLoad =
    effective('chat.useClaudeMdFile') === true &&
    effective('chat.useAgentsMdFile') === true &&
    claudeMd?.present &&
    agentsMd?.present;

  const callouts = [
    doubleLoad
      ? `<div class="callout">Copilot loads <code>CLAUDE.md</code> <em>and</em> <code>AGENTS.md</code> on
         every request — if one imports the other, you pay for the same guidance twice.
         Keep one loader on. <button class="ghost" data-setting="chat.useAgentsMdFile">Edit</button></div>`
      : '',
    effective('chat.useNestedAgentsMdFiles') === true
      ? `<div class="callout">Nested AGENTS.md files are on: every subfolder file joins the prompt
         when you work under it. Fine if they are short and targeted — check they are.
         <button class="ghost" data-setting="chat.useNestedAgentsMdFiles">Edit</button></div>`
      : '',
  ].join('');

  return `<h2>What every request carries</h2>
    <p class="lede">These files are re-sent with <em>every</em> message — they are the fixed cost of
    each request. Claude starts at <strong>${claude} lines</strong>, Copilot at
    <strong>${copilot} lines</strong>.</p>
    <div class="callout">You do not have to sort this by hand. Copy the ready-made prompt and
    paste it into your AI chat in this project: it reads the fattest file, keeps what every
    request needs, and moves the rest into files that only load when they are relevant.
    Nothing is deleted — moved, and shown to you.
    <button data-trim-prompt>Copy the prompt</button></div>
    ${callouts}
    ${loaded.length ? `<table>${rows}</table>` : '<div class="callout ok-callout">No always-loaded instruction file: every request starts lean.</div>'}`;
}

/**
 * The MySQLTuner idea, applied to AI configuration: measured value, threshold verdict,
 * marker, and at the bottom the exact variables to adjust. No prose, no lesson — a report
 * you scan in ten seconds. The fixes' `applicable()` checks ARE the thresholds: a line is
 * [!!] exactly when the corresponding one-click adjustment exists below.
 */
function reportSection(
  result: ScanResult,
  fixes: Fix[],
  usage: SessionUsage | undefined,
  findings: Finding[],
): string {
  // Structured lines instead of a wall of ✓/!/· in scan order: what needs attention renders
  // first with its fix button on the same line, everything that checked out folds away.
  // Same checks as before — only the reading order changed.
  interface RLine {
    kind: 'ok' | 'warn' | 'dim';
    section: string;
    text: string;
    /** When set and the fix is applicable, its Review button sits on this very line. */
    fixId?: string;
  }
  const entries: RLine[] = [];
  let section = '';
  const sec = (t: string) => {
    section = t;
  };
  const ok = (t: string) => entries.push({ kind: 'ok', section, text: t });
  const bad = (t: string, fixId?: string) => entries.push({ kind: 'warn', section, text: t, fixId });
  const off = (t: string) => entries.push({ kind: 'dim', section, text: t });
  const toApply = (id: string) => fixes.some((f) => f.id === id);
  const setting = (key: string) => result.vscode.find((s) => s.key === key);

  sec('Instruction files — re-sent with every request');
  const loaded = result.instructions
    .filter((f) => f.present && f.loaded && f.lines > 0)
    .sort((a, b) => b.lines - a.lines);
  if (!loaded.length) {
    ok('no always-loaded instruction file: every request starts lean');
  }
  for (const f of loaded) {
    const line = `${esc(f.label)}: ${f.lines} lines ≈ ${(Math.round((f.lines * 12) / 100) / 10).toFixed(1)}k tok/msg`;
    if (f.lines > 100) {
      bad(line);
    } else {
      ok(line);
    }
  }

  sec('GitHub Copilot');
  if (!result.tooling.copilot && !result.tooling.copilotChat) {
    off('Copilot extension not installed');
  } else {
    const useClaudeMd = setting('chat.useClaudeMdFile')?.effective === true;
    if (useClaudeMd) {
      ok('reads CLAUDE.md (chat.useClaudeMdFile = true) — one instruction file for both tools');
    } else {
      bad('ignores CLAUDE.md (chat.useClaudeMdFile = off) — two instruction files to keep in sync');
    }
    const claudeMd = result.instructions.find((f) => f.label === 'Project CLAUDE.md');
    const agentsMd = result.instructions.find((f) => f.label === 'AGENTS.md');
    if (useClaudeMd && setting('chat.useAgentsMdFile')?.effective === true && claudeMd?.present && agentsMd?.present) {
      bad('CLAUDE.md AND AGENTS.md both loaded — same guidance billed twice per request');
    }
    const maxReq = setting('chat.agent.maxRequests');
    if (maxReq?.effective !== undefined) {
      if (toApply('agent-max-requests')) {
        bad(
          `chat.agent.maxRequests = ${String(maxReq.effective)} — a lost agent digs that long before stopping`,
          'agent-max-requests',
        );
      } else {
        ok(`chat.agent.maxRequests = ${String(maxReq.effective)}`);
      }
    }
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
    if (toApply('close-stale-tabs')) {
      bad(`${tabs} editor tabs open — every one of them feeds the chat context`, 'close-stale-tabs');
    } else {
      ok(`${tabs} editor tab(s) open — context stays focused`);
    }
    off(
      'model choice is not readable locally — no setting carries it. In the model picker, ' +
        '"Auto" routes to a cost-efficient model at a 10% discount; pick a named model only ' +
        'when the task needs that one.',
    );
    off(
      'token usage measured from VSCode\'s own chat archive — see the spend screen. Requests ' +
        'before mid-2026 carry no counts. Per-turn detail: chat "…" menu → Show Chat Debug ' +
        'View. Billing is per token (AI Credits) since June 2026.',
    );
  }

  sec('Claude Code');
  if (toApply('explore-on-haiku')) {
    bad('helper agents inherit your model — every file search runs on the expensive one', 'explore-on-haiku');
  } else {
    ok('Explore agent pinned to a small model — searches run cheap');
  }
  if (toApply('general-purpose-on-sonnet')) {
    bad('general-purpose helper inherits your model', 'general-purpose-on-sonnet');
  } else {
    ok('general-purpose helper calibrated');
  }
  if (toApply('effort-level')) {
    bad('effortLevel = high/xhigh — long reasoning billed on every trivial turn', 'effort-level');
  } else {
    ok('reasoning effort reasonable');
  }
  if (toApply('auto-compact')) {
    bad('autoCompactEnabled = false — a long chat resends its whole history every message', 'auto-compact');
  } else {
    ok('auto-compact on — long chats stop growing linearly in price');
  }
  if (toApply('concision-rule')) {
    bad('no concision rule — every answer carries filler you pay for twice on helpers', 'concision-rule');
  } else {
    ok('concision rule active');
  }

  // An absent tool gets its row — the sweep must look as complete as it is.
  sec('OpenAI Codex');
  if (!result.tooling.codex) {
    off('Codex extension not installed (openai.chatgpt) — nothing to tune');
  } else if (!result.codex.configPresent) {
    off('installed, but no ~/.codex/config.toml yet — defaults apply everywhere');
  } else {
    const effort = result.codex.reasoningEffort;
    if (effort === 'high' || effort === 'xhigh') {
      bad(`model_reasoning_effort = ${esc(effort)} — long reasoning billed on every trivial turn`);
    } else {
      ok(`model_reasoning_effort = ${esc(effort ?? 'default (medium)')}`);
    }
    if (result.codex.autoCompactLimit) {
      ok(`auto-compact at ${Math.round(result.codex.autoCompactLimit / 1000)}k tokens — long chats stop growing linearly`);
    } else {
      off('model_auto_compact_token_limit not set — the model default applies');
    }
    const agentsMd = result.instructions.find((f) => f.label === 'AGENTS.md');
    if (agentsMd?.present) {
      ok(`reads AGENTS.md (${agentsMd.lines} lines) — shared with Copilot, one file to maintain`);
    }
  }

  sec('MCP servers — each schema rides along on every request');
  const mcp = [
    ...result.mcp,
    ...(result.tooling.codex && result.codex.mcpServers.length
      ? [{ label: '~/.codex/config.toml (Codex)', file: '', servers: result.codex.mcpServers }]
      : []),
  ].filter((s) => s.servers.length);
  if (!mcp.length) {
    ok('no MCP server declared — no schema overhead');
  } else {
    for (const s of mcp) {
      const line = `${esc(s.label)}: ${s.servers.length} server(s) — ${esc(s.servers.join(', '))}`;
      if (s.servers.length >= 3) {
        bad(`${line}. Every tool's name, description and schema is re-sent each turn — remove the ones this project never uses`);
      } else {
        ok(line);
      }
    }
  }

  // One line per conversation, the active one marked. "Current session" as a lone number
  // answered a question nobody asked; the list is what a dev actually recognises.
  const warnTokens =
    vscode.workspace.getConfiguration('voxAiGuide').get<number>('statusBar.warnAtTokens') ?? 150_000;
  const spend = result.workspaceRoot
    ? spendBreakdown(result.workspaceRoot, { longChatThreshold: warnTokens })
    : undefined;

  sec(`Conversations — this project, last ${spend?.days ?? 7} days (Claude)`);
  if (!spend?.chats.length) {
    off('no Claude conversation for this folder');
  } else {
    for (const c of spend.chats.slice(0, 6)) {
      const current = usage && c.file === usage.sessionFile;
      const share = spend.chats.length > 1 ? `${c.percent}% — ` : '';
      const line =
        `${share}"${esc(c.label.slice(0, 50))}" — peak ${Math.round(c.peakContext / 1000)}k` +
        (current
          ? ` ← active now, context ${Math.round(usage.contextTokens / 1000)}k on ${esc(usage.model ?? '?')}`
          : '');
      if (c.peakContext >= warnTokens) {
        bad(current ? `${line} — /compact pays off` : line);
      } else {
        ok(line);
      }
    }
    if (spend.chats.length > 6) {
      off(`${spend.chats.length - 6} more, each smaller`);
    }
  }

  sec(`Spend — last ${spend?.days ?? 7} days (Claude only, measured from its transcripts)`);
  if (!spend) {
    off('no Claude transcript for this project');
  } else {
    for (const s of [...spend.slices].sort((a, b) => b.tokens - a.tokens)) {
      if (!s.tokens) {
        continue;
      }
      const hot =
        (s.label === 'Long chats' && s.percent >= 50) ||
        (s.label === 'Helper agents' && s.percent >= 30 && spend.helperModels.some(isExpensiveModel));
      const line = `${esc(s.label)}: ${s.percent}% of the week's spend`;
      if (hot) {
        bad(line);
      } else {
        ok(line);
      }
    }
    // Raw volume and billed cost are different animals: a long chat is mostly the same
    // conversation re-read from cache each turn, at a tenth of the full rate. Showing the
    // raw figure next to a cost share made 245M read as 245M full-price tokens.
    off(
      `behind those shares: ${Math.round(spend.rawTokens / 1_000_000)}M raw tokens moved, ` +
        `worth ≈ ${Math.round(spend.total / 1_000_000)}M full-price input tokens — most of the ` +
        'volume is the conversation re-read from cache each turn, billed at a tenth of the rate',
    );
    if (spend.partial) {
      off('measurement cut short by the time budget — figures are a floor');
    }
  }

  sec('Credentials & personal data');
  const critical = findings.filter((f) => f.severity === 'critical').length;
  if (findings.length) {
    bad(`${findings.length} finding(s), ${critical} critical — see the Secrets tab. A pushed key is a burned key.`);
  } else {
    ok('no credential or personal data (emails, phones, IBANs, passwords) found in the scanned files — a scan, not a guarantee');
  }

  // --- Rendering: problems first, each with its fix; the rest one fold away. ---
  const glyphs = { ok: '✓', warn: '!', dim: '·' } as const;
  const classes = { ok: 'is-ok', warn: 'is-warn', dim: 'is-dim' } as const;
  const render = (list: RLine[], withFix: boolean) => {
    let cur = '';
    let html = '';
    for (const e of list) {
      if (e.section !== cur) {
        cur = e.section;
        html += `<div class="rsec">${esc(cur)}</div>`;
      }
      const fix = withFix && e.fixId ? fixes.find((f) => f.id === e.fixId) : undefined;
      const btn = fix
        ? ` <button class="ghost" data-review="${esc(fix.id)}">Fix — ${esc(fix.title)}…</button>`
        : '';
      html += `<div class="rline ${classes[e.kind]}"><span class="mark" aria-hidden="true">${glyphs[e.kind]}</span><span>${e.text}${btn}</span></div>`;
    }
    return html;
  };

  const warns = entries.filter((e) => e.kind === 'warn');
  const oks = entries.filter((e) => e.kind === 'ok');
  const dims = entries.filter((e) => e.kind === 'dim');
  // Applicable fixes whose trigger line is green or absent still deserve a row.
  const leftover = fixes.filter((f) => !warns.some((w) => w.fixId === f.id));

  const attention = warns.length
    ? render(warns, true)
    : `<div class="rline is-ok"><span class="mark" aria-hidden="true">✓</span><span>nothing needs attention — this setup is tuned</span></div>`;

  const also = leftover.length
    ? `<div class="rsec">Also worth doing</div>${leftover
        .map(
          (f) => `<div class="rline is-rec"><span class="mark" aria-hidden="true">→</span><span>${esc(f.title)}
            <button class="ghost" data-review="${esc(f.id)}">Review…</button></span></div>`,
        )
        .join('')}`
    : '';

  return `<div class="report">
    ${attention}
    ${also}
    <details class="rfold"><summary>✓ ${oks.length} check(s) passed — open for the detail</summary>${render(oks, false)}</details>
    <details class="rfold"><summary>· ${dims.length} for information — absent tools, counters no one can read</summary>${render(dims, false)}</details>
  </div>`;
}

function html(
  result: ScanResult,
  fixes: ReturnType<typeof applicableFixes>,
  usage?: SessionUsage,
  findings: Finding[] = [],
  logo?: { light: string; dark: string },
  tab: Tab = 'secrets',
  inPlace: ReturnType<typeof inPlaceFixes> = [],
): string {
  // Escape FIRST, transform backticks AFTERWARDS: warnings now carry paths coming from a
  // scan, and a `<` in a directory name would break the rendering.
  const warnBlocks = result.warnings
    .map((w) => `<div class="callout">${esc(w).replace(/`([^`]+)`/g, '<code>$1</code>')}</div>`)
    .join('');

  const fixCard = (f: Fix) => `<div class="fix">
      <div class="fix-head">
        <strong>${esc(f.title)}</strong>
        <button data-review="${esc(f.id)}">Review…</button>
      </div>
      <p>${esc(f.why)}</p>
      <p class="gain">↳ ${esc(f.gain)}</p>
    </div>`;

  // Two lists, never one. A setting on your machine and a file committed to a client repo
  // are not the same decision, and must not sit under the same heading.
  const personal = fixes.filter((f) => f.scope === 'personal');
  const project = fixes.filter((f) => f.scope === 'project');

  const fixBlocks = fixes.length
    ? `${
        personal.length
          ? `<h3>Fixes that affect only you</h3>
             <p class="lede small">They edit files in your home folder. Nothing changes for anyone else.</p>
             ${personal.map(fixCard).join('')}`
          : ''
      }${
        project.length
          ? `<h3>Fixes that affect the whole team</h3>
             <p class="lede small">They edit files inside this repo. When you commit and push, your teammates
             get the change too — on a client repo, read it before committing.</p>
             ${project.map(fixCard).join('')}`
          : ''
      }`
    : '<div class="callout ok-callout">Nothing to fix: your configuration is aligned.</div>';

  const usageBlock = usage
    ? `<div class="usage">
         <div><span class="dim">Context at last exchange</span><strong>${usage.contextTokens.toLocaleString('en-GB')} tokens</strong></div>
         <div><span class="dim">Model</span><strong>${esc(usage.model ?? '—')}</strong></div>
         <div><span class="dim">Subagents spawned</span><strong>${usage.subagents}</strong></div>
       </div>`
    : '<div class="callout">No Claude session detected for this folder.</div>';

  // Counts on the tabs, so the bar says what it holds before you click it.
  const counts: Partial<Record<Tab, number>> = {
    secrets: findings.length,
    fixes: fixes.length,
  };

  const nav = TABS.map(
    (t) =>
      `<button class="tab${t.id === tab ? ' on' : ''}" data-tab="${t.id}" aria-current="${t.id === tab}">${esc(t.label)}${
        counts[t.id] ? ` <span class="count">${counts[t.id]}</span>` : ''
      }</button>`,
  ).join('');

  const panes: Record<Tab, string> = {
    report: `<h2>Tune-up report</h2>
      <p class="lede">Measured on this machine, right now. What needs attention comes first,
      with its fix on the same line; everything that checked out is folded below.</p>
      ${reportSection(result, fixes, usage, findings)}`,

    secrets: `${secretsSection(findings)}
      <h2>Current Claude session</h2>
      ${usageBlock}`,

    fixes: `<h2>Suggested fixes</h2>
      ${fixBlocks}
      ${
        inPlace.length
          ? `<h2>Already in place — still yours to edit</h2>
             <p class="lede small">Nothing this extension writes is final. Each of these opens the
             file or setting it lives in.</p>
             ${inPlace
               .map(
                 (e) => `<div class="inplace">
                   <span><strong>${esc(e.fix.title)}</strong>
                     <span class="dim small">— ${esc(e.target.label)}</span></span>
                   <button class="ghost" data-edit="${esc(e.fix.id)}">${
                     e.target.file ? 'Open the file' : 'Open the setting'
                   }</button>
                 </div>`,
               )
               .join('')}`
          : ''
      }
      ${result.warnings.length ? `<h2>Worth your attention</h2>${warnBlocks}` : ''}`,

    files: `<h2>Where your instructions live</h2>
      <div class="rules2">
        <div class="rulecard">
          <div class="rule-title">Instruction files (.md) — they stack</div>
          <div class="rule-demo mono">A + B + C&nbsp;&nbsp;=&nbsp;&nbsp;one prompt</div>
          <p>Every loaded file joins the same prompt. Nothing cancels anything: a personal rule
          and a project rule that disagree are <em>both</em> sent, and the model arbitrates.</p>
        </div>
        <div class="rulecard">
          <div class="rule-title">Settings (.json) — they override</div>
          <div class="rule-demo mono">IT &gt; project &gt; you&nbsp;&nbsp;→&nbsp;&nbsp;one winner per key</div>
          <p>Each setting takes its value from the strongest layer that defines it — the other
          layers are ignored for that key. That is the next tab.</p>
        </div>
      </div>
      <p class="lede small">The chip on each row says which folder family the file lives in —
      <span class="zone z-home">home (~)</span> is yours alone,
      <span class="zone z-repo">repo</span> travels with Git to the whole team,
      <span class="zone z-it">IT managed</span> is pushed by IT and cannot be edited.</p>

      <h3>What Claude Code reads — in this order, top to bottom</h3>
      <p class="lede small">Machine first, then your home folder, then the repo. Later files
      <em>add to</em> earlier ones; nothing cancels anything. Present is not the same as loaded —
      watch the last column.</p>
      <table>${chainRows(
        result.instructions.filter((f) => f.reader === 'claude' || f.reader === 'both'),
        true,
      )}</table>

      <h3>What Copilot reads — all combined, no pecking order</h3>
      <p class="lede small">Copilot merges these too. Half of them only exist for it if a VSCode
      setting says so — that is where "present but ignored" comes from.</p>
      <table>${chainRows(
        result.instructions.filter((f) => f.reader === 'copilot' || f.reader === 'both'),
        false,
      )}</table>`,

    settings: `${dietSection(result)}

      <h2>Settings layers (Claude Code)</h2>
      <p class="lede">The opposite logic from instruction files: these do not add up, they
      <strong>override</strong>. For each setting, the highest layer on this ladder that defines
      it wins — everything below is ignored for that key.</p>
      <div class="ladder">${result.settings
        .map(
          (st, i) => `${
            i ? '<div class="beats" aria-hidden="true">▲ beats everything below</div>' : ''
          }<div class="rung${st.present ? '' : ' rung-off'}">
            <span class="rankn">${st.rank}</span>
            <span class="rung-body">${zoneChip(st.file)} <strong>${esc(st.label)}</strong>
              <span class="dim small mono">${esc(st.file || '—')}</span></span>
            <span class="state">${
              st.present ? '<span class="ok">present</span>' : '<span class="dim">missing</span>'
            }</span>
          </div>`,
        )
        .join('')}</div>

      <h2>Active VSCode settings — same rule, another ladder</h2>
      <p class="lede">VSCode settings override too, on their own ladder: folder &gt; workspace &gt;
      user &gt; default — the most specific wins. A setting whose badge says <em>workspace</em>
      lives in <code>.vscode/settings.json</code>, a file Git shares with the whole team.</p>
      <table>${vscodeRows(result.vscode)}</table>`,

    habits: `<h2>What no setting will do for you</h2>
      <p class="lede">Each title is the whole instruction — open one only if you want the reason.</p>
      ${TIPS.map(
        (t) =>
          `<details class="tip"><summary>${esc(t.title)}</summary><p>${esc(t.why).replace(
            /`([^`]+)`/g,
            '<code>$1</code>',
          )}</p></details>`,
      ).join('')}`,
  };

  return shell(`
${brand(logo, 'Your AI configuration')}
<nav class="tabs">${nav}
  <button class="tab refresh" data-refresh title="Re-run every scan and measurement" aria-label="Scan again"><span class="glyph">⟳</span> Scan again</button>
</nav>
${panes[tab]}
`);
}

/** The colour logo, with its light/dark pair — impossible on the activity bar, fine here. */
function brand(logo: { light: string; dark: string } | undefined, title: string): string {
  return logo
    ? `<div class="brand">
         <img class="logo logo-light" src="${logo.light}" alt="Vox Teneo">
         <img class="logo logo-dark" src="${logo.dark}" alt="Vox Teneo">
         <h1>${esc(title)}</h1>
       </div>`
    : `<h1>${esc(title)}</h1>`;
}

function nonce(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

/** One page chrome for both screens: the map and the review. */
function shell(body: string): string {
  const n = nonce();
  // Same lockdown as the sidebar: this webview renders file paths and setting names from
  // the scan — nothing it shows may ever become an execution vector.
  const csp = `default-src 'none'; img-src ${panel?.webview.cspSource ?? ''}; style-src 'nonce-${n}'; script-src 'nonce-${n}';`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${n}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
         color: var(--vscode-foreground);
         padding: 20px 24px; max-width: 980px; line-height: 1.5; }
  button:focus-visible, textarea:focus-visible, select:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
  }
  h1 { font-size: 1.38em; margin: 0 0 4px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  .brand h1 { margin: 0; }
  .logo { height: 34px; width: auto; }
  /* VSCode puts vscode-light / vscode-dark / vscode-high-contrast on the body. */
  .logo-dark { display: none; }
  body.vscode-dark .logo-dark, body.vscode-high-contrast .logo-dark { display: block; }
  body.vscode-dark .logo-light, body.vscode-high-contrast .logo-light { display: none; }
  h2 { font-size: 1.08em; margin: 28px 0 10px; text-transform: uppercase; letter-spacing: .06em;
       color: var(--vscode-descriptionForeground); }
  .lede { color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  td:first-child { width: 78px; }
  .scope { color: var(--vscode-descriptionForeground); width: 30%; }
  .state { text-align: right; white-space: nowrap; }
  .dim { color: var(--vscode-descriptionForeground); }
  .small { font-size: 0.85em; }
  .mono, code { font-family: var(--vscode-editor-font-family); font-size: 0.85em; }
  .report { line-height: 1.5; }
  .report .rsec {
    font-size: 0.78em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--vscode-descriptionForeground);
    margin: 20px 0 6px; padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
  }
  .report .rsec:first-child { margin-top: 4px; }
  .report .rline { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; }
  .report .mark {
    display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; border-radius: 50%; flex: none;
    font-size: 10px; font-weight: 700; align-self: flex-start; margin-top: 2px;
  }
  .report .is-ok .mark { color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 18%, transparent); }
  .report .is-warn .mark { color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 22%, transparent); }
  .mark-inline { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; font-size: 9px; font-weight: 700; vertical-align: baseline; color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 22%, transparent); }

  /* The two opposite rules of the maze, side by side — the whole lesson in one glance. */
  .rules2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 12px 0 16px; }
  @media (max-width: 640px) { .rules2 { grid-template-columns: 1fr; } }
  .rulecard { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 6px; padding: 12px 14px; }
  .rulecard p { margin: 6px 0 0; color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  .rule-title { font-weight: 600; }
  .rule-demo { margin-top: 4px; color: var(--vscode-textLink-foreground); font-size: 0.9em; }

  /* Where a file lives — the ".claude vs .github vs .vscode" answer, one chip per row. */
  .zone { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 0.72em; font-weight: 600; letter-spacing: 0.02em; vertical-align: 1px; }
  .z-home { color: var(--vscode-charts-blue); background: color-mix(in srgb, var(--vscode-charts-blue) 15%, transparent); }
  .z-repo { color: var(--vscode-charts-orange); background: color-mix(in srgb, var(--vscode-charts-orange) 15%, transparent); }
  .z-it { color: var(--vscode-charts-purple); background: color-mix(in srgb, var(--vscode-charts-purple) 15%, transparent); }
  .z-none { color: var(--vscode-descriptionForeground); }

  /* The override ladder: strongest on top, and the arrow says so between every rung. */
  .ladder { margin: 8px 0 16px; }
  .rung { display: flex; align-items: baseline; gap: 10px; padding: 8px 10px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 6px; }
  .rung-off { opacity: 0.55; }
  .rung-body { flex: 1; min-width: 0; }
  .rung-body .mono { display: block; overflow-wrap: anywhere; }
  .beats { margin: 2px 0 2px 18px; font-size: 0.75em; color: var(--vscode-descriptionForeground); }
  .report .is-dim .mark { color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent); }
  .report .is-dim > span:last-child { color: var(--vscode-descriptionForeground); }
  .report .is-rec .mark { color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 15%, transparent); }
  .report button { margin-left: 8px; }
  .report details.rfold { margin-top: 20px; }
  .report .rfold summary { cursor: pointer; font-weight: 600; padding: 6px 0; color: var(--vscode-descriptionForeground); list-style-position: outside; }
  .report .rfold summary:hover { color: var(--vscode-textLink-foreground); }
  .report .rfold[open] summary { color: inherit; }
  .inplace { display: flex; align-items: center; justify-content: space-between; gap: 16px;
             padding: 6px 2px; border-bottom: 1px solid var(--vscode-panel-border); }
  .inplace button { flex-shrink: 0; }
  .ok { color: var(--vscode-charts-green); }
  .warn { color: var(--vscode-charts-yellow); }
  td.rank { width: 34px; text-align: center; }
  .rankn { display: inline-flex; align-items: center; justify-content: center;
           width: 20px; height: 20px; border-radius: 50%; font-size: 0.8em; font-weight: 700;
           border: 1px solid var(--vscode-panel-border);
           color: var(--vscode-descriptionForeground); }
  .rankn.sum { border-color: var(--vscode-charts-green); color: var(--vscode-charts-green); }
  tr.chain-off > td:not(.state) { opacity: 0.55; }
  tr.chain-sum td { border-bottom: 0; color: var(--vscode-descriptionForeground); }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 0.77em;
           border: 1px solid var(--vscode-panel-border); }
  .badge.both { border-color: var(--vscode-charts-green); color: var(--vscode-charts-green); }
  .callout { border-left: 3px solid var(--vscode-charts-yellow); padding: 8px 12px; margin: 8px 0;
             background: var(--vscode-textBlockQuote-background); }
  .ok-callout { border-left-color: var(--vscode-charts-green); }
  .danger { border-left-color: var(--vscode-charts-red); }
  .sev { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 0.77em;
         border: 1px solid currentColor; white-space: nowrap; }
  .sev-crit { color: var(--vscode-charts-red); }
  .sev-high { color: var(--vscode-charts-yellow); }
  .sev-low  { color: var(--vscode-descriptionForeground); }
  button.ghost { background: transparent; color: var(--vscode-foreground);
                 border: 1px solid var(--vscode-panel-border); margin-left: 4px; }
  .fix { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 14px; margin: 10px 0; }
  .fix-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .fix p { margin: 8px 0 0; color: var(--vscode-descriptionForeground); }
  .gain { color: var(--vscode-charts-green) !important; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: 0; padding: 5px 14px; border-radius: 3px; cursor: pointer; flex: none; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .tip { border-left: 2px solid var(--vscode-panel-border); padding: 2px 0 2px 12px; margin: 7px 0; }
  .tip summary { cursor: pointer; font-weight: 600; }
  .tip summary:hover { color: var(--vscode-textLink-foreground); }
  .tip p { margin: 4px 0 0; color: var(--vscode-descriptionForeground); max-width: 70ch; }
  .usage { display: flex; gap: 32px; padding: 12px 0; }
  .usage div { display: flex; flex-direction: column; gap: 2px; }

  h3 { font-size: 1em; margin: 22px 0 4px; }
  button.back { background: transparent; color: var(--vscode-descriptionForeground);
                border: 0; padding: 4px 0; margin: 0 0 14px; font-size: 0.92em; }
  button.back:hover { color: var(--vscode-textLink-foreground); background: transparent; }
  .review-title { font-size: 1.54em; margin: 0 0 6px; }
  .why { max-width: 74ch; margin: 0 0 16px; }
  .target { border-left: 3px solid var(--vscode-panel-border); padding: 8px 12px; margin: 0 0 14px;
            background: var(--vscode-textBlockQuote-background); }
  .target-shared { border-left-color: var(--vscode-charts-yellow); }
  .target-file { font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
  .target-note { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .target-shared .target-note { color: var(--vscode-charts-yellow); }
  .was { font-size: 0.92em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
  .swap { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 4px;
          font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
  .swap .arrow { color: var(--vscode-descriptionForeground); }
  .swap .will { color: var(--vscode-charts-green); }
  .notes { margin: 14px 0 0; padding: 0; list-style: none;
           color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  .notes li { padding-left: 18px; position: relative; margin: 3px 0; }
  .notes li::before { content: '✓'; position: absolute; left: 0; color: var(--vscode-charts-green); }
  .actions { display: flex; gap: 8px; margin: 22px 0 0; }
  .tabs { display: flex; gap: 2px; margin: 14px 0 4px; flex-wrap: wrap;
          border-bottom: 1px solid var(--vscode-panel-border); }
  button.tab { background: transparent; color: var(--vscode-descriptionForeground);
               border: 0; border-bottom: 2px solid transparent; border-radius: 0;
               padding: 7px 12px; font-size: 0.92em; }
  button.tab:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  button.tab.on { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  button.tab.refresh { margin-left: auto; padding: 4px 12px; display: inline-flex; align-items: center; gap: 6px; }
  button.tab.refresh .glyph { font-size: 1.35em; line-height: 1; }
  .count { display: inline-block; min-width: 15px; padding: 0 4px; border-radius: 8px;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
           font-size: 0.77em; text-align: center; }
  h2:first-of-type { margin-top: 18px; }
  textarea { width: 100%; min-height: 260px; box-sizing: border-box; padding: 10px 12px;
             border-radius: 6px; border: 1px solid var(--vscode-charts-green);
             background: var(--vscode-input-background); color: var(--vscode-input-foreground);
             font-family: var(--vscode-editor-font-family); font-size: 0.85em; line-height: 1.5;
             resize: vertical; }
  .picker { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .picker label { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
           border: 1px solid var(--vscode-dropdown-border); border-radius: 3px; padding: 4px 6px; }
</style></head><body>
${body}
<script nonce="${n}">
  const vscodeApi = acquireVsCodeApi();
  const send = (sel, make) =>
    document.querySelectorAll(sel).forEach((b) => b.addEventListener('click', () => vscodeApi.postMessage(make(b))));
  send('button[data-tab]', (b) => ({ command: 'tab', id: b.dataset.tab }));
  send('button[data-review]', (b) => ({ command: 'review', id: b.dataset.review }));
  const draftEl = () => document.getElementById('draft');
  const tplEl = () => document.getElementById('tpl');
  send('button[data-apply]', (b) => ({
    command: 'apply',
    id: b.dataset.apply,
    draft: draftEl() ? draftEl().value : undefined,
  }));
  // Switching entry reloads the text, unless it has already been edited by hand.
  if (tplEl()) {
    tplEl().addEventListener('change', () =>
      vscodeApi.postMessage({ command: 'template', id: tplEl().value }));
  }
  send('button[data-cancel]', () => ({ command: 'cancel' }));
  send('button[data-reveal]', (b) => ({ command: 'reveal', idx: Number(b.dataset.reveal) }));
  send('button[data-revoke]', (b) => ({ command: 'revoke', idx: Number(b.dataset.revoke) }));
  send('button[data-gitignore]', (b) => ({ command: 'gitignore', idx: Number(b.dataset.gitignore) }));
  send('button[data-edit]', (b) => ({ command: 'edit', id: b.dataset.edit }));
  send('button[data-setting]', (b) => ({ command: 'setting', id: b.dataset.setting }));
  send('button[data-open]', (b) => ({ command: 'open', path: b.dataset.open }));
  send('button[data-trim-prompt]', () => ({ command: 'trimPrompt' }));
  send('button[data-refresh]', () => ({ command: 'refresh' }));
</script>
</body></html>`;
}
