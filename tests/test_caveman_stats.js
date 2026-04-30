#!/usr/bin/env node
// Tests for /caveman-stats — direct script invocation and via mode tracker.
// Run: node tests/test_caveman_stats.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATS = path.join(ROOT, 'hooks', 'caveman-stats.js');
const TRACKER = path.join(ROOT, 'hooks', 'caveman-mode-tracker.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-stats-test-'));
  try {
    fn(tmp);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function makeSession(dir, lines) {
  const projDir = path.join(dir, '.claude', 'projects', 'p');
  fs.mkdirSync(projDir, { recursive: true });
  const sessFile = path.join(projDir, 's.jsonl');
  fs.writeFileSync(sessFile, lines.map(l => JSON.stringify(l)).join('\n'));
  return sessFile;
}

console.log('caveman-stats tests\n');

test('reads --session-file directly and sums output tokens', (tmp) => {
  const sess = makeSession(tmp, [
    { type: 'assistant', message: { usage: { output_tokens: 100, cache_read_input_tokens: 200 } } },
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { usage: { output_tokens: 50, cache_read_input_tokens: 50 } } },
  ]);
  const out = execFileSync(process.execPath, [STATS, '--session-file', sess], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, '.claude') },
  });
  assert.match(out, /Turns:\s+2/);
  assert.match(out, /Output tokens:\s+150/);
  assert.match(out, /Cache-read tokens:\s+250/);
});

test('shows full-mode savings estimate when flag is full', (tmp) => {
  const sess = makeSession(tmp, [
    { type: 'assistant', message: { usage: { output_tokens: 350 } } },
  ]);
  const claudeDir = path.join(tmp, '.claude');
  fs.writeFileSync(path.join(claudeDir, '.caveman-active'), 'full');
  const out = execFileSync(process.execPath, [STATS, '--session-file', sess], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
  });
  // 350 / 0.35 = 1000, saved = 650, ~65%
  assert.match(out, /Est\. without caveman:\s+1,000/);
  assert.match(out, /Est\. tokens saved:\s+650 \(~65%\)/);
});

test('skips estimate for non-full modes', (tmp) => {
  const sess = makeSession(tmp, [
    { type: 'assistant', message: { usage: { output_tokens: 100 } } },
  ]);
  const claudeDir = path.join(tmp, '.claude');
  fs.writeFileSync(path.join(claudeDir, '.caveman-active'), 'ultra');
  const out = execFileSync(process.execPath, [STATS, '--session-file', sess], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
  });
  assert.match(out, /No savings estimate for 'ultra' mode/);
});

test('reports no-session when no .jsonl exists', (tmp) => {
  fs.mkdirSync(path.join(tmp, '.claude', 'projects'), { recursive: true });
  let err = null;
  try {
    execFileSync(process.execPath, [STATS], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, '.claude') },
    });
  } catch (e) { err = e; }
  assert.ok(err, 'should exit non-zero');
  assert.match(err.stderr, /no Claude Code session found/);
});

test('mode tracker handles /caveman-stats with decision block', (tmp) => {
  const sess = makeSession(tmp, [
    { type: 'assistant', message: { usage: { output_tokens: 100 } } },
  ]);
  const claudeDir = path.join(tmp, '.claude');
  fs.writeFileSync(path.join(claudeDir, '.caveman-active'), 'full');
  const out = execFileSync(process.execPath, [TRACKER], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, HOME: tmp },
    input: JSON.stringify({ prompt: '/caveman-stats', transcript_path: sess }),
  });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.decision, 'block');
  assert.match(parsed.reason, /Caveman Stats/);
  assert.match(parsed.reason, /Output tokens:\s+100/);
});

test('mode tracker preserves caveman flag when /caveman-stats fires', (tmp) => {
  const sess = makeSession(tmp, [
    { type: 'assistant', message: { usage: { output_tokens: 50 } } },
  ]);
  const claudeDir = path.join(tmp, '.claude');
  fs.writeFileSync(path.join(claudeDir, '.caveman-active'), 'full');
  execFileSync(process.execPath, [TRACKER], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, HOME: tmp },
    input: JSON.stringify({ prompt: '/caveman-stats', transcript_path: sess }),
  });
  // The flag must still say 'full' — the stats command must not change mode.
  assert.strictEqual(fs.readFileSync(path.join(claudeDir, '.caveman-active'), 'utf8'), 'full');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
