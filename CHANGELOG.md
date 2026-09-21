# Changelog

## 0.5.1

- Removed a project folder name that had been quoted in a source comment, and two screenshots
  showing real conversation titles. Nothing in a published package should name anyone's work.

## 0.5.0

- Every instruction source, not just ours. Added the files Claude Code loads **on demand** —
  `.claude/skills`, `.claude/agents`, `.claude/commands`, personal and project — Copilot's
  `.github/prompts` and `.github/chatmodes`, and the third-party ecosystem: `.cursor/rules`,
  `.cursorrules`, `.windsurf/rules`, `.windsurfrules`, `.clinerules`, `.roo/rules`,
  `.continue/rules`, `GEMINI.md`, `.gemini/styleguide.md`, `.aiexclude`, `.rules` (Zed),
  `CONVENTIONS.md`, `.junie/guidelines.md`.
- New **on demand** state next to *loaded* and *ignored*: a skill costs nothing until it is used.
  It is excluded from the "lines re-sent every turn" total, which was previously overstated.
- Instruction map redesigned: four tables — Claude's stack, Copilot's merge, on-demand, and the
  rest of the ecosystem — each with real column headers.
- Panel redesigned: sticky header, four clickable figures answering "is anything wrong" before
  the first scroll, tabs as a segmented control, framed tables.
- Clicking a conversation in the status-bar list now opens that conversation instead of starting
  a new one.
- New command **Clean up old conversation archives**: what every past chat weighs, grouped by
  the folder it belongs to, vanished projects first. Chat logs only — no project file is ever
  touched — moved to the OS Trash so the one irreversible act in this extension is recoverable.
  Nothing preselected, the live conversation spared, every path checked against a known archive
  folder.
- The status bar now follows the chat **in front of you**, read from the tab order Claude Code
  records in VSCode's workspace state, and a chat can be **pinned** so the figure stops drifting
  to whichever conversation wrote last.
- Status bar shows the figure alone: the chat name filled the bar with prose, since a transcript
  often has no name beyond the opening words of its first message.

## 0.4.1

- Marketplace listing: screenshots, cleaned README, source repository link.

## 0.4.0

First public release.

- Configuration map: every instruction file and settings layer Copilot, Claude Code and Codex
  read, with what is loaded, what overrides, and what merges.
- Tune-up report: measured checks with a one-click, previewed fix on each line that needs one.
- Credential and personal-data detection in AI config files — findings never carry the value.
- Local spend measurement from Claude Code transcripts; Continue counters; honest "not
  measurable" rows for tools that keep none.
- Status bar context counter with a per-conversation list and a ready-to-paste /compact.
- No telemetry, no network calls, nothing written without a preview.
