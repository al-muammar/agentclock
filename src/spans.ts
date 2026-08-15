import type { Span } from './types.js';

/**
 * Merge overlapping and touching spans into a minimal, sorted set.
 *
 * This is what guarantees a session can never contribute more than 1 to a
 * concurrency count. Turns are sequential and should not overlap, but a turn's
 * recorded duration can include time that bleeds into the neighbouring record, and
 * a session double-counting itself would quietly inflate every parallelism figure.
 * Merge first, ask questions never.
 */
export function mergeSpans(spans: Span[]): Span[] {
  if (spans.length <= 1) return spans.filter((s) => s.end > s.start);

  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];

  const out: Span[] = [];
  let cur = { ...sorted[0]! };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (next.start <= cur.end) {
      if (next.end > cur.end) cur.end = next.end;
    } else {
      out.push(cur);
      cur = { ...next };
    }
  }
  out.push(cur);
  return out;
}

/** Total covered time. Assumes the input is already merged. */
export function totalMs(spans: Span[]): number {
  let sum = 0;
  for (const s of spans) sum += s.end - s.start;
  return sum;
}

/** Restrict spans to a window, dropping anything fully outside it. */
export function clip(spans: Span[], from: number, to: number): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const start = Math.max(s.start, from);
    const end = Math.min(s.end, to);
    if (end > start) out.push({ start, end });
  }
  return out;
}
