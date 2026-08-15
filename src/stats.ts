import { clip, mergeSpans, totalMs } from './spans.js';
import type { SessionRecord, Span } from './types.js';

export interface Summary {
  sessions: number;
  /** Sessions old enough to predate the turn_duration record (Claude Code < 2.1.222). */
  sessionsWithoutTurnData: number;
  projects: number;
  turns: number;
  prompts: number;
  /** Summed agent working time across sessions. Can exceed wall clock. */
  activeMs: number;
  /** Wall-clock time during which at least one session was working. */
  coveredMs: number;
  /** activeMs / coveredMs — how much of the work happened in parallel. */
  parallelism: number;
  peakConcurrency: number;
  peakAt: number;
  windowFrom: number;
  windowTo: number;
  /** Longest single session lifetime, and its summed working time. */
  longestLifetimeMs: number;
  totalLifetimeMs: number;
}

export interface ConcurrencyBucket {
  level: number;
  ms: number;
}

export interface DayBucket {
  day: string;
  activeMs: number;
  coveredMs: number;
  sessions: number;
  peak: number;
}

export interface ProjectBucket {
  project: string;
  activeMs: number;
  sessions: number;
  turns: number;
}

export interface Stats {
  summary: Summary;
  concurrency: ConcurrencyBucket[];
  days: DayBucket[];
  projects: ProjectBucket[];
  sessions: SessionRecord[];
}

function nextLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function dayKey(t: number): string {
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Split a span at local midnight boundaries, so DST shifts don't drift the buckets. */
function splitByDay(span: Span): Array<{ day: string; ms: number; at: number }> {
  const out: Array<{ day: string; ms: number; at: number }> = [];
  let cursor = span.start;
  while (cursor < span.end) {
    const boundary = Math.min(nextLocalDay(cursor), span.end);
    out.push({ day: dayKey(cursor), ms: boundary - cursor, at: cursor });
    cursor = boundary;
  }
  return out;
}

/**
 * Sweep over every session's spans to find how long was spent at each level of
 * simultaneous work.
 *
 * Sessions are merged individually before they get here, so one session contributes
 * at most 1 to the level at any instant no matter how many subagents it was running.
 */
export interface ConcurrencyProfile {
  buckets: ConcurrencyBucket[];
  peak: number;
  peakAt: number;
  coveredMs: number;
  /** Highest simultaneous level reached on each local day. */
  dayPeaks: Map<string, number>;
}

export function concurrencyProfile(sessions: SessionRecord[]): ConcurrencyProfile {
  const events: Array<[number, number]> = [];
  for (const s of sessions) {
    for (const span of s.spans) {
      events.push([span.start, 1], [span.end, -1]);
    }
  }
  if (events.length === 0) {
    return { buckets: [], peak: 0, peakAt: 0, coveredMs: 0, dayPeaks: new Map() };
  }

  // Close before open at the same instant, so touching spans don't read as overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const atLevel = new Map<number, number>();
  const dayPeaks = new Map<string, number>();
  let level = 0;
  let peak = 0;
  let peakAt = events[0]![0];
  let prev = events[0]![0];

  for (const [t, delta] of events) {
    if (t > prev && level > 0) {
      atLevel.set(level, (atLevel.get(level) ?? 0) + (t - prev));
      // Attribute the level to every local day this interval touches. Done inside
      // the one sweep: computing it per day instead meant re-sweeping every session
      // once per day, which cost 12s of a 15s run on a 30-day window.
      for (const piece of splitByDay({ start: prev, end: t })) {
        const current = dayPeaks.get(piece.day) ?? 0;
        if (level > current) dayPeaks.set(piece.day, level);
      }
    }
    level += delta;
    prev = t;
    if (level > peak) {
      peak = level;
      peakAt = t;
    }
  }

  const buckets = [...atLevel.entries()]
    .map(([lvl, ms]) => ({ level: lvl, ms }))
    .sort((a, b) => a.level - b.level);

  const coveredMs = buckets.reduce((sum, b) => sum + b.ms, 0);
  return { buckets, peak, peakAt, coveredMs, dayPeaks };
}

export function computeStats(
  records: SessionRecord[],
  window?: { from: number; to: number },
): Stats {
  // Clip to the requested window before anything else, so every figure agrees.
  const sessions: SessionRecord[] = [];
  for (const r of records) {
    if (!window) {
      sessions.push(r);
      continue;
    }
    if (r.endedAt < window.from || r.startedAt > window.to) continue;
    const spans = clip(r.spans, window.from, window.to);
    sessions.push({
      ...r,
      spans,
      activeMs: totalMs(spans),
      startedAt: Math.max(r.startedAt, window.from),
      endedAt: Math.min(r.endedAt, window.to),
    });
  }

  sessions.sort((a, b) => b.activeMs - a.activeMs || b.endedAt - a.endedAt);

  const { buckets, peak, peakAt, coveredMs, dayPeaks } = concurrencyProfile(sessions);

  const activeMs = sessions.reduce((sum, s) => sum + s.activeMs, 0);
  const turns = sessions.reduce((sum, s) => sum + s.turns, 0);
  const prompts = sessions.reduce((sum, s) => sum + s.prompts, 0);

  let windowFrom = Number.POSITIVE_INFINITY;
  let windowTo = 0;
  let longestLifetimeMs = 0;
  let totalLifetimeMs = 0;
  for (const s of sessions) {
    if (s.startedAt < windowFrom) windowFrom = s.startedAt;
    if (s.endedAt > windowTo) windowTo = s.endedAt;
    const life = s.endedAt - s.startedAt;
    totalLifetimeMs += life;
    if (life > longestLifetimeMs) longestLifetimeMs = life;
  }
  if (!Number.isFinite(windowFrom)) windowFrom = 0;

  // Per-day: summed session time, plus union coverage from globally merged spans.
  const union = mergeSpans(sessions.flatMap((s) => s.spans));
  const dayMap = new Map<string, DayBucket>();
  const daySessions = new Map<string, Set<string>>();

  const ensureDay = (day: string): DayBucket => {
    let bucket = dayMap.get(day);
    if (!bucket) {
      bucket = { day, activeMs: 0, coveredMs: 0, sessions: 0, peak: 0 };
      dayMap.set(day, bucket);
    }
    return bucket;
  };

  for (const s of sessions) {
    for (const span of s.spans) {
      for (const piece of splitByDay(span)) {
        ensureDay(piece.day).activeMs += piece.ms;
        let set = daySessions.get(piece.day);
        if (!set) {
          set = new Set();
          daySessions.set(piece.day, set);
        }
        set.add(s.sessionId);
      }
    }
  }
  for (const span of union) {
    for (const piece of splitByDay(span)) {
      ensureDay(piece.day).coveredMs += piece.ms;
    }
  }
  for (const [day, set] of daySessions) ensureDay(day).sessions = set.size;
  for (const [day, peakLevel] of dayPeaks) ensureDay(day).peak = peakLevel;

  const days = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  const projectMap = new Map<string, ProjectBucket>();
  for (const s of sessions) {
    let bucket = projectMap.get(s.project);
    if (!bucket) {
      bucket = { project: s.project, activeMs: 0, sessions: 0, turns: 0 };
      projectMap.set(s.project, bucket);
    }
    bucket.activeMs += s.activeMs;
    bucket.sessions += 1;
    bucket.turns += s.turns;
  }
  const projects = [...projectMap.values()].sort((a, b) => b.activeMs - a.activeMs);

  return {
    summary: {
      sessions: sessions.length,
      sessionsWithoutTurnData: sessions.filter((s) => !s.hasTurnData).length,
      projects: projects.length,
      turns,
      prompts,
      activeMs,
      coveredMs,
      parallelism: coveredMs > 0 ? activeMs / coveredMs : 0,
      peakConcurrency: peak,
      peakAt,
      windowFrom,
      windowTo,
      longestLifetimeMs,
      totalLifetimeMs,
    },
    concurrency: buckets,
    days,
    projects,
    sessions,
  };
}
