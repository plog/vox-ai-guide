# Vox AI Guide for VSCode

**Nobody understands the maze.** Copilot reads five kinds of instruction file, Claude Code reads
another set, they overlap in one place and contradict each other in three. Somewhere in there,
a settings file holds an API key.

This extension answers two questions, in plain words, on your own machine:

> **Is my AI setup costing me more than it should?**
> **Are my keys safe?**

It **explains** and it **suggests**. It never blocks, never sends anything anywhere, and never
writes a file you have not seen a preview of.

Above all, **it teaches.** A tool that silently fixed your configuration would leave you exactly
as dependent tomorrow as you were today.

<p align="center">
  <img src="media/screenshots/secrets.png" width="520" alt="The panel header: four figures — secrets in your config, fixes suggested, lines re-sent every turn, context in this chat — each one a button into the tab that explains it">
</p>

---

## It is a teaching tool that happens to write files

This is the part that explains every other design decision here.

Nobody chose this mess. People inherited it — a `CLAUDE.md` copied from a blog post, a
`.cursorrules` left by whoever tried Cursor for a week, a `.vscode/settings.json` committed by
accident three sprints ago. The result is a configuration nobody on the team can read, and a bill
nobody can account for. Fixing that for you, quietly, would buy one good afternoon and change
nothing: the next file lands next month and the maze grows back.

So every surface here is built to leave you knowing something:

- **Every fix carries its *why* and its *gain*, in plain words**, before its Review button. You
  can apply it — or read the two sentences, understand the mechanism, and never need the fix
  again.
- **Nothing is applied blind.** A mandatory before/after preview is a type-level requirement on a
  fix (`preview()` is not optional in the code), because a diff you read is a lesson and a diff
  you never see is magic.
- **Absence is shown, not hidden.** A file you do not have still gets a row. You cannot learn the
  shape of a system from a list of the parts you already installed.
- **The distinctions are the content.** Files that *stack* versus settings that *override*.
  *Present* versus *actually loaded*. *Always loaded* versus *on demand*. *Tracked by git* versus
  *sent to the model*. Each of those is a rule people get wrong for months, at a real cost.
- **"Not detected" tools are still documented**, and so is the rest of the ecosystem — Cursor,
  Windsurf, Cline, Gemini, Zed, Aider, Junie. You are not the only reader of your repo: a
  teammate on another tool is being steered by a file committed next to yours.

The measurements exist for the same reason. "Subagents inherit the session's model" is an
abstraction; **"86% of your spend was helper agents running on Opus"** is a thing you remember.

## Why both questions live in one extension

They are **the same files**.

An oversized `CLAUDE.md` inflates the context on every single turn — you pay for it again at each
message. The same file with an API key in it sends that key to the provider on every single turn.
One sweep, one map, two answers.

## The two ways a secret escapes

This is the distinction the extension teaches, and the one no conventional secret scanner makes.

| Vector | How far it went | What actually fixes it |
|---|---|---|
| **Git** — the file is tracked and left with a push | The whole repo, permanently | **Revoke the key.** A `.gitignore` added afterwards repairs nothing |
| **Context** — the file is loaded into the prompt | The provider, plus your local transcripts | Remove the secret from the file, then revoke |

The three traps that catch almost everyone:

- the `env` block in `settings.json`;
- `.vscode/settings.json` — **version-controlled by default**, and it carries
  `claudeCode.environmentVariables`;
- the `env` block of an MCP server in `.mcp.json`, a file designed to be committed.

And the one nobody thinks about: `~/.claude/projects/**/*.jsonl` records **everything that hit the
screen** — a `cat .env`, a `printenv`, an API response. `/clear` erases nothing on disk. The
command `Vox AI: Scan my Claude transcripts for secrets` sweeps exactly that.

### The value is never displayed

The `Finding` type does not carry the secret's value. Not in the panel, not in a notification, not
in a log — the startup notification announces a **count**. This is a type-level guarantee, not a
discipline: you cannot leak what you do not carry. A panel is a webview; it ends up in a
screenshot, in a screen share, or in the context of an agent asked to read it back.

## Where the money goes

Both tools now bill per token — Claude always did, and GitHub replaced premium requests with
**AI Credits** on 2026-06-01, billed on input, output **and cache**. So the answer to "where did
my month go" is a measurement, not an estimate. The extension walks your local transcripts and
splits the spend three ways:

| Bucket | What it is | What to do about it |
|---|---|---|
| **Helper agents** | Everything the subagents burned, from their own transcripts | Pin them to a cheaper model — they inherit the conversation's by default |
| **Long chats** | Turns whose context had already passed 150k | `/clear` between tasks, not at the end of the day |
| **Normal work** | The rest | Nothing. This is the part you meant to spend |

That split is why the first fix on the list is usually the right one. On the machine this project
came from, **86%** of the spend sat in the first bucket: built-in subagents inherit the session's
model, the session ran on Opus, so 78 searches ran on Opus.

## The fixes

Every one of them carries its **why** — that is the point of the extension, not a UI detail — and
every one shows a **before/after preview** before it touches anything.

| Fix | Effect |
|---|---|
| `chat.useClaudeMdFile` | Copilot reads the repo's `CLAUDE.md` — **one file for both tools** |
| `AGENTS.md` bridge | Creates a `CLAUDE.md` importing your existing `AGENTS.md` (Claude never reads `AGENTS.md` itself) |
| `Explore` on Haiku | Subagents inherit the session's model: without this, every search runs on Opus |
| `general-purpose` on Sonnet | Same mechanism, for the general-purpose agent |
| `effortLevel` → `medium` | Stop paying for long reasoning on trivial turns |
| Concision rule | Kills preambles and closing summaries, without touching code output |
| `.github/copilot-instructions.md` | Sets the Copilot response style once and for all |
| `chat.agent.maxRequests` → 25 | An agent gone astray hands back control sooner |
| Closing stale tabs | Copilot builds its context from your open editors |

Writes to `~/.claude/settings.json` create a `.bak` first.

On a detected secret there are only two actions — **Open** (the file, at the right line) and
**Ignore** (add to `.gitignore`). No automatic rewriting: on a file holding a credential, taking
the human to the right place beats editing blind. And when the file is already tracked by git, the
fix refuses to present itself as sufficient — it points at revocation instead.

## What it looks like

An **icon in the activity bar** opens the summary: keys found, current Claude session, available
fixes. A badge shows the number of exposed credentials, or failing that the number of fixes.
One idea per screen; the figures are one click deeper, as evidence for the word.

`Vox AI: Diagnose my AI configuration` opens the full map in an editor tab:

The page opens on four figures — secrets found, fixes available, lines re-sent on every turn,
context size of the current chat — each one a button into the tab that explains it. Then:

1. **Secrets in your config** — with, for each, *how it escapes*: pushed out, or sent to the model.
2. **Current Claude session** — context size, model, subagents spawned. Read from the local
   transcript, since Claude Code exposes no API to an extension.
3. **Suggested fixes** — each with its why.
4. **Where your instructions live** — every location we know of, in four tables, and for each
   file: who reads it, how far it reaches, whether it exists, and whether it is **actually
   loaded** (several depend on a VSCode setting people forget to switch on).
   - *What Claude Code reads*, numbered in the order it stacks them.
   - *What Copilot reads*, unnumbered — it merges its files with no documented pecking order.
   - *Loaded on demand* — `.claude/skills`, `.claude/agents`, `.claude/commands`,
     `.github/prompts`, `.github/chatmodes`. Only their name and one-line description sit in the
     permanent context; the body arrives when one is used. **This is the way out of a bloated
     `CLAUDE.md`**, and most people have never been told these exist.
   - *The rest of the ecosystem* — `.cursor/rules` and `.cursorrules`, `.windsurf/rules` and
     `.windsurfrules`, `.clinerules`, `.roo/rules`, `.continue/rules`, `GEMINI.md`,
     `.gemini/styleguide.md`, `.aiexclude`, `.rules` (Zed), `CONVENTIONS.md` (Aider),
     `.junie/guidelines.md`. `AGENTS.md` is the standard several of these now agree on — and a
     stale `.cursorrules` can quietly win over it, because some editors take the **first** file
     they find rather than merging them all.
5. **Active VSCode settings** — the effective value **and the layer it comes from**, plus the
   layers it overrides. A `workspace` setting lives in a version-controlled file.
6. **Habits** — what no setting will ever do for you.

"Not detected" is a first-class state: a tool you do not have still gets a row, so the sweep looks
as complete as it is.

## The status bar, and the chat it describes

The bar shows one figure: the context size of a conversation, in thousands of tokens. Past your
threshold it warns — that is the point where every turn resends a history you are paying for
twice.

*Which* conversation, though, is the hard part. Claude Code exposes no API for it, and VSCode's
tab API deliberately hides a webview's identity. The extension reads the tab order Claude Code
records in VSCode's own workspace state to identify the chat **in front of you** — an index, not
a name, and written to fail silently if anything on their side changes. Failing that, you can
**pin** a chat from the list so the figure stops drifting to whichever conversation wrote last: a
terminal `claude` in the same folder will otherwise steal it.

Clicking the bar lists every recent conversation with its own counter, and opens the one you
pick. A ready-to-paste `/compact` sits at the top — the extension cannot send text into a chat,
so it puts the command in your clipboard and focuses the input rather than pretending to run it
for you.

## Housekeeping: what your chat logs weigh

`Vox AI: Clean up old conversation archives` answers a question nobody asks until the disk is
full. Every conversation you have ever held is still on disk, including those of projects that no
longer exist — often gigabytes, accumulated without anyone deciding it should be.

The list groups logs by the folder they were held in, vanished projects first, then by size.
Deleting is **the one irreversible act in this extension**, so it is fenced accordingly:

- **Chat logs only.** No project folder, no file of yours. Every path is checked to sit inside a
  known archive folder before anything happens to it.
- **To the Trash, never an `unlink`.** Rather than warn you that the act cannot be undone, the
  act is made undoable: restore anything from the Finder or Recycle Bin.
- **Nothing preselected**, and a modal naming the exact count and size before it runs.
- **The live conversation is spared** — Claude Code writes to it continuously.
- Failures and skipped files are reported as they happened. A partial result never poses as a
  clean one.

Worth knowing before you tick a box: deleting a transcript also removes the ability to resume
that chat, and the spend figures elsewhere in this extension are computed *from* these files.

## No telemetry. At all.

On a secret detector, the slightest network callback would be credential exfiltration.

- Local reads, displayed to you, on your machine. **Zero network egress.**
- Nothing is collected, so there is nothing to declare. Centralising this — an OTEL exporter, a
  team dashboard, per-user Admin API pulls — would put it under GDPR **and** CBA no. 81:
  prior collective information, works council consultation, purpose, proportionality.
- Transcripts contain **client** code and data. Exporting them, even to an internal collector,
  touches the NDAs.
- If management wants figures, they exist at organisation level: the Anthropic Admin API and the
  GitHub billing report. Never from a developer's workstation.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `voxAiGuide.statusBar.enabled` | `true` | Shows the current Claude session's context size in the status bar |
| `voxAiGuide.statusBar.warnAtTokens` | `150000` | Threshold past which the status bar warns — the point where a `/clear` starts to pay off |
| `voxAiGuide.library.path` | `""` | Folder holding your team's best-practice entries. Clone an internal repo there and everyone shares the same conventions. Read locally, never fetched |

## Install

From the Marketplace: search **Vox AI Guide** in the Extensions view, or

```bash
code --install-extension plog.vox-ai-guide
```

Nothing on your machine is installed through `curl | bash`. That is a rule here, not a preference.

## Develop

```bash
npm install
npm run compile          # or: npm run watch
```

**F5** in VSCode launches a test window (see `.vscode/launch.json`). To package:

```bash
npx @vscode/vsce package
```

### Adding a fix

`src/fixes.ts` is the only file to touch. A fix is
`{ id, title, why, gain, applicable(), preview(), apply() }`, and `preview()` is **mandatory** —
a fix without one would be a fix applied blind.

| File | Role |
|---|---|
| `src/scan.ts` | Every instruction location — Claude Code, Copilot, on-demand, and the third-party ecosystem — the 4 settings layers, the VSCode layers via `inspect()`, the warnings |
| `src/secrets.ts` | Credential detection. **Never carries a value** |
| `src/fixes.ts` | The fixes and the tips |
| `src/usage.ts` | Reads the local transcripts: current session, and the three-way spend split |
| `src/panel.ts` | The full map, in an editor webview |
| `src/sidebar.ts` | The activity-bar webview: the four screens, and the badge |
| `src/cleanup.ts` | Grouping and deletion of conversation archives. Trash only, inside known roots |
| `src/claudeTabs.ts` | Which chat is on screen, from Claude Code's tab order. Fails silently by design |
| `src/paths.ts` | Cross-platform paths, project-folder encoding, JSON I/O with `.bak` |

Only `--vscode-*` variables are used for colour, so Light and High Contrast work without a second
palette. Reference width is 340px, but the sidebar shrinks to ~170px: everything is fluid.

## Scope

VSCode, for now. Developers who run `claude` in a terminal outside VSCode are not covered — for
them the same agent files would redistribute as a Claude Code plugin. A port, not a rewrite.

---

Questions, fixes to add, false positives: open an issue.
