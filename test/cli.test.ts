import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { root } from './helpers.js';

const example = join(root, 'examples', 'log-example.csv');
let out = '';
let err = '';

beforeEach(() => {
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const tmp = (name: string, text: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'pq-cli-')), name);
  writeFileSync(path, text);
  return path;
};

describe('cli', () => {
  it('reports the example events, gap and frequency finding (exit 1)', () => {
    expect(main([example, '--nominal', '230'])).toBe(1);
    expect(out).toContain('Events: 1 interruption, 2 sag, 1 swell');
    expect(out).toContain('sag          2026-11-02 09:15:00 -> 2026-11-02 09:18:00  3 min, min 184 V (80%) on v2');
    expect(out).toContain('2026-11-02 02:59:00 -> 2026-11-02 03:10:00 (11 min)');
    expect(out).toContain('Findings: 1 interruption(s), 2 sag(s), 1 swell(s), 1 frequency sample(s) outside 49-51 Hz');
    expect(out).toContain('Event durations (open events are counted by their duration so far):');
    expect(out).toMatch(/Type {10}< 1 min {2}1-10 min {2}>= 10 min {2}Open/);
    expect(out).toMatch(/\n {2}sag +0 +2 +0 +0\n/);
  });

  it('JSON and Markdown outputs', () => {
    expect(main([example, '--nominal', '230', '--json'])).toBe(1);
    const data = JSON.parse(out);
    expect(data.eventCounts).toEqual({ sag: 2, swell: 1, interruption: 1, sagWithInterruption: 1 });
    expect(data.unbalance).toMatchObject({ samples: 1420, flaggedSamples: 10, overLimit: false });
    out = '';
    expect(main([example, '--nominal', '230', '--md'])).toBe(1);
    expect(out).toContain('| interruption | 2026-11-02 14:00:00 | 2026-11-02 14:05:00 | 5 min | 0 V (0%) | v1 |  |');
    expect(out).toContain('## Logging gaps');
    expect(out).toContain('| Type | < 1 min | 1-10 min | >= 10 min | Open |');
    expect(out).toContain('| interruption | 0 | 1 | 0 | 0 |');
    expect(data.durationBuckets.sag).toEqual({ under1Min: 0, from1To10Min: 2, atLeast10Min: 0, open: 0 });
  });

  it('exit 0 on a clean log, options change thresholds and columns', () => {
    const log = tmp('clean.csv', 'time,L1\n2026-01-01 00:00,230\n2026-01-01 00:01,216\n');
    expect(main([log, '--nominal', '230', '--columns', 'L1', '--time-column', 'time'])).toBe(0);
    expect(out).not.toContain('Event durations');
    expect(out).toContain('Findings: none');
    expect(main([log, '--nominal', '230', '--columns', 'L1', '--time-column', 'time', '--sag', '95', '--hysteresis', '1'])).toBe(1);
  });

  it('per-day table in text and Markdown only when the log spans more than one date', () => {
    expect(main([example, '--nominal', '230'])).toBe(1);
    expect(out).not.toContain('Per day');
    out = '';
    const log = tmp(
      'days.csv',
      'timestamp,v1,v2,v3,freq\n' +
        '2026-01-01T23:00:00+08:00,230,230,230,50\n2026-01-01T23:30:00+08:00,230,200,230,50\n' +
        '2026-01-02T00:00:00+08:00,230,230,230,52\n2026-01-02T00:30:00+08:00,230,230,230,50\n',
    );
    expect(main([log, '--nominal', '230'])).toBe(1);
    expect(out).toContain('Per day (events counted on the day they start):');
    expect(out).toMatch(/Date {8}Samples {2}Interr\. {2}Sags {2}Swells {2}Min V {2}Max V {2}In band {2}Unbal\. p95 {2}Freq out/);
    // dates are the logger's local dates as written, not UTC (23:30+08:00 is 15:30 UTC the same day)
    expect(out).toMatch(/2026-01-01 +2 +0 +1 +0 +200 +230 +83\.33% +0% +0/);
    expect(out).toMatch(/2026-01-02 +2 +0 +0 +0 +230 +230 +100% +0% +1/);
    out = '';
    expect(main([log, '--nominal', '230', '--md'])).toBe(1);
    expect(out).toContain('| Date | Samples | Interr. | Sags | Swells | Min V | Max V | In band | Unbal. p95 | Freq out |');
    expect(out).toContain('| 2026-01-02 | 2 | 0 | 0 | 0 | 230 | 230 | 100% | 0% | 1 |');
    out = '';
    expect(main([log, '--nominal', '230', '--json'])).toBe(1);
    expect(JSON.parse(out).days.map((d: { date: string }) => d.date)).toEqual(['2026-01-01', '2026-01-02']);
  });

  it('input errors exit 2 with a message', () => {
    const cases: [string[], RegExp][] = [
      [[], /Give a log CSV/],
      [[example, example, '--nominal', '230'], /exactly one/],
      [[example], /--nominal <volts> is required/],
      [[example, '--nominal', 'x'], /--nominal must be a number/],
      [[example, '--nominal', '230', '--json', '--md'], /either --json or --md/],
      [[example, '--nominal', '230', '--sag', '120'], /Thresholds/],
      [[example, '--nominal', '230', '--columns', 'a,b'], /one voltage column/],
      [[join(root, 'nope.csv'), '--nominal', '230'], /Cannot read log .*ENOENT/],
      [[example, '--nominal', '230', '--bogus'], /Unknown option/],
    ];
    for (const [args, message] of cases) {
      err = '';
      expect(main(args), args.join(' ')).toBe(2);
      expect(err).toMatch(message);
    }
  });

  it('prints help', () => {
    expect(main(['--help'])).toBe(0);
    expect(out).toContain('Usage: pq-log-check');
  });

  it('current unbalance from --current-columns in text, Markdown and JSON', () => {
    const rows = ['timestamp,v1,v2,v3,i1,i2,i3'];
    for (let m = 0; m < 10; m++) rows.push(`2026-01-01 00:0${m},230,230,230,${m < 5 ? '100,100,100' : '110,100,90'}`);
    const log = tmp('amps.csv', `${rows.join('\n')}\n`);
    expect(main([log, '--nominal', '230', '--current-columns', 'i1,i2,i3'])).toBe(0);
    expect(out).toContain('Current unbalance (max deviation from average current), 10 samples; left out: 0 flagged, 0 low load');
    expect(out).toContain('i1: min 100 A, mean 105 A, max 110 A');
    expect(out).toContain('95th percentile 10%, max 10% (2026-01-01 00:05); no limit given (report only)');
    out = '';
    expect(main([log, '--nominal', '230', '--current-columns', 'i1,i2,i3', '--current-unbalance-limit', '8', '--md'])).toBe(1);
    expect(out).toContain('## Current unbalance');
    expect(out).toContain('| 5% | 10% | 10% | 8% | 5 | over limit |');
    expect(out).toContain('- current unbalance 95th percentile 10% > 8%');
    out = '';
    expect(main([log, '--nominal', '230', '--current-columns', 'i1,i2,i3', '--current-min', '200', '--json'])).toBe(0);
    expect(JSON.parse(out).current).toMatchObject({ samples: 0, lowLoadSamples: 10, minAverageA: 200 });
    expect(main([log, '--nominal', '230', '--current-min', '5'])).toBe(2);
    expect(err).toContain('need --current-columns');
  });
});
