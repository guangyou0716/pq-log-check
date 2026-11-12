import { describe, expect, it } from 'vitest';
import { analyze, bucketDurations, negativeSequenceUnbalance, nemaUnbalance, resolveSettings } from '../src/analyze.js';
import { makeLog, ok } from './helpers.js';

const s = { nominal: 230 };

describe('events (polyphase rules)', () => {
  it('a sag starts when one channel drops and ends when all are back above threshold + hysteresis', () => {
    // sag threshold 207 V, end needs >= 211.6 V on every channel
    const log = makeLog([ok, [230, 200, 230], [230, 190, 230], [230, 209, 230], [230, 212, 230], ok]);
    const r = analyze(log, s);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      type: 'sag',
      start: '2026-01-01 00:01:00',
      end: '2026-01-01 00:04:00',
      durationS: 180,
      extremeV: 190,
      extremePct: 82.61,
      channel: 'v2',
      samples: 3,
      spansGap: false,
      containsInterruption: false,
    });
    expect(r.findings[0]).toBe('1 sag(s)'); // the recovery sample (212 V) is not flagged, so it counts for unbalance
  });

  it('exactly at the threshold is not a sag; exactly at threshold + hysteresis ends it', () => {
    expect(analyze(makeLog([[207, 207, 207]]), s).events).toHaveLength(0);
    const r = analyze(makeLog([[206.9, 230, 230], [211.6, 230, 230]]), s);
    expect(r.events[0].end).toBe('2026-01-01 00:01:00');
  });

  it('overlapping dips on different channels are one sag; the deepest channel is reported', () => {
    const log = makeLog([[200, 230, 230], [230, 195, 230], [230, 230, 205], ok]);
    const r = analyze(log, s);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ durationS: 180, extremeV: 195, channel: 'v2' });
  });

  it('a swell mirrors the sag rule', () => {
    // swell > 253 V, end needs <= 248.4 V on every channel
    const log = makeLog([ok, [255, 230, 230], [250, 260, 230], [248.4, 230, 230]]);
    const r = analyze(log, s);
    expect(r.events).toEqual([
      expect.objectContaining({ type: 'swell', durationS: 120, extremeV: 260, channel: 'v2', samples: 2 }),
    ]);
    expect(r.events[0].containsInterruption).toBeUndefined();
  });

  it('an interruption needs every channel below 10% and ends when any channel recovers past hysteresis', () => {
    // interruption < 23 V, ends when any channel >= 27.6 V
    const log = makeLog([ok, [0, 0, 0], [5, 20, 25], [27.6, 0, 0], ok]);
    const r = analyze(log, s);
    const int = r.events.filter((e) => e.type === 'interruption');
    expect(int).toEqual([expect.objectContaining({ start: '2026-01-01 00:01:00', end: '2026-01-01 00:03:00', samples: 2 })]);
    // 25 V is not below 23 V, but it is also under 23 + 4.6 V, so the interruption stays open until 27.6 V.
    expect(r.eventCounts).toEqual({ sag: 1, swell: 0, interruption: 1, sagWithInterruption: 1 });
    expect(r.events[0].type).toBe('interruption');
    expect(r.events[1]).toMatchObject({ type: 'sag', containsInterruption: true, durationS: 180 });
  });

  it('one dead phase is a sag, not an interruption', () => {
    const r = analyze(makeLog([[0, 230, 230], ok]), s);
    expect(r.eventCounts).toEqual({ sag: 1, swell: 0, interruption: 0, sagWithInterruption: 0 });
  });

  it('an event still open at the end has end null and runs to the last sample', () => {
    const r = analyze(makeLog([ok, [200, 230, 230], [200, 230, 230], [200, 230, 230]]), s);
    expect(r.events[0]).toMatchObject({ end: null, durationS: 120, samples: 3 });
  });

  it('a sag and a swell can be in progress at the same time', () => {
    const r = analyze(makeLog([[200, 260, 230], ok]), s);
    expect(r.events.map((e) => e.type)).toEqual(['sag', 'swell']);
  });

  it('marks an event with a logging gap inside and lists gaps', () => {
    // samples at minutes 0,1,2, then 13,14 (minutes 3-12 missing)
    const log = makeLog([ok, [200, 230, 230], [200, 230, 230], [200, 230, 230], ok], { skip: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
    const r = analyze(log, s);
    expect(r.coverage.gaps).toEqual([{ after: '2026-01-01 00:02:00', before: '2026-01-01 00:13:00', seconds: 660 }]);
    expect(r.coverage.medianIntervalS).toBe(60);
    expect(r.events[0]).toMatchObject({ spansGap: true, durationS: 780 });
  });

  it('works on a single-phase log (no unbalance) and with custom thresholds', () => {
    const log = makeLog([[230], [215], [230]]);
    expect(analyze(log, s).events).toHaveLength(0);
    const r = analyze(log, { nominal: 230, sagPct: 95, hysteresisPct: 1 });
    expect(r.events).toEqual([expect.objectContaining({ type: 'sag', channel: 'v', extremeV: 215 })]);
    expect(r.unbalance).toBeNull();
    expect(r.phases).toBe(1);
  });
});

describe('unbalance', () => {
  it('negative-sequence formula matches symmetrical components on line-line phasors', () => {
    // Build unbalanced phase phasors, take line-line magnitudes, compare with |V2|/|V1| from complex maths.
    const phasor = (mag: number, deg: number) => [mag * Math.cos((deg * Math.PI) / 180), mag * Math.sin((deg * Math.PI) / 180)];
    const cases = [
      [[230, 0], [225, -118], [238, 121]],
      [[240, 0], [200, -125], [220, 115]],
      [[230, 0], [230, -120], [230, 120]],
    ];
    for (const c of cases) {
      const [a, b, cc] = c.map(([m, d]) => phasor(m, d));
      const sub = (x: number[], y: number[]) => [x[0] - y[0], x[1] - y[1]];
      const ab = sub(a, b);
      const bc = sub(b, cc);
      const ca = sub(cc, a);
      const mag = (x: number[]) => Math.hypot(x[0], x[1]);
      const rot = (x: number[], deg: number) => {
        const r = (deg * Math.PI) / 180;
        return [x[0] * Math.cos(r) - x[1] * Math.sin(r), x[0] * Math.sin(r) + x[1] * Math.cos(r)];
      };
      const add = (...xs: number[][]) => xs.reduce((p, x) => [p[0] + x[0], p[1] + x[1]], [0, 0]);
      const v1 = mag(add(ab, rot(bc, 120), rot(ca, 240)));
      const v2 = mag(add(ab, rot(bc, 240), rot(ca, 120)));
      const u = negativeSequenceUnbalance(mag(ab), mag(bc), mag(ca));
      expect(Math.abs((u as number) - (v2 / v1) * 100)).toBeLessThan(1e-9);
    }
    expect(negativeSequenceUnbalance(0, 0, 0)).toBeNull();
    expect(negativeSequenceUnbalance(400, 400, 400)).toBe(0);
    // textbook form agrees away from balance
    const [x, y, z] = [410, 395, 402];
    const beta = (x ** 4 + y ** 4 + z ** 4) / (x * x + y * y + z * z) ** 2;
    const r = Math.sqrt(3 - 6 * beta);
    expect(negativeSequenceUnbalance(x, y, z)).toBeCloseTo(Math.sqrt((1 - r) / (1 + r)) * 100, 6);
    expect(negativeSequenceUnbalance(400, 400, 0)).toBeCloseTo(100, 6);
  });

  it('NEMA unbalance is the largest deviation from the average', () => {
    expect(nemaUnbalance([230, 232, 222])).toBeCloseTo((6 / 228) * 100, 12);
    expect(nemaUnbalance([0, 0, 0])).toBeNull();
  });

  it('reports mean, nearest-rank 95th percentile and max, leaving out samples during events', () => {
    const rows: number[][] = [];
    for (let i = 0; i < 20; i++) rows.push([230, 230, 230 - i]); // NEMA unbalance grows with i
    rows.push([100, 230, 230]); // sag sample: flagged, left out
    const r = analyze(makeLog(rows), s);
    const expected = Array.from({ length: 20 }, (_, i) => nemaUnbalance([230, 230, 230 - i]) as number);
    expect(r.unbalance).toMatchObject({ samples: 20, flaggedSamples: 1, maxAt: '2026-01-01 00:19:00' });
    expect(r.unbalance?.p95).toBeCloseTo(expected[18], 3); // ceil(0.95*20) = 19th value
    expect(r.unbalance?.max).toBeCloseTo(expected[19], 3);
    expect(r.unbalance?.mean).toBeCloseTo(expected.reduce((x, y) => x + y) / 20, 3);
    expect(r.unbalance?.samplesAboveLimit).toBe(expected.filter((u) => u > 2).length);
    expect(r.unbalance?.overLimit).toBe(expected[18] > 2);
  });

  it('flags the unbalance as a finding only when the 95th percentile is over the limit', () => {
    const rows = Array.from({ length: 20 }, () => [230, 230, 220]); // 2.9 %
    const r = analyze(makeLog(rows), s);
    expect(r.unbalance?.overLimit).toBe(true);
    expect(r.findings).toEqual([expect.stringMatching(/^unbalance 95th percentile 2\.941% > 2%$/)]);
    expect(analyze(makeLog(rows), { nominal: 230, unbalanceLimitPct: 3 }).findings).toEqual([]);
  });

  it('uses the negative-sequence method with --line-to-line', () => {
    const r = analyze(makeLog([[400, 400, 400]]), { nominal: 400, lineToLine: true });
    expect(r.unbalance).toMatchObject({ method: 'negative-sequence (line-line magnitudes)', max: 0 });
  });
});

describe('channel stats, frequency, settings', () => {
  it('per-channel min/max/mean and share inside the band (inclusive)', () => {
    const r = analyze(makeLog([[207, 230, 230], [253, 230, 230], [254, 230, 230], [206, 230, 230]]), { nominal: 230, sagPct: 80, swellPct: 120 });
    expect(r.channels[0]).toMatchObject({ min: 206, minAt: '2026-01-01 00:03:00', max: 254, mean: 230, inBandPct: 50 });
    expect(r.channels[1].inBandPct).toBe(100);
  });

  it('frequency range and samples outside the band; empty cells are skipped', () => {
    const r = analyze(makeLog([ok, ok, ok, ok], { freq: [50, null, 51.2, 48.9] }), s);
    expect(r.frequency).toEqual({ samples: 3, min: 48.9, max: 51.2, mean: 50.033, low: 49, high: 51, samplesOutside: 2, firstOutsideAt: '2026-01-01 00:02:00' });
    expect(r.findings).toEqual(['2 frequency sample(s) outside 49-51 Hz']);
    expect(analyze(makeLog([ok], { freq: [59.5] }), { nominal: 230, freqNominal: 60, freqToleranceHz: 0.5 }).frequency?.samplesOutside).toBe(0);
    expect(analyze(makeLog([ok]), s).frequency).toBeNull();
  });

  it('a clean log has no findings', () => {
    const r = analyze(makeLog([ok, ok]), s);
    expect(r.findings).toEqual([]);
    expect(r.events).toEqual([]);
  });

  it('rejects inconsistent settings', () => {
    expect(() => resolveSettings({ nominal: 0 })).toThrow(/nominal/);
    expect(() => resolveSettings({ nominal: Number.NaN })).toThrow(/finite/);
    expect(() => resolveSettings({ nominal: 230, sagPct: 5 })).toThrow(/interruption < sag/);
    expect(() => resolveSettings({ nominal: 230, swellPct: 100 })).toThrow(/< swell/);
    expect(() => resolveSettings({ nominal: 230, sagPct: 99, hysteresisPct: 2 })).toThrow(/Hysteresis/);
    expect(() => resolveSettings({ nominal: 230, hysteresisPct: -1 })).toThrow(/Hysteresis/);
    expect(() => resolveSettings({ nominal: 230, bandLowPct: 100 })).toThrow(/band/);
    expect(() => resolveSettings({ nominal: 230, unbalanceLimitPct: -1 })).toThrow(/unbalance/);
    expect(() => resolveSettings({ nominal: 230, freqToleranceHz: -1 })).toThrow(/frequency/);
    expect(resolveSettings({ nominal: 230 })).toMatchObject({ sagPct: 90, swellPct: 110, interruptPct: 10, hysteresisPct: 2 });
  });
});

describe('per-day summary', () => {
  // 6-hour steps: 2026-01-01 00/06/12/18, 2026-01-02 00/06/12/18
  const rows = [ok, [230, 200, 230], ok, ok, [260, 230, 230], ok, [0, 0, 0], ok];
  const freq = [50, 50, 50, 50, 50, 52, null, 50];

  it('one row per date with events counted on their start day', () => {
    const r = analyze(makeLog(rows, { stepS: 6 * 3600, freq }), s);
    expect(r.days).toEqual([
      { date: '2026-01-01', samples: 4, sag: 1, swell: 0, interruption: 0, minV: 200, maxV: 230, inBandPct: 91.67, unbalanceP95: 0, freqOutside: 0 },
      { date: '2026-01-02', samples: 4, sag: 1, swell: 1, interruption: 1, minV: 0, maxV: 260, inBandPct: 66.67, unbalanceP95: 0, freqOutside: 1 },
    ]);
    // the day rows add up to the whole-log counts
    const sum = (k: 'sag' | 'swell' | 'interruption') => r.days.reduce((t, d) => t + d[k], 0);
    expect({ sag: sum('sag'), swell: sum('swell'), interruption: sum('interruption') }).toMatchObject({
      sag: r.eventCounts.sag,
      swell: r.eventCounts.swell,
      interruption: r.eventCounts.interruption,
    });
  });

  it('daily unbalance p95 leaves out flagged samples; null for single phase; freqOutside null without a frequency column', () => {
    const r = analyze(makeLog([[230, 230, 220], [230, 230, 220], [230, 230, 230]], { stepS: 12 * 3600 }), s);
    expect(r.days.map((d) => d.unbalanceP95)).toEqual([2.941, 0]);
    expect(r.days.every((d) => d.freqOutside === null)).toBe(true);
    const flaggedOnly = analyze(makeLog([[230, 230, 220], [200, 230, 230], [230, 230, 230]], { stepS: 12 * 3600 }), s);
    // the sag sample (NEMA 6.9 %) is flagged and left out of its day's p95
    expect(flaggedOnly.days[0]).toMatchObject({ date: '2026-01-01', samples: 2, sag: 1, unbalanceP95: 2.941 });
    const allFlagged = analyze(makeLog([[200, 230, 230], ok], { stepS: 86400 }), s);
    expect(allFlagged.days.map((d) => d.unbalanceP95)).toEqual([null, 0]);
    const single = analyze(makeLog([[230], [230]], { stepS: 86400 }), s);
    expect(single.days.map((d) => [d.date, d.unbalanceP95])).toEqual([['2026-01-01', null], ['2026-01-02', null]]);
  });
});

describe('event duration buckets', () => {
  const ev = (type: 'sag' | 'swell' | 'interruption', durationS: number, end: string | null = 'x') => ({
    type, start: 's', end, durationS, extremeV: 0, extremePct: 0, channel: 'v', samples: 1, spansGap: false,
  });

  it('buckets at the 1-minute and 10-minute edges (lower edge inclusive) and counts open events', () => {
    const b = bucketDurations([
      ev('sag', 0), ev('sag', 59.999), ev('sag', 60), ev('sag', 599.999), ev('sag', 600), ev('sag', 3600, null),
      ev('swell', 120, null), ev('interruption', 30),
    ]);
    expect(b.sag).toEqual({ under1Min: 2, from1To10Min: 2, atLeast10Min: 2, open: 1 });
    expect(b.swell).toEqual({ under1Min: 0, from1To10Min: 1, atLeast10Min: 0, open: 1 });
    expect(b.interruption).toEqual({ under1Min: 1, from1To10Min: 0, atLeast10Min: 0, open: 0 });
  });

  it('report buckets add up to the event counts', () => {
    // 1-min log: a 3-min sag, a 15-min sag, an open swell of 1 min
    const rows = [ok, [200, 230, 230], [200, 230, 230], [200, 230, 230], ok,
      ...Array.from({ length: 15 }, () => [230, 200, 230]), ok, ok, [260, 230, 230], [260, 230, 230]];
    const r = analyze(makeLog(rows), s);
    expect(r.eventCounts).toMatchObject({ sag: 2, swell: 1, interruption: 0 });
    expect(r.durationBuckets.sag).toEqual({ under1Min: 0, from1To10Min: 1, atLeast10Min: 1, open: 0 });
    expect(r.durationBuckets.swell).toEqual({ under1Min: 0, from1To10Min: 1, atLeast10Min: 0, open: 1 });
    expect(r.durationBuckets.interruption).toEqual({ under1Min: 0, from1To10Min: 0, atLeast10Min: 0, open: 0 });
  });
});

describe('current unbalance', () => {
  const withAmps = () => {
    const log = makeLog([ok, ok, ok, ok, [230, 200, 230], ok]);
    log.currentChannels = ['i1', 'i2', 'i3'];
    log.amps = [[100, 100, 100], [110, 100, 90], [0, 0, 0], null, [200, 100, 100], [12, 10, 8]];
    return log;
  };

  it('max deviation from average, leaving out flagged, zero-load and empty rows; report only without a limit', () => {
    const r = analyze(withAmps(), s);
    expect(r.events).toHaveLength(1);
    expect(r.current).toMatchObject({
      samples: 3,
      missingSamples: 1,
      flaggedSamples: 1,
      lowLoadSamples: 1,
      mean: 10,
      p95: 20,
      max: 20,
      maxAt: '2026-01-01 00:05:00',
      limitPct: null,
      samplesAboveLimit: null,
      overLimit: false,
    });
    expect(r.current?.channels[0]).toEqual({ channel: 'i1', min: 0, mean: 84.4, max: 200 });
    expect(r.findings.some((f) => f.startsWith('current'))).toBe(false);
  });

  it('minimum average current and a limit make it a finding', () => {
    const r = analyze(withAmps(), { ...s, currentMinA: 50, currentUnbalanceLimitPct: 5 });
    expect(r.current).toMatchObject({ samples: 2, lowLoadSamples: 2, p95: 10, samplesAboveLimit: 1, overLimit: true });
    expect(r.findings).toContain('current unbalance 95th percentile 10% > 5%');
    const ok15 = analyze(withAmps(), { ...s, currentMinA: 50, currentUnbalanceLimitPct: 15 });
    expect(ok15.current).toMatchObject({ samplesAboveLimit: 0, overLimit: false });
  });

  it('is null without current columns and rejects bad settings', () => {
    expect(analyze(makeLog([ok]), s).current).toBeNull();
    expect(() => resolveSettings({ ...s, currentMinA: -1 })).toThrow(/minimum average current/);
    expect(() => resolveSettings({ ...s, currentUnbalanceLimitPct: -1 })).toThrow(/current unbalance limit/);
  });
});
