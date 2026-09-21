import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeUserDir, vscodeUserDirs } from './paths';
import { Conversation } from './usage';

/**
 * Housekeeping for conversation archives.
 *
 * Chat logs are the one thing on this machine that grows without anyone deciding it should:
 * every conversation ever held is still on disk, including those belonging to projects that
 * no longer exist. This module groups them so the size becomes attributable, and deletes
 * only what the user picked, after seeing what it weighs.
 *
 * Deleting is the one irreversible act in this extension — a transcript has no `.bak` and no
 * second copy. So: nothing is ever deleted without an explicit selection and a modal count,
 * the current conversation is never touched, and every path is checked to sit inside a known
 * archive folder before it is unlinked.
 */

export interface CleanupGroup {
  /** Grouping key, and what the row shows: the folder these conversations were held in. */
  project: string;
  tool: string;
  conversations: Conversation[];
  bytes: number;
  /** The folder no longer exists locally — these are the strongest candidates. */
  missing: boolean;
  /** The folder lives on another machine, so nothing can be concluded about it. */
  remote: boolean;
  /** Codex keeps its threads in its own database, which this extension does not write to. */
  deletable: boolean;
}

/** Conversations grouped by the folder they belong to, heaviest concern first. */
export function groupForCleanup(conversations: Conversation[]): CleanupGroup[] {
  const groups = new Map<string, CleanupGroup>();
  for (const c of conversations) {
    const project = c.project ?? 'No folder';
    const key = `${c.tool}\u0000${project}`;
    const group = groups.get(key) ?? {
      project,
      tool: c.tool,
      conversations: [],
      bytes: 0,
      missing: Boolean(c.projectMissing),
      remote: Boolean(c.remote),
      // Claude and Copilot archives are plain files we can remove. A Codex thread is a row
      // in Codex's own database: listing it is fair, rewriting their storage is not.
      deletable: c.tool !== 'Codex',
    };
    group.conversations.push(c);
    group.bytes += c.bytes ?? 0;
    groups.set(key, group);
  }
  // Vanished projects first — they are the ones the user can decide about without thinking —
  // then by size, because that is what the cleanup is for.
  return [...groups.values()].sort(
    (a, b) => Number(b.missing) - Number(a.missing) || b.bytes - a.bytes,
  );
}

/** The folders an archive may legitimately live in. Anything else is never unlinked. */
function archiveRoots(): string[] {
  const roots = [path.join(claudeUserDir(), 'projects')];
  for (const userDir of vscodeUserDirs()) {
    roots.push(path.join(userDir, 'workspaceStorage'));
    roots.push(path.join(userDir, 'globalStorage', 'emptyWindowChatSessions'));
  }
  return roots.map((r) => path.resolve(r));
}

function insideArchive(file: string): boolean {
  const resolved = path.resolve(file);
  return archiveRoots().some((root) => resolved.startsWith(root + path.sep));
}

export interface CleanupResult {
  deleted: number;
  bytes: number;
  /** Files that could not be removed, with the reason — never silently swallowed. */
  failed: { file: string; reason: string }[];
  /** Files deliberately spared, and why. */
  skipped: { file: string; reason: string }[];
}

/**
 * Moves the archives of the given conversations out of the way.
 *
 * `remove` is supplied by the caller and sends each path to the operating system's trash
 * rather than unlinking it. That is the whole design: a conversation log has no `.bak` and
 * no second copy, so instead of warning the user that the act cannot be undone, the act is
 * made undoable — everything removed here can be restored from the Finder or Recycle Bin.
 *
 * `protect` is the transcript of the conversation running right now: Claude Code writes to
 * it continuously and reads it back for `--resume` and compaction, so removing it would
 * break a live session rather than tidy a dead one.
 */
export async function deleteArchives(
  conversations: Conversation[],
  opts: { protect?: string; remove: (file: string) => Promise<void> },
): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, bytes: 0, failed: [], skipped: [] };
  const protectedPath = opts.protect ? path.resolve(opts.protect) : undefined;

  for (const c of conversations) {
    if (!c.file) {
      result.skipped.push({ file: c.label, reason: 'no file to delete' });
      continue;
    }
    const file = path.resolve(c.file);
    if (file === protectedPath) {
      result.skipped.push({ file, reason: 'this is the conversation running right now' });
      continue;
    }
    if (!insideArchive(file)) {
      result.skipped.push({ file, reason: 'outside the known archive folders' });
      continue;
    }
    let bytes = 0;
    try {
      bytes = fs.statSync(file).size;
      await opts.remove(file);
      // Claude keeps a chat's sub-agent transcripts in a folder named after the session.
      const subagents = path.join(path.dirname(file), path.basename(file, '.jsonl'));
      if (fs.existsSync(subagents) && insideArchive(subagents)) {
        await opts.remove(subagents);
      }
    } catch (e) {
      result.failed.push({ file, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    // Counted only once the file is really gone: a report that says "deleted" about
    // something still on disk is worse than no report at all.
    if (fs.existsSync(file)) {
      result.failed.push({ file, reason: 'still on disk after the removal' });
      continue;
    }
    result.deleted += 1;
    result.bytes += bytes;
  }
  return result;
}

/** Bytes as a person reads them. */
export function humanBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ['kB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** A folder as a person reads it: `~/Sites/app`, and remote labels left as they are. */
export function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
