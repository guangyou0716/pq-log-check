#!/usr/bin/env node
// End-to-end check of the built CLI (dist/cli.js), run directly and through a symlink like an npm bin.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const example = join(root, 'examples', 'log-example.csv');
const fail = (message) => {
  console.error(`smoke: FAIL ${message}`);
  process.exit(1);
};
const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

const dir = mkdtempSync(join(tmpdir(), 'pq-smoke-'));
const link = join(dir, 'pq-log-check');
symlinkSync(cli, link);
for (const bin of [cli, link]) {
  const res = run(bin, [example, '--nominal', '230', '--json']);
  const data = res.stdout ? JSON.parse(res.stdout) : {};
  const c = data.eventCounts ?? {};
  if (res.status !== 1 || c.sag !== 2 || c.swell !== 1 || c.interruption !== 1 || data.coverage?.gaps?.length !== 1) {
    fail(`example via ${bin}: status ${res.status} ${JSON.stringify(c)} ${res.stderr}`);
  }
}
console.log('smoke: ok example (direct and via symlink) 1 interruption, 2 sags, 1 swell, 1 gap, exit 1');

// One year of 1-minute three-phase line-line samples (525,600 rows), balanced except one sag.
const rows = ['timestamp,vab,vbc,vca,freq'];
const base = Date.UTC(2026, 0, 1);
for (let i = 0; i < 525600; i++) {
  const t = new Date(base + i * 60000).toISOString().slice(0, 19);
  const dip = i >= 100000 && i < 100003 ? 300 : 400;
  rows.push(`${t}Z,${dip},${400 + (i % 3)},${401 - (i % 2)},${50 + (i % 5) / 100}`);
}
const big = join(dir, 'year.csv');
writeFileSync(big, `${rows.join('\n')}\n`);
const started = Date.now();
const res = run(cli, [big, '--nominal', '400', '--line-to-line', '--columns', 'vab,vbc,vca', '--json']);
const data = res.stdout ? JSON.parse(res.stdout) : {};
if (res.status !== 1 || data.events?.length !== 1 || data.events[0].durationS !== 180 || data.unbalance?.overLimit !== false || data.frequency?.max !== 50.04) {
  fail(`year log: status ${res.status} ${JSON.stringify(data.eventCounts)} ${res.stderr}`);
}
console.log(`smoke: ok one-year 1-min line-line log (525600 rows) in ${Date.now() - started} ms, 1 sag of 180 s`);

const bad = run(cli, [example]);
if (bad.status !== 2 || !bad.stderr.includes('--nominal')) {
  fail(`missing nominal: status ${bad.status} ${bad.stderr}`);
}
console.log('smoke: ok missing --nominal -> exit 2');
