import * as vscode from 'vscode';
import { applicableFixes, Fix, FixContext } from './fixes';
import { showDoctor } from './panel';
import { scan } from './scan';
import { Finding, scanSecrets } from './secrets';
import { detectTraces } from './tools';
import {
  claudeInstalled,
  currentUsage,
  isExpensiveModel,
  localChats,
  SessionUsage,
  crossToolSpend,
  spendBreakdown,
  SpendBreakdown,
  SpendSlice,
} from './usage';

/**
 * The sidebar answers two questions and nothing else: am I overspending, and are my keys
 * safe. Everything beyond that is one click deeper. It is a webview and not a tree because
 * the answer has to be a sentence a non-expert understands, not a labelled node — and
 * because "nothing is written without review" needs a before/after screen to live in.
 *
 * The full configuration map stays in `panel.ts`: its tables do not fit this width.
 */
type Screen = 'home' | 'spend' | 'secrets';

const CONTEXT_WARN_KEY = 'statusBar.warnAtTokens';

export class DoctorSidebar implements vscode.WebviewViewProvider {
  static readonly viewId = 'voxAiGuide.home';

  private view?: vscode.WebviewView;
  private screen: Screen = 'home';

  /** Host name when we run as a local fallback in a remote window; version for the footer. */
  constructor(
    private readonly remoteFallbackHost?: string,
    private readonly version?: string,
  ) {}

  /** Deploy done this session — only a window reload switches to the remote copy. */
  private remoteDeployed = false;

  remoteInstalled(): void {
    this.remoteDeployed = true;
    this.render();
  }

  /** Findings from the last render — the webview only ever sends back an index. */
  private findings: Finding[] = [];
  /** Computed on demand: it walks whole transcripts, the home screen must stay instant. */
  private spend?: SpendBreakdown;
  private spendComputed = false;
  /** Scan results survive navigation clicks; only refresh() invalidates them. */
  private scanCache?: { findings: Finding[]; fixes: Fix[] };

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    // Without retainContextWhenHidden the webview is torn down when hidden: rebuild on
    // show, both to restore it and to catch up on refreshes deferred while invisible.
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.render();
      }
    });
    this.render();
  }

  /** Re-scan and redraw. Called on refresh, after a fix, and when a watched file is saved. */
  refresh(): void {
    this.spendComputed = false;
    this.scanCache = undefined;
    this.render();
  }

  home(): void {
    this.screen = 'home';
    this.refresh();
  }

  private ctx(): FixContext {
    return { workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath };
  }

  private async onMessage(msg: {
    command?: string;
    to?: Screen;
    id?: string;
    idx?: number;
    tab?: 'report' | 'secrets' | 'fixes' | 'files' | 'settings' | 'habits';
  }): Promise<void> {
    try {
      switch (msg?.command) {
        case 'nav':
          this.screen = msg.to ?? 'home';
          break;
        // The sidebar informs and points; the panel acts. Every actionable click leaves
        // this 340px column for a full page, where the before/after fits and where the
        // decision to write a file is actually taken.
        case 'review':
          showDoctor({ mode: 'review', fixId: msg.id ?? '' });
          return;
        case 'panel':
          // Land on the tab that matches where the click came from, not on a generic page.
          showDoctor({
            mode: 'map',
            tab: msg.tab ?? (this.screen === 'secrets' ? 'secrets' : 'fixes'),
          });
          return;
        case 'refresh':
          this.spendComputed = false;
          break;
        case 'installRemote':
          // The whole flow (self-built vsix, remote write, fallback) lives in extension.ts.
          await vscode.commands.executeCommand('voxAiGuide.installOnRemote');
          return;
        case 'reloadWindow':
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        default:
          return;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Vox AI: failed — ${e instanceof Error ? e.message : String(e)}`);
    }
    this.render();
  }

  private render(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const ctx = this.ctx();
    // A navigation click re-renders but must not re-scan: the answer has not changed
    // because the user changed screens. refresh() is the only invalidation.
    if (!this.scanCache) {
      this.scanCache = {
        findings: scanSecrets(ctx.workspaceRoot),
        fixes: applicableFixes(ctx),
      };
    }
    this.findings = this.scanCache.findings;
    const fixes = this.scanCache.fixes;

    // Urgent first: an exposed credential outranks a saving. The badge sits on the
    // activity bar icon, so it is kept current even while the view itself is hidden.
    const critical = this.findings.filter((f) => f.severity === 'critical').length;
    view.badge = critical
      ? { value: critical, tooltip: `${critical} credential(s) exposed` }
      : fixes.length
        ? { value: fixes.length, tooltip: `${fixes.length} thing(s) to fix` }
        : undefined;

    // Hidden view: badge updated, html deferred — onDidChangeVisibility re-renders on
    // show. This is what makes the 15-minute background tick nearly free when the
    // sidebar is closed.
    if (!view.visible) {
      return;
    }

    const usage = ctx.workspaceRoot ? currentUsage(ctx.workspaceRoot) : undefined;

    if (this.screen === 'spend' && !this.spendComputed) {
      this.spendComputed = true;
      this.spend = ctx.workspaceRoot
        ? spendBreakdown(ctx.workspaceRoot, { longChatThreshold: warnAt() })
        : undefined;
    }

    view.webview.html = page(this.body(fixes, usage), view.webview.cspSource);
  }

  private body(fixes: Fix[], usage: SessionUsage | undefined): string {
    // Wrong-machine data must be labelled on every screen, not just home: "no Claude chat
    // in this project" reads as a verdict, and it is one — about the laptop, not the VM.
    const strip = this.remoteFallbackHost
      ? `<div class="remote-strip">${
          this.remoteDeployed
            ? `Installed on <code>${esc(this.remoteFallbackHost)}</code> — reload the window to switch.`
            : `Looking at <b>your local machine</b>, not
               <code>${esc(this.remoteFallbackHost)}</code> — install there from the home screen.`
        }</div>`
      : '';
    switch (this.screen) {
      case 'spend':
        return strip + spendScreen(this.spend, fixes, usage);
      case 'secrets':
        return strip + secretsScreen(this.findings);
      default:
        return homeScreen(
          this.findings,
          fixes,
          usage,
          this.remoteFallbackHost,
          this.remoteDeployed,
          this.version,
        );
    }
  }
}

function warnAt(): number {
  return (
    vscode.workspace.getConfiguration('voxAiGuide').get<number>(CONTEXT_WARN_KEY) ?? 150_000
  );
}


// --- Screens ----------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Colour is a claim, so it is earned, never decorative.
 * `danger` (red) is reserved for an exposed credential — something already lost. Money is
 * `warn` (amber) at worst: overspending is a habit to change, not an incident. `off` is the
 * neutral default, and most things should land there.
 */
type Tone = 'ok' | 'warn' | 'danger' | 'off';

interface Verdict {
  /** The answer is always a word. A number here would be a second question, not an answer. */
  word: string;
  tone: Tone;
  summary: string;
}

function spendVerdict(fixes: Fix[], usage: SessionUsage | undefined): Verdict {
  const hot = !!usage && usage.contextTokens >= warnAt();
  const helpersOnBigModel = !!usage && usage.subagents > 0 && isExpensiveModel(usage.model);

  // Without a Claude session there is no live context figure — Copilot's archive gives
  // per-request totals, not the size of the chat you have open right now. Answering "No,
  // you're lean" from nothing would be a comfortable lie. Say what we cannot see instead.
  if (!claudeInstalled() && !usage) {
    return {
      word: "Can't tell",
      tone: 'off',
      summary:
        'No Claude chat recorded here. Copilot totals appear in the tool list below, ' +
        'but no tool exposes the <b>live context size</b> of a Copilot chat.',
    };
  }

  if (helpersOnBigModel) {
    return {
      word: 'Yes',
      tone: 'warn',
      summary:
        `Your helper agents run on <b>the most expensive model</b> — ` +
        `${usage!.subagents} of them in this chat alone.`,
    };
  }
  if (hot) {
    return {
      word: 'Yes',
      tone: 'warn',
      summary:
        `This chat now carries <b>${Math.round(usage!.contextTokens / 1000)}k</b> of history, ` +
        'and you pay for all of it on every message.',
    };
  }
  if (fixes.length >= 3) {
    return {
      word: 'Yes',
      tone: 'warn',
      summary: `<b>${fixes.length} habits</b> are costing you more than they need to.`,
    };
  }
  if (fixes.length) {
    return {
      word: 'A bit',
      tone: 'warn',
      summary: `<b>${fixes.length} small thing${fixes.length > 1 ? 's' : ''}</b> to tidy up, nothing urgent.`,
    };
  }
  return {
    word: 'No',
    tone: 'ok',
    summary: claudeInstalled()
      ? 'Your setup is as lean as we can check for. <span class="dim">Claude measured; Copilot cannot be.</span>'
      : 'Your setup is as lean as we can check for.',
  };
}

function keysVerdict(findings: Finding[]): Verdict {
  const critical = findings.filter((f) => f.severity === 'critical');
  if (critical.length) {
    const shared = critical.some((f) => f.tracked);
    return {
      word: 'No',
      tone: 'danger',
      summary: shared
        ? `<b>${critical.length} key${critical.length > 1 ? 's' : ''} at risk</b> — sitting in a file Git shares with your team.`
        : `<b>${critical.length} key${critical.length > 1 ? 's' : ''} at risk</b> — sent to the AI provider on every message.`,
    };
  }
  if (findings.length) {
    return {
      word: 'Check',
      tone: 'warn',
      summary: `<b>${findings.length} thing${findings.length > 1 ? 's' : ''}</b> worth a look — probably fine, worth 30 seconds.`,
    };
  }
  // Never "Yes". A scanner can prove presence, not absence: we check the files these
  // tools read, against known key formats, tuned for zero false alarms — which buys
  // false silences. The word must claim exactly that much and no more.
  return {
    word: 'None',
    tone: 'ok',
    summary:
      'Nothing in the files your AI tools read, against known key formats. ' +
      'A scan, not a guarantee.',
  };
}

function gauge(v: Verdict): string {
  return `<div class="gauge ${v.tone}"><span>${esc(v.word)}</span></div>`;
}

/**
 * The card answers in a word; the click opens the panel on the matching tab. The sidebar
 * is a pure summary — the user decided the detail lives in the editor, tuner-report style,
 * not in a second sidebar screen nobody realises they navigated to.
 */
function questionCard(title: string, tab: 'report' | 'secrets', v: Verdict): string {
  return `<div class="card q ${v.tone === 'danger' ? 'edge-danger' : ''}" data-panel="${tab}" role="button" tabindex="0">
    <div class="q-head"><span class="q-title">${esc(title)}</span><span class="chev">›</span></div>
    <div class="q-body">${gauge(v)}<span class="q-summary">${v.summary}</span></div>
  </div>`;
}

interface Tool {
  name: string;
  status: string;
  /** Second line: the same tool seen across the whole machine, not just this project. */
  everywhere?: string;
  tone: Tone;
}

/** 87_800_000 -> "87.8M". Volume is context, never the headline. */
function mtok(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 / 1024)} MB`;
}

function detectTools(usage: SessionUsage | undefined, findings: Finding[]): Tool[] {
  const out: Tool[] = [];
  const detected = detectTraces(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

  // Claude and Copilot get a hand-written row: we know more about them than the catalogue
  // does — a live context size for one, VS Code's closed storage for the other.
  const claudeHere = claudeInstalled();
  const all = claudeHere ? localChats() : undefined;
  out.push({
    name: 'Claude',
    tone: !claudeHere ? 'off' : usage && usage.contextTokens >= warnAt() ? 'warn' : 'ok',
    status: !claudeHere
      ? 'not detected'
      : usage
        ? `active · ${Math.round(usage.contextTokens / 1000)}k of history in this chat`
        : 'installed · no chat in this project',
    everywhere: all
      ? `${all.chats} chat${all.chats > 1 ? 's' : ''} kept on this machine · ` +
        `${all.projects} project${all.projects > 1 ? 's' : ''} · ${mb(all.bytes)}` +
        (all.today ? ` · ${all.today} today` : '')
      : undefined,
  });

  const copilot =
    vscode.extensions.getExtension('GitHub.copilot') ??
    vscode.extensions.getExtension('GitHub.copilot-chat');
  const sharedFile = findings.some((f) => toolOf(f.file) === 'Copilot');
  out.push({
    name: 'Copilot',
    tone: !copilot ? 'off' : sharedFile ? 'warn' : 'ok',
    status: !copilot ? 'not detected' : sharedFile ? 'active · check its settings file' : 'active',
    // Copilot keeps its chat history inside VS Code's own storage, which no extension can read.
    everywhere: copilot ? 'chat history kept by VS Code, not readable from here' : undefined,
  });

  // Everything else comes straight from the catalogue. A developer rarely knows how many
  // of these are on their disk, nor that some keep whole conversations in clear text.
  for (const tool of detected) {
    if (tool.id === 'claude-code' || tool.id === 'copilot') {
      continue;
    }
    const logs = tool.traces.filter((t) => t.kind === 'history').length;
    out.push({
      name: tool.name,
      tone: !tool.detected ? 'off' : logs ? 'warn' : 'ok',
      status: !tool.detected
        ? 'not detected'
        : `${tool.traces.length} file${tool.traces.length > 1 ? 's' : ''} on this machine`,
      everywhere: logs
        ? `${logs} conversation log${logs > 1 ? 's' : ''} kept in clear text`
        : undefined,
    });
  }

  return out;
}

function toolOf(file: string): 'Claude' | 'Copilot' {
  const p = file.replace(/\\/g, '/');
  return /\/\.vscode\/|\/\.github\//.test(p) ? 'Copilot' : 'Claude';
}

/**
 * Detected tools get a line each; absent ones share a single line at the bottom.
 *
 * "Not detected" is still a first-class state — the sweep has to look as complete as it is —
 * but eight absent tools spread over sixteen lines drowns the two or three that are actually
 * there. One line says the same thing and leaves the screen readable.
 */
function toolRows(tools: Tool[]): string {
  const here = tools.filter((t) => t.tone !== 'off');
  const absent = tools.filter((t) => t.tone === 'off');

  const rows = here
    .map(
      (t) => `<div class="row">
        <span class="row-block">
          <b>${esc(t.name)}</b>
          <i>${esc(t.status)}${t.everywhere ? ` · ${esc(t.everywhere)}` : ''}</i>
        </span>
        <span class="dot ${t.tone}"></span>
      </div>`,
    )
    .join('');

  const rest = absent.length
    ? `<div class="row absent" title="${esc(absent.map((t) => t.name).join(', '))}">
        <span class="row-block"><i class="dim">Not detected: ${esc(
          absent.map((t) => t.name).join(', '),
        )}</i></span>
      </div>`
    : '';

  return rows + rest;
}

function homeScreen(
  findings: Finding[],
  fixes: Fix[],
  usage: SessionUsage | undefined,
  remoteHost?: string,
  remoteDeployed = false,
  version?: string,
): string {
  // Running locally against a remote window: every verdict below describes the laptop, not
  // the machine on screen. That has to be said before the verdicts, not under them.
  // Once deployed, the remaining gesture is a window reload — so that is the button.
  const remoteBanner = remoteHost
    ? remoteDeployed
      ? `<div class="card teach">
          <div class="card-title">Installed on ${esc(remoteHost)}</div>
          <div class="card-body">Reload the window to switch to the copy that sees the
          remote machine.</div>
          <div class="btn primary" data-cmd="reloadWindow" role="button" tabindex="0">Reload window →</div>
        </div>`
      : `<div class="card teach edge-danger">
          <div class="card-title">This window is remote</div>
          <div class="card-body">Everything below describes <b>your local machine</b>, not
          <code>${esc(remoteHost)}</code>.</div>
          <div class="btn primary" data-cmd="installRemote" role="button" tabindex="0">Install / update on the remote host →</div>
        </div>`
    : '';

  return `
  <header class="head">
    <span class="brand">VOX AI GUIDE</span>
    <span class="icon-btn" data-cmd="refresh" title="Scan again" aria-label="Scan again" role="button" tabindex="0">⟳</span>
  </header>
  <main>
    ${remoteBanner}
    ${questionCard('Am I overspending?', 'report', spendVerdict(fixes, usage))}
    ${questionCard('Are my keys safe?', 'secrets', keysVerdict(findings))}
    <section>
      <div class="label">YOUR AI TOOLS</div>
      ${toolRows(detectTools(usage, findings))}
    </section>
    <div class="more" data-cmd="panel" role="button" tabindex="0">
      See every file these tools read →
    </div>
  </main>
  <footer class="foot">Scanned locally · nothing leaves this machine${version ? ` · v${esc(version)}` : ''}</footer>`;
}

function back(title: string): string {
  return `<header class="head">
    <span class="icon-btn" data-nav="home" aria-label="Back to overview" role="button" tabindex="0">←</span>
    <span class="brand">${esc(title)}</span>
  </header>`;
}

/**
 * Colour says "is this a problem", never "which row is this". A red bar is a claim, and on a
 * slice at 0% it would be a false one: the user reads alarm where the measurement says clean.
 * So the tone comes from the value — dominant and large is red, sizeable is amber, the rest
 * is neutral — and "Normal work" is green because spending there is the healthy outcome.
 */
function sliceTone(slice: SpendSlice, dominant: boolean): Tone {
  if (slice.label === 'Normal work') {
    return slice.percent >= 50 ? 'ok' : 'off';
  }
  if (slice.tokens === 0) {
    return 'off';
  }
  // Never 'danger' here: red is reserved for an exposed credential, something already
  // lost. Overspending is a habit to change, so amber is as loud as money gets.
  return dominant && slice.percent >= 40 ? 'warn' : slice.percent >= 20 ? 'warn' : 'off';
}

/**
 * One stacked bar, not three. Three bars invite you to compare each against an empty
 * track; a single bar shows what it actually is — one budget, split. The legend carries
 * the numbers, so the bar itself stays a shape you read in half a second.
 */
function bars(spend: SpendBreakdown): string {
  const top = [...spend.slices].sort((a, b) => b.tokens - a.tokens)[0];
  const shown = spend.slices.filter((s) => s.percent > 0);

  const segments = shown
    .map(
      (s) =>
        `<i class="${sliceTone(s, s === top)} w${s.percent}" title="${esc(s.label)} ${
          s.percent
        }%"></i>`,
    )
    .join('');

  const legend = shown
    .map((s) => {
      const tone = sliceTone(s, s === top);
      return `<span class="key"><i class="${tone}"></i>${esc(s.label)}
        <b class="${tone === 'warn' || tone === 'danger' ? tone : ''}">${s.percent}%</b></span>`;
    })
    .join('');

  return `<div class="stack">${segments}</div><div class="keys">${legend}</div>`;
}

/**
 * Which chats, and where. A share on its own names a problem without locating it — you
 * cannot close a percentage. Dearest first, with the two facts that make it actionable:
 * how big it grew, and how much of it was spent past the threshold.
 */
/**
 * The same question asked of every tool, not just Claude. A row per tool, measured or not —
 * because a missing row reads as "this one is free", which is the wrong lesson.
 */
/** Three words on screen, the full sentence in the tooltip. */
function shortReason(reason?: string): string {
  if (!reason) {
    return 'not measurable';
  }
  if (reason.includes('not detected')) {
    return 'not installed';
  }
  if (reason.includes('cannot read SQLite') || reason.includes('could not be read')) {
    return 'not readable';
  }
  if (reason.includes('none carries a token count')) {
    return 'no counts kept';
  }
  return 'no activity';
}

/**
 * A number nobody can name a referent for is noise. "Claude Code 100%" answers a question
 * no one asked — 100% of what? So each tool gets a *word* for its place, the way the gauges
 * do, and the figures stay in the tooltip as evidence. A single measurable tool gets no
 * share at all: a share of one is not information.
 */
function shareWord(share: number, howMany: number): string {
  if (howMany < 2) {
    return 'the only one we can measure';
  }
  if (share >= 80) {
    return 'nearly all of it';
  }
  if (share >= 50) {
    return 'most of it';
  }
  if (share >= 20) {
    return 'a good part';
  }
  return 'a small part';
}

function toolSpendRows(workspaceRoot: string | undefined): string {
  const tools = crossToolSpend(workspaceRoot);
  const measured = tools.filter((t) => t.measurable);

  const rows = tools
    .map((t) => {
      if (!t.measurable) {
        // No bar at all rather than an empty one: an empty track reads as "zero spend",
        // and zero is exactly what we do not know.
        return `<div class="tool" title="${esc(t.reason ?? '')}">
          <div class="tool-head"><b>${esc(t.tool)}</b><span class="dim">${esc(
            shortReason(t.reason),
          )}</span></div>
        </div>`;
      }

      const raw = t.inputTokens + t.outputTokens;
      const evidence = `${raw ? `${mtok(raw)} tokens · ` : ''}${t.calls} ${
        raw ? `call${t.calls > 1 ? 's' : ''}` : `chat${t.calls > 1 ? 's' : ''}`
      }${t.models.length ? ` · ${t.models.slice(0, 2).join(', ')}` : ''}`;

      // The bar only earns its place when there is something to compare it to.
      const bar =
        measured.length > 1
          ? `<div class="stack w${Math.max(4, t.share)}">${
              t.slices?.length
                ? t.slices
                    .filter((sl) => sl.percent > 0)
                    .map(
                      (sl) =>
                        `<i class="${sliceTone(sl, false)} w${sl.percent}" title="${esc(
                          sl.label,
                        )} ${sl.percent}%"></i>`,
                    )
                    .join('')
                : '<i class="ok w100"></i>'
            }</div>`
          : '';

      return `<div class="tool" title="${esc(evidence)}${
        measured.length > 1 ? ` — ${t.share}% of measured spend` : ''
      }">
        <div class="tool-head"><b>${esc(t.tool)}</b><span class="dim">${esc(
          shareWord(t.share, measured.length),
        )}</span></div>
        ${bar}
        <div class="caption">${esc(evidence)}</div>
        ${t.note ? `<div class="caption">${esc(t.note)}</div>` : ''}
      </div>`;
    })
    .join('');

  return `<section>
      <div class="label">EVERY AI TOOL</div>
      ${rows}
    </section>`;
}

function chatRows(spend: SpendBreakdown): string {
  if (!spend.chats.length) {
    return '';
  }
  // "100%" of a single chat is a tautology, not a finding — same rule as the tool list:
  // a share only means something against siblings. And warm colour is only earned past
  // the threshold: one chat that peaked under it is normal use, not an incident.
  const solo = spend.chats.length === 1;
  const rows = spend.chats
    .slice(0, 6)
    .map((c) => {
      const past = Math.round((c.longChatCost / Math.max(1, c.cost)) * 100);
      const hot = past >= 50 && c.peakContext >= spend.longChatThreshold;
      // One line each: share, name, and the single number that decides. The rest is a tooltip.
      return `<div class="row chat" title="${esc(c.label)} — peaked at ${Math.round(
        c.peakContext / 1000,
      )}k${past ? `, ${past}% spent past the threshold` : ''}${
        c.helperRuns ? `, ${c.helperRuns} helper runs` : ''
      }">
        ${solo ? '' : `<span class="pct ${hot ? 'warn' : ''}">${c.percent}%</span>`}
        <span class="chat-name">${esc(c.label)}</span>
        <span class="chat-num ${hot ? 'warn' : 'dim'}">${Math.round(c.peakContext / 1000)}k</span>
      </div>`;
    })
    .join('');

  return `<section>
      <div class="label" title="Share of this period\u2019s spend, and the largest context each chat reached.">WHICH CHATS COST IT</div>
      ${rows}
      ${
        spend.chats.length > 6
          ? `<div class="caption">${spend.chats.length - 6} more, each under ${
              spend.chats[5].percent
            }%</div>`
          : ''
      }
    </section>`;
}

/** The fixes `culprit()` will offer, so the list below can leave them out. */
function culpritFixIds(spend: SpendBreakdown, fixes: Fix[]): string[] {
  const top = [...spend.slices].sort((a, b) => b.tokens - a.tokens)[0];
  if (top.label === 'Helper agents') {
    return [fixes.find((f) => f.id === 'explore-on-haiku') ??
      fixes.find((f) => f.id === 'general-purpose-on-sonnet')].filter((f): f is Fix => !!f).map((f) => f.id);
  }
  if (top.label === 'Long chats') {
    return ['auto-compact', 'concision-rule'].filter((id) => fixes.some((f) => f.id === id));
  }
  return fixes[0] ? [fixes[0].id] : [];
}

function culprit(spend: SpendBreakdown, fixes: Fix[]): string {
  const top = [...spend.slices].sort((a, b) => b.tokens - a.tokens)[0];

  if (top.label === 'Helper agents') {
    const fix = fixes.find((f) => f.id === 'explore-on-haiku') ?? fixes.find((f) => f.id === 'general-purpose-on-sonnet');
    const expensive = spend.helperModels.some(isExpensiveModel);
    return card(
      'The #1 culprit: helper agents',
      expensive
        ? `${spend.helperRuns} runs on <b>the most expensive model</b>, for simple lookups.`
        : `${spend.helperRuns} runs, carrying most of your spend.`,
      fix ? { id: fix.id, text: 'Fix it — use a small model' } : undefined,
    );
  }

  if (top.label === 'Long chats') {
    // Only root-cause remedies, and all of them — this is the screen's whole job. Each
    // attacks a different term of the same bill: auto-compact shrinks the history resent,
    // concision slows its growth, the instruction diet cuts the fixed cost every message
    // of that long chat carries. The measured gesture (/compact on the actual peak) rides
    // along because it is the only remedy that pays off today rather than from now on.
    const remedies = ['auto-compact', 'concision-rule']
      .map((id) => fixes.find((f) => f.id === id))
      .filter((f): f is Fix => !!f);

    const peak = spend.chats[0]?.peakContext ?? 0;
    const gesture =
      peak >= spend.longChatThreshold
        ? `<div class="note">The biggest chat peaked at <b>${Math.round(peak / 1000)}k</b>: ` +
          `<b>/compact</b> shrinks it now, <b>/clear</b> when you switch subjects starts the next one at zero.</div>`
        : '';

    let diet = '';
    try {
      const lines = scan(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
        .instructions.filter((f) => f.present && f.loaded && f.lines > 0)
        .reduce((n, f) => n + f.lines, 0);
      if (lines > 200) {
        diet = `<div class="row act" data-panel="settings" role="button" tabindex="0">
          <span class="row-title">Every message also re-sends <b>${lines} lines</b> of instructions — trim them</span>
          <span class="chev">›</span>
        </div>`;
      }
    } catch {
      /* the panel's settings tab still covers it */
    }

    // One chat is a story, not a ranking: "the #1 culprit" would be dressing normal use
    // up as an incident. The number stays; the alarm does not.
    const solo = spend.chats.length === 1;
    return `<div class="card">
      <div class="card-title">${solo ? 'Where it went: one long chat' : 'The #1 culprit: long chats'}</div>
      <div class="card-body">${top.percent}% went to messages sent past ${Math.round(
        spend.longChatThreshold / 1000,
      )}k of history.${
        solo
          ? ' Normal for a long task — the moves below just stop it compounding.'
          : ''
      }</div>
      ${gesture}
      ${remedies
        .map(
          (f) =>
            `<div class="btn primary" data-review="${esc(f.id)}" role="button" tabindex="0">${esc(f.title)}</div>`,
        )
        .join('')}
      ${diet}
      ${
        remedies.length
          ? ''
          : '<div class="note">Settings are right already. What remains is the habit: <b>/clear when you switch task.</b></div>'
      }
    </div>`;
  }

  const fix = fixes[0];
  return card(
    'Nothing is running away',
    'Most of your spend is normal work, at a normal size.',
    fix ? { id: fix.id, text: fix.title } : undefined,
    fix ? 'Still, one thing could be leaner:' : undefined,
  );
}

function card(
  title: string,
  bodyHtml: string,
  action?: { id: string; text: string },
  note?: string,
): string {
  return `<div class="card">
    <div class="card-title">${esc(title)}</div>
    ${note ? `<div class="note">${esc(note)}</div>` : ''}
    <div class="card-body">${bodyHtml}</div>
    ${action ? `<div class="btn primary" data-review="${esc(action.id)}" role="button" tabindex="0">${esc(action.text)}</div>` : ''}
  </div>`;
}

function spendScreen(
  spend: SpendBreakdown | undefined,
  fixes: Fix[],
  usage: SessionUsage | undefined,
): string {
  const measured = spend
    ? `<section>
        <div class="label">LAST ${spend.days} DAYS · CLAUDE</div>
        ${bars(spend)}
        <div class="caption" title="Most of the raw volume is the conversation re-read from cache each turn, billed at about a tenth of the full rate. Claude only — other tools have their own rows below.">${
          spend.sessions
        } chat${spend.sessions > 1 ? 's' : ''} · ${mtok(spend.rawTokens)} moved ≈ ${mtok(spend.total)} full-price${
          spend.helperRuns ? ` · ${spend.helperRuns} helper runs` : ''
        }${spend.partial ? ' · partial' : ''}</div>
      </section>
      ${chatRows(spend)}
      ${culprit(spend, fixes)}
      ${toolSpendRows(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)}`
    : `<div class="card">
        <div class="card-title">Nothing to measure here</div>
        <div class="card-body">No Claude chat in this project lately. Copilot and Codex are
        counted from their own local records — their rows are below.</div>
      </div>
      ${toolSpendRows(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)}`;

  // The culprit card already offers one fix; listing it again two rows below reads as
  // noise and makes the screen feel repetitive.
  const offered = spend ? culpritFixIds(spend, fixes) : [];
  const others = fixes.filter((f) => !offered.includes(f.id));
  const rest = others.length
    ? `<section>
        <div class="label">${spend ? 'ALSO WORTH FIXING' : 'WORTH FIXING'}</div>
        ${others
          .slice(0, 6)
          .map(
            (f) => `<div class="row act" data-review="${esc(f.id)}" role="button" tabindex="0">
              <span class="row-title">${esc(f.title)}</span>
              <span class="chev">›</span>
            </div>`,
          )
          .join('')}
      </section>`
    : '';

  return `${back('AM I OVERSPENDING?')}
  <main>
    ${measured}
    ${rest}
  </main>`;
}

/** Plain-word version of the two exposure vectors. This wording is the teaching. */
function exposureLine(f: Finding): string {
  if (f.tracked) {
    return (
      `A ${esc(f.what.toLowerCase())} is written in <code>${esc(f.where)}</code> — a file Git sends ` +
      'to everyone on the repo. If it was ever pushed, <b class="danger">consider it stolen</b>.'
    );
  }
  if (f.loadedInPrompt) {
    return (
      `A ${esc(f.what.toLowerCase())} sits in <code>${esc(f.where)}</code>, a file the AI reads on ` +
      'every message. The key leaves your machine each time, and gets written into local chat logs.'
    );
  }
  return (
    `A ${esc(f.what.toLowerCase())} sits in <code>${esc(f.where)}</code>. It is not shared yet — ` +
    'move it out before it ends up in a commit.'
  );
}

/**
 * "Checked, tool by tool" — every catalogue entry gets a row, detected or not. An absent
 * tool is a result: it is what makes the sweep look as complete as it is.
 */
function securityToolRows(findings: Finding[]): string {
  const detected = detectTraces(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  // Attribute each finding to the tool that owns the file, rather than guessing from paths.
  const owner = new Map<string, string>();
  for (const t of detected) {
    for (const tr of t.traces) {
      owner.set(tr.file, t.name);
    }
  }

  return detected
    .map((t) => {
      if (!t.detected) {
        return `<div class="row">
          <span class="mark off">—</span>
          <span class="row-block"><b>${esc(t.name)}</b><i>not detected on this machine</i></span>
        </div>`;
      }
      const own = findings.filter((f) => owner.get(f.file) === t.name);
      const logs = t.traces.filter((tr) => tr.kind === 'history').length;
      const extra = logs ? ` · ${logs} conversation log${logs > 1 ? 's' : ''} on disk` : '';
      return `<div class="row">
        <span class="mark ${own.length ? 'danger' : 'ok'}">${own.length ? '✗' : '✓'}</span>
        <span class="row-block"><b>${esc(t.name)}</b><i>${
          own.length
            ? `${own.length} key${own.length > 1 ? 's' : ''} in its config${extra}`
            : `${t.traces.length} file${t.traces.length > 1 ? 's' : ''} checked, nothing in plain text${extra}`
        }</i></span>
      </div>`;
    })
    .join('');
}

function secretsScreen(findings: Finding[]): string {
  const worst = findings[0];
  // The plan depends on the family: a key gets revoked, personal data only gets removed.
  const hasCredential = findings.some((f) => f.kind === 'credential');
  const alert = worst
    ? `<div class="card alert">
        <div class="alert-head"><span class="danger">⚠</span><span>${esc(
          hasCredential
            ? findings.length > 1
              ? `${findings.length} sensitive items in your config files`
              : '1 API key in a shared file'
            : findings.length > 1
              ? `${findings.length} personal details in your config files`
              : 'Personal data in a shared file',
        )}</span></div>
        <div class="card-body">${exposureLine(worst)}</div>
        <ol class="plan">
          ${
            hasCredential
              ? `<li><span class="num danger">1</span>Revoke the key on the provider's site</li>
          <li><span class="num">2</span>Replace it with a pointer, then keep the file out of Git</li>`
              : `<li><span class="num danger">1</span>Remove it from the file</li>
          <li><span class="num">2</span>Keep the file out of Git if it is yours alone</li>`
          }
        </ol>
        <div class="btn wide danger-bg" data-panel="1" role="button" tabindex="0">Sort this out →</div>
      </div>`
    : `<div class="card">
        <div class="card-title"><span class="ok">✓</span> Nothing sensitive found</div>
        <div class="card-body">We checked every config file your AI tools read, on this machine and
        in this project. Nothing that looks like a key, an email, a phone number, a bank account
        or a plain-text password.</div>
      </div>`;

  const others = findings.slice(1);
  const list = others.length
    ? `<section>
        <div class="label">THE OTHERS</div>
        ${others
          .map(
            (f, i) => `<div class="row act" data-panel="1" role="button" tabindex="0">
              <span class="mark ${f.severity === 'critical' ? 'danger' : 'warn'}">${f.severity === 'critical' ? '✗' : '!'}</span>
              <span class="row-block"><b>${esc(f.what)}</b><i>${esc(f.where)}</i></span>
              <span class="chev">›</span>
            </div>`,
          )
          .join('')}
      </section>`
    : '';

  return `${back('ARE MY KEYS SAFE?')}
  <main>
    ${alert}
    ${list}
    <section>
      <div class="label">CHECKED, TOOL BY TOOL</div>
      ${securityToolRows(findings)}
    </section>
    <div class="tip"><span>💡</span><span>Good to know: AI chat logs stay on your disk. Anything you pasted in a chat is written there too.</span></div>
  </main>`;
}


// --- Shell ------------------------------------------------------------------

function nonce(): string {
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)];
  }
  return s;
}

/**
 * Colours come from VS Code variables only: the design is a Dark Modern reference, but
 * Light and High Contrast then work for free. No remote resource, and a strict CSP.
 */
function page(body: string, cspSource: string): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}' ${cspSource}; script-src 'nonce-${n}';">
<style nonce="${n}">
  /* Width utilities. The CSP forbids inline styles — a style="width:71%" attribute is
     silently dropped, which is exactly what left the bars empty. Generated once, cheap. */
  ${Array.from({ length: 101 }, (_, i) => `.w${i}{width:${i}%}`).join('')}
  :root {
    --danger: var(--vscode-editorError-foreground, var(--vscode-errorForeground));
    --warn: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow));
    --ok: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    --edge: var(--vscode-panel-border, rgba(128,128,128,.35));
    --surface: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    --dim: var(--vscode-descriptionForeground);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    /* Track the editor's font-size setting instead of pinning our own: the guidelines ask
       webviews to respect the user's typography, and zoomed setups break on a fixed 12px. */
    font-size: calc(var(--vscode-font-size, 13px) * 0.92);
    display: flex; flex-direction: column; min-height: 100vh;
  }
  /* Keyboard users need to see where they are: every role="button" is Tab-reachable. */
  [role="button"]:focus-visible, .card.q:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; border-radius: 4px;
  }
  main { flex: 1; padding: 10px 10px 6px; display: flex; flex-direction: column; gap: 9px; }
  section { display: flex; flex-direction: column; gap: 4px; }

  .head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 9px 12px; border-bottom: 1px solid var(--edge);
  }
  .brand { font-size: 0.92em; font-weight: 600; letter-spacing: .08em; flex: 1; }
  .icon-btn { color: var(--dim); cursor: pointer; font-size: 1.08em; padding: 0 2px; }
  .icon-btn:hover { color: var(--vscode-foreground); }

  .label {
    font-size: 0.83em; font-weight: 600; letter-spacing: .07em;
    color: var(--dim); text-transform: uppercase; padding: 0 2px;
  }
  .caption { font-size: 0.83em; color: var(--dim); padding: 2px; }
  .remote-strip {
    font-size: 0.83em; padding: 5px 12px;
    background: color-mix(in srgb, var(--vscode-charts-yellow) 14%, transparent);
    border-bottom: 1px solid var(--edge);
  }
  .remote-strip code { font-family: var(--vscode-editor-font-family); }

  .card {
    background: var(--surface); border: 1px solid var(--edge); border-radius: 8px;
    padding: 10px 11px; display: flex; flex-direction: column; gap: 6px;
  }
  .card.q { cursor: pointer; }
  .card.q:hover { border-color: var(--vscode-focusBorder); }
  .card.edge-danger { border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
  .card-title { font-size: 1.04em; font-weight: 600; }
  .card-body { font-size: 1em; line-height: 1.55; color: var(--dim); }
  .card-body code { font-family: var(--vscode-editor-font-family); color: var(--vscode-textPreformat-foreground); }
  .card-body b { color: var(--vscode-foreground); }
  .card.teach .card-body { color: var(--vscode-foreground); }
  .note { font-size: 0.92em; color: var(--dim); }
  .lead { font-size: 1.04em; }

  .q-head { display: flex; align-items: center; justify-content: space-between; }
  .q-title { font-size: 1.08em; font-weight: 600; }
  .q-body { display: flex; align-items: center; gap: 9px; }
  .q-summary { font-size: 0.96em; line-height: 1.4; color: var(--dim); }
  .q-summary b { color: inherit; }
  .chev { color: var(--dim); }

  .gauge {
    width: 38px; height: 38px; flex: 0 0 38px; border-radius: 50%;
    border: 2px solid var(--edge);
    display: flex; align-items: center; justify-content: center;
    font-size: 1em; font-weight: 600;
  }
  .gauge.ok { border-color: var(--ok); }
  .gauge.warn { border-color: var(--warn); }
  .gauge.danger { border-color: var(--danger); color: var(--danger); }

  .row {
    display: flex; align-items: center; gap: 9px;
    padding: 6px 10px; background: var(--surface);
    border: 1px solid var(--edge); border-radius: 6px;
  }
  .row.act { cursor: pointer; }
  .row.act:hover { border-color: var(--vscode-focusBorder); }
  .row-title { flex: 1; font-size: 0.96em; }
  .row-block { flex: 1; display: flex; flex-direction: column; min-width: 0; gap: 1px; }
  .row-block b { font-size: 0.96em; font-weight: 600; }
  .row-block i {
    font-style: normal; font-size: 0.88em; color: var(--dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* The machine-wide line is a second thought, not a second status: quieter, and free to wrap
     because the sidebar can be dragged down to ~170px. */
  .row-block i.faint { opacity: .75; font-size: 0.83em; line-height: 1.4; white-space: normal; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--edge); }
  .dot.ok { background: var(--ok); }
  .dot.warn { background: var(--warn); }
  .dot.danger { background: var(--danger); }
  .mark { flex: none; width: 12px; text-align: center; }

  .bar-row { display: flex; align-items: center; gap: 8px; }
  .bar-label { flex: 0 0 84px; font-size: 0.96em; }
  .bar { flex: 1; height: 13px; border-radius: 3px; background: var(--edge); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--dim); }
  .bar i.danger { background: var(--danger); }
  .bar i.warn { background: var(--warn); }
  .bar i.ok { background: var(--ok); }
  .stack { display: flex; height: 18px; border-radius: 4px; overflow: hidden;
           background: var(--edge); margin: 2px 0 8px; }
  .stack i { display: block; height: 100%; background: var(--dim); }
  .stack i.danger { background: var(--danger); }
  .stack i.warn { background: var(--warn); }
  .stack i.ok { background: var(--ok); }
  .keys { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-bottom: 6px; }
  .key { display: flex; align-items: center; gap: 5px; font-size: 0.96em; }
  .key i { width: 9px; height: 9px; border-radius: 2px; background: var(--dim); flex: none; }
  .key i.danger { background: var(--danger); }
  .key i.warn { background: var(--warn); }
  .key i.ok { background: var(--ok); }
  .key b { color: var(--fg); }
  .key b.warn { color: var(--warn); }
  .key b.danger { color: var(--danger); }
  .tool { margin: 0 0 10px; }
  .tool-head { display: flex; justify-content: space-between; align-items: baseline;
               font-size: 0.96em; margin-bottom: 3px; }
  .tool .stack { margin: 0 0 3px; min-width: 4%; }
  .pct { flex: 0 0 30px; font-size: 0.96em; text-align: right; }
  .row.chat { padding: 4px 10px; gap: 8px; }
  .chat-name { flex: 1; min-width: 0; font-size: 0.96em; overflow: hidden;
               text-overflow: ellipsis; white-space: nowrap; }
  .chat-num { font-size: 0.92em; flex: none; }
  .pct.warn { color: var(--warn); }
  .bar-pct { flex: 0 0 30px; text-align: right; font-size: 0.92em; color: var(--dim); }

  .alert { background: color-mix(in srgb, var(--danger) 12%, var(--surface)); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
  .alert-head { display: flex; align-items: center; gap: 7px; font-size: 1.04em; font-weight: 600; }
  .plan { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
  .plan li { display: flex; align-items: flex-start; gap: 7px; font-size: 0.96em; line-height: 1.45; }
  .num {
    flex: none; width: 15px; height: 15px; border-radius: 50%; margin-top: 1px;
    background: var(--edge); color: var(--vscode-foreground);
    font-size: 0.75em; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .num.danger { background: var(--danger); color: var(--vscode-editor-background); }

  .btns { display: flex; gap: 7px; }
  .btn {
    flex: 1; text-align: center; padding: 7px 8px; border-radius: 4px; cursor: pointer;
    font-size: 0.96em; font-weight: 600;
    background: var(--vscode-button-secondaryBackground, var(--surface));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--edge);
  }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--surface)); }
  .btn.primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn.danger-bg { background: var(--danger); color: var(--vscode-editor-background); border-color: transparent; }
  .btn.ghost { background: transparent; color: var(--dim); }
  .btn.wide { flex: none; }

  .ba { border: 1px solid var(--edge); border-radius: 6px; padding: 10px; background: var(--surface); }
  .ba-label { font-size: 0.79em; font-weight: 600; letter-spacing: .07em; color: var(--dim); margin-bottom: 4px; }
  .ba pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: var(--vscode-editor-font-family); font-size: 0.92em;
    color: var(--vscode-textPreformat-foreground);
  }
  /* Amber, not red: the state we are replacing is improvable, not dangerous. Red here would
     tell the user their machine is compromised because a setting is off by default. */
  .ba.before { border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .ba.after { border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
  .ba.after pre { color: var(--ok); }
  .arrow { text-align: center; color: var(--dim); }

  .checks { display: flex; flex-direction: column; gap: 5px; font-size: 0.96em; color: var(--dim); }
  .checks div { display: flex; gap: 7px; align-items: flex-start; line-height: 1.45; }

  .tip { display: flex; gap: 7px; font-size: 0.92em; line-height: 1.5; color: var(--dim); padding: 0 2px; }
  .tip code { font-family: var(--vscode-editor-font-family); color: var(--vscode-textPreformat-foreground); }
  .more { font-size: 0.92em; color: var(--dim); cursor: pointer; padding: 2px; }
  .more:hover { color: var(--vscode-textLink-foreground); }

  .actions { padding: 10px 12px 14px; display: flex; flex-direction: column; gap: 7px; }
  .foot { padding: 6px 10px 10px; text-align: center; font-size: 0.83em; color: var(--dim); }

  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
  .danger { color: var(--danger); }
  .off, .dim { color: var(--dim); opacity: .8; }
</style>
</head>
<body>
${body}
<script nonce="${n}">
  const vs = acquireVsCodeApi();
  const send = (el) => {
    // Only two verbs left here: navigate between the three screens, or hand over to the
    // panel. Nothing in this column writes anything.
    if (el.dataset.nav) { vs.postMessage({ command: 'nav', to: el.dataset.nav }); }
    else if (el.dataset.review) { vs.postMessage({ command: 'review', id: el.dataset.review }); }
    else if (el.dataset.panel) { vs.postMessage({ command: 'panel', tab: el.dataset.panel === '1' ? undefined : el.dataset.panel }); }
    else if (el.dataset.cmd) { vs.postMessage({ command: el.dataset.cmd }); }
    else { return false; }
    return true;
  };
  const target = (e) => e.target.closest('[data-nav],[data-review],[data-panel],[data-cmd]');
  document.addEventListener('click', (e) => { const el = target(e); if (el) { send(el); } });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') { return; }
    const el = target(e);
    if (el && send(el)) { e.preventDefault(); }
  });
</script>
</body>
</html>`;
}
