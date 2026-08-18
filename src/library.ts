import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * The library of best practices.
 *
 * What the fixes write used to be string constants buried in `fixes.ts`: one wording, for
 * every project, take it or leave it. But instructions for a Symfony API and for a React
 * front-end are not the same text, and a team's conventions are not ours to guess. So the
 * content lives here, it is picked from a list, it is edited on the review screen before
 * anything is written, and a team can ship its own entries from a shared folder.
 *
 * Built-in entries are a starting point, never an answer.
 */

/** Where a template can be written. A fix declares the slot it fills. */
export type Slot = 'copilot-instructions' | 'claude-rule' | 'agent-explore' | 'agent-general';

export interface Template {
  id: string;
  slot: Slot;
  title: string;
  /** One line, shown in the picker: when would I choose this one? */
  summary: string;
  body: string;
  /** Built-ins ship with the extension; the others come from the team or user folder. */
  origin: 'built-in' | 'library';
  /**
   * The stack this entry targets. An entry matching the open project is offered first —
   * instructions for a Go service and for a Symfony app have almost nothing in common, and
   * the generic wording is the one nobody ever bothers to fill in.
   */
  stack?: Stack;
}

export type Stack = 'dotnet' | 'php' | 'python' | 'go' | 'node';

/** Marker files, most specific first. Detection is a hint for ordering, never a constraint. */
const STACK_MARKERS: Array<[Stack, RegExp]> = [
  ['dotnet', /\.(csproj|sln|fsproj)$/],
  ['php', /^composer\.json$/],
  ['python', /^(pyproject\.toml|requirements\.txt|setup\.py|Pipfile)$/],
  ['go', /^go\.mod$/],
  ['node', /^package\.json$/],
];

/** What this project is written in, judged from the files at its root. */
export function detectStack(workspaceRoot?: string): Stack | undefined {
  if (!workspaceRoot) {
    return undefined;
  }
  let names: string[];
  try {
    names = fs.readdirSync(workspaceRoot);
  } catch {
    return undefined;
  }
  for (const [stack, re] of STACK_MARKERS) {
    if (names.some((n) => re.test(n))) {
      return stack;
    }
  }
  return undefined;
}

// --- Built-in entries -------------------------------------------------------

const COPILOT_MINIMAL = `# Project instructions

## Response style
- Go straight to the code. No preamble, no closing summary.
- Explain only when asked, or when a non-obvious choice deserves one line of justification.
- Do not echo back a file I just showed you: give the diff, or cite \`file:line\`.
- Code, commands and error messages stay complete and exact.
`;

const COPILOT_FULL = `# Project instructions

## Response style
- Go straight to the code. No preamble, no closing summary.
- Explain only when asked, or when a non-obvious choice deserves one line of justification.
- Do not echo back a file I just showed you: give the diff, or cite \`file:line\`.
- Code, commands and error messages stay complete and exact.

## Stack
<!-- Languages, frameworks and versions. The agent guesses wrong without this. -->

## Build and test
<!-- The exact commands. Nothing costs more tokens than an agent inventing a build command. -->

## Conventions
<!-- Naming, folder layout, what is forbidden. Be specific: "no default export" beats "clean code". -->
`;

const CONCISION_RULE = `# Concision

- Answer without preamble or closing summary. No "I will now…", no "In summary…".
- One recommendation, not a comparison table of the options you discarded.
- Do not copy code or command output the user can already see into your reply: cite \`file:line\`.
- Do not re-read a file you just edited to check it.
- Code, commands and error messages stay complete and exact. Concision applies to prose, never to technical content.
`;

const EXPLORE_AGENT = `---
name: Explore
description: Read-only search agent, for broad sweeps where only the conclusion matters, not file contents. State the breadth: "quick", "medium" or "very thorough".
disallowedTools: Write, Edit, NotebookEdit
model: haiku
maxTurns: 15
---

You locate and you report. You do not review, you do not audit, you do not judge quality.

Method:
- Grep and Glob before Read. If you must read, read the useful range (offset/limit), never a large file whole.
- Group independent searches into a single message so they run in parallel.
- Stop as soon as you can answer. Do not keep going "just to be safe".

Output:
- Your last message IS the value returned to the main conversation. No preamble, no pleasantries.
- Cite \`path/file.ext:42\` and short excerpts. Never large blocks of content.
- Explicitly state what you looked for and did not find: a confirmed absence is a useful result.
- Stay under 40 lines unless the caller asked for "very thorough".
`;

const GENERAL_AGENT = `---
name: general-purpose
description: General-purpose agent for complex questions, code search and multi-step tasks.
model: sonnet
maxTurns: 25
---

You handle a delegated task end to end, in your own context window.

Method:
- Stay within the given scope. No "while I'm here" on neighbouring files.
- Search before reading: Grep/Glob to locate, then Read on the useful ranges.
- Group independent calls into a single message.
- Do not spawn another subagent.
- Stop when it is done. An extra verification pass costs more than it returns.

Output:
- Your last message IS the returned value. No preamble.
- Give the conclusion and its evidence: \`path/file.ext:42\`, decisions made, open points.
- Never large blocks of content or command output. Summarise and cite the location.
`;






const STACK_DOTNET = `# Project instructions

## Response style
- Straight to the code. No preamble, no closing summary.
- Cite \`File.cs:42\` instead of pasting back a file I showed you.

## Stack
- .NET 8 / C# 12. <!-- adjust -->
- Nullable reference types are enabled: honour the annotations, do not add \`!\` to silence them.

## Commands
\`\`\`
dotnet build
dotnet test
dotnet format          # before proposing a diff
\`\`\`

## Conventions
- \`async\` all the way down. Never \`.Result\` or \`.Wait()\` — they deadlock.
- Pass \`CancellationToken\` through public async methods.
- Constructor injection only. No service locator, no static state.
- Prefer \`IReadOnlyList<T>\` on public surfaces; expose \`IEnumerable<T>\` only when laziness is intended.
- EF Core: schema changes go through a migration. Never edit an applied migration.

## Do not
- Do not touch generated files, \`bin/\`, \`obj/\`.
- Do not introduce a package without saying so first.
`;

const STACK_PHP = `# Project instructions

## Response style
- Straight to the code. No preamble, no closing summary.
- Cite \`src/Service/Foo.php:42\` instead of pasting back a file I showed you.

## Stack
- PHP 8.3, Composer. <!-- Symfony / Laravel / WordPress — adjust -->
- \`declare(strict_types=1);\` at the top of every new file.

## Commands
\`\`\`
composer install
vendor/bin/phpunit
vendor/bin/php-cs-fixer fix     # or phpcs, adjust
vendor/bin/phpstan analyse
\`\`\`

## Conventions
- PSR-12 formatting, PSR-4 autoloading. Typed properties, typed params, typed returns.
- Constructor injection. No \`new\` on a service inside a service.
- Database access goes through the ORM/repository layer — no raw SQL string concatenation, ever.
- Exceptions over error codes. Never silence with \`@\`.

## Do not
- Do not edit \`vendor/\`.
- Do not add a Composer package without saying so first.
`;

const STACK_PYTHON = `# Project instructions

## Response style
- Straight to the code. No preamble, no closing summary.
- Cite \`pkg/module.py:42\` instead of pasting back a file I showed you.

## Stack
- Python 3.12, virtualenv in \`.venv\`. <!-- adjust -->
- Type hints on every public function. The codebase is checked, not decorative.

## Commands
\`\`\`
pytest -q
ruff check --fix
ruff format
mypy .
\`\`\`

## Conventions
- No mutable default arguments. \`None\` plus a guard.
- Prefer \`pathlib.Path\` over \`os.path\`, f-strings over \`%\` and \`.format()\`.
- Explicit exceptions; never a bare \`except:\`.
- Dependencies are declared in \`pyproject.toml\`, not installed ad hoc.

## Do not
- Do not edit \`.venv/\`, \`__pycache__/\`, or lock files by hand.
- Do not add a dependency without saying so first.
`;

const STACK_GO = `# Project instructions

## Response style
- Straight to the code. No preamble, no closing summary.
- Cite \`internal/svc/foo.go:42\` instead of pasting back a file I showed you.

## Stack
- Go 1.22, modules. <!-- adjust -->

## Commands
\`\`\`
go build ./...
go test ./...
gofmt -l .
go vet ./...
\`\`\`

## Conventions
- Handle every error. Wrap with context: \`fmt.Errorf("doing x: %w", err)\`.
- No \`panic\` in library code — return an error.
- Accept interfaces, return structs. Keep interfaces small and defined by the consumer.
- \`context.Context\` is the first parameter of anything that blocks.
- Table-driven tests, with \`t.Parallel()\` where it is safe.

## Do not
- Do not add a dependency without saying so first — the standard library usually suffices.
- Do not edit generated files (\`*.pb.go\`, mocks).
`;

const STACK_NODE = `# Project instructions

## Response style
- Straight to the code. No preamble, no closing summary.
- Cite \`src/module.ts:42\` instead of pasting back a file I showed you.

## Stack
- TypeScript, Node 22. <!-- adjust -->
- \`strict\` is on. Do not add \`any\` or \`@ts-ignore\` to make an error go away.

## Commands
\`\`\`
npm ci
npm test
npm run lint
npm run build
\`\`\`

## Conventions
- Named exports. No default export.
- \`async\`/\`await\` over \`.then()\` chains. Every promise is awaited or explicitly voided.
- Errors are \`Error\` instances, never strings.
- No new runtime dependency without saying so first.

## Do not
- Do not edit \`node_modules/\`, \`dist/\`, or lock files by hand.
`;

const BUILT_INS: Template[] = [
  {
    id: 'copilot-minimal',
    slot: 'copilot-instructions',
    title: 'Response style only',
    summary: 'Short. Sets the tone and nothing else — safe on any repo, including a client one.',
    body: COPILOT_MINIMAL,
    origin: 'built-in',
  },
  {
    id: 'copilot-full',
    slot: 'copilot-instructions',
    title: 'Response style + project sections',
    summary: 'Adds empty Stack / Build / Conventions sections for you to fill in.',
    body: COPILOT_FULL,
    origin: 'built-in',
  },
  {
    id: 'stack-dotnet',
    slot: 'copilot-instructions',
    stack: 'dotnet',
    title: '.NET / C#',
    summary: 'dotnet build & test, async rules, EF Core migrations, nullable.',
    body: STACK_DOTNET,
    origin: 'built-in',
  },
  {
    id: 'stack-php',
    slot: 'copilot-instructions',
    stack: 'php',
    title: 'PHP',
    summary: 'composer, PHPUnit, PHPStan, PSR-12, strict types.',
    body: STACK_PHP,
    origin: 'built-in',
  },
  {
    id: 'stack-python',
    slot: 'copilot-instructions',
    stack: 'python',
    title: 'Python',
    summary: 'pytest, ruff, mypy, type hints, no mutable defaults.',
    body: STACK_PYTHON,
    origin: 'built-in',
  },
  {
    id: 'stack-go',
    slot: 'copilot-instructions',
    stack: 'go',
    title: 'Go',
    summary: 'go build & test, error wrapping, context first, table tests.',
    body: STACK_GO,
    origin: 'built-in',
  },
  {
    id: 'stack-node',
    slot: 'copilot-instructions',
    stack: 'node',
    title: 'TypeScript / Node',
    summary: 'npm scripts, strict TS, named exports, no any.',
    body: STACK_NODE,
    origin: 'built-in',
  },
  {
    id: 'concision',
    slot: 'claude-rule',
    title: 'Concision',
    summary: 'Cuts preambles and closing summaries, leaves code and errors untouched.',
    body: CONCISION_RULE,
    origin: 'built-in',
  },
  {
    id: 'explore-haiku',
    slot: 'agent-explore',
    title: 'Explore on Haiku',
    summary: 'Read-only search agent, pinned to the cheap model.',
    body: EXPLORE_AGENT,
    origin: 'built-in',
  },
  {
    id: 'general-sonnet',
    slot: 'agent-general',
    title: 'General-purpose on Sonnet',
    summary: 'Multi-step delegated work, pinned to the mid-tier model.',
    body: GENERAL_AGENT,
    origin: 'built-in',
  },
];

// --- Team / user entries ----------------------------------------------------

/**
 * Extra entries, read from a folder. Point it at a cloned internal repo and the whole team
 * shares the same conventions — the same self-hosted logic as the rest of the extension,
 * with no network call from here: it is a plain directory read.
 */
export function libraryPath(): string {
  const configured = vscode.workspace
    .getConfiguration('voxAiGuide')
    .get<string>('library.path')
    ?.trim();
  if (configured) {
    return configured.startsWith('~')
      ? path.join(os.homedir(), configured.slice(1))
      : configured;
  }
  return path.join(os.homedir(), '.claude', 'vox-library');
}

const SLOTS: Slot[] = ['copilot-instructions', 'claude-rule', 'agent-explore', 'agent-general'];

/**
 * Reads a `slot: …` / `title: …` / `summary: …` header from an entry. Deliberately a tiny
 * parser and not a YAML dependency: an entry is a Markdown file a human wrote by hand, and
 * a malformed one must degrade, never throw.
 */
function parseEntry(file: string): Template | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }

  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const head = m?.[1] ?? '';
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}\\s*:\\s*(.+)$`, 'mi').exec(head)?.[1]?.trim();

  const slot = field('slot') as Slot | undefined;
  if (!slot || !SLOTS.includes(slot)) {
    return undefined; // no slot: not a library entry, just a file sitting in the folder
  }

  // The slot header is ours; it must not end up in the written file. Agent entries keep
  // their own frontmatter, which Claude Code reads.
  const body = slot.startsWith('agent-') ? raw : raw.slice(m?.[0].length ?? 0);
  const name = path.basename(file, '.md');

  return {
    id: `library:${name}`,
    slot,
    title: field('title') ?? name,
    summary: field('summary') ?? 'From your library.',
    body,
    origin: 'library',
  };
}

function libraryEntries(): Template[] {
  const dir = libraryPath();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return []; // no folder configured or none cloned yet: built-ins only
  }
  return names
    .map((n) => parseEntry(path.join(dir, n)))
    .filter((t): t is Template => t !== undefined);
}

/**
 * Everything available for a slot, best first: your team's entries, then whatever matches
 * the project's stack, then the generic ones. Yours beat ours; specific beats generic.
 */
export function templatesFor(slot: Slot, workspaceRoot?: string): Template[] {
  const stack = detectStack(workspaceRoot);
  const all = [...libraryEntries(), ...BUILT_INS].filter((t) => t.slot === slot);
  const rank = (t: Template) =>
    (t.origin === 'library' ? 0 : 2) + (t.stack && t.stack === stack ? 0 : 1);
  return all
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t);
}

export function templateById(slot: Slot, id?: string, workspaceRoot?: string): Template | undefined {
  const list = templatesFor(slot, workspaceRoot);
  return list.find((t) => t.id === id) ?? list[0];
}
