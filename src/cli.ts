#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyze } from './analyze.js';
import { InputError } from './errors.js';
import { parseLog } from './log.js';
import { jsonReport, markdownReport, textReport } from './report.js';

const USAGE = `Usage: pq-log-check <log.csv> --nominal <volts> [options]

Power-quality report from an RMS voltage log: sags (dips), swells and interruptions with start, duration and depth;
voltage unbalance; voltage range per channel; logging gaps; frequency range when the log has a frequency column.
Offline; reads one local file.

log.csv: a header row with a timestamp column and one (single phase) or three (three phase) voltage columns,
default "timestamp,v1,v2,v3", plus an optional "freq" column in Hz. Timestamps ISO 8601
(2026-11-12 14:05:00 or 2026-11-12T14:05:00+08:00), in time order.

Events follow IEC 61000-4-30 style polyphase rules on the logged values: a sag starts when any channel falls below
the sag threshold and ends when every channel is back at threshold + hysteresis; swells mirror this; an
interruption starts when every channel is below the interruption threshold and ends when any channel is back at
threshold + hysteresis. A log of 1-minute RMS values can miss short events, and durations are +/- one interval.
Unbalance leaves out samples taken while an event was in progress.

Options:
  --nominal <V>           nominal voltage (required); line-neutral unless --line-to-line
  --line-to-line          the voltage columns are line-line (exact negative-sequence unbalance)
  --columns <a,b,c>       voltage column names (default v1,v2,v3; give one name for single phase)
  --time-column <name>    timestamp column (default timestamp)
  --freq-column <name>    frequency column, used when present (default freq)
  --sag <pct>             sag threshold, % of nominal (default 90)
  --swell <pct>           swell threshold, % of nominal (default 110)
  --interruption <pct>    interruption threshold, % of nominal (default 10)
  --hysteresis <pct>      hysteresis, % of nominal (default 2)
  --band-low <pct>        voltage band lower edge, % below nominal (default 10)
  --band-high <pct>       voltage band upper edge, % above nominal (default 10)
  --unbalance-limit <pct> limit for the 95th percentile of unbalance (default 2)
  --freq-nominal <Hz>     nominal frequency (default 50)
  --freq-tolerance <Hz>   allowed frequency deviation (default 1)
  --json                  JSON report
  --md                    Markdown report
  -h, --help              show this help

The defaults are common values, not a compliance verdict: set the limits that apply to your supply.
Exit codes: 0 no findings, 1 findings (any event, unbalance over limit, frequency outside band), 2 input error.
`;

function number(text: string | undefined, flag: string): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value)) {
    throw new InputError(`${flag} must be a number.`);
  }
  return value;
}

export function main(argv: string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        nominal: { type: 'string' },
        'line-to-line': { type: 'boolean', default: false },
        columns: { type: 'string' },
        'time-column': { type: 'string' },
        'freq-column': { type: 'string' },
        sag: { type: 'string' },
        swell: { type: 'string' },
        interruption: { type: 'string' },
        hysteresis: { type: 'string' },
        'band-low': { type: 'string' },
        'band-high': { type: 'string' },
        'unbalance-limit': { type: 'string' },
        'freq-nominal': { type: 'string' },
        'freq-tolerance': { type: 'string' },
        json: { type: 'boolean', default: false },
        md: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (positionals.length !== 1) {
      throw new InputError(positionals.length ? 'Give exactly one log CSV.' : 'Give a log CSV.');
    }
    if (values.json && values.md) {
      throw new InputError('Use either --json or --md, not both.');
    }
    const nominal = number(values.nominal, '--nominal');
    if (nominal === undefined) {
      throw new InputError('--nominal <volts> is required (for example --nominal 230).');
    }
    let text: string;
    try {
      text = readFileSync(positionals[0], 'utf8');
    } catch (e) {
      throw new InputError(`Cannot read log ${positionals[0]}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    }
    const log = parseLog(text, {
      voltColumns: values.columns?.split(',').map((c) => c.trim()),
      timeColumn: values['time-column'],
      freqColumn: values['freq-column'],
    });
    const report = analyze(log, {
      nominal,
      lineToLine: values['line-to-line'],
      sagPct: number(values.sag, '--sag'),
      swellPct: number(values.swell, '--swell'),
      interruptPct: number(values.interruption, '--interruption'),
      hysteresisPct: number(values.hysteresis, '--hysteresis'),
      bandLowPct: number(values['band-low'], '--band-low'),
      bandHighPct: number(values['band-high'], '--band-high'),
      unbalanceLimitPct: number(values['unbalance-limit'], '--unbalance-limit'),
      freqNominal: number(values['freq-nominal'], '--freq-nominal'),
      freqToleranceHz: number(values['freq-tolerance'], '--freq-tolerance'),
    });
    process.stdout.write(values.json ? jsonReport(report) : values.md ? markdownReport(report) : textReport(report));
    return report.findings.length ? 1 : 0;
  } catch (e) {
    if (e instanceof InputError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`pq-log-check: ${(e as Error).message}\n`);
      return 2;
    }
    throw e;
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
