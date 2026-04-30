#!/usr/bin/env node
// caveman-stats — read the active Claude Code session log, print real token
// usage plus an estimated savings figure from the benchmark in benchmarks/.
//
// Run directly:    node hooks/caveman-stats.js
// Inside Claude:   /caveman-stats triggers this via the UserPromptSubmit hook.
// Hook integration passes --session-file <transcript_path> so we always read
// the active session, not whichever JSONL was modified most recently.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readFlag } = require('./caveman-config');

// Mean per-task savings from benchmarks/results/*.json (avg_savings: 65 across
// 10 tasks, sonnet-4-20250514). Only 'full' has measured data; lite/ultra/
// wenyan modes show no estimate.
const COMPRESSION = { 'full': 0.65 };

function findRecentSession(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  let entries;
  try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); }
  catch { return null; }

  let best = null;
  const stack = entries.map(e => path.join(projectsDir, e.name));
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      try {
        for (const child of fs.readdirSync(p)) stack.push(path.join(p, child));
      } catch {}
    } else if (p.endsWith('.jsonl') && (!best || st.mtimeMs > best.mtime)) {
      best = { file: p, mtime: st.mtimeMs };
    }
  }
  return best ? best.file : null;
}

function parseSession(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { outputTokens: 0, cacheReadTokens: 0, turns: 0 }; }

  let outputTokens = 0;
  let cacheReadTokens = 0;
  let turns = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const usage = entry.type === 'assistant' && entry.message && entry.message.usage;
    if (!usage) continue;
    outputTokens    += usage.output_tokens           || 0;
    cacheReadTokens += usage.cache_read_input_tokens || 0;
    turns++;
  }
  return { outputTokens, cacheReadTokens, turns };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--session-file');
  const sessionFileArg = i !== -1 ? args[i + 1] : null;

  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const sessionFile = sessionFileArg || findRecentSession(claudeDir);

  if (!sessionFile) {
    process.stderr.write('caveman-stats: no Claude Code session found.\n');
    process.exit(1);
  }

  const { outputTokens, cacheReadTokens, turns } = parseSession(sessionFile);
  const mode = readFlag(path.join(claudeDir, '.caveman-active'));
  const ratio = COMPRESSION[mode] != null ? COMPRESSION[mode] : null;
  const sep = '──────────────────────────────────';
  const shortPath = sessionFile.length > 45 ? '...' + sessionFile.slice(-45) : sessionFile;

  if (turns === 0) {
    process.stdout.write(`\nCaveman Stats\n${sep}\nNo conversation yet — stats available after first response.\n${sep}\n`);
    return;
  }

  let savings;
  let footer = '';
  if (ratio !== null) {
    const estNormal = Math.round(outputTokens / (1 - ratio));
    const estSaved = estNormal - outputTokens;
    savings = `Est. without caveman:  ${estNormal.toLocaleString()}\n` +
              `Est. tokens saved:     ${estSaved.toLocaleString()} (~${Math.round(ratio * 100)}%)`;
    footer = 'Savings est. from benchmarks/ (mean per-task). Actual varies by task.';
  } else if (mode && mode !== 'off') {
    savings = `No savings estimate for '${mode}' mode — only 'full' has benchmark data.`;
  } else {
    savings = 'Caveman not active this session.';
  }

  process.stdout.write(
    `\nCaveman Stats\n${sep}\n` +
    `Session:  ${shortPath}\n` +
    `Turns:    ${turns}\n${sep}\n` +
    `Output tokens:         ${outputTokens.toLocaleString()}\n` +
    `Cache-read tokens:     ${cacheReadTokens.toLocaleString()}\n${sep}\n` +
    `${savings}\n` +
    (footer ? footer + '\n' : '')
  );
}

main();
