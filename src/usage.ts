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

/**
 * How much of a conversation's tail is enough to find its last recorded counters. Shared by
 * the Claude transcript reader and the Copilot one so both keep the same bounded appetite.
 */
const TAIL_BYTES = 512 * 1024;

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
  const lines = readTail(file, TAIL_BYTES).split('\n');
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
  /** The folder the chat ran in, from the transcript's own `cwd`. */
  project?: string;
  bytes?: number;
  remote?: boolean;
  projectMissing?: boolean;
  /** Claude Code names each transcript after its session id — the handle to reopen the chat. */
  id: string;
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
  return dir ? sessionsInDir(dir, limit) : [];
}

/**
 * The same reading, addressed by transcript directory rather than by project path. Listing
 * every project needs this form: a directory name encodes its path with every non-alphanumeric
 * character replaced by a dash, which cannot be decoded back into a path to look up again.
 */
function sessionsInDir(dir: string, limit: number): SessionBrief[] {
  let files: { file: string; mtime: number }[];
  try {
    files = transcriptsByAge(dir).slice(0, limit);
  } catch {
    return [];
  }
  return files.map((f) => sessionBrief(f.file, f.mtime));
}

/** One transcript read as a conversation summary: its tail for the counters, its head for the name. */
function sessionBrief(file: string, mtime: number): SessionBrief {
  const { contextTokens, model } = tailContext(file);
  let bytes: number | undefined;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    // Deleted since it was listed: its size is simply unknown.
  }
  return {
    file,
    id: path.basename(file, '.jsonl'),
    label: chatLabel(file) ?? new Date(mtime).toLocaleDateString('en-GB'),
    contextTokens,
    model,
    lastActivity: new Date(mtime),
    bytes,
    ...locate(transcriptCwd(file)),
  };
}

/**
 * What can be said about a conversation's folder. A folder that no longer exists is the
 * clearest sign a chat has outlived its work — but only for local ones: a path on an SSH
 * host or in a container cannot be checked from here, and calling it missing would be a lie.
 */
function locate(project: string | undefined): {
  project?: string;
  remote?: boolean;
  projectMissing?: boolean;
} {
  if (!project) {
    return {};
  }
  const remote = !path.isAbsolute(project) || /^[^/]+:\//.test(project);
  return { project, remote, projectMissing: remote ? undefined : !exists(project) };
}

/**
 * The folder a Claude chat ran in. Claude Code stamps `cwd` on its records, which is the
 * only trustworthy source: the transcript *directory* name encodes the path with every
 * non-alphanumeric character flattened to a dash, so `-Users-plog-my-app` could be `my-app`
 * or `my.app` — unguessable. One bounded head read, alongside the one the label already does.
 */
function transcriptCwd(file: string): string | undefined {
  try {
    return /"cwd":"((?:[^"\\]|\\.){1,400})"/.exec(readHead(file, 16 * 1024))?.[1];
  } catch {
    return undefined;
  }
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

  return {
    contextTokens,
    model,
    sessionFile: newest.file,
    label: chatLabel(newest.file),
    lastActivity: new Date(newest.mtime),
    subagents: subagentCount(newest.file),
  };
}

/** Sub-agents Claude Code spawned from one chat: one transcript each, in a sibling folder. */
export function subagentCount(sessionFile: string): number {
  try {
    return fs.readdirSync(
      path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'), 'subagents'),
    ).length;
  } catch {
    // No sub-agent was ever spawned from this chat, so the folder does not exist.
    return 0;
  }
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
/**
 * A folder uri as a person reads it, remote ones included.
 *
 * Most of a developer's chats may not be local at all: VSCode records SSH hosts and
 * containers as `vscode-remote://ssh-remote%2Bfury/projects/app`, which `folderUriToPath`
 * rightly refuses — it answers "which local path is this", and there is none. Provenance
 * asks a different question, "where was this held", and `fury:/projects/app` answers it.
 */
function folderLabel(uri: string): string | undefined {
  const local = folderUriToPath(uri);
  if (local) {
    return local;
  }
  const m = /^vscode-remote:\/\/([^/]+)(\/.*)$/.exec(uri);
  if (!m) {
    return undefined;
  }
  const authority = decodeURIComponent(m[1]);
  // `attached-container+<hex>@ssh-remote+host`: the container's name is hex-encoded JSON,
  // and the host it runs on follows the @. Show the host, which is what situates the work.
  const host = authority.split('@').pop() ?? authority;
  const name = host.replace(/^(ssh-remote|dev-container|attached-container|wsl)\+/, '');
  return `${name}:${m[2]}`;
}

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
const COPILOT_TAIL_BYTES = 64 * 1024;
const COPILOT_HEAD_BYTES = 16 * 1024;

/**
 * Where VSCode archives the chats that belong to this window: under the workspace's own
 * storage folder when a folder is open, and in globalStorage/emptyWindowChatSessions when
 * none is — those chats belong to no project, so they answer for exactly the case that has
 * none. Shared by the spend total and the conversation list so the two can never disagree.
 */
function copilotSessionDirs(workspaceRoot: string | undefined, everywhere = false): string[] {
  const dirs: string[] = [];
  for (const userDir of vscodeUserDirs()) {
    if (everywhere) {
      // Every project's archive plus the folderless one: the conversation list shows all of
      // them, because a chat left open in another window is still a chat you are paying for.
      const orphans = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
      if (exists(orphans)) {
        dirs.push(orphans);
      }
      let all: string[] = [];
      try {
        all = fs.readdirSync(path.join(userDir, 'workspaceStorage'));
      } catch {
        continue;
      }
      for (const hash of all) {
        const dir = path.join(userDir, 'workspaceStorage', hash, 'chatSessions');
        if (exists(dir)) {
          dirs.push(dir);
        }
      }
      continue;
    }
    if (!workspaceRoot) {
      const orphans = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
      if (exists(orphans)) {
        dirs.push(orphans);
      }
      continue;
    }
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
        dirs.push(path.join(dir, 'chatSessions'));
      }
    }
  }
  return dirs;
}

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
    reason: workspaceRoot
      ? 'no VSCode chat archive found for this project'
      : 'no VSCode chat archive found for windows without a folder',
    inputTokens: 0,
    outputTokens: 0,
    weighted: 0,
    models: [],
    calls: 0,
    share: 0,
  };
  const sessionDirs = copilotSessionDirs(workspaceRoot);

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

// --- One list, every tool -----------------------------------------------------
// The status bar shows a single figure, so it needs a single list to choose from. Claude,
// Copilot and Codex each keep their own archive in their own shape; what follows normalises
// the three into one row type. Only what is recorded is reported: a tool that writes no
// counter contributes nothing rather than a guess.

export interface Conversation {
  /** 'Claude' | 'Copilot' | 'Codex' — shown as the row's group, and half of the pin key. */
  tool: string;
  id: string;
  label: string;
  contextTokens: number;
  model?: string;
  lastActivity: Date;
  /** Claude only: the transcript, for the sub-agent count and `/compact`. */
  file?: string;
  /**
   * Where the conversation was held, as a person reads it — a local path, or `host:/path`
   * for an SSH or container workspace. Without it a list spanning every project is
   * unreadable: a title alone does not say which repository it belongs to, and the machine
   * holds hundreds. Undefined when the tool recorded none — a chat opened with no folder.
   */
  project?: string;
  /** Bytes this conversation occupies on disk — what cleaning it up would give back. */
  bytes?: number;
  /** The folder is on another machine: its existence cannot be checked from here. */
  remote?: boolean;
  /** The folder no longer exists locally — the clearest sign a chat has outlived its work. */
  projectMissing?: boolean;
}

/**
 * Every Copilot archive on this machine, each with the folder it belongs to. VSCode files a
 * chat under its workspace's storage folder, whose sibling `workspace.json` names the folder
 * — so provenance is read there, once per directory, not once per chat.
 */
function copilotArchives(
  workspaceRoot: string | undefined,
  everywhere = false,
): { file: string; project?: string }[] {
  const out: { file: string; project?: string }[] = [];
  for (const dir of copilotSessionDirs(workspaceRoot, everywhere)) {
    let project: string | undefined;
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(path.dirname(dir), 'workspace.json'), 'utf8'),
      ) as { folder?: string };
      project = meta.folder ? folderLabel(meta.folder) : undefined;
    } catch {
      // emptyWindowChatSessions, or metadata we cannot read: the chat belongs to no folder.
    }
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/\.jsonl?$/.test(name)) {
          out.push({ file: path.join(dir, name), project });
        }
      }
    } catch {
      // Storage folder removed between listing and reading: nothing to report for it.
    }
  }
  return out;
}

/** One Copilot archive read as a conversation, or undefined when it records no counter. */
function copilotConversation(file: string, project?: string): Conversation | undefined {
  let mtime: number;
  let bytes: number;
  try {
    const st = fs.statSync(file);
    mtime = st.mtimeMs;
    bytes = st.size;
  } catch {
    return undefined;
  }
  const tail = copilotTailContext(file);
  if (!tail) {
    return undefined;
  }
  const name = path.basename(file);
  return {
    tool: 'Copilot',
    id: path.basename(name, path.extname(name)),
    // The title is written near the top; the counters at the end. Two bounded reads, and
    // never the middle of the file — which is the megabytes of conversation itself.
    label: copilotChatLabel(readHead(file, COPILOT_HEAD_BYTES)) ?? new Date(mtime).toLocaleDateString('en-GB'),
    contextTokens: tail.tokens,
    model: tail.model,
    lastActivity: new Date(mtime),
    bytes,
    ...locate(project),
  };
}

/**
 * How big a Copilot conversation currently is, and the model serving it — read from the end
 * of its archive, exactly as `tailContext()` does for a Claude transcript.
 *
 * The figure is the *last* request's prompt, not the largest: Copilot rebuilds the whole
 * prompt every turn, so the most recent one is the size the next turn will pay for, which is
 * the question the status bar asks. It also happens to be the cheap one to answer — reading
 * two numbers out of the tail instead of parsing megabytes of archive.
 *
 * Scanned textually rather than parsed: `harvestCopilotRequests` walks the whole document and
 * is right for the spend total, which needs every request's timestamp. Here a regex answers
 * the same question without building the object graph.
 */
function copilotTailContext(file: string): { tokens: number; model?: string } | undefined {
  const last = <T>(raw: string, re: RegExp, pick: (m: RegExpExecArray) => T): T | undefined => {
    let found: T | undefined;
    for (let m = re.exec(raw); m; m = re.exec(raw)) {
      found = pick(m);
    }
    return found;
  };

  // Escalating read: a small tail answers for almost every archive, and paying the large one
  // for all of them costs hundreds of megabytes of I/O. A chat whose last counters sit
  // further back — a long run of tool calls since — gets the full read rather than being
  // dropped from the list, which would be a silent hole in "every conversation".
  for (const bytes of [COPILOT_TAIL_BYTES, TAIL_BYTES]) {
    let raw: string;
    try {
      raw = readTail(file, bytes);
    } catch {
      return undefined;
    }
    const tokens = last(raw, /"promptTokens":(\d+)/g, (m) => Number(m[1]));
    if (tokens) {
      return { tokens, model: last(raw, /"resolvedModel":"([^"]{1,80})"/g, (m) => m[1]) };
    }
    if (raw.length < bytes) {
      break; // The whole file was read: a larger request would return the same bytes.
    }
  }
  return undefined;
}

/**
 * A name for a Copilot chat: VSCode stores a `customTitle` once the session has one. The
 * search is textual and bounded — the archive is a large, undocumented, VSCode-internal
 * document, and walking it whole to find one string would cost more than the name is worth.
 */
function copilotChatLabel(raw: string): string | undefined {
  const m = /"(?:customTitle|title)":"((?:[^"\\]|\\.){1,120})"/.exec(raw);
  if (!m) {
    return undefined;
  }
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return undefined;
  }
}

/** Codex threads, one row each. Its `threads` table records tokens_used per conversation. */
function codexConversations(workspaceRoot: string | undefined, everywhere = false): Conversation[] {
  let stateFile: string | undefined;
  try {
    stateFile = fs
      .readdirSync(codexUserDir())
      .filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => parseInt(b.slice(6), 10) - parseInt(a.slice(6), 10))
      .map((n) => path.join(codexUserDir(), n))[0];
  } catch {
    return [];
  }
  if (!stateFile) {
    return [];
  }

  let db: SqliteDb | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(stateFile, { readOnly: true }) as SqliteDb;
    const rows = db
      .prepare(
        'SELECT id, title, cwd, model, tokens_used AS tokens, ' +
          'COALESCE(updated_at_ms, updated_at * 1000) AS ts ' +
          'FROM threads WHERE tokens_used > 0 AND archived = 0 ORDER BY ts DESC LIMIT 50',
      )
      .all() as { id: string; title: string; cwd: string; model: string | null; tokens: number; ts: number }[];
    return rows
      .filter((r) => everywhere || !workspaceRoot || samePath(r.cwd, workspaceRoot))
      .map((r) => ({
      tool: 'Codex',
      id: r.id,
      label: r.title || new Date(r.ts).toLocaleDateString('en-GB'),
      contextTokens: r.tokens,
      model: r.model ?? undefined,
      lastActivity: new Date(r.ts),
      ...locate(r.cwd || undefined),
    }));
  } catch {
    // No node:sqlite, database busy, or a schema that has moved on: report nothing.
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a database that never opened is not an error worth reporting.
    }
  }
}

/**
 * Every conversation this window can account for, across tools, newest first. This is what
 * the status bar picks from: one figure on screen means one list to choose it in.
 */
export async function recentConversations(
  workspaceRoot: string | undefined,
  opts: {
    onProgress?: (soFar: Conversation[]) => void;
    /**
     * 'project' — only chats held in this folder, which is what the status bar is about.
     * 'everywhere' — every project on the machine, which only the cleanup screen wants:
     * there the question is what the archives weigh in total, not what is open here.
     */
    scope?: 'project' | 'everywhere';
    perTool?: number;
  } = {},
): Promise<Conversation[]> {
  const { onProgress, scope = 'project', perTool = 25 } = opts;
  const everywhere = scope === 'everywhere';
  const found: Conversation[] = [];
  const publish = (): void => {
    found.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
    onProgress?.(found);
  };

  // Claude first, and cheaply: a handful of tail reads per directory. The picker can already
  // be useful while the rest arrives.
  const claude = new Map<string, Conversation>();
  for (const dir of claudeTranscriptDirs(workspaceRoot, everywhere)) {
    for (const s of sessionsInDir(dir, perTool)) {
      // Keyed by id: the current project is read first and again as one of the directories.
      claude.set(s.id, { tool: 'Claude', ...s, id: s.id });
    }
  }
  found.push(...[...claude.values()].filter((c) => c.contextTokens > 0));
  publish();

  // Copilot is the expensive half — hundreds of archives, megabytes each. Reading them in
  // batches with a yield between lets the extension host serve everything else meanwhile:
  // a list that takes a second to fill is fine, a VSCode frozen for a second is not.
  const archives = copilotArchives(workspaceRoot, everywhere);
  for (let i = 0; i < archives.length; i += COPILOT_BATCH) {
    for (const a of archives.slice(i, i + COPILOT_BATCH)) {
      const c = copilotConversation(a.file, a.project);
      if (c && c.contextTokens > 0) {
        found.push(c);
      }
    }
    publish();
    await new Promise((r) => setImmediate(r));
  }

  found.push(...codexConversations(workspaceRoot, everywhere).filter((c) => c.contextTokens > 0));
  publish();
  return found;
}

/** Archives read between two yields — small enough that no single batch is felt. */
const COPILOT_BATCH = 25;

/**
 * One conversation, addressed directly. The status bar needs this when the user has pinned a
 * Copilot or Codex chat: re-listing hundreds of archives every minute to find one of them
 * would be exactly the cost the batched listing above exists to avoid.
 */
export function conversationById(
  tool: string,
  id: string,
  workspaceRoot: string | undefined,
): Conversation | undefined {
  if (tool === 'Claude') {
    for (const dir of claudeTranscriptDirs(workspaceRoot, true)) {
      const file = path.join(dir, `${id}.jsonl`);
      try {
        return { tool: 'Claude', ...sessionBrief(file, fs.statSync(file).mtimeMs) };
      } catch {
        // Not this project's transcript: try the next directory.
      }
    }
    return undefined;
  }
  if (tool === 'Copilot') {
    // Pinning reaches across projects, so the lookup must too.
    const a = copilotArchives(workspaceRoot, true).find(
      (x) => path.basename(x.file, path.extname(x.file)) === id,
    );
    return a ? copilotConversation(a.file, a.project) : undefined;
  }
  return codexConversations(workspaceRoot, true).find((c) => c.id === id);
}

/** This project's transcript directory, and — for the cleanup screen only — every other. */
function claudeTranscriptDirs(workspaceRoot: string | undefined, everywhere: boolean): string[] {
  const here = workspaceRoot ? projectTranscriptDir(workspaceRoot) : undefined;
  if (!everywhere) {
    return here ? [here] : [];
  }
  const root = path.join(claudeUserDir(), 'projects');
  let others: string[] = [];
  try {
    others = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    // No transcript folder at all: a machine where Claude Code has never run.
  }
  return here ? [here, ...others] : others;
}
