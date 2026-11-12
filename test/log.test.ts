import { describe, expect, it } from 'vitest';
import { InputError } from '../src/errors.js';
import { parseLog, parseTimestamp } from '../src/log.js';

describe('parseTimestamp', () => {
  it('reads naive and zoned ISO 8601 times', () => {
    expect(parseTimestamp('2026-11-12 14:05')).toEqual({ ms: Date.UTC(2026, 10, 12, 14, 5), zoned: false });
    expect(parseTimestamp('2026-11-12T14:05:30.5')?.ms).toBe(Date.UTC(2026, 10, 12, 14, 5, 30, 500));
    expect(parseTimestamp('2026-11-12T14:05:00+08:00')).toEqual({ ms: Date.UTC(2026, 10, 12, 6, 5), zoned: true });
    expect(parseTimestamp('2026-11-12T14:05:00-0130')?.ms).toBe(Date.UTC(2026, 10, 12, 15, 35));
    expect(parseTimestamp('2026-11-12T14:05:00Z')?.zoned).toBe(true);
  });

  it('rejects impossible or other formats', () => {
    for (const bad of ['2026-02-30 00:00', '2026-13-01 00:00', '2026-11-12 24:00', '12/11/2026 10:00', '2026-11-12', '2026-11-12 10:00+25:00']) {
      expect(parseTimestamp(bad), bad).toBeUndefined();
    }
    expect(parseTimestamp('2028-02-29 00:00')).toBeDefined();
  });
});

describe('parseLog', () => {
  it('reads three-phase rows with frequency, any column order, case-insensitive header', () => {
    const log = parseLog('Freq,V3,timestamp,V1,V2\n50.01,231,2026-01-01 00:00,230,229\n,232,2026-01-01 00:01,230.5,229\n');
    expect(log.channels).toEqual(['V1', 'V2', 'V3']);
    expect(log.volts).toEqual([[230, 229, 231], [230.5, 229, 232]]);
    expect(log.freq).toEqual([50.01, null]);
    expect(log.times[1] - log.times[0]).toBe(60_000);
  });

  it('reads a single-phase log and custom column names', () => {
    const log = parseLog('time,Va\n2026-01-01 00:00,230\n', { timeColumn: 'time', voltColumns: ['Va'] });
    expect(log.channels).toEqual(['Va']);
    expect(log.freq).toBeUndefined();
  });

  it('names the row for every input problem', () => {
    const cases: [string, RegExp][] = [
      ['', /empty/],
      ['timestamp,v1,v2,v3\n', /no rows/],
      ['time,v1,v2,v3\n', /no "timestamp" column/],
      ['timestamp,v1,v2\n', /no voltage column "v3"/],
      ['timestamp,v1,v2,v3\n2026-01-01 00:00,230,230\n', /Row 2: 3 fields/],
      ['timestamp,v1,v2,v3\nyesterday,230,230,230\n', /Row 2: timestamp "yesterday"/],
      ['timestamp,v1,v2,v3\n2026-01-01 00:00,230,abc,230\n', /Row 2: v2 "abc" is not a number/],
      ['timestamp,v1,v2,v3\n2026-01-01 00:00,230,,230\n', /Row 2: v2 "" is not a number/],
      ['timestamp,v1,v2,v3\n2026-01-01 00:00,230,-1,230\n', /negative/],
      ['timestamp,v1,v2,v3\n2026-01-01 00:01,230,230,230\n2026-01-01 00:01,230,230,230\n', /Row 3: .*not after/],
      ['timestamp,v1,v2,v3\n2026-01-01 00:01,230,230,230\n2026-01-01 00:00,230,230,230\n', /Row 3: .*time order/],
      ['timestamp,v1,v2,v3\n2026-01-01 00:00,230,230,230\n2026-01-01T00:01Z,230,230,230\n', /Row 3: timestamps mix/],
      ['timestamp,v1,v2,v3,freq\n2026-01-01 00:00,230,230,230,fifty\n', /Row 2: freq/],
    ];
    for (const [text, message] of cases) {
      expect(() => parseLog(text), text).toThrow(message);
    }
    expect(() => parseLog('timestamp,v1,v2,v3\n2026-01-01 00:00,0x10,230,230\n')).toThrow(InputError);
  });

  it('accepts only one or three distinct voltage columns', () => {
    expect(() => parseLog('timestamp,a,b\n', { voltColumns: ['a', 'b'] })).toThrow(/one voltage column .* or three/);
    expect(() => parseLog('timestamp,a\n', { voltColumns: ['a', 'a', 'a'] })).toThrow(/different/);
  });

  it('reads optional current columns; an empty current cell makes that row missing', () => {
    const log = parseLog('timestamp,v1,v2,v3,IA,IB,IC\n2026-01-01 00:00,230,230,230,10,11,12\n2026-01-01 00:01,230,230,230,10,,12\n', {
      currentColumns: ['ia', 'ib', 'ic'],
    });
    expect(log.currentChannels).toEqual(['IA', 'IB', 'IC']);
    expect(log.amps).toEqual([[10, 11, 12], null]);
    expect(parseLog('timestamp,v1,v2,v3,IA\n2026-01-01 00:00,230,230,230,1\n').amps).toBeUndefined();
  });

  it('checks current columns', () => {
    const text = 'timestamp,v1,v2,v3,i1,i2,i3\n2026-01-01 00:00,230,230,230,1,2,x\n';
    expect(() => parseLog(text, { currentColumns: ['i1', 'i2'] })).toThrow(/three current columns/);
    expect(() => parseLog('timestamp,v\n', { voltColumns: ['v'], currentColumns: ['i1', 'i2', 'i3'] })).toThrow(/three-phase/);
    expect(() => parseLog(text, { currentColumns: ['i1', 'I1', 'i3'] })).toThrow(/different/);
    expect(() => parseLog(text, { currentColumns: ['i1', 'v2', 'i3'] })).toThrow(/"v2" is also used/);
    expect(() => parseLog(text, { currentColumns: ['i1', 'i2', 'i4'] })).toThrow(/no current column "i4"/);
    expect(() => parseLog(text, { currentColumns: ['i1', 'i2', 'i3'] })).toThrow(/Row 2: i3 "x" is not a number/);
    expect(() => parseLog('timestamp,v1,v2,v3,i1,i2,i3\n2026-01-01 00:00,230,230,230,,2,x\n', { currentColumns: ['i1', 'i2', 'i3'] }))
      .toThrow(/Row 2: i3 "x"/);
  });
});
