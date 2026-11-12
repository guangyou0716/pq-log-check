import { parseCsv } from './csv.js';
import { InputError } from './errors.js';

/** One RMS log: sample times and per-channel voltages, in file order (strictly increasing time). */
export interface VoltageLog {
  /** Voltage column names as given (one for single phase, three for three phase). */
  channels: string[];
  /** Timestamps exactly as written in the file. */
  timestamps: string[];
  /** Milliseconds since epoch (naive timestamps are read as if UTC; only differences matter). */
  times: number[];
  /** volts[sample][channel] */
  volts: number[][];
  /** Frequency per sample in Hz, or undefined when the log has no frequency column. null = empty cell. */
  freq?: (number | null)[];
  /** Current column names as given (three, one per phase) when the log was read with current columns. */
  currentChannels?: string[];
  /** amps[sample] = per-phase currents in A, or null when any current cell of that row is empty. */
  amps?: (number[] | null)[];
}

export interface LogOptions {
  /** Timestamp column name (default "timestamp"). */
  timeColumn?: string;
  /** Voltage column names: one or three (default v1,v2,v3). */
  voltColumns?: string[];
  /** Frequency column name. Used when present in the header (default "freq"). */
  freqColumn?: string;
  /** Optional current column names, three (one per phase), for current unbalance. Not read by default. */
  currentColumns?: string[];
}

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parses an ISO 8601 date-time. Returns epoch ms and whether the text carried a zone (Z or offset). */
export function parseTimestamp(text: string): { ms: number; zoned: boolean } | undefined {
  const m = TIMESTAMP.exec(text.trim());
  if (!m) {
    return undefined;
  }
  const [, y, mo, d, h, mi, s = '0', frac = '', zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  let ms = Date.UTC(year, month - 1, day, hour, minute, second, Math.floor(Number(`0.${frac || '0'}`) * 1000));
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offH = Number(digits.slice(0, 2));
    const offM = Number(digits.slice(2));
    if (offH > 23 || offM > 59) {
      return undefined;
    }
    ms -= sign * (offH * 60 + offM) * 60_000;
  }
  return { ms, zoned: zone !== undefined };
}

function measurement(text: string, what: string, line: number): number {
  const t = text.trim();
  const value = Number(t);
  if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) || !Number.isFinite(value)) {
    throw new InputError(`Row ${line}: ${what} "${text}" is not a number.`);
  }
  if (value < 0) {
    throw new InputError(`Row ${line}: ${what} ${t} is negative (RMS values cannot be negative).`);
  }
  return value;
}

/** Reads a CSV RMS log. Throws InputError with the row number on any problem. */
export function parseLog(text: string, options: LogOptions = {}): VoltageLog {
  const timeColumn = options.timeColumn ?? 'timestamp';
  const voltColumns = options.voltColumns ?? ['v1', 'v2', 'v3'];
  const freqColumn = options.freqColumn ?? 'freq';
  if (voltColumns.length !== 1 && voltColumns.length !== 3) {
    throw new InputError(`Give one voltage column (single phase) or three (three phase), not ${voltColumns.length}.`);
  }
  if (new Set(voltColumns).size !== voltColumns.length) {
    throw new InputError('The voltage column names must be different.');
  }
  const currentColumns = options.currentColumns;
  if (currentColumns) {
    if (currentColumns.length !== 3) {
      throw new InputError(`Give three current columns (one per phase), not ${currentColumns.length}.`);
    }
    if (voltColumns.length !== 3) {
      throw new InputError('Current columns need a three-phase log (three voltage columns).');
    }
    const lower = (names: string[]) => names.map((n) => n.toLowerCase());
    if (new Set(lower(currentColumns)).size !== 3) {
      throw new InputError('The current column names must be different.');
    }
    const taken = new Set(lower([...voltColumns, timeColumn, freqColumn]));
    const clash = currentColumns.find((n) => taken.has(n.toLowerCase()));
    if (clash !== undefined) {
      throw new InputError(`Current column "${clash}" is also used as the time, voltage or frequency column.`);
    }
  }
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new InputError('The log is empty.');
  }
  const header = rows[0].map((h) => h.trim());
  const index = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const timeIdx = index(timeColumn);
  if (timeIdx < 0) {
    throw new InputError(`The header has no "${timeColumn}" column (header: ${header.join(',')}).`);
  }
  const voltIdx = voltColumns.map((name) => {
    const i = index(name);
    if (i < 0) {
      throw new InputError(`The header has no voltage column "${name}" (header: ${header.join(',')}).`);
    }
    return i;
  });
  const freqIdx = index(freqColumn);
  const currentIdx = currentColumns?.map((name) => {
    const i = index(name);
    if (i < 0) {
      throw new InputError(`The header has no current column "${name}" (header: ${header.join(',')}).`);
    }
    return i;
  });
  const log: VoltageLog = {
    channels: voltIdx.map((i) => header[i]),
    timestamps: [],
    times: [],
    volts: [],
    freq: freqIdx >= 0 ? [] : undefined,
    ...(currentIdx ? { currentChannels: currentIdx.map((i) => header[i]), amps: [] } : {}),
  };
  let zoned: boolean | undefined;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const line = r + 1;
    if (row.length !== header.length) {
      throw new InputError(`Row ${line}: ${row.length} fields, the header has ${header.length}.`);
    }
    const stamp = row[timeIdx].trim();
    const parsed = parseTimestamp(stamp);
    if (!parsed) {
      throw new InputError(`Row ${line}: timestamp "${stamp}" is not an ISO 8601 date-time (YYYY-MM-DD HH:MM[:SS]).`);
    }
    if (zoned === undefined) {
      zoned = parsed.zoned;
    } else if (zoned !== parsed.zoned) {
      throw new InputError(`Row ${line}: timestamps mix local times and times with a zone offset.`);
    }
    const previous = log.times[log.times.length - 1];
    if (previous !== undefined && parsed.ms <= previous) {
      throw new InputError(
        `Row ${line}: timestamp ${stamp} is not after the previous row (${log.timestamps[log.timestamps.length - 1]}); ` +
          'rows must be in time order without duplicates.',
      );
    }
    log.timestamps.push(stamp);
    log.times.push(parsed.ms);
    log.volts.push(voltIdx.map((i) => measurement(row[i], header[i], line)));
    if (log.freq) {
      const cell = row[freqIdx].trim();
      log.freq.push(cell === '' ? null : measurement(cell, header[freqIdx], line));
    }
    if (currentIdx && log.amps) {
      // Non-empty cells are always checked; a row with any empty current cell has no current sample.
      const amps = currentIdx.map((i) => (row[i].trim() === '' ? null : measurement(row[i], header[i], line)));
      log.amps.push(amps.some((x) => x === null) ? null : (amps as number[]));
    }
  }
  if (log.times.length === 0) {
    throw new InputError('The log has a header but no rows.');
  }
  return log;
}
