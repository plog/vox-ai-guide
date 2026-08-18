import * as vscode from 'vscode';
import { deployToRemote } from './deploy';
import { initPanel, showDoctor } from './panel';
import { scanTranscripts } from './secrets';
import { DoctorSidebar } from './sidebar';
import { currentUsage, recentSessions } from './usage';

let status: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let sidebar: DoctorSidebar;

/** Saving one of these means the answer on screen may have just changed. */
const WATCHED = /(settings\.json|settings\.local\.json|\.claude\.json|mcp\.json|CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|copilot-instructions\.md)$/;

export function activate(ctx: vscode.ExtensionContext): void {
  initPanel(ctx.extensionUri);

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
    vscode.commands.registerCommand('voxAiGuide.refresh', () => sidebar.home()),
    vscode.commands.registerCommand('voxAiGuide.installOnRemote', async () => {
      if (await installOnRemote(ctx)) {
        sidebar.remoteInstalled();
      }
    }),
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
 * The list behind the status bar figure. The bar can only show the most recently active
 * chat — with two windows or a terminal `claude`, that is a moving target. Here every
 * recent conversation gets its own counter, so the figure becomes attributable.
 *
 * "Compact" cannot be run for the user: the Claude Code extension exposes no command that
 * sends text into a chat. The honest gesture is to put `/compact` in the clipboard and
 * focus the chat input — one paste away, and the user sees what runs.
 */
async function showSessions(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const sessions = root ? recentSessions(root) : [];
  // The status bar refreshes on a 20 s tick; the list is computed now. With two chats
  // writing to the same project, a stale tick makes the two disagree — resync first.
  refresh(false);

  type Item = vscode.QuickPickItem & { action?: 'compact' | 'diagnostic' };

  // Item buttons need createQuickPick — showQuickPick has no per-row buttons.
  const compactButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('fold'),
    tooltip: 'Compact — copies /compact and focuses Claude',
  };

  const items: Item[] = [
    {
      label: '$(fold) Compact the current chat',
      description: 'copies /compact — you paste and send',
      action: 'compact',
    },
    { label: '$(list-tree) Open the full diagnostic', action: 'diagnostic' },
    {
      label: 'Chats in this project — the status bar follows whichever wrote last',
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...(sessions.length
      ? sessions.map((s) => ({
          label: `$(comment-discussion) ${Math.round(s.contextTokens / 1000)}k — ${s.label}`,
          description: `${s.model ? `${s.model} · ` : ''}${ago(s.lastActivity)}`,
          action: 'compact' as const,
          buttons: [compactButton],
        }))
      : [{ label: 'No conversation found for this folder.' }]),
  ];

  const prepareCompact = async (): Promise<void> => {
    await vscode.env.clipboard.writeText('/compact');
    try {
      await vscode.commands.executeCommand('claude-vscode.focus');
    } catch {
      // Claude Code extension absent or renamed the command: the clipboard part still holds.
    }
    vscode.window.setStatusBarMessage('Vox AI: "/compact" copied — paste it into the chat and send.', 8000);
  };

  const qp = vscode.window.createQuickPick<Item>();
  qp.title = 'Claude chats — context size of each conversation';
  qp.items = items;
  qp.onDidTriggerItemButton(() => {
    qp.hide();
    void prepareCompact();
  });
  qp.onDidAccept(() => {
    const pick = qp.selectedItems[0];
    qp.hide();
    if (pick?.action === 'compact') {
      void prepareCompact();
    } else if (pick?.action === 'diagnostic') {
      showDoctor();
    }
  });
  qp.onDidHide(() => qp.dispose());
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

function refresh(verbose: boolean): void {
  const cfg = vscode.workspace.getConfiguration('voxAiGuide');
  if (cfg.get<boolean>('statusBar.enabled') === false) {
    status.hide();
    return;
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const usage = root ? currentUsage(root) : undefined;
  if (!usage || !usage.contextTokens) {
    status.hide();
    if (verbose) {
      vscode.window.showInformationMessage('Vox AI: no Claude session detected for this folder.');
    }
    return;
  }

  const threshold = cfg.get<number>('statusBar.warnAtTokens') ?? 150_000;
  const k = Math.round(usage.contextTokens / 1000);
  const hot = usage.contextTokens >= threshold;

  status.text = `$(symbol-namespace) ${k}k${hot ? ' $(warning)' : ''}`;
  status.tooltip = new vscode.MarkdownString(
    [
      `**Most recently active Claude chat** — ${usage.contextTokens.toLocaleString('en-GB')} context tokens`,
      '',
      ...(usage.label ? [`Chat: “${usage.label}”`] : []),
      `Model: \`${usage.model ?? 'unknown'}\``,
      `Subagents spawned: ${usage.subagents}`,
      '',
      'The figure follows whichever chat wrote last — with two windows open it moves between them.',
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
