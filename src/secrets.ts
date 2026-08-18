import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { claudeUserDir, exists } from './paths';
import { historyTraces, scannableTraces } from './tools';

/**
 * How the secret escapes. Two distinct mechanisms, never to be confused:
 * - `git`     : the file is tracked and went out with a push — the only remedy is revocation.
 * - `context` : the file is loaded into the prompt, so the secret goes to the provider on
 *               every turn and is rewritten into local transcripts.
 */
export type Exposure = 'git' | 'context' | 'both' | 'local';

export type Severity = 'critical' | 'high' | 'review';

/**
 * Two families, two remedies. A credential gets revoked; personal data (an email, a phone
 * number, a bank account, a plain-text password) only gets removed — there is nothing to
 * revoke, and once committed it must be treated as public.
 */
export type FindingKind = 'credential' | 'personal';

/**
 * INVARIANT — this type does not carry the secret's value, and never must.
 * It is a type-level guarantee, not a coding habit: you cannot display what you do not
 * carry. The panel is a webview, and webviews end up in screenshots, in shared sessions,
 * or in the context of an agent asked to read them back.
 */
export interface Finding {
  file: string;
  line: number;
  /** What was recognised: "Anthropic API key", "GitHub token (fine-grained)". */
  what: string;
  /** Logical path of the key — "env.ANTHROPIC_API_KEY". Never the value. */
  where: string;
  exposure: Exposure;
  tracked: boolean;
  ignored: boolean;
  loadedInPrompt: boolean;
  severity: Severity;
  kind: FindingKind;
}

interface Detector {
  label: string;
  re: RegExp;
}

/**
 * Prefixed patterns: recognition is based on the token's shape, not on its surroundings.
 * Near-zero false positives, so these get a high severity straight away.
 */
const DETECTORS: Detector[] = [
  { label: 'Anthropic API key', re: /\bsk-ant-[a-z0-9]{2,8}-[A-Za-z0-9_-]{16,}/ },
  // OpenAI's `sk-`, explicitly excluding the Anthropic prefix handled above.
  { label: 'OpenAI API key', re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { label: 'GitHub token (classic)', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { label: 'GitHub token (fine-grained)', re: /\bgithub_pat_[A-Za-z0-9_]{50,}/ },
  { label: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: 'DigitalOcean token', re: /\bdop_v1_[a-f0-9]{64}\b/ },
  { label: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    label: 'JWT',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
];

// --- Personal data ----------------------------------------------------------

const EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;

/** Role and machine accounts: not a person, so not personal data. */
const IMPERSONAL_LOCAL =
  /^(?:git|noreply|no-?reply|do-?not-?reply|info|support|contact|hello|hi|admin|webmaster|postmaster|team|sales|office|billing|security|abuse|example|test|demo|user(?:name)?|someone|me|you|your[._-]?\w*|my[._-]?\w*|email|mail|name|nobody)$/i;

/** Documentation and placeholder domains — flagging them would punish good examples. */
const IMPERSONAL_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|localdomain|domain\.(?:com|tld)|email\.com|company\.com|acme\.(?:com|org)|users\.noreply\.github\.com)$/i;

function personalEmail(value: string): boolean {
  EMAIL_RE.lastIndex = 0;
  for (const m of value.matchAll(EMAIL_RE)) {
    if (!IMPERSONAL_LOCAL.test(m[1]) && !IMPERSONAL_DOMAIN.test(m[2])) {
      return true;
    }
  }
  return false;
}

/**
 * Phone numbers: international prefix required. A national format ("0475 12 34 56") is
 * indistinguishable from an ID or a version by regex — the honest choice is to not guess.
 */
const PHONE_RE = /(?<![\w.])\+\d[\d ().\-/]{6,18}\d(?![\w.])/g;

function personalPhone(value: string): boolean {
  PHONE_RE.lastIndex = 0;
  for (const m of value.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) {
      return true;
    }
  }
  return false;
}

/** European IBAN prefixes we bother with — Vox Teneo's neighbourhood. */
const IBAN_RE = /\b(?:BE|FR|DE|NL|LU|GB|IE|ES|IT|PT|CH|AT)\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;

/** The mod-97 checksum is what separates an IBAN from a random uppercase ID. */
function validIban(candidate: string): boolean {
  const s = candidate.replace(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) {
    return false;
  }
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const c of rearranged) {
    const v = c >= 'A' ? String(c.charCodeAt(0) - 55) : c;
    for (const d of v) {
      rem = (rem * 10 + Number(d)) % 97;
    }
  }
  return rem === 1;
}

function personalIban(value: string): boolean {
  IBAN_RE.lastIndex = 0;
  for (const m of value.matchAll(IBAN_RE)) {
    if (validIban(m[0])) {
      return true;
    }
  }
  return false;
}

/** Recognises personal data in a piece of text. Returns a label, never the match. */
function classifyPersonal(text: string): string | undefined {
  if (personalEmail(text)) {
    return 'email address';
  }
  if (personalIban(text)) {
    return 'IBAN (bank account)';
  }
  if (personalPhone(text)) {
    return 'phone number';
  }
  return undefined;
}

/** A key that says "password": the name is the classification. */
const PASSWORD_KEY = /pass(?:word|wd)?|pwd/i;

/**
 * Subtrees where personal data is the tool working as designed, not a leak:
 * `oauthAccount` in ~/.claude.json is the login record Claude Code writes itself, and
 * `permissions` rules are invocation patterns that may quote the user's own identity.
 */
const PERSONAL_EXEMPT_PATH = /(^|\.)(oauthAccount|permissions)(\.|$)/;

// --- Credentials ------------------------------------------------------------

/** Key names that, paired with an opaque literal value, deserve a look. */
const SUSPECT_KEY = /(api[_-]?key|secret|token|password|passwd|credential|auth[_-]?key)/i;

/**
 * …but "claudeCodeFirstTokenDate" contains "Token" without being a secret. These suffixes
 * describe metadata, not an authentication value.
 */
const NOT_A_SECRET_KEY =
  /(date|_at|At|time|count|expiry|expires|enabled|disabled|version|url|uri|path|file|name|type|source|helper|header)$/;

/** An ISO date or a timestamp clears the entropy bar without being a secret. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ]|$)|^\d{10,13}$/;

/**
 * Shapes that are precisely the RIGHT practice, or obvious filler.
 * Flagging them would punish the people doing it properly — and make the panel unusable.
 */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) {
    return true;
  }
  // Environment and input references: ${env:X}, ${input:X}, ${localEnv:X}, $VAR, %VAR%
  if (/^\$\{[^}]*\}$/.test(v) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v) || /^%[^%]+%$/.test(v)) {
    return true;
  }
  if (/^<[^>]*>$/.test(v)) {
    return true;
  }
  if (/^(x{3,}|\.{3,}|…|-+|\*{3,})$/i.test(v)) {
    return true;
  }
  return /^(changeme|change[_-]?me|replace[_-]?me|your[_-]?\w*|my[_-]?\w*|todo|tbd|none|null|true|false|example|sample|dummy|test|placeholder)$/i.test(
    v,
  );
}

/** Shannon entropy, in bits per character. A real key sits well above 3. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True when the value looks like a secret without matching a known format. */
function looksOpaque(value: string): boolean {
  const v = value.trim();
  if (v.length < 16 || isPlaceholder(v) || TIMESTAMP.test(v)) {
    return false;
  }
  // A path, or a URL with no embedded credential, is not a secret.
  if (/^[a-z]+:\/\//i.test(v) && !/:\/\/[^/@\s]+:[^/@\s]+@/.test(v)) {
    return false;
  }
  // A sentence or a path is not a secret either.
  if (/\s/.test(v) || /^[./~]/.test(v)) {
    return false;
  }
  return entropy(v) >= 3.2;
}

// --- Git status -------------------------------------------------------------

interface GitStatus {
  inRepo: boolean;
  tracked: boolean;
  ignored: boolean;
}

const gitCache = new Map<string, boolean>();

/**
 * execFile rather than exec: no shell, so a hostile directory name cannot turn into
 * command injection.
 */
function git(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'], timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function gitStatus(file: string): GitStatus {
  const cwd = path.dirname(file);
  let inRepo = gitCache.get(cwd);
  if (inRepo === undefined) {
    inRepo = git(cwd, ['rev-parse', '--is-inside-work-tree']);
    gitCache.set(cwd, inRepo);
  }
  if (!inRepo) {
    return { inRepo: false, tracked: false, ignored: false };
  }
  return {
    inRepo: true,
    tracked: git(cwd, ['ls-files', '--error-unmatch', file]),
    ignored: git(cwd, ['check-ignore', '-q', file]),
  };
}

// --- File walking -----------------------------------------------------------

/** Strips JSONC comments — .vscode/settings.json and .mcp.json allow them. */
function stripComments(text: string): string {
  return text
    .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '')
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*/g, (m, str) => str ?? '');
}

/** First line (1-indexed) where a fragment appears. 1 when not found. */
function lineOf(text: string, fragment: string): number {
  const i = text.indexOf(fragment);
  if (i < 0) {
    return 1;
  }
  let line = 1;
  for (let k = 0; k < i; k++) {
    if (text[k] === '\n') {
      line++;
    }
  }
  return line;
}

/**
 * True when a piece of text carries something that looks like a credential. Used to redact
 * chat labels before they reach a webview: a conversation title is user text, and user text
 * sometimes starts with a pasted key.
 */
export function looksLikeSecret(text: string): boolean {
  return DETECTORS.some((d) => d.re.test(text));
}

/** Recognises a value. Returns the format label, or undefined. */
function classify(value: string): string | undefined {
  if (isPlaceholder(value)) {
    return undefined;
  }
  for (const d of DETECTORS) {
    if (d.re.test(value)) {
      return d.label;
    }
  }
  return undefined;
}

interface Hit {
  what: string;
  where: string;
  line: number;
  certain: boolean;
  kind: FindingKind;
}

/** Walks JSON while keeping the logical key path — without ever retaining values. */
function scanJsonValue(node: unknown, keyPath: string[], raw: string, out: Hit[]): void {
  if (typeof node === 'string') {
    const where = keyPath.join('.') || '(root)';
    const known = classify(node);
    if (known) {
      out.push({ what: known, where, line: lineOf(raw, node), certain: true, kind: 'credential' });
      return;
    }
    const key = keyPath[keyPath.length - 1] ?? '';
    const personal = PERSONAL_EXEMPT_PATH.test(where) ? undefined : classifyPersonal(node);
    if (personal) {
      out.push({ what: personal, where, line: lineOf(raw, node), certain: true, kind: 'personal' });
      return;
    }
    // A key literally named "password" classifies its own value — entropy does not apply:
    // real passwords are often short and human.
    if (
      PASSWORD_KEY.test(key) &&
      !NOT_A_SECRET_KEY.test(key) &&
      !isPlaceholder(node) &&
      !/\s/.test(node.trim()) &&
      node.trim().length >= 4
    ) {
      out.push({
        what: 'password in plain text',
        where,
        line: lineOf(raw, node),
        certain: false,
        kind: 'personal',
      });
      return;
    }
    if (SUSPECT_KEY.test(key) && !NOT_A_SECRET_KEY.test(key) && looksOpaque(node)) {
      out.push({
        what: 'opaque value under a sensitive name',
        where,
        line: lineOf(raw, node),
        certain: false,
        kind: 'credential',
      });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanJsonValue(v, [...keyPath, String(i)], raw, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      scanJsonValue(v, [...keyPath, k], raw, out);
    }
  }
}

/** Line-by-line fallback, for Markdown and unparseable JSON. */
function scanLines(raw: string): Hit[] {
  const out: Hit[] = [];
  raw.split('\n').forEach((text, i) => {
    const key = /"([^"]+)"\s*:/.exec(text)?.[1] ?? /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(text)?.[1];
    const where = key ?? `line ${i + 1}`;
    for (const d of DETECTORS) {
      if (d.re.test(text)) {
        out.push({ what: d.label, where, line: i + 1, certain: true, kind: 'credential' });
        return;
      }
    }
    const personal = classifyPersonal(text);
    if (personal) {
      out.push({ what: personal, where, line: i + 1, certain: true, kind: 'personal' });
    }
  });
  return out;
}

const MAX_BYTES = 2 * 1024 * 1024;

function scanFile(file: string): Hit[] {
  let raw: string;
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      return [];
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  if (/\.jsonc?$/.test(file)) {
    try {
      const parsed = JSON.parse(stripComments(raw));
      const out: Hit[] = [];
      scanJsonValue(parsed, [], raw, out);
      return out;
    } catch {
      return scanLines(raw);
    }
  }
  return scanLines(raw);
}

// --- Targets ----------------------------------------------------------------

interface Target {
  file: string;
  /** Loaded into the prompt on every turn — the secret goes to the provider. */
  loadedInPrompt: boolean;
}


/**
 * The scan targets are no longer a hand-kept list: they come from the tool catalogue in
 * `tools.ts`, so a developer on Cursor or Continue is covered without touching this file.
 * A few Claude-specific extras stay here because they have no catalogue entry.
 */
export function targets(workspaceRoot?: string): Target[] {
  const home = claudeUserDir();
  const out: Target[] = scannableTraces(workspaceRoot).map((t) => ({
    file: t.file,
    loadedInPrompt: t.loadedInPrompt,
  }));

  // Not tied to one tool: the parent-level .claude.json some setups write.
  out.push({ file: path.join(path.dirname(home), '.claude.json'), loadedInPrompt: false });
  if (workspaceRoot) {
    out.push({
      file: path.join(workspaceRoot, '.devcontainer', 'devcontainer.json'),
      loadedInPrompt: false,
    });
  }

  // A file can be listed by two tools (AGENTS.md, .vscode/settings.json): scan it once.
  const seen = new Set<string>();
  return out.filter((t) => {
    if (seen.has(t.file) || !exists(t.file)) {
      return false;
    }
    seen.add(t.file);
    return true;
  });
}

function severity(certain: boolean, tracked: boolean, loaded: boolean, kind: FindingKind): Severity {
  if (!certain) {
    return 'review';
  }
  // Personal data caps at 'high': exposed is bad, but nothing is burned the way a key is.
  if (kind === 'personal') {
    return tracked || loaded ? 'high' : 'review';
  }
  // Tracked by git: already pushed out. Loaded into the prompt: leaves on every turn.
  return tracked || loaded ? 'critical' : 'high';
}

function exposure(tracked: boolean, loaded: boolean): Exposure {
  if (tracked && loaded) {
    return 'both';
  }
  if (tracked) {
    return 'git';
  }
  return loaded ? 'context' : 'local';
}

const ORDER: Record<Severity, number> = { critical: 0, high: 1, review: 2 };

export function scanSecrets(workspaceRoot?: string): Finding[] {
  gitCache.clear();
  const out: Finding[] = [];

  for (const t of targets(workspaceRoot)) {
    const hits = scanFile(t.file);
    if (!hits.length) {
      continue;
    }
    const g = gitStatus(t.file);
    for (const h of hits) {
      out.push({
        file: t.file,
        line: h.line,
        what: h.what,
        where: h.where,
        exposure: exposure(g.tracked, t.loadedInPrompt),
        tracked: g.tracked,
        ignored: g.ignored,
        loadedInPrompt: t.loadedInPrompt,
        severity: severity(h.certain, g.tracked, t.loadedInPrompt, h.kind),
        kind: h.kind,
      });
    }
  }

  return out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

// --- Transcripts ------------------------------------------------------------

export interface TranscriptReport {
  filesScanned: number;
  filesWithSecrets: number;
  kinds: string[];
  /** Which tools' logs were involved — a developer rarely knows they all keep one. */
  tools: string[];
  truncated: boolean;
}

/**
 * Transcripts record EVERYTHING that hit the screen — a `cat .env`, a `printenv`, an API
 * response. This is the largest and least-known leak. Kept out of the main scan: several
 * MB per session, so it cannot run every time the panel opens.
 */
export function scanTranscripts(
  workspaceRoot?: string,
  budgetMs = 8000,
  maxFiles = 40,
): TranscriptReport {
  const root = path.join(claudeUserDir(), 'projects');
  const started = Date.now();
  const files: { file: string; mtime: number }[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 3) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.name.endsWith('.jsonl')) {
        try {
          files.push({ file: p, mtime: fs.statSync(p).mtimeMs });
        } catch {
          /* file vanished in the meantime */
        }
      }
    }
  };
  walk(root, 0);

  // Claude is not the only tool keeping conversations on disk — Continue stores whole
  // sessions as JSON, Aider writes its chat history into the project itself.
  const toolOf = new Map<string, string>();
  for (const t of historyTraces(workspaceRoot)) {
    try {
      files.push({ file: t.file, mtime: fs.statSync(t.file).mtimeMs });
      toolOf.set(t.file, t.tool);
    } catch {
      /* vanished */
    }
  }

  // Recent sessions first: those are the ones whose secrets are still valid.
  files.sort((a, b) => b.mtime - a.mtime);
  const slice = files.slice(0, maxFiles);

  const kinds = new Set<string>();
  const tools = new Set<string>();
  let filesWithSecrets = 0;
  let filesScanned = 0;
  let truncated = files.length > maxFiles;

  for (const { file } of slice) {
    if (Date.now() - started > budgetMs) {
      truncated = true;
      break;
    }
    filesScanned++;
    let found = false;
    try {
      // Chunked reads: a transcript can weigh tens of MB.
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(1024 * 1024);
        let pos = 0;
        let read = 0;
        while ((read = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
          const chunk = buf.toString('utf8', 0, read);
          for (const d of DETECTORS) {
            if (d.re.test(chunk)) {
              kinds.add(d.label);
              found = true;
            }
          }
          pos += read;
          if (Date.now() - started > budgetMs) {
            truncated = true;
            break;
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* unreadable: skip */
    }
    if (found) {
      filesWithSecrets++;
      tools.add(toolOf.get(file) ?? 'Claude Code');
    }
  }

  return { filesScanned, filesWithSecrets, kinds: [...kinds], tools: [...tools], truncated };
}
