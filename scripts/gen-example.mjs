#!/usr/bin/env node
// Writes examples/log-example.csv: EXAMPLE DATA (synthetic, not a real measurement).
// One day of 1-minute RMS values, 230 V line-neutral three phase, with a frequency column and:
// - a 10-minute logging gap from 03:00 (rows 03:00-03:09 missing);
// - a sag on v2 to 184 V (80%) from 09:15 for 3 minutes;
// - a supply interruption (all phases 0 V) from 14:00 for 5 minutes, frequency 48.7 Hz on the first sample back;
// - a swell on v1 to 255 V (110.87%) from 20:30 for 2 minutes.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pad = (n) => String(n).padStart(2, '0');
const rows = ['timestamp,v1,v2,v3,freq'];
for (let m = 0; m < 24 * 60; m++) {
  const h = Math.floor(m / 60);
  const mi = m % 60;
  if (h === 3 && mi < 10) continue;
  let v1 = 230 + 2 * Math.sin(m / 90);
  let v2 = 228.5 + 1.5 * Math.sin(m / 70 + 1);
  let v3 = 231.5 + 1.8 * Math.sin(m / 110 + 2);
  let f = 50 + 0.05 * Math.sin(m / 30);
  if (h === 9 && mi >= 15 && mi < 18) v2 = 184;
  if (h === 14 && mi < 5) v1 = v2 = v3 = 0;
  if (h === 14 && mi === 5) f = 48.7;
  if (h === 20 && mi >= 30 && mi < 32) v1 = 255;
  rows.push(`2026-11-02 ${pad(h)}:${pad(mi)}:00,${v1.toFixed(1)},${v2.toFixed(1)},${v3.toFixed(1)},${f.toFixed(2)}`);
}
writeFileSync(fileURLToPath(new URL('../examples/log-example.csv', import.meta.url)), `${rows.join('\n')}\n`);
