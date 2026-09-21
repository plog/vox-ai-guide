import * as os from 'os';
import * as vscode from 'vscode';
import { deployToRemote } from './deploy';
import { initPanel, showDoctor } from './panel';
import { scanTranscripts } from './secrets';
import { DoctorSidebar } from './sidebar';
import { CleanupGroup, deleteArchives, groupForCleanup, humanBytes, shortPath } from './cleanup';
import { openChatTabs } from './claudeTabs';
import {
  Conversation,
  conversationById,
  currentUsage,
  recentConversations,
  recentSessions,
  SessionBrief,
  subagentCount,
} from './usage';

let status: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let sidebar: DoctorSidebar;

/**
 * The chat the status bar must keep describing, or undefined to follow the most recently
 * written one. Opening a chat writes nothing, so "most recent" drifts to whichever
 * conversation is talking — a terminal `claude` in the same folder steals the figure from
 * the chat on screen. Pinning is the only way to aim it, since no API tells us which chat
 * the user is looking at.
 */
let pinnedId: string | undefined;
let memento: vscode.Memento | undefined;
const PIN_KEY = 'statusBar.pinnedSession';

/** A conversation's identity across tools: two tools may well reuse an id shape. */
function conversationKey(c: Conversation): string {
  return `${c.tool}:${c.id}`;
}

/**
 * The pinned conversation, resolved by id rather than by scanning, and cached.
 *
 * A Claude figure is one tail read, cheap enough for every tick. Copilot's needs the archive
 * to be located first, which costs a directory walk — so the answer is held for a minute.
 * A pinned figure a minute old is still true; a VSCode that stutters every twenty seconds
 * would not be forgiven.
 */
const PINNED_TTL_MS = 60_000;
let pinnedCache: { key: string; at: number; value?: Conversation } | undefined;

function pinnedConversation(key: string): Conversation | undefined {
  const [tool, ...rest] = key.split(':');
  const fresh = pinnedCache?.key === key && Date.now() - pinnedCache.at < PINNED_TTL_MS;
  if (fresh && tool !== 'Claude') {
    return pinnedCache?.value;
  }
  const value = conversationById(tool, rest.join(':'), transcriptRoot());
  pinnedCache = { key, at: Date.now(), value };
  return value;
}

/** Saving one of these means the answer on screen may have just changed. */
const WATCHED = /(settings\.json|settings\.local\.json|\.claude\.json|mcp\.json|CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|copilot-instructions\.md)$/;

export function activate(ctx: vscode.ExtensionContext): void {
  initPanel(ctx.extensionUri);

  // Per folder, not global: a pinned chat belongs to the project it was opened in.
  memento = ctx.workspaceState;
  pinnedId = memento.get<string>(PIN_KEY);

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'voxAiGuide.sessions';
  ctx.subscriptions.push(status);

  // Set when VSCode runs us locally as a fallback in a remote window: everything we scan
  // then describes the laptop, not the host the developer is working on.
  const remoteFallbackHost =
    vscode.env.remoteName && ctx.extension.extensionKind === vscode.ExtensionKind.UI
      ? vscode.env.remoteName
      : undefined;

  sidebar = new DoctorSidebar(remoteFallbackHost, ctx.extension.packageJSON.version as string);
  ctx.subscriptions.push(
    // No retainContextWhenHidden: the html is cheap to rebuild (state lives in the
    // provider, not the webview), so a hidden sidebar costs zero memory instead of a
    // live iframe kept warm for nothing.
    vscode.window.registerWebviewViewProvider(DoctorSidebar.viewId, sidebar),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('voxAiGuide.run', () => showDoctor()),
    vscode.commands.registerCommand('voxAiGuide.sessions', showSessions),
    vscode.commands.registerCommand('voxAiGuide.showUsage', () => refresh(true)),
    vscode.commands.registerCommand('voxAiGuide.checkTranscripts', checkTranscripts),
    vscode.commands.registerCommand('voxAiGuide.cleanup', cleanupArchives),
    vscode.commands.registerCommand('voxAiGuide.refresh', () => sidebar.home()),
    vscode.commands.registerCommand('voxAiGuide.installOnRemote', async () => {
      if (await installOnRemote(ctx)) {
        sidebar.remoteInstalled();
      }
    }),
    // Switching chats writes nothing to disk, so the 20 s tick would never notice it.
    vscode.window.tabGroups.onDidChangeTabs(() => refresh(false)),
    vscode.window.tabGroups.onDidChangeTabGroups(() => refresh(false)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (WATCHED.test(doc.fileName)) {
        sidebar.refresh();
      }
    }),
  );

  void remoteFallbackNotice(ctx);

  refresh(false);
  // The status bar follows the session closely (one file read); the sidebar re-runs a full
  // scan with git subprocesses, so only every quarter of an hour — or on demand.
  let ticks = 0;
  timer = setInterval(() => {
    refresh(false);
    if (++ticks % 45 === 0) {
      sidebar.refresh();
    }
  }, 20_000);
  ctx.subscriptions.push({ dispose: () => timer && clearInterval(timer) });
}

/**
 * Where to look for transcripts. A window opened without a folder has no workspace folder,
 * but Claude Code still runs there — with the home directory as its cwd, so its transcripts
 * land in `projects/<encoded home>`. Falling back to the home directory is what makes the
 * status bar appear in such a window; the scans (panel, sidebar) keep using the workspace
 * folder alone, because "the project" is a different question from "the chat next door".
 */
function transcriptRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

/**
 * Housekeeping: what every past conversation weighs, grouped by the folder it belongs to,
 * with the folders that no longer exist at the top.
 *
 * This is the one screen that looks beyond the current project, because the question it
 * answers — what do these archives weigh — is about the machine, not about the folder open.
 * Everywhere else the scope stays on this project.
 *
 * Conversations go to the operating system's trash, never to an unlink: removing one is then
 * recoverable, which is a better answer than warning the user that it would not be. Nothing
 * is preselected, and the modal names the exact number of conversations and megabytes.
 */
async function cleanupArchives(): Promise<void> {
  const conversations = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Vox AI: measuring conversation archives…' },
    () => recentConversations(transcriptRoot(), { scope: 'everywhere', perTool: Infinity }),
  );
  const groups = groupForCleanup(conversations);
  if (!groups.length) {
    vscode.window.showInformationMessage('Vox AI: no conversation archive found.');
    return;
  }

  const total = groups.reduce((n, g) => n + g.bytes, 0);
  type Row = vscode.QuickPickItem & { group?: CleanupGroup };
  // The row used to read "627 MB — ~/Sites/my-app", which puts the project folder where the
  // object of the sentence goes: it looks like the folder is what gets deleted. What is
  // deleted is the chat logs; the folder is only where the conversations were held. So the
  // logs are the subject, the path is demoted to context, and every row says so outright.
  const rows: Row[] = groups.map((g) => ({
    label: `${g.missing ? '$(warning) ' : ''}${humanBytes(g.bytes)} of chat logs — ${
      g.conversations.length
    } conversation${g.conversations.length > 1 ? 's' : ''}`,
    description: `${g.tool} · held in ${shortPath(g.project)}`,
    // One short line each: this is a QuickPick row, not a paragraph — anything longer is
    // truncated mid-sentence and the reassurance never reaches the reader.
    detail: g.missing
      ? '$(trash) Project folder gone — only these logs are left.'
      : g.remote
        ? '$(device-desktop) Logs are on this disk; the project is remote.'
        : g.deletable
          ? '$(shield) Logs only — your code is untouched.'
          : '$(lock) Codex database — not written to by this extension.',
    picked: false,
  }));
  rows.forEach((r, i) => (r.group = groups[i]));

  const picked = await vscode.window.showQuickPick(
    rows.filter((r) => r.group?.deletable),
    {
      canPickMany: true,
      title: `Chat logs only — no project file is ever touched · ${humanBytes(total)} across ${
        conversations.length
      } conversations`,
      placeHolder:
        'Pick the chat logs to move to the Trash. Your code stays where it is. Nothing is selected by default.',
    },
  );
  if (!picked?.length) {
    return;
  }

  const doomed = picked.flatMap((r) => r.group?.conversations ?? []);
  const bytes = doomed.reduce((n, c) => n + (c.bytes ?? 0), 0);
  const go = 'Move to Trash';
  const answer = await vscode.window.showInformationMessage(
    `Move ${doomed.length} chat log${doomed.length > 1 ? 's' : ''} (${humanBytes(bytes)}) to the Trash?\n\n` +
      'These are conversation transcripts only. No project folder, and no file of yours, ' +
      'is touched — nothing leaves the archive folders Claude and Copilot write to.\n\n' +
      'You can restore them from the Trash. The conversation running right now is kept.',
    { modal: true },
    go,
  );
  if (answer !== go) {
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Vox AI: moving conversations to the Trash…' },
    () =>
      deleteArchives(doomed, {
        protect: currentUsage(transcriptRoot())?.sessionFile,
        // The OS trash, not an unlink: recoverable by design, so nothing here is a one-way door.
        remove: (file) =>
          Promise.resolve(
            vscode.workspace.fs.delete(vscode.Uri.file(file), { recursive: true, useTrash: true }),
          ),
      }),
  );
  pinnedCache = undefined;
  refresh(false);

  const notes = [
    `Vox AI: ${result.deleted} conversation${result.deleted > 1 ? 's' : ''} moved to the Trash, ${humanBytes(result.bytes)} freed.`,
    ...(result.skipped.length ? [`${result.skipped.length} kept — ${result.skipped[0].reason}.`] : []),
    ...(result.failed.length ? [`${result.failed.length} could not be moved: ${result.failed[0].reason}.`] : []),
  ];
  // Whatever happened is reported as it happened: a partial result never poses as a clean one.
  (result.failed.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(
    notes.join(' '),
  );
}

function ago(d: Date): string {
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 2) {
    return 'just now';
  }
  if (min < 90) {
    return `${min} min ago`;
  }
  const h = Math.round(min / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * The list behind the status bar figure — every conversation this machine can account for,
 * across Claude, Copilot and Codex. The bar shows one number, so it needs one list to choose
 * it in; and since VSCode never says which side-panel chat has the focus, picking a row here
 * is the only way to aim the figure at a tool other than Claude.
 *
 * "Compact" cannot be run for the user: the Claude Code extension exposes no command that
 * sends text into a chat. The honest gesture is to put `/compact` in the clipboard and
 * focus the chat input — one paste away, and the user sees what runs.
 */
async function showSessions(): Promise<void> {
  // The status bar refreshes on a 20 s tick; the list is computed now. With two chats
  // writing to the same project, a stale tick makes the two disagree — resync first.
  refresh(false);

  type Item = vscode.QuickPickItem & {
    action?: 'compact' | 'diagnostic' | 'open' | 'pin-only' | 'cleanup' | 'unpin';
    sessionId?: string;
    /** Identifies a conversation across tools, and is what the pin stores. */
    key?: string;
  };

  // Item buttons need createQuickPick — showQuickPick has no per-row buttons.
  const compactButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('fold'),
    tooltip: 'Compact — copies /compact and focuses Claude',
  };
  const pinButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('pin'),
    tooltip: 'Pin the status bar to this chat',
  };
  const unpinButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('pinned'),
    tooltip: 'Unpin — follow the chat on screen again',
  };

  // Grouped by tool, each group behind its own separator, so hundreds of rows stay navigable.
  const buildRows = (conversations: Conversation[]): Item[] => {
    const rows: Item[] = [];
    for (const tool of ['Claude', 'Copilot', 'Codex']) {
      const group = conversations.filter((c) => c.tool === tool);
      if (!group.length) {
        continue;
      }
      rows.push({
        label: `${tool} — ${group.length} conversation${group.length > 1 ? 's' : ''}`,
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const c of group) {
        const key = conversationKey(c);
        const pin = key === pinnedId ? unpinButton : pinButton;
        rows.push({
          label: `${key === pinnedId ? '$(pinned)' : '$(comment-discussion)'} ${Math.round(c.contextTokens / 1000)}k — ${c.label}`,
          description: `${c.model ? `${c.model} · ` : ''}${ago(c.lastActivity)}`,
          // Where it was held. Across hundreds of chats from every project on the machine, a
          // title on its own says nothing about which repository it belongs to.
          detail: c.projectMissing
            ? `$(warning) ${shortPath(c.project ?? '')} — this folder no longer exists`
            : `$(folder) ${c.project ? shortPath(c.project) : 'no folder'}`,
          // Only Claude chats can be reopened from here: Copilot and Codex expose no command
          // that takes a conversation id, so those rows say plainly that they only pin.
          action: c.tool === 'Claude' ? ('open' as const) : ('pin-only' as const),
          sessionId: c.tool === 'Claude' ? c.id : undefined,
          key,
          buttons: c.tool === 'Claude' ? [pin, compactButton] : [pin],
        });
      }
    }
    return rows;
  };

  const header: Item[] = [
    {
      label: '$(fold) Compact the current chat',
      description: 'copies /compact — you paste and send',
      action: 'compact',
    },
    { label: '$(list-tree) Open the full diagnostic', action: 'diagnostic' },
    // A pin is a mode, and a mode with no visible way out is a trap. It stays at the top of
    // the list as long as it holds, so undoing it never means hunting for the right row.
    ...(pinnedId
      ? [
          {
            label: '$(pinned) Unpin the status bar',
            description: 'follow the chat on screen again',
            action: 'unpin' as const,
          },
        ]
      : []),
    {
      label: '$(trash) Clean up old conversations',
      description: 'grouped by folder, vanished folders first',
      action: 'cleanup',
    },
  ];

  /**
   * `claude-vscode.editor.open` takes the session id as its first argument — the transcript
   * file name. Without it the extension opens a brand new conversation, which is never what
   * clicking a named chat means.
   */
  const openSession = async (sessionId: string): Promise<void> => {
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
    } catch {
      // Claude Code extension absent or renamed the command: nothing sensible to fall back to.
    }
  };

  const prepareCompact = async (sessionId?: string): Promise<void> => {
    await vscode.env.clipboard.writeText('/compact');
    try {
      if (sessionId) {
        await openSession(sessionId);
      }
      await vscode.commands.executeCommand('claude-vscode.focus');
    } catch {
      // Claude Code extension absent or renamed the command: the clipboard part still holds.
    }
    vscode.window.setStatusBarMessage('Vox AI: "/compact" copied — paste it into the chat and send.', 8000);
  };

  const qp = vscode.window.createQuickPick<Item>();
  qp.title = 'Conversations in this project — context size of each, across tools';
  qp.items = header;
  // Shown empty, then filled as each batch lands: Claude arrives at once, Copilot's hundreds
  // of archives over the next second. The alternative — build the whole list first — freezes
  // VSCode for that second, which is never worth a tidier first frame.
  qp.busy = true;
  let open = true;
  qp.onDidHide(() => {
    open = false;
    qp.dispose();
  });
  void recentConversations(transcriptRoot(), {
    onProgress: (soFar) => {
      if (open) {
        qp.items = [...header, ...buildRows(soFar)];
      }
    },
  }).then(() => {
    if (open) {
      qp.busy = false;
    }
  });
  qp.onDidTriggerItemButton((e) => {
    qp.hide();
    if (e.button === compactButton) {
      void prepareCompact(e.item.sessionId);
      return;
    }
    pinnedId = e.button === unpinButton ? undefined : e.item.key;
    void memento?.update(PIN_KEY, pinnedId);
    refresh(false);
  });
  qp.onDidAccept(() => {
    const pick = qp.selectedItems[0];
    qp.hide();
    if (pick?.action === 'pin-only' && pick.key) {
      // Accepting such a row used to do nothing at all, which read as "it opened Claude" —
      // the picker closed and focus fell back to whatever was behind it. Pin instead: it is
      // the only action these rows have, and the one the user came for.
      pinnedId = pick.key;
      void memento?.update(PIN_KEY, pinnedId);
      refresh(false);
    } else if (pick?.action === 'open' && pick.sessionId) {
      void openSession(pick.sessionId);
    } else if (pick?.action === 'compact') {
      void prepareCompact();
    } else if (pick?.action === 'unpin') {
      pinnedId = undefined;
      void memento?.update(PIN_KEY, undefined);
      refresh(false);
    } else if (pick?.action === 'cleanup') {
      void cleanupArchives();
    } else if (pick?.action === 'diagnostic') {
      showDoctor();
    }
  });
  qp.show();
}

/**
 * Transcripts record everything that hit the screen. Kept out of the panel: several MB per
 * session. The report contains only counts — never an excerpt.
 */
async function checkTranscripts(): Promise<void> {
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Vox AI: scanning transcripts…' },
    async () => scanTranscripts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
  );
  if (!r.filesWithSecrets) {
    vscode.window.showInformationMessage(
      `Vox AI: no credentials spotted in ${r.filesScanned} conversation log(s).`,
    );
    return;
  }
  vscode.window.showWarningMessage(
    `Vox AI: ${r.filesWithSecrets} of ${r.filesScanned} conversation log(s) contain credentials ` +
      `(${r.kinds.join(', ')}) — ${r.tools.join(', ')}. These files sit on your disk: clearing a ` +
      'chat erases nothing. Revoke the keys involved, then delete the logs.',
  );
}

/**
 * In an SSH window with no remote install, VSCode falls back to running us locally
 * (extensionKind lists "ui" second). Everything we scan then describes the wrong machine —
 * the laptop's ~/.claude while the developer works on the VM. Say it once per host, and
 * offer to fix it rather than explain it.
 */
async function remoteFallbackNotice(ctx: vscode.ExtensionContext): Promise<void> {
  const host = vscode.env.remoteName;
  if (!host || ctx.extension.extensionKind !== vscode.ExtensionKind.UI) {
    return;
  }
  const dismissKey = `remoteNotice.${host}`;
  if (ctx.globalState.get<boolean>(dismissKey)) {
    return;
  }

  const install = 'Install on the remote host';
  const never = "Don't show again";
  const pick = await vscode.window.showWarningMessage(
    `Vox AI Guide is running on your local machine: it sees your local AI configuration, ` +
      `not the remote host's. Install it on "${host}" to diagnose that machine.`,
    install,
    never,
  );
  if (pick === never) {
    await ctx.globalState.update(dismissKey, true);
  } else if (pick === install) {
    await installOnRemote(ctx);
  }
}

/**
 * The extension deploys itself: it rebuilds its own .vsix from the bytes already running
 * locally, writes it to the remote /tmp through the extension API — a remote window has
 * native access to the host's filesystem — and hands it to VSCode's installer. No scp, no
 * terminal, no network, and nothing to verify: the artefact is the running copy itself.
 */
async function installOnRemote(ctx: vscode.ExtensionContext): Promise<boolean> {
  try {
    await deployToRemote(ctx);
    return true;
  } catch (e) {
    // Self-deploy failed (unwritable /tmp, exotic remote): leave the manual gesture.
    const version = ctx.extension.packageJSON.version as string;
    await vscode.env.clipboard.writeText(`code --install-extension /tmp/vox-ai-guide-${version}.vsix`);
    vscode.window.showWarningMessage(
      `Vox AI: self-install failed — ${e instanceof Error ? e.message : String(e)}. ` +
        `Manual path: scp vox-ai-guide-${version}.vsix to the host's /tmp, then run the ` +
        'command now in your clipboard from the remote window terminal.',
    );
    return false;
  }
}

/**
 * The session id of the chat tab the user is looking at.
 *
 * VSCode tells us which tab is active and what it is called, but not which conversation it
 * holds; the Claude Code extension's own workspace state lists its open chats with the title
 * it gave each tab. Those titles are the same strings VSCode paints on the tabs — ellipsis
 * included, since both come from that extension — so the title joins the two halves.
 *
 * Position would be simpler and is wrong: the stored list reorders when tabs are moved or
 * reopened, which points the figure at the neighbouring conversation without any sign.
 *
 * Returns undefined for a chat docked in the side panel: that is a WebviewView, invisible to
 * the tab API. Also undefined when no stored title matches, because naming the wrong chat is
 * worse than falling back and saying so.
 */
function activeChatSession(): { onChatTab: boolean; sessionId?: string } {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return { onChatTab: false };
  }

  let active: vscode.Tab | undefined;
  for (const group of vscode.window.tabGroups.all) {
    const tab = group.activeTab;
    const input = tab?.input as { viewType?: unknown } | undefined;
    if (!tab || typeof input?.viewType !== 'string' || !/claude/i.test(input.viewType)) {
      continue;
    }
    // The focused group's active tab wins; another group's only stands in for it.
    if (group.isActive) {
      active = tab;
      break;
    }
    active ??= tab;
  }
  if (!active) {
    return { onChatTab: false };
  }
  // A brand new chat has a tab but no stored session and no transcript: it is on screen and
  // it is empty, which is a figure of its own — not a reason to show the neighbour's.
  return { onChatTab: true, sessionId: openChatTabs(root).find((t) => t.title === active?.label)?.sessionId };
}

function refresh(verbose: boolean): void {
  const cfg = vscode.workspace.getConfiguration('voxAiGuide');
  if (cfg.get<boolean>('statusBar.enabled') === false) {
    status.hide();
    return;
  }

  // The chat tab on screen wins, always. A pin exists for what VSCode cannot report — a chat
  // docked in the side panel, or a Copilot or Codex conversation — so it must never override
  // the one signal we do have: making the pin win froze the figure on tab switches, which
  // reads as the bar being broken.
  const { onChatTab, sessionId } = activeChatSession();
  const claude = recentSessions(transcriptRoot());
  const asConversation = (s: SessionBrief): Conversation => ({ tool: 'Claude', ...s });
  const usage = onChatTab
    ? claude.filter((s) => s.id === sessionId).map(asConversation)[0]
    : pinnedId
      ? pinnedConversation(pinnedId)
      : claude.slice(0, 1).map(asConversation)[0];

  // An empty chat on screen measures zero — that is an answer, and hiding the bar instead
  // would leave the previous conversation's figure standing as if it were this one's.
  if (onChatTab && !usage) {
    status.text = '0k';
    status.tooltip = new vscode.MarkdownString(
      'This chat has not sent a message yet, so it costs nothing so far.',
    );
    status.backgroundColor = undefined;
    status.show();
    return;
  }

  if (!usage || !usage.contextTokens) {
    status.hide();
    if (verbose) {
      vscode.window.showInformationMessage('Vox AI: no Claude session detected here.');
    }
    return;
  }

  const live = onChatTab;
  const pinned = !live && Boolean(pinnedId);
  const threshold = cfg.get<number>('statusBar.warnAtTokens') ?? 150_000;
  const k = Math.round(usage.contextTokens / 1000);
  const hot = usage.contextTokens >= threshold;

  // The figure alone, with no decorative icon: `$(symbol-namespace)` drew a `{ }` that means
  // "namespace" in every other VSCode surface and nothing at all here. Only the two icons
  // that carry information remain — pinned, and over threshold.
  status.text = `${pinned ? '$(pin) ' : ''}${k}k${hot ? ' $(warning)' : ''}`;
  status.tooltip = new vscode.MarkdownString(
    [
      `**${usage.label || 'Untitled chat'}** — ${usage.contextTokens.toLocaleString('en-GB')} context tokens`,
      '',
      `Tool: ${usage.tool}`,
      `Model: \`${usage.model ?? 'unknown'}\``,
      // Sub-agents are a Claude notion, and the count needs its transcript.
      ...(usage.file ? [`Subagents spawned: ${subagentCount(usage.file)}`] : []),
      '',
      live
        ? 'This is the chat open in front of you.'
        : pinned
        ? `Pinned to this ${usage.tool} conversation: the figure stays here whatever else writes. Click to unpin or pin another.`
        : 'This is the conversation that wrote *last* — which may be a terminal `claude` rather ' +
          'than the one you are reading. Click a chat to pin the bar to it.',
      '',
      hot
        ? `Past ${Math.round(threshold / 1000)}k, every turn resends this whole history. ` +
          'Click for the chat list and a ready-to-paste `/compact`.'
        : 'Click for the list of recent chats, each with its own counter.',
    ].join('\n'),
  );
  status.backgroundColor = hot
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  status.show();

  if (verbose) {
    showDoctor();
  }
}

export function deactivate(): void {
  if (timer) {
    clearInterval(timer);
  }
}
