# pq-log-check

Offline CLI that turns an RMS voltage log (CSV) into a power-quality report:

- **events**: voltage sags (dips), swells and supply interruptions, with start, end, duration, depth and channel;
- **unbalance**: mean, 95th percentile and max, with a limit check;
- **voltage per channel**: min / mean / max and the share of samples inside a voltage band;
- **current unbalance** (optional): with three current columns, per-phase current and the current unbalance
  mean / 95th percentile / max, with an optional limit;
- **logging gaps** and, when the log has a frequency column, **frequency** range and samples outside a band;
- **per day**: when the log covers more than one date, a table with samples, events, min / max voltage, share in
  band, unbalance 95th percentile and frequency samples outside the band for each date.

It is meant for the logs you get from a temporary power monitor, a generator set controller or a smart meter
with 1-minute (or any interval) RMS logging, when you would otherwise build the report in a spreadsheet.
No runtime dependencies, no network, reads one local file.

## Usage

```sh
npm ci && npm run build
node dist/cli.js examples/log-example.csv --nominal 230          # text report
node dist/cli.js examples/log-example.csv --nominal 230 --md     # Markdown
node dist/cli.js examples/log-example.csv --nominal 230 --json   # JSON
node dist/cli.js feeder.csv --nominal 400 --line-to-line --columns vab,vbc,vca
```

`examples/log-example.csv` is **example data** (synthetic, made by `scripts/gen-example.mjs`): one day of 1-minute
values with a logging gap, a sag, an interruption, a swell and one off-frequency sample.

```
Events: 1 interruption, 2 sag, 1 swell
  sag          2026-11-02 09:15:00 -> 2026-11-02 09:18:00  3 min, min 184 V (80%) on v2
  interruption 2026-11-02 14:00:00 -> 2026-11-02 14:05:00  5 min, min 0 V (0%) on v1
  sag          2026-11-02 14:00:00 -> 2026-11-02 14:05:00  5 min, min 0 V (0%) on v1  [includes interruption]
  swell        2026-11-02 20:30:00 -> 2026-11-02 20:32:00  2 min, max 255 V (110.87%) on v1
...
Unbalance (NEMA phase-voltage unbalance (max deviation from average)), 1420 samples, 10 flagged left out:
  mean 0.841%, 95th percentile 1.518%, max 1.618% (2026-11-02 11:27:00); limit 2%: 0 sample(s) above, ok
```

### Input

A header row with a timestamp column and one (single phase) or three (three phase) voltage columns, default
`timestamp,v1,v2,v3`, plus an optional `freq` column in Hz (empty cells allowed). Column names are matched without
case and can be changed with `--columns`, `--time-column` and `--freq-column`. Three-phase logs can also carry
per-phase currents in A, named with `--current-columns` (not read unless given; a row with an empty current cell
counts as missing for current only). Timestamps are ISO 8601
(`2026-11-12 14:05:00`, `2026-11-12T14:05:00+08:00`), in time order, all with or all without a zone offset.
Any problem is reported with its row number (exit 2).

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--nominal <V>` | required | nominal voltage, line-neutral unless `--line-to-line` |
| `--line-to-line` | off | voltage columns are line-line values |
| `--sag <pct>` | 90 | sag threshold, % of nominal |
| `--swell <pct>` | 110 | swell threshold, % of nominal |
| `--interruption <pct>` | 10 | interruption threshold, % of nominal |
| `--hysteresis <pct>` | 2 | hysteresis, % of nominal |
| `--band-low <pct>` / `--band-high <pct>` | 10 / 10 | voltage band, % below / above nominal |
| `--unbalance-limit <pct>` | 2 | limit for the 95th percentile of unbalance |
| `--freq-nominal <Hz>` / `--freq-tolerance <Hz>` | 50 / 1 | frequency band |
| `--current-columns <a,b,c>` | none | three current columns (A); adds current unbalance |
| `--current-min <A>` | 0 | current unbalance leaves out samples with average current below this |
| `--current-unbalance-limit <pct>` | none | limit for the 95th percentile of current unbalance; without it current unbalance is report only |

The defaults are common values, **not a compliance verdict**: set the limits that apply to your supply and contract.
The tool ships no standard limit tables.

Exit codes: `0` no findings, `1` findings (any event, unbalance 95th percentile over the limit, current unbalance
95th percentile over `--current-unbalance-limit` when given, frequency outside the band), `2` input error.

## How it works

**Events** use IEC 61000-4-30 style polyphase rules, applied to the logged values:

- a **sag** starts when any channel is below the sag threshold and ends at the first sample where every channel is at
  or above threshold + hysteresis;
- a **swell** starts when any channel is above the swell threshold and ends when every channel is at or below
  threshold - hysteresis;
- an **interruption** starts when every channel is below the interruption threshold and ends when any channel is at or
  above threshold + hysteresis. An interruption is also a sag; that sag is marked "includes interruption" so it is
  not counted twice by mistake.

Duration is from the first sample past the threshold to the first sample back inside, so it is only as exact as the
logging interval (+/- one interval), and a log of 1-minute RMS values can miss events shorter than that. An event
still open at the end of the log has no end. An event with a logging gap inside it is marked.

**Logging gaps** are steps longer than 1.5 x the median step.

**Unbalance** leaves out samples taken while a sag, swell or interruption was in progress (the "flagging" idea of
IEC 61000-4-30):

- line-line values (`--line-to-line`): the exact negative-sequence unbalance u2 = |V2| / |V1| from the three
  magnitudes, `beta = (a^4 + b^4 + c^4) / (a^2 + b^2 + c^2)^2`, `u2 = sqrt((1 - sqrt(3 - 6 beta)) / (1 + sqrt(3 - 6 beta)))`;
  the tests check it against symmetrical components computed from phasors;
- line-neutral values: line-neutral magnitudes cannot give u2 without phase angles, so the NEMA phase-voltage
  unbalance is used: the largest deviation from the average, over the average.

The 95th percentile is nearest-rank. Note that supply standards usually state unbalance limits on 10-minute
aggregates; with another logging interval the figure is indicative.

**Current unbalance** (with `--current-columns`) is the largest deviation of a phase current from the average of
the three, over the average, per sample (the same max-deviation form as the NEMA voltage figure). It leaves out
flagged samples (as for voltage unbalance), rows with an empty current cell, and low-load samples whose average
current is zero or below `--current-min`: at light load a few amperes of single-phase load give large percentages
that say little. Per-phase min / mean / max use every row with all three currents. There is no standard current
unbalance limit, so it is a finding only when you give `--current-unbalance-limit`.

**Event durations** count each event type in three buckets: shorter than 1 minute, 1 to under 10 minutes, and
10 minutes or longer (`durationBuckets` in JSON; the text and Markdown reports show the table when there are events).
An event still open at the end of the log is counted by its duration so far and also in the `open` column.
Durations come from logged samples, so they are accurate to about one logging interval.

**Voltage per channel** statistics use all samples, including events.

**Per day** rows use the calendar date as written in the timestamps (the logger's local date, also for timestamps
with a zone offset). An event is counted on the day it starts, so an event across midnight appears once. The daily
unbalance 95th percentile uses that day's unflagged samples (`-` when there are none); min / max and the share in
band cover all channels. The text and Markdown reports show the table only for logs that span more than one date;
the JSON report always has `days`.

## Development

```sh
npm ci
npm run check     # lint, typecheck, tests
npm run build
npm run smoke     # built CLI end to end, incl. a one-year 1-minute log
```

## Not included

Waveform analysis, harmonics, flicker, vendor-specific export formats (need real sample files), standard limit tables.
