/**
 * Deleting is the only act in this extension that touches the user's data rather than their
 * settings, and a conversation log has no second copy. So the guards are tested, not trusted:
 * each case below is one way the cleanup could destroy something it was never asked to.
 *
 * Everything runs against a throwaway tree under the real archive root — the guards match on
 * that location, so testing them anywhere else would prove nothing.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deleteArchives, groupForCleanup, humanBytes } = require('../out/cleanup.js');

const sandbox = path.join(os.homedir(), '.claude', 'projects', '-vox-cleanup-test');
fs.mkdirSync(sandbox, { recursive: true });

const write = (name, bytes) => {
  const file = path.join(sandbox, name);
  fs.writeFileSync(file, 'x'.repeat(bytes));
  return file;
};
const conv = (file, extra = {}) => ({
  tool: 'Claude',
  id: path.basename(String(file), '.jsonl'),
  label: path.basename(String(file)),
  contextTokens: 1,
  lastActivity: new Date(),
  file,
  bytes: file ? fs.statSync(file).size : 0,
  ...extra,
});

// The removal the extension performs is VSCode's trash API, which does not exist outside
// VSCode. The caller supplies it, so the test supplies an equivalent and records the calls.
const removed = [];
const remove = async (file) => {
  removed.push(file);
  fs.rmSync(file, { recursive: true, force: true });
};

async function main() {
  const doomed = write('doomed.jsonl', 2048);
  const live = write('live.jsonl', 1024);
  const outside = path.join(os.tmpdir(), 'vox-outside.jsonl');
  fs.writeFileSync(outside, 'x');

  // A sub-agent folder belongs to its chat and must go with it, not linger orphaned.
  const subagents = path.join(sandbox, 'doomed', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, 'a.jsonl'), 'x');

  const result = await deleteArchives(
    [conv(doomed), conv(live), conv(outside), conv(undefined, { tool: 'Codex' })],
    { protect: live, remove },
  );

  assert.strictEqual(result.deleted, 1, 'only the selected archive is removed');
  assert.strictEqual(result.failed.length, 0, 'a guarded run reports no failure');
  assert.ok(!fs.existsSync(doomed), 'the selected archive is gone');
  assert.ok(!fs.existsSync(path.join(sandbox, 'doomed')), 'its sub-agent folder went with it');
  assert.ok(fs.existsSync(live), 'the running conversation is untouched');
  assert.ok(fs.existsSync(outside), 'a path outside the archive roots is never touched');

  const reasons = result.skipped.map((s) => s.reason).join(' | ');
  assert.match(reasons, /running right now/, 'the live session is spared, and says so');
  assert.match(reasons, /outside the known archive/, 'foreign paths are spared, and say so');
  assert.match(reasons, /no file/, 'a conversation with no file is spared, and says so');

  // Reported bytes are the bytes that actually left the disk.
  assert.strictEqual(result.bytes, 2048, 'freed bytes are measured, not estimated');

  // A removal that silently does nothing must be reported as a failure, never as a success.
  const stubborn = write('stubborn.jsonl', 16);
  const noop = await deleteArchives([conv(stubborn)], { remove: async () => {} });
  assert.strictEqual(noop.deleted, 0, 'a file still on disk is not counted as deleted');
  assert.strictEqual(noop.failed.length, 1, 'it is reported as a failure');

  // Grouping puts vanished folders first, then the heaviest.
  const groups = groupForCleanup([
    conv(stubborn, { project: '/nowhere', projectMissing: true, bytes: 1 }),
    conv(stubborn, { project: '/here', bytes: 999 }),
  ]);
  assert.strictEqual(groups[0].project, '/nowhere', 'vanished folders come first');
  assert.strictEqual(humanBytes(2048), '2.0 kB');

  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
  console.log('cleanup OK — guards hold: live session, foreign paths and no-op removals all refused');
}

main().catch((e) => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
