import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeUserDir, codexUserDir, exists, projectTranscriptDir, vscodeUserDirs } from './paths';
import { looksLikeSecret } from './secrets';

export interface SessionUsage {
  /** Approximate context size at the latest exchange. */
  contextTokens: number;
  model?: string;
  sessionFile: string;
  /** Claude Code's name for the chat — what makes the figure attributable. */
  label?: string;
  lastActivity: Date;
  /** Number of subagents spawned in this session. */
  subagents: number;
}

/** Reads the leading bytes of a file — the slug and opening message sit in the first lines. */
function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads the trailing bytes of a file without loading all of it. */
function readTail(file: string, bytes: number): string {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Last recorded context size and model of one transcript, from its tail. */
function tailContext(file: string): { contextTokens: number; model?: string } {
  const lines = readTail(file, 512 * 1024).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) {
      continue;
    }
    try {
      const rec = JSON.parse(line);
      const usage = rec?.message?.usage;
      if (usage) {
        return {
          contextTokens:
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0),
          model: rec?.message?.model,
        };
      }
    } catch {
      // Line truncated by the partial read: keep walking backwards.
    }
  }
  return { contextTokens: 0 };
}

/** The project's transcripts, newest first. */
function transcriptsByAge(dir: string): { file: string; mtime: number }[] {
  const out: { file: string; mtime: number }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    const file = path.join(dir, entry.name);
    try {
      out.push({ file, mtime: fs.statSync(file).mtimeMs });
    } catch {
      // Deleted between readdir and stat: it no longer exists for us either.
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export interface SessionBrief {
  file: string;
  label: string;
  contextTokens: number;
  model?: string;
  lastActivity: Date;
}

/**
 * The conversations behind the status bar figure, newest first. The status bar can only
 * show one number — the most recently active chat, which jumps around when a second window
 * or a terminal `claude` writes to the same project. This list is what makes the figure
 * attributable: every recent chat with its own counter.
 */
export function recentSessions(workspaceRoot: string, limit = 6): SessionBrief[] {
  const dir = projectTranscriptDir(workspaceRoot);
  if (!dir) {
    return [];
  }
  let files: { file: string; mtime: number }[];
  try {
    files = transcriptsByAge(dir).slice(0, limit);
  } catch {
    return [];
  }
  return files.map((f) => {
    const { contextTokens, model } = tailContext(f.file);
    return {
      file: f.file,
      label: chatLabel(f.file) ?? new Date(f.mtime).toLocaleDateString('en-GB'),
      contextTokens,
      model,
      lastActivity: new Date(f.mtime),
    };
  });
}

/**
 * Claude Code exposes no API to extensions, so we read the session transcript,
 * which records the token counters of every call.
 */
export function currentUsage(workspaceRoot: string): SessionUsage | undefined {
  const dir = projectTranscriptDir(workspaceRoot);
  if (!dir) {
    return undefined;
  }

  let newest: { file: string; mtime: number } | undefined;
  try {
    newest = transcriptsByAge(dir)[0];
  } catch {
    return undefined;
  }
  if (!newest) {
    return undefined;
  }

  const { contextTokens, model } = tailContext(newest.file);

  const subagentsDir = path.join(
    path.dirname(newest.file),
    path.basename(newest.file, '.jsonl'),
    'subagents',
  );
  let subagents = 0;
  try {
    subagents = fs.readdirSync(subagentsDir).length;
  } catch {
    subagents = 0;
  }

  return {
    contextTokens,
    model,
    sessionFile: newest.file,
    label: chatLabel(newest.file),
    lastActivity: new Date(newest.mtime),
    subagents,
  };
}

// --- Where the week's tokens actually went -----------------------------------
// The home screen answers with a word, so it must stay cheap. This part is heavier
// (it walks whole transcripts) and therefore only runs when the user opens the
// spend screen. Every figure below is measured, never estimated: three buckets that
// add up to the total billed tokens of the period.

export interface SpendSlice {
  /** Plain-word label shown to the user — no jargon on this screen. */
  label: string;
  tokens: number;
  /** 0-100, rounded, forced to at least 1 when the slice is non-empty. */
  percent: number;
}

export interface SpendBreakdown {
  /** Helper agents, long chats, normal work — in that order, largest concern first. */
  slices: SpendSlice[];
  total: number;
  /** Number of helper agents spawned over the period. */
  helperRuns: number;
  /** Distinct models the helpers ran on. An expensive one here is the usual culprit. */
  helperModels: string[];
  sessions: number;
  /** True when the budget ran out before every transcript was read. */
  partial: boolean;
  /** Context size past which a turn is counted as a "long chat". */
  longChatThreshold: number;
  /** Days covered. */
  days: number;
  /** Raw tokens over the period, all kinds added up. Volume, not cost. */
  rawTokens: number;
  /** Per-conversation breakdown, dearest first. "65% long chats" means nothing without it. */
  chats: ChatCost[];
}

/**
 * One conversation, and what it cost. A share without the chats behind it tells you there is
 * a problem and not where it is — you cannot close a percentage.
 */
export interface ChatCost {
  file: string;
  /** Claude Code's own name for the chat, else its opening words, else the date. */
  label: string;
  lastActive: Date;
  /** Weighted cost, same unit as the slices. */
  cost: number;
  /** 0-100 of the period's total. */
  percent: number;
  /** How much of this chat's cost was spent past the long-chat threshold. */
  longChatCost: number;
  /** Largest context this chat ever carried. */
  peakContext: number;
  helperRuns: number;
}

/** Models whose per-token rate makes them a poor default for mechanical lookups. */
const EXPENSIVE = /opus/i;

export function isExpensiveModel(model: string | undefined): boolean {
  return !!model && EXPENSIVE.test(model);
}

interface Totals {
  helpers: number;
  longChats: number;
  normal: number;
}

/** Billed tokens of one assistant record: everything the provider charges for. */
/**
 * Not all tokens cost the same, and adding them up as one number misleads.
 * A token read from cache bills at about a tenth of a fresh input token; writing the cache
 * costs a little more than input; output is roughly five times input — a ratio that holds
 * across Haiku, Sonnet and Opus, so a single set of weights works without knowing the model.
 *
 * These are relative weights, not prices: the result is "input-token equivalents", which is
 * what makes the three shares reflect the bill rather than the volume. Long chats are mostly
 * cache reads, so counting them raw overstated them by a wide margin.
 */
const COST_WEIGHTS = {
  input: 1,
  cacheRead: 0.1,
  cacheWrite: 1.25,
  output: 5,
} as const;

/** Relative cost of a turn, in input-token equivalents. Use this for the shares. */
function weightedCost(usage: Record<string, number>): number {
  return (
    (usage.input_tokens ?? 0) * COST_WEIGHTS.input +
    (usage.cache_read_input_tokens ?? 0) * COST_WEIGHTS.cacheRead +
    (usage.cache_creation_input_tokens ?? 0) * COST_WEIGHTS.cacheWrite +
    (usage.output_tokens ?? 0) * COST_WEIGHTS.output
  );
}

/** Raw token count, all kinds added up. Use this for volume, never for shares. */
function billed(usage: Record<string, number>): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  );
}

/** Input side only — what "the whole conversation so far" costs on this turn. */
function contextOf(usage: Record<string, number>): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/** Transcripts can reach several MB; past this we skip rather than block the UI. */
const MAX_FILE_BYTES = 12 * 1024 * 1024;

/**
 * A name for a conversation. Claude Code writes a `slug` for most chats; when it has not,
 * fall back to the opening words of the first user message — redacted if that text carries
 * anything that looks like a credential, because it lands in a webview.
 */
function chatLabel(file: string): string | undefined {
  let firstUser: string | undefined;
  try {
    // Head only: the slug and the opening message are written in the first lines, and this
    // now also runs on the 20-second status bar tick — never load a multi-MB transcript here.
    for (const line of readHead(file, 256 * 1024).split('\n')) {
      if (!line.startsWith('{')) {
        continue;
      }
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof rec.slug === 'string' && rec.slug) {
        return rec.slug.replace(/-/g, ' ');
      }
      if (!firstUser) {
        const msg = rec.message as { role?: string; content?: unknown } | undefined;
        if (msg?.role === 'user') {
          const text = Array.isArray(msg.content)
            ? (msg.content.find((c: { type?: string }) => c?.type === 'text') as { text?: string })?.text
            : typeof msg.content === 'string'
              ? msg.content
              : undefined;
          if (text && !text.startsWith('<')) {
            firstUser = text.slice(0, 70).replace(/\s+/g, ' ').trim();
          }
        }
      }
    }
  } catch {
    return undefined;
  }
  if (!firstUser) {
    return undefined;
  }
  return looksLikeSecret(firstUser) ? '(hidden — this chat opens with a credential)' : firstUser;
}

function walkTranscript(
  file: string,
  onRecord: (usage: Record<string, number>, model: string | undefined) => void,
): void {
  if (fs.statSync(file).size > MAX_FILE_BYTES) {
    return;
  }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{')) {
      continue;
    }
    try {
      const rec = JSON.parse(line);
      const usage = rec?.message?.usage;
      if (usage) {
        onRecord(usage, rec?.message?.model);
      }
    } catch {
      // A record we cannot parse is a record we do not count.
    }
  }
}

/**
 * Reads the project's transcripts and splits the period's billed tokens three ways.
 * Claude Code exposes no usage API, so this is the only honest source available —
 * and it is local: nothing here leaves the machine.
 */
export function spendBreakdown(
  workspaceRoot: string,
  opts: { days?: number; longChatThreshold?: number; budgetMs?: number } = {},
): SpendBreakdown | undefined {
  const dir = projectTranscriptDir(workspaceRoot);
  if (!dir) {
    return undefined;
  }

  const days = opts.days ?? 7;
  const longChatThreshold = opts.longChatThreshold ?? 150_000;
  const deadline = Date.now() + (opts.budgetMs ?? 4000);
  const since = Date.now() - days * 86_400_000;

  const totals: Totals = { helpers: 0, longChats: 0, normal: 0 };
  let rawTokens = 0;
  const chats: ChatCost[] = [];
  const helperModels = new Set<string>();
  let helperRuns = 0;
  let sessions = 0;
  let partial = false;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    const file = path.join(dir, entry.name);
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < since) {
      continue;
    }
    if (Date.now() > deadline) {
      partial = true;
      break;
    }

    sessions++;
    // Per-chat as well as per-category: the shares say there is a problem, these say where.
    const chat: ChatCost = {
      file,
      label: chatLabel(file) ?? new Date(mtime).toLocaleDateString('en-GB'),
      lastActive: new Date(mtime),
      cost: 0,
      percent: 0,
      longChatCost: 0,
      peakContext: 0,
      helperRuns: 0,
    };
    try {
      walkTranscript(file, (usage) => {
        rawTokens += billed(usage);
        const cost = weightedCost(usage);
        const ctx = contextOf(usage);
        chat.cost += cost;
        chat.peakContext = Math.max(chat.peakContext, ctx);
        if (ctx >= longChatThreshold) {
          totals.longChats += cost;
          chat.longChatCost += cost;
        } else {
          totals.normal += cost;
        }
      });
    } catch {
      sessions--;
      continue;
    }
    chats.push(chat);

    // Helper agents keep their own transcripts, one directory per parent session.
    // That separation is what makes the split measurable rather than guessed.
    const helperDir = path.join(dir, path.basename(entry.name, '.jsonl'), 'subagents');
    let helpers: string[];
    try {
      helpers = fs.readdirSync(helperDir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of helpers) {
      helperRuns++;
      chat.helperRuns++;
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
      try {
        walkTranscript(path.join(helperDir, name), (usage, model) => {
          rawTokens += billed(usage);
          const c = weightedCost(usage);
          totals.helpers += c;
          chat.cost += c;
          if (model) {
            helperModels.add(model);
          }
        });
      } catch {
        // Unreadable helper transcript: it simply does not contribute.
      }
    }
  }

  const total = totals.helpers + totals.longChats + totals.normal;
  if (!total) {
    return undefined;
  }

  // A slice that exists must be visible: rounding a real 0.4% down to nothing would
  // tell the user "you spend zero here", which is not what we measured.
  const slice = (label: string, tokens: number): SpendSlice => ({
    label,
    tokens,
    percent: tokens === 0 ? 0 : Math.max(1, Math.round((tokens / total) * 100)),
  });

  return {
    slices: [
      slice('Helper agents', totals.helpers),
      slice('Long chats', totals.longChats),
      slice('Normal work', totals.normal),
    ],
    total,
    rawTokens,
    chats: chats
      .map((c) => ({ ...c, percent: Math.round((c.cost / Math.max(1, total)) * 100) }))
      .sort((a, b) => b.cost - a.cost),
    helperRuns,
    helperModels: [...helperModels],
    sessions,
    partial,
    longChatThreshold,
    days,
  };
}

/** True when Claude Code has ever run on this machine — drives the "your tools" list. */
export function claudeInstalled(): boolean {
  return exists(claudeUserDir());
}

export interface LocalChats {
  /** Conversations kept on disk, all projects taken together. */
  chats: number;
  projects: number;
  /** Touched in the last 24 hours. */
  today: number;
  /** Bytes on disk — the privacy surface, not a cost. */
  bytes: number;
  oldest?: Date;
  newest?: Date;
}

/**
 * Everything Claude Code has kept on this machine, all projects included.
 * Deliberately built from directory entries and `stat` alone — no transcript is opened.
 * This runs on the home screen, which must stay instant, and the figure it feeds is about
 * what is *stored*, not what was spent: those are two different questions.
 */
export function localChats(): LocalChats | undefined {
  const root = path.join(claudeUserDir(), 'projects');
  const out: LocalChats = { chats: 0, projects: 0, today: 0, bytes: 0 };
  const dayAgo = Date.now() - 86_400_000;

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const dir of dirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(path.join(root, dir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    let seen = 0;
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) {
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(root, dir.name, f.name));
      } catch {
        continue;
      }
      seen++;
      out.chats++;
      out.bytes += st.size;
      if (st.mtimeMs >= dayAgo) {
        out.today++;
      }
      if (!out.oldest || st.mtimeMs < out.oldest.getTime()) {
        out.oldest = new Date(st.mtimeMs);
      }
      if (!out.newest || st.mtimeMs > out.newest.getTime()) {
        out.newest = new Date(st.mtimeMs);
      }
    }
    if (seen) {
      out.projects++;
    }
  }

  return out.chats ? out : undefined;
}

// --- Cross-tool spend -------------------------------------------------------

/**
 * What each AI tool cost, tool by tool.
 *
 * The three-way split above only ever covered Claude Code, which was honest but narrow.
 * Some other tools do keep local counters — Continue writes `tokensGenerated.jsonl` with a
 * prompt/generated count per call — and where they do, we read them. Where they do not, the
 * row still appears, saying so: "not measurable" is a finding, not a blank.
 */
export interface ToolSpend {
  tool: string;
  measurable: boolean;
  /** Why not, when not. Written for someone who will otherwise assume zero means free. */
  reason?: string;
  inputTokens: number;
  outputTokens: number;
  /** Same unit as the slices: input-token equivalents. */
  weighted: number;
  models: string[];
  calls: number;
  /** Internal split, when the tool exposes one. Drawn as the tool's own stacked bar. */
  slices?: SpendSlice[];
  /** 0-100 of everything measurable on this machine. Comparable across tools: both are
   *  expressed in input-token equivalents. */
  share: number;
  /** Honesty line for partial measurements — "12 of 40 requests carry token counts". */
  note?: string;
}

/** Continue's own local counters. No network, no API — a JSONL file it writes as it goes. */
function continueSpend(since: number): ToolSpend {
  const out: ToolSpend = {
    tool: 'Continue',
    measurable: false,
    reason: 'installed, but no activity over the period',
    inputTokens: 0,
    outputTokens: 0,
    weighted: 0,
    models: [],
    calls: 0,
    share: 0,
  };

  const base = path.join(os.homedir(), '.continue', 'dev_data');
  let files: string[] = [];
  try {
    for (const version of fs.readdirSync(base)) {
      const f = path.join(base, version, 'tokensGenerated.jsonl');
      if (exists(f)) {
        files.push(f);
      }
    }
  } catch {
    return { ...out, reason: 'not detected on this machine' };
  }

  const models = new Set<string>();
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.startsWith('{')) {
        continue;
      }
      try {
        const r = JSON.parse(line) as {
          timestamp?: string;
          model?: string;
          promptTokens?: number;
          generatedTokens?: number;
        };
        if (r.timestamp && Date.parse(r.timestamp) < since) {
          continue;
        }
        out.calls++;
        out.inputTokens += r.promptTokens ?? 0;
        out.outputTokens += r.generatedTokens ?? 0;
        if (r.model) {
          models.add(r.model);
        }
      } catch {
        /* skip */
      }
    }
  }

  if (!out.calls) {
    return {
      ...out,
      reason: files.length
        ? 'installed, counters found, but nothing logged over the period'
        : 'installed, but it keeps no token counter',
    };
  }
  out.measurable = true;
  out.reason = undefined;
  out.models = [...models];
  // Continue reports prompt and generated only — no cache split, so weight those two.
  out.weighted = out.inputTokens * COST_WEIGHTS.input + out.outputTokens * COST_WEIGHTS.output;
  return out;
}

/** A `file:///…` workspace URI from VSCode's workspace.json, as a comparable local path.
 *  Remote workspaces (`vscode-remote://…`) return undefined: their files are not this root. */
function folderUriToPath(uri: string): string | undefined {
  if (!uri.startsWith('file://')) {
    return undefined;
  }
  try {
    let p = decodeURIComponent(uri.slice('file://'.length));
    // Windows file URIs look like file:///c%3A/… — drop the leading slash before the drive.
    if (/^\/[a-zA-Z]:/.test(p)) {
      p = p.slice(1);
    }
    return path.resolve(p);
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase();
  return norm(a) === norm(b);
}

/** One Copilot request as VSCode archived it. Counters only — never the messages. */
interface CopilotRequest {
  promptTokens: number;
  outputTokens: number;
  timestamp: number;
  model?: string;
}

/** Recursively harvests request records from one archived chat session. The format is
 *  VSCode-internal and undocumented, so the walk is tolerant: it looks for objects carrying
 *  a `requestId` and takes whatever counters are present, ignoring everything else. */
function harvestCopilotRequests(node: unknown, into: Map<string, CopilotRequest>, depth = 0): void {
  if (depth > 24 || node === null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      harvestCopilotRequests(v, into, depth + 1);
    }
    return;
  }
  const o = node as Record<string, unknown>;
  if (typeof o.requestId === 'string') {
    const md =
      o.result && typeof o.result === 'object'
        ? ((o.result as Record<string, unknown>).metadata as Record<string, unknown> | undefined)
        : undefined;
    const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);
    const prompt = num(o.promptTokens) || num(md?.promptTokens);
    const output = num(o.completionTokens) || num(md?.outputTokens);
    const model =
      typeof md?.resolvedModel === 'string'
        ? md.resolvedModel
        : typeof o.modelId === 'string'
          ? o.modelId.replace(/^copilot\//, '')
          : undefined;
    const prev = into.get(o.requestId);
    // The same request reappears across snapshot and incremental records: keep the fullest.
    into.set(o.requestId, {
      promptTokens: Math.max(prev?.promptTokens ?? 0, prompt),
      outputTokens: Math.max(prev?.outputTokens ?? 0, output),
      timestamp: Math.max(prev?.timestamp ?? 0, num(o.timestamp)),
      model: model ?? prev?.model,
    });
  }
  for (const v of Object.values(o)) {
    harvestCopilotRequests(v, into, depth + 1);
  }
}

const COPILOT_SESSION_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Copilot, measured from VSCode's own chat archive. Copilot Chat exposes no supported local
 * API — but VSCode persists every chat session under workspaceStorage/<hash>/chatSessions/,
 * and since mid-2026 each request carries promptTokens/outputTokens and the resolved model.
 * Same epistemic status as Claude's transcripts: an on-disk artifact, read locally.
 * Requests older than the counter (or cancelled/errored) have no counts — the `note` says
 * how many did, so a partial measurement never poses as a complete one.
 */
function copilotSpend(workspaceRoot: string | undefined, since: number): ToolSpend {
  const out: ToolSpend = {
    tool: 'GitHub Copilot',
    measurable: false,
    reason: 'no VSCode chat archive found for this project',
    inputTokens: 0,
    outputTokens: 0,
    weighted: 0,
    models: [],
    calls: 0,
    share: 0,
  };
  if (!workspaceRoot) {
    return out;
  }

  const sessionDirs: string[] = [];
  for (const userDir of vscodeUserDirs()) {
    const storage = path.join(userDir, 'workspaceStorage');
    let hashes: string[] = [];
    try {
      hashes = fs.readdirSync(storage);
    } catch {
      continue;
    }
    for (const hash of hashes) {
      const dir = path.join(storage, hash);
      let meta: { folder?: string };
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
      } catch {
        continue;
      }
      const folder = meta.folder && folderUriToPath(meta.folder);
      if (folder && samePath(folder, workspaceRoot) && exists(path.join(dir, 'chatSessions'))) {
        sessionDirs.push(path.join(dir, 'chatSessions'));
      }
    }
  }

  const requests = new Map<string, CopilotRequest>();
  for (const dir of sessionDirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /\.jsonl?$/.test(n));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      let raw: string;
      try {
        if (fs.statSync(file).size > COPILOT_SESSION_MAX_BYTES) {
          continue;
        }
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      // .jsonl holds one record per line; legacy .json holds a single document.
      for (const chunk of name.endsWith('.jsonl') ? raw.split('\n') : [raw]) {
        if (!chunk.trim()) {
          continue;
        }
        try {
          harvestCopilotRequests(JSON.parse(chunk), requests);
        } catch {
          /* truncated or foreign line — skip */
        }
      }
    }
  }

  const inPeriod = [...requests.values()].filter((r) => r.timestamp >= since);
  const counted = inPeriod.filter((r) => r.promptTokens > 0);
  if (!counted.length) {
    return {
      ...out,
      reason: inPeriod.length
        ? `VSCode archived ${inPeriod.length} request(s) here, but none carries a token count`
        : sessionDirs.length
          ? 'chat archive found, but no request over the period'
          : out.reason,
    };
  }

  const models = new Set<string>();
  for (const r of counted) {
    out.inputTokens += r.promptTokens;
    out.outputTokens += r.outputTokens;
    if (r.model) {
      models.add(r.model);
    }
  }
  out.measurable = true;
  out.reason = undefined;
  out.calls = counted.length;
  out.models = [...models];
  // Prompt and output only — the archive has no cache split, so weight those two.
  out.weighted =
    out.inputTokens * COST_WEIGHTS.input + out.outputTokens * COST_WEIGHTS.output;
  if (counted.length < inPeriod.length) {
    out.note = `${counted.length} of ${inPeriod.length} requests carry token counts — the others were cancelled, errored, or predate VSCode's counter`;
  }
  return out;
}

interface SqliteDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
  close(): void;
}

/**
 * Codex, measured from its own state database. Modern Codex keeps no sessions/*.jsonl —
 * everything lives in ~/.codex/state_<n>.sqlite, whose `threads` table records tokens_used,
 * cwd and model per thread. Read-only, and `node:sqlite` ships with the Node ≥22.5 inside
 * current VSCode builds — when it is absent we say so instead of guessing.
 */
function codexSpend(workspaceRoot: string | undefined, since: number): ToolSpend {
  const out: ToolSpend = {
    tool: 'Codex',
    measurable: false,
    reason: 'not detected on this machine',
    inputTokens: 0,
    outputTokens: 0,
    weighted: 0,
    models: [],
    calls: 0,
    share: 0,
  };

  let stateFile: string | undefined;
  try {
    stateFile = fs
      .readdirSync(codexUserDir())
      .filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => parseInt(b.slice(6), 10) - parseInt(a.slice(6), 10))
      .map((n) => path.join(codexUserDir(), n))[0];
  } catch {
    return out;
  }
  if (!stateFile) {
    return { ...out, reason: 'installed, but no state database yet' };
  }

  let DatabaseSync: (new (p: string, opts: { readOnly: boolean }) => SqliteDb) | undefined;
  try {
    // Resolved at call time so the extension still loads (and says so) where it is missing.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { ...out, reason: 'installed, but this VSCode build cannot read its SQLite state' };
  }

  let rows: { cwd: string; model: string | null; tokens: number; ts: number }[] = [];
  let db: SqliteDb | undefined;
  try {
    db = new DatabaseSync!(stateFile, { readOnly: true });
    rows = db
      .prepare(
        'SELECT cwd, model, tokens_used AS tokens, ' +
          'COALESCE(updated_at_ms, updated_at * 1000) AS ts FROM threads WHERE tokens_used > 0',
      )
      .all() as typeof rows;
  } catch {
    return { ...out, reason: 'installed, but its state database could not be read' };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }

  const mine = rows.filter(
    (r) =>
      r.ts >= since &&
      !!workspaceRoot &&
      (samePath(r.cwd, workspaceRoot) || r.cwd.startsWith(workspaceRoot + path.sep)),
  );
  if (!mine.length) {
    return { ...out, reason: 'installed, but no chat in this project over the period' };
  }

  const models = new Set<string>();
  for (const r of mine) {
    out.inputTokens += r.tokens;
    if (r.model) {
      models.add(r.model);
    }
  }
  out.measurable = true;
  out.reason = undefined;
  out.calls = mine.length;
  out.models = [...models];
  // Codex records one blended total per thread — no input/output split. Counting it at the
  // input weight understates output, which beats inventing a split it never recorded.
  out.weighted = out.inputTokens;
  out.note = 'blended total from Codex — it records no input/output split';
  return out;
}

/**
 * Every tool, measured where possible. Reads local files only — the same rule as the rest
 * of the extension: nothing leaves the machine.
 */
export function crossToolSpend(workspaceRoot?: string, days = 7): ToolSpend[] {
  const since = Date.now() - days * 86_400_000;
  const out: ToolSpend[] = [];

  const claude = workspaceRoot ? spendBreakdown(workspaceRoot, { days }) : undefined;
  out.push(
    claude
      ? {
          tool: 'Claude Code',
          measurable: true,
          inputTokens: 0,
          outputTokens: 0,
          weighted: claude.total,
          models: claude.helperModels,
          calls: claude.sessions,
          slices: claude.slices,
          share: 0,
        }
      : {
          tool: 'Claude Code',
          measurable: false,
          reason: claudeInstalled()
            ? 'installed, but no chat in this project over the period'
            : 'not detected on this machine',
          inputTokens: 0,
          outputTokens: 0,
          weighted: 0,
          models: [],
          calls: 0,
          share: 0,
        },
  );

  out.push(continueSpend(since));
  out.push(copilotSpend(workspaceRoot, since));
  out.push(codexSpend(workspaceRoot, since));

  // Shares across tools, so the bars are comparable rather than each full-width.
  const grand = out.reduce((n, t) => n + t.weighted, 0);
  return out
    .map((t) => ({ ...t, share: grand ? Math.round((t.weighted / grand) * 100) : 0 }))
    .sort((a, b) => b.weighted - a.weighted);
}
