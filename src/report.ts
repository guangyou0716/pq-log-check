import type { PqEvent, Report } from './analyze.js';

const dur = (seconds: number) => {
  if (seconds < 60) return `${seconds} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = Math.round((seconds % 60) * 1000) / 1000;
  return h ? `${h} h ${m} min${sec ? ` ${sec} s` : ''}` : `${m} min${sec ? ` ${sec} s` : ''}`;
};

const eventEnd = (e: PqEvent) => e.end ?? 'open at end of log';
const eventNotes = (e: PqEvent) =>
  [e.containsInterruption ? 'includes interruption' : '', e.spansGap ? 'logging gap inside' : ''].filter(Boolean).join('; ');

function header(r: Report): string[] {
  const s = r.settings;
  const t = r.thresholdsV;
  return [
    `Log: ${r.coverage.start} .. ${r.coverage.end}, ${r.coverage.samples} samples, ` +
      `median interval ${r.coverage.medianIntervalS ?? '-'} s, ${r.coverage.gaps.length} gap(s)`,
    `Supply: ${r.phases === 3 ? 'three phase' : 'single phase'}, nominal ${s.nominal} V ${s.lineToLine ? 'line-line' : 'line-neutral'}`,
    `Thresholds: sag < ${t.sag} V (${s.sagPct}%), swell > ${t.swell} V (${s.swellPct}%), interruption < ${t.interruption} V ` +
      `(${s.interruptPct}%), hysteresis ${t.hysteresis} V, band ${t.bandLow}-${t.bandHigh} V`,
  ];
}

export function textReport(r: Report): string {
  const out = header(r);
  out.push('', `Events: ${r.eventCounts.interruption} interruption, ${r.eventCounts.sag} sag, ${r.eventCounts.swell} swell`);
  for (const e of r.events) {
    const notes = eventNotes(e);
    out.push(
      `  ${e.type.padEnd(12)} ${e.start} -> ${eventEnd(e)}  ${dur(e.durationS)}, ` +
        `${e.type === 'swell' ? 'max' : 'min'} ${e.extremeV} V (${e.extremePct}%) on ${e.channel}${notes ? `  [${notes}]` : ''}`,
    );
  }
  out.push('', 'Voltage per channel (all samples):');
  for (const c of r.channels) {
    out.push(`  ${c.channel}: min ${c.min} V (${c.minAt}), mean ${c.mean} V, max ${c.max} V (${c.maxAt}), in band ${c.inBandPct}%`);
  }
  if (r.unbalance) {
    const u = r.unbalance;
    out.push(
      '',
      `Unbalance (${u.method}), ${u.samples} samples, ${u.flaggedSamples} flagged left out:`,
      `  mean ${u.mean}%, 95th percentile ${u.p95}%, max ${u.max}%${u.maxAt ? ` (${u.maxAt})` : ''}; ` +
        `limit ${u.limitPct}%: ${u.samplesAboveLimit} sample(s) above, ${u.overLimit ? 'OVER LIMIT' : 'ok'}`,
    );
  }
  if (r.frequency) {
    const f = r.frequency;
    out.push(
      '',
      `Frequency (${f.samples} samples): min ${f.min} Hz, mean ${f.mean} Hz, max ${f.max} Hz; ` +
        `outside ${f.low}-${f.high} Hz: ${f.samplesOutside}${f.firstOutsideAt ? ` (first ${f.firstOutsideAt})` : ''}`,
    );
  }
  if (r.coverage.gaps.length) {
    out.push('', 'Logging gaps:');
    for (const g of r.coverage.gaps.slice(0, 20)) {
      out.push(`  ${g.after} -> ${g.before} (${dur(g.seconds)})`);
    }
    if (r.coverage.gaps.length > 20) out.push(`  ... ${r.coverage.gaps.length - 20} more`);
  }
  out.push('', r.findings.length ? `Findings: ${r.findings.join(', ')}` : 'Findings: none');
  return `${out.join('\n')}\n`;
}

const cell = (v: string | number) => String(v).replace(/\|/g, '\\|');

export function markdownReport(r: Report): string {
  const out = ['# Power-quality log report', '', ...header(r).map((l) => `- ${l}`), '', '## Events', ''];
  if (r.events.length) {
    out.push('| Type | Start | End | Duration | Extreme | Channel | Notes |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const e of r.events) {
      out.push(
        `| ${e.type} | ${cell(e.start)} | ${cell(eventEnd(e))} | ${dur(e.durationS)} | ${e.extremeV} V (${e.extremePct}%) | ` +
          `${cell(e.channel)} | ${eventNotes(e)} |`,
      );
    }
  } else {
    out.push('None.');
  }
  out.push('', '## Voltage per channel', '', '| Channel | Min (V) | Mean (V) | Max (V) | In band |', '| --- | --- | --- | --- | --- |');
  for (const c of r.channels) {
    out.push(`| ${cell(c.channel)} | ${c.min} | ${c.mean} | ${c.max} | ${c.inBandPct}% |`);
  }
  if (r.unbalance) {
    const u = r.unbalance;
    out.push(
      '',
      '## Unbalance',
      '',
      `${u.method}; ${u.samples} samples, ${u.flaggedSamples} flagged left out.`,
      '',
      '| Mean | 95th percentile | Max | Limit | Samples above | Result |',
      '| --- | --- | --- | --- | --- | --- |',
      `| ${u.mean}% | ${u.p95}% | ${u.max}% | ${u.limitPct}% | ${u.samplesAboveLimit} | ${u.overLimit ? 'over limit' : 'ok'} |`,
    );
  }
  if (r.frequency) {
    const f = r.frequency;
    out.push(
      '',
      '## Frequency',
      '',
      `${f.samples} samples: min ${f.min} Hz, mean ${f.mean} Hz, max ${f.max} Hz; outside ${f.low}-${f.high} Hz: ${f.samplesOutside}.`,
    );
  }
  if (r.coverage.gaps.length) {
    out.push('', '## Logging gaps', '');
    for (const g of r.coverage.gaps) out.push(`- ${cell(g.after)} -> ${cell(g.before)} (${dur(g.seconds)})`);
  }
  out.push('', '## Findings', '', r.findings.length ? r.findings.map((f) => `- ${f}`).join('\n') : 'None.');
  return `${out.join('\n')}\n`;
}

export function jsonReport(r: Report): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}
