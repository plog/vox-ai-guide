# Vox AI Guide for VSCode

**Nobody understands the maze.** Copilot reads five kinds of instruction file, Claude Code reads
another set, they overlap in one place and contradict each other in three. Somewhere in there,
a settings file holds an API key.

This extension answers two questions, in plain words, on your own machine:

> **Is my AI setup costing me more than it should?**
> **Are my keys safe?**

It **explains** and it **suggests**. It never blocks, never sends anything anywhere, and never
writes a file you have not seen a preview of.

<p align="center">
  <img src="media/screenshots/fixes.png" width="640" alt="Suggested fixes: each with its why, its gain, and a Review button — nothing applied blind">
</p>
<p align="center">
  <img src="media/screenshots/status-chats.png" width="480" alt="Status bar context counter, with the per-conversation list and a ready-to-paste /compact">
</p>

---

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

1. **Secrets in your config** — with, for each, *how it escapes*: pushed out, or sent to the model.
2. **Current Claude session** — context size, model, subagents spawned. Read from the local
   transcript, since Claude Code exposes no API to an extension.
3. **Suggested fixes** — each with its why.
4. **Where your instructions live** — the 12 locations across both tools, and for each: who reads
   it, its scope, whether it exists, and whether it is **actually loaded** (several depend on a
   VSCode setting people forget to switch on).
5. **Active VSCode settings** — the effective value **and the layer it comes from**, plus the
   layers it overrides. A `workspace` setting lives in a version-controlled file.
6. **Habits** — what no setting will ever do for you.

"Not detected" is a first-class state: a tool you do not have still gets a row, so the sweep looks
as complete as it is.

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
| `src/scan.ts` | The 12 instruction locations, the 4 settings layers, the VSCode layers via `inspect()`, the warnings |
| `src/secrets.ts` | Credential detection. **Never carries a value** |
| `src/fixes.ts` | The fixes and the tips |
| `src/usage.ts` | Reads the local transcripts: current session, and the three-way spend split |
| `src/panel.ts` | The full map, in an editor webview |
| `src/sidebar.ts` | The activity-bar webview: the four screens, and the badge |
| `src/paths.ts` | Cross-platform paths, project-folder encoding, JSON I/O with `.bak` |

Only `--vscode-*` variables are used for colour, so Light and High Contrast work without a second
palette. Reference width is 340px, but the sidebar shrinks to ~170px: everything is fluid.

## Scope

VSCode, for now. Developers who run `claude` in a terminal outside VSCode are not covered — for
them the same agent files would redistribute as a Claude Code plugin. A port, not a rewrite.

---

Questions, fixes to add, false positives: open an issue.
