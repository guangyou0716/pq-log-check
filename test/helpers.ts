import { fileURLToPath } from 'node:url';
import type { VoltageLog } from '../src/log.js';

export const root = fileURLToPath(new URL('..', import.meta.url));

/** Builds a log with 1-minute steps from 2026-01-01 00:00 UTC. Each row is the channel voltages. */
export function makeLog(rows: number[][], options: { stepS?: number; freq?: (number | null)[]; skip?: number[] } = {}): VoltageLog {
  const step = (options.stepS ?? 60) * 1000;
  const base = Date.UTC(2026, 0, 1);
  const times: number[] = [];
  let k = 0;
  for (let i = 0; i < rows.length; i++) {
    while (options.skip?.includes(k)) k++;
    times.push(base + k * step);
    k++;
  }
  const channels = rows[0].length === 1 ? ['v'] : ['v1', 'v2', 'v3'];
  return {
    channels,
    timestamps: times.map((t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')),
    times,
    volts: rows,
    freq: options.freq,
  };
}

export const ok = [230, 230, 230];
