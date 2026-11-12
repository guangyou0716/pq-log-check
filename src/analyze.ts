import { InputError } from './errors.js';
import type { VoltageLog } from './log.js';

export interface Settings {
  /** Nominal (declared) voltage in volts: line-neutral, or line-line with lineToLine. */
  nominal: number;
  /** The voltage columns are line-line values (unbalance then uses the exact negative-sequence formula). */
  lineToLine?: boolean;
  /** Sag (dip) threshold, % of nominal (default 90). */
  sagPct?: number;
  /** Swell threshold, % of nominal (default 110). */
  swellPct?: number;
  /** Interruption threshold, % of nominal (default 10). */
  interruptPct?: number;
  /** Hysteresis, % of nominal (default 2). */
  hysteresisPct?: number;
  /** Lower edge of the voltage band, % below nominal (default 10). */
  bandLowPct?: number;
  /** Upper edge of the voltage band, % above nominal (default 10). */
  bandHighPct?: number;
  /** Unbalance limit in % for the 95th percentile (default 2). */
  unbalanceLimitPct?: number;
  /** Nominal frequency in Hz (default 50). */
  freqNominal?: number;
  /** Allowed frequency deviation in Hz (default 1). */
  freqToleranceHz?: number;
}

export type EventType = 'sag' | 'swell' | 'interruption';

export interface PqEvent {
  type: EventType;
  start: string;
  /** First sample back inside the limits; null when the event is still open at the end of the log. */
  end: string | null;
  durationS: number;
  /** Lowest voltage (sag, interruption) or highest voltage (swell) seen during the event. */
  extremeV: number;
  extremePct: number;
  /** Channel where the extreme was seen. */
  channel: string;
  samples: number;
  /** A logging gap falls inside the event, so its real extent is unknown. */
  spansGap: boolean;
  /** Sag only: all channels were also below the interruption threshold at some point. */
  containsInterruption?: boolean;
}

export interface ChannelStats {
  channel: string;
  min: number;
  minAt: string;
  max: number;
  maxAt: string;
  mean: number;
  inBandPct: number;
}

export interface UnbalanceStats {
  method: 'negative-sequence (line-line magnitudes)' | 'NEMA phase-voltage unbalance (max deviation from average)';
  samples: number;
  /** Samples left out because a sag, swell or interruption was in progress (flagged). */
  flaggedSamples: number;
  mean: number;
  p95: number;
  max: number;
  maxAt: string;
  limitPct: number;
  samplesAboveLimit: number;
  overLimit: boolean;
}

export interface FrequencyStats {
  samples: number;
  min: number;
  max: number;
  mean: number;
  low: number;
  high: number;
  samplesOutside: number;
  firstOutsideAt: string | null;
}

export interface Gap {
  after: string;
  before: string;
  seconds: number;
}

export interface Report {
  settings: Required<Settings>;
  thresholdsV: { sag: number; swell: number; interruption: number; hysteresis: number; bandLow: number; bandHigh: number };
  coverage: { start: string; end: string; samples: number; medianIntervalS: number | null; gaps: Gap[] };
  phases: number;
  events: PqEvent[];
  eventCounts: { sag: number; swell: number; interruption: number; sagWithInterruption: number };
  channels: ChannelStats[];
  unbalance: UnbalanceStats | null;
  frequency: FrequencyStats | null;
  findings: string[];
}

const round = (value: number, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

export function resolveSettings(settings: Settings): Required<Settings> {
  const s: Required<Settings> = {
    nominal: settings.nominal,
    lineToLine: settings.lineToLine ?? false,
    sagPct: settings.sagPct ?? 90,
    swellPct: settings.swellPct ?? 110,
    interruptPct: settings.interruptPct ?? 10,
    hysteresisPct: settings.hysteresisPct ?? 2,
    bandLowPct: settings.bandLowPct ?? 10,
    bandHighPct: settings.bandHighPct ?? 10,
    unbalanceLimitPct: settings.unbalanceLimitPct ?? 2,
    freqNominal: settings.freqNominal ?? 50,
    freqToleranceHz: settings.freqToleranceHz ?? 1,
  };
  for (const [key, value] of Object.entries(s)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new InputError(`${key} must be a finite number.`);
    }
  }
  if (!(s.nominal > 0)) {
    throw new InputError('The nominal voltage must be greater than 0.');
  }
  if (!(s.interruptPct > 0 && s.interruptPct < s.sagPct && s.sagPct < 100 && s.swellPct > 100)) {
    throw new InputError('Thresholds must satisfy 0 < interruption < sag < 100 < swell (% of nominal).');
  }
  if (!(s.hysteresisPct >= 0 && s.sagPct + s.hysteresisPct <= 100 && s.swellPct - s.hysteresisPct >= 100 &&
    s.interruptPct + s.hysteresisPct <= s.sagPct)) {
    throw new InputError('Hysteresis must be >= 0 and must not push a threshold past nominal or past the next threshold.');
  }
  if (!(s.bandLowPct >= 0 && s.bandLowPct < 100 && s.bandHighPct >= 0)) {
    throw new InputError('The voltage band must be 0-100 % below and >= 0 % above nominal.');
  }
  if (!(s.unbalanceLimitPct >= 0)) {
    throw new InputError('The unbalance limit must be >= 0 %.');
  }
  if (!(s.freqNominal > 0 && s.freqToleranceHz >= 0)) {
    throw new InputError('Nominal frequency must be > 0 Hz and the tolerance >= 0 Hz.');
  }
  return s;
}

/** Negative-sequence unbalance u2 (%) from three line-line voltage magnitudes (exact, no angles needed). */
export function negativeSequenceUnbalance(a: number, b: number, c: number): number | null {
  const s2 = a * a + b * b + c * c;
  if (s2 === 0) {
    return null;
  }
  const beta = (a ** 4 + b ** 4 + c ** 4) / (s2 * s2);
  const r = Math.sqrt(Math.max(0, 3 - 6 * beta));
  return Math.sqrt((1 - r) / (1 + r)) * 100;
}

/** NEMA phase-voltage unbalance (%): largest deviation from the average, over the average. */
export function nemaUnbalance(volts: number[]): number | null {
  const avg = volts.reduce((sum, v) => sum + v, 0) / volts.length;
  if (avg === 0) {
    return null;
  }
  return (Math.max(...volts.map((v) => Math.abs(v - avg))) / avg) * 100;
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Open {
  start: number;
  extreme: number;
  channel: number;
  samples: number;
  spansGap: boolean;
  containsInterruption: boolean;
}

export function analyze(log: VoltageLog, input: Settings): Report {
  const s = resolveSettings(input);
  const pct = (p: number) => (s.nominal * p) / 100;
  const sagV = pct(s.sagPct);
  const swellV = pct(s.swellPct);
  const intV = pct(s.interruptPct);
  const hyst = pct(s.hysteresisPct);
  const bandLow = pct(100 - s.bandLowPct);
  const bandHigh = pct(100 + s.bandHighPct);
  const n = log.times.length;
  const last = n - 1;

  // Logging gaps: a step longer than 1.5x the median step.
  const steps = log.times.slice(1).map((t, i) => t - log.times[i]);
  const medianStep = steps.length ? median(steps) : null;
  const gapBefore = new Array<boolean>(n).fill(false);
  const gaps: Gap[] = [];
  if (medianStep !== null) {
    steps.forEach((step, i) => {
      if (step > medianStep * 1.5) {
        gapBefore[i + 1] = true;
        gaps.push({ after: log.timestamps[i], before: log.timestamps[i + 1], seconds: round(step / 1000) });
      }
    });
  }

  const found: { event: PqEvent; startIdx: number }[] = [];
  const flagged = new Array<boolean>(n).fill(false);
  const open: Record<EventType, Open | null> = { sag: null, swell: null, interruption: null };
  const close = (type: EventType, endIdx: number | null) => {
    const o = open[type];
    if (!o) {
      return;
    }
    const stopIdx = endIdx ?? last;
    found.push({ startIdx: o.start, event: {
      type,
      start: log.timestamps[o.start],
      end: endIdx === null ? null : log.timestamps[endIdx],
      durationS: round((log.times[stopIdx] - log.times[o.start]) / 1000),
      extremeV: round(o.extreme),
      extremePct: round((o.extreme / s.nominal) * 100, 2),
      channel: log.channels[o.channel],
      samples: o.samples,
      spansGap: o.spansGap,
      ...(type === 'sag' ? { containsInterruption: o.containsInterruption } : {}),
    } });
    open[type] = null;
  };
  const extremeOf = (v: number[], low: boolean) => {
    let channel = 0;
    v.forEach((x, k) => {
      if (low ? x < v[channel] : x > v[channel]) {
        channel = k;
      }
    });
    return { value: v[channel], channel };
  };
  const track = (type: EventType, i: number, v: number[], starts: boolean, ends: boolean, low: boolean) => {
    const o = open[type];
    if (o) {
      if (gapBefore[i]) {
        o.spansGap = true;
      }
      if (ends) {
        close(type, i);
        return;
      }
    } else if (!starts) {
      return;
    }
    const ext = extremeOf(v, low);
    const cur = open[type] ?? {
      start: i,
      extreme: ext.value,
      channel: ext.channel,
      samples: 0,
      spansGap: false,
      containsInterruption: false,
    };
    open[type] = cur;
    cur.samples++;
    if (low ? ext.value < cur.extreme : ext.value > cur.extreme) {
      cur.extreme = ext.value;
      cur.channel = ext.channel;
    }
    if (v.every((x) => x < intV)) {
      cur.containsInterruption = true;
    }
  };

  for (let i = 0; i < n; i++) {
    const v = log.volts[i];
    track('sag', i, v, v.some((x) => x < sagV), v.every((x) => x >= sagV + hyst), true);
    track('swell', i, v, v.some((x) => x > swellV), v.every((x) => x <= swellV - hyst), false);
    track('interruption', i, v, v.every((x) => x < intV), v.some((x) => x >= intV + hyst), true);
    flagged[i] = open.sag !== null || open.swell !== null || open.interruption !== null;
  }
  close('sag', null);
  close('swell', null);
  close('interruption', null);
  const order: Record<EventType, number> = { interruption: 0, sag: 1, swell: 2 };
  found.sort((x, y) => x.startIdx - y.startIdx || order[x.event.type] - order[y.event.type]);
  const events = found.map((f) => f.event);

  const channels: ChannelStats[] = log.channels.map((channel, k) => {
    let min = 0;
    let max = 0;
    let sum = 0;
    let inBand = 0;
    for (let i = 0; i < n; i++) {
      const x = log.volts[i][k];
      if (x < log.volts[min][k]) min = i;
      if (x > log.volts[max][k]) max = i;
      sum += x;
      if (x >= bandLow && x <= bandHigh) inBand++;
    }
    return {
      channel,
      min: round(log.volts[min][k]),
      minAt: log.timestamps[min],
      max: round(log.volts[max][k]),
      maxAt: log.timestamps[max],
      mean: round(sum / n),
      inBandPct: round((inBand / n) * 100, 2),
    };
  });

  let unbalance: UnbalanceStats | null = null;
  if (log.channels.length === 3) {
    const values: number[] = [];
    let maxValue = -1;
    let maxAt = '';
    let flaggedSamples = 0;
    for (let i = 0; i < n; i++) {
      if (flagged[i]) {
        flaggedSamples++;
        continue;
      }
      const [a, b, c] = log.volts[i];
      const u = s.lineToLine ? negativeSequenceUnbalance(a, b, c) : nemaUnbalance([a, b, c]);
      if (u === null) {
        continue;
      }
      values.push(u);
      if (u > maxValue) {
        maxValue = u;
        maxAt = log.timestamps[i];
      }
    }
    const sorted = [...values].sort((x, y) => x - y);
    const p95 = sorted.length ? percentile(sorted, 95) : 0;
    unbalance = {
      method: s.lineToLine
        ? 'negative-sequence (line-line magnitudes)'
        : 'NEMA phase-voltage unbalance (max deviation from average)',
      samples: values.length,
      flaggedSamples,
      mean: values.length ? round(values.reduce((x, y) => x + y, 0) / values.length) : 0,
      p95: round(p95),
      max: values.length ? round(maxValue) : 0,
      maxAt,
      limitPct: s.unbalanceLimitPct,
      samplesAboveLimit: values.filter((u) => u > s.unbalanceLimitPct).length,
      overLimit: values.length > 0 && p95 > s.unbalanceLimitPct,
    };
  }

  let frequency: FrequencyStats | null = null;
  if (log.freq) {
    const low = s.freqNominal - s.freqToleranceHz;
    const high = s.freqNominal + s.freqToleranceHz;
    const present = log.freq.map((f, i) => ({ f, i })).filter((x): x is { f: number; i: number } => x.f !== null);
    const outside = present.filter((x) => x.f < low || x.f > high);
    frequency = {
      samples: present.length,
      // reduce, not Math.min(...array): a year of 1-minute samples is too many arguments for a spread call
      min: present.length ? round(present.reduce((m, x) => Math.min(m, x.f), Infinity)) : 0,
      max: present.length ? round(present.reduce((m, x) => Math.max(m, x.f), -Infinity)) : 0,
      mean: present.length ? round(present.reduce((sum, x) => sum + x.f, 0) / present.length) : 0,
      low: round(low),
      high: round(high),
      samplesOutside: outside.length,
      firstOutsideAt: outside.length ? log.timestamps[outside[0].i] : null,
    };
  }

  const eventCounts = {
    sag: events.filter((e) => e.type === 'sag').length,
    swell: events.filter((e) => e.type === 'swell').length,
    interruption: events.filter((e) => e.type === 'interruption').length,
    sagWithInterruption: events.filter((e) => e.containsInterruption).length,
  };
  const findings: string[] = [];
  if (eventCounts.interruption) findings.push(`${eventCounts.interruption} interruption(s)`);
  if (eventCounts.sag) findings.push(`${eventCounts.sag} sag(s)`);
  if (eventCounts.swell) findings.push(`${eventCounts.swell} swell(s)`);
  if (unbalance?.overLimit) {
    findings.push(`unbalance 95th percentile ${unbalance.p95}% > ${unbalance.limitPct}%`);
  }
  if (frequency?.samplesOutside) {
    findings.push(`${frequency.samplesOutside} frequency sample(s) outside ${frequency.low}-${frequency.high} Hz`);
  }

  return {
    settings: s,
    thresholdsV: {
      sag: round(sagV),
      swell: round(swellV),
      interruption: round(intV),
      hysteresis: round(hyst),
      bandLow: round(bandLow),
      bandHigh: round(bandHigh),
    },
    coverage: {
      start: log.timestamps[0],
      end: log.timestamps[last],
      samples: n,
      medianIntervalS: medianStep === null ? null : round(medianStep / 1000),
      gaps,
    },
    phases: log.channels.length,
    events,
    eventCounts,
    channels,
    unbalance,
    frequency,
    findings,
  };
}
