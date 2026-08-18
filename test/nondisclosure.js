// The non-disclosure invariant, as an executable guarantee.
//
// `Finding` must never carry a secret's value — the webview renders findings, and a webview
// ends up in screenshots, shared sessions, or the context of an agent asked to read it back.
// This test plants invented secrets in a throwaway workspace, runs the real scanner, and
// fails if any planted value survives anywhere in the serialized findings.
//
// The values are generated at runtime and never real. The test also fails if the detector
// stops detecting: an invariant proven on zero findings proves nothing.
//
// Run with: npm test   (plain node, no framework, no vscode dependency)

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanSecrets } = require('../out/secrets.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-nondisclosure-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// Invented at runtime so no fixture file ever contains a secret-shaped string.
const rand = (n) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const planted = {
  githubToken: 'ghp_' + rand(36),
  anthropicKey: 'sk-ant-api03-' + rand(48),
  // Not @example.org: documentation domains are excluded by design, and rightly so.
  email: `${rand(8)}.${rand(6)}@${rand(8)}.be`,
};

fs.mkdirSync(path.join(tmp, '.vscode'), { recursive: true });
fs.writeFileSync(
  path.join(tmp, '.vscode', 'settings.json'),
  JSON.stringify({ 'claudeCode.environmentVariables': { GITHUB_TOKEN: planted.githubToken } }, null, 2),
);
fs.writeFileSync(
  path.join(tmp, 'CLAUDE.md'),
  // One secret per line: the line scanner reports a single hit per line by design.
  `# Test\n\nUse key ${planted.anthropicKey}\nand write to ${planted.email}.\n`,
);

const findings = scanSecrets(tmp);
const mine = findings.filter((f) => f.file.startsWith(tmp));

// 1. The detector still detects — otherwise the invariant below is vacuously true.
assert.ok(
  mine.length >= 3,
  `expected the 3 planted secrets to be found, got ${mine.length}: ${JSON.stringify(mine, null, 2)}`,
);
assert.ok(mine.some((f) => f.kind === 'credential'), 'no credential finding for planted tokens');
assert.ok(mine.some((f) => f.kind === 'personal'), 'no personal finding for planted email');

// 2. The invariant: no planted value, whole or in part, anywhere in the serialization.
//    Substrings of length 8 catch a truncated or "preview" leak, not just a verbatim one.
const serialized = JSON.stringify(findings);
for (const [name, value] of Object.entries(planted)) {
  assert.ok(!serialized.includes(value), `finding leaks the full ${name}`);
  for (let i = 0; i + 8 <= value.length; i += 4) {
    assert.ok(!serialized.includes(value.slice(i, i + 8)), `finding leaks a fragment of ${name}`);
  }
}

console.log(`non-disclosure OK — ${mine.length} findings on planted secrets, zero value fragments in output`);
