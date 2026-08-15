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

/** One day's worth of activity, positioned within the day. */
/**
 * One hour of the day.
 *
 * `sessions` counts a session if it was working at any point in the hour, however
 * briefly — occupancy, not duration. `peak` is the most that overlapped at once
 * within the hour.
 */
export interface HourBucket {
  hour: number;
  sessions: number;
  peak: number;
  activeMs: number;
  /** Days that had any activity in this hour. Always 1 for a single day. */
  days: number;
}

/** Walk the local clock hours a range touches, clipped to it. */
function eachLocalHour(
  start: number,
  end: number,
  visit: (from: number, to: number, hour: number) => void,
): void {
  if (end <= start) return;
  const cursor = new Date(start);
  cursor.setMinutes(0, 0, 0);
  let at = cursor.getTime();
  // Guard against a pathological range rather than looping forever.
  for (let guard = 0; at < end && guard < 100_000; guard++) {
    const next = new Date(at);
    next.setHours(next.getHours() + 1);
    const nextAt = next.getTime();
    const from = Math.max(at, start);
    const to = Math.min(nextAt, end);
    if (to > from) visit(from, to, new Date(at).getHours());
    at = nextAt;
  }
}

function emptyHours(): HourBucket[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    sessions: 0,
    peak: 0,
    activeMs: 0,
    days: 0,
  }));
}

/** One session's working time within a single day — a lane in the expanded view. */
export interface TimelineLane {
  sessionId: string;
  label: string;
  project: string;
  activeMs: number;
  spans: Span[];
}

export interface TimelineDay {
  day: string;
  /** Local midnight that starts this day. */
  midnight: number;
  /**
   * Length of this local day. Not always 24h — a DST transition makes it 23 or
   * 25, and positioning against a fixed 24h would skew that day's bars.
   */
  dayMs: number;
  activeMs: number;
  peak: number;
  /** Union intervals clipped to this day, carrying how many were working. */
  intervals: Interval[];
  /** Per-session detail, busiest first. */
  lanes: TimelineLane[];
  /** 24 entries, one per local clock hour. */
  hours: HourBucket[];
}

export interface Stats {
  summary: Summary;
  concurrency: ConcurrencyBucket[];
  days: DayBucket[];
  projects: ProjectBucket[];
  sessions: SessionRecord[];
  timeline: TimelineDay[];
  /** Hourly distribution across every day in the window. */
  hourly: HourBucket[];
}

/** Local midnight for a `YYYY-MM-DD` key. */
export function midnightOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

/** Split intervals across local day boundaries and group them by day. */
export function buildTimeline(
  intervals: Interval[],
  days: DayBucket[],
  sessions: SessionRecord[] = [],
): TimelineDay[] {
  const byDay = new Map<string, Interval[]>();

  for (const interval of intervals) {
    let cursor = interval.start;
    while (cursor < interval.end) {
      const boundary = Math.min(nextLocalDay(cursor), interval.end);
      const key = dayKey(cursor);
      let list = byDay.get(key);
      if (!list) {
        list = [];
        byDay.set(key, list);
      }
      list.push({
        start: cursor,
        end: boundary,
        level: interval.level,
        projects: interval.projects,
      });
      cursor = boundary;
    }
  }

  // Per-session lanes, so a day can be opened to see who was doing what.
  const lanesByDay = new Map<string, TimelineLane[]>();
  for (const session of sessions) {
    const spansByDay = new Map<string, Span[]>();
    for (const span of session.spans) {
      let cursor = span.start;
      while (cursor < span.end) {
        const boundary = Math.min(nextLocalDay(cursor), span.end);
        const key = dayKey(cursor);
        let list = spansByDay.get(key);
        if (!list) {
          list = [];
          spansByDay.set(key, list);
        }
        list.push({ start: cursor, end: boundary });
        cursor = boundary;
      }
    }
    for (const [key, spans] of spansByDay) {
      let lanes = lanesByDay.get(key);
      if (!lanes) {
        lanes = [];
        lanesByDay.set(key, lanes);
      }
      lanes.push({
        sessionId: session.sessionId,
        label: session.label,
        project: session.project,
        activeMs: totalMs(spans),
        spans,
      });
    }
  }
  for (const lanes of lanesByDay.values()) {
    lanes.sort((a, b) => b.activeMs - a.activeMs);
  }

  return days
    .filter((d) => byDay.has(d.day) || d.activeMs > 0)
    .map((d) => {
      const midnight = midnightOf(d.day);
      const dayIntervals = byDay.get(d.day) ?? [];
      const dayLanes = lanesByDay.get(d.day) ?? [];
      return {
        day: d.day,
        midnight,
        dayMs: nextLocalDay(midnight) - midnight,
        activeMs: d.activeMs,
        peak: d.peak,
        intervals: dayIntervals,
        lanes: dayLanes,
        hours: hoursOfDay(dayIntervals, dayLanes),
      };
    });
}

/**
 * Bucket a single day into local clock hours.
 *
 * A session counts toward an hour if it was working at any point inside it, however
 * briefly — the question "was this hour worked" is about occupancy, not duration.
 */
export function hoursOfDay(intervals: Interval[], lanes: TimelineLane[]): HourBucket[] {
  const buckets = emptyHours();
  const seen = Array.from({ length: 24 }, () => new Set<string>());

  for (const lane of lanes) {
    for (const span of lane.spans) {
      eachLocalHour(span.start, span.end, (from, to, hour) => {
        const bucket = buckets[hour]!;
        bucket.activeMs += to - from;
        seen[hour]!.add(lane.sessionId);
      });
    }
  }

  for (const interval of intervals) {
    eachLocalHour(interval.start, interval.end, (_from, _to, hour) => {
      const bucket = buckets[hour]!;
      if (interval.level > bucket.peak) bucket.peak = interval.level;
    });
  }

  for (let hour = 0; hour < 24; hour++) {
    buckets[hour]!.sessions = seen[hour]!.size;
    buckets[hour]!.days = buckets[hour]!.activeMs > 0 ? 1 : 0;
  }
  return buckets;
}

/** Sum per-day hourly buckets into one distribution for the whole window. */
export function aggregateHours(days: TimelineDay[]): HourBucket[] {
  const total = emptyHours();
  for (const day of days) {
    for (let hour = 0; hour < 24; hour++) {
      const from = day.hours[hour]!;
      const into = total[hour]!;
      into.sessions += from.sessions;
      into.activeMs += from.activeMs;
      into.days += from.days;
      if (from.peak > into.peak) into.peak = from.peak;
    }
  }
  return total;
}

function _startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
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
/** A stretch during which a fixed set of sessions was working. */
export interface Interval {
  start: number;
  end: number;
  /** How many sessions were working — always equal to `projects.length`. */
  level: number;
  /** Which projects were working, for the timeline tooltip. */
  projects: string[];
}

export interface ConcurrencyProfile {
  buckets: ConcurrencyBucket[];
  peak: number;
  peakAt: number;
  coveredMs: number;
  /** Highest simultaneous level reached on each local day. */
  dayPeaks: Map<string, number>;
  /** Every stretch with at least one session working, in order. */
  intervals: Interval[];
}

export function concurrencyProfile(sessions: SessionRecord[]): ConcurrencyProfile {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const events: Array<[number, number, string]> = [];
  for (const s of sessions) {
    for (const span of s.spans) {
      events.push([span.start, 1, s.sessionId], [span.end, -1, s.sessionId]);
    }
  }
  if (events.length === 0) {
    return {
      buckets: [],
      peak: 0,
      peakAt: 0,
      coveredMs: 0,
      dayPeaks: new Map(),
      intervals: [],
    };
  }

  // Close before open at the same instant, so touching spans don't read as overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const atLevel = new Map<number, number>();
  const dayPeaks = new Map<string, number>();
  const intervals: Interval[] = [];
  // Counted, not a plain Set: one session's merged spans never overlap, but the
  // same session id must survive an adjacent close/open pair at the same instant.
  const active = new Map<string, number>();
  let level = 0;
  let peak = 0;
  let peakAt = events[0]![0];
  let prev = events[0]![0];

  const projectsOf = (): string[] => {
    const names = new Set<string>();
    for (const id of active.keys()) {
      const session = byId.get(id);
      if (session) names.add(session.project);
    }
    return [...names];
  };

  for (const [t, delta, sessionId] of events) {
    if (t > prev && level > 0) {
      atLevel.set(level, (atLevel.get(level) ?? 0) + (t - prev));

      // Attribute the level to every local day this interval touches. Done inside
      // the one sweep: computing it per day instead meant re-sweeping every session
      // once per day, which cost 12s of a 15s run on a 30-day window.
      for (const piece of splitByDay({ start: prev, end: t })) {
        const current = dayPeaks.get(piece.day) ?? 0;
        if (level > current) dayPeaks.set(piece.day, level);
      }

      const last = intervals[intervals.length - 1];
      if (last && last.end === prev && last.level === level) {
        last.end = t; // extend rather than emit a second rect at the same level
      } else {
        intervals.push({ start: prev, end: t, level, projects: projectsOf() });
      }
    }

    level += delta;
    if (delta > 0) {
      active.set(sessionId, (active.get(sessionId) ?? 0) + 1);
    } else {
      const count = (active.get(sessionId) ?? 1) - 1;
      if (count <= 0) active.delete(sessionId);
      else active.set(sessionId, count);
    }

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
  return { buckets, peak, peakAt, coveredMs, dayPeaks, intervals };
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

  const { buckets, peak, peakAt, coveredMs, dayPeaks, intervals } = concurrencyProfile(sessions);

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

  const timeline = buildTimeline(intervals, days, sessions);

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
    timeline,
    hourly: aggregateHours(timeline),
  };
}
