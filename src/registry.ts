import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { sessionsDir } from './paths.js';
import { EXCLUDED_KINDS, type LiveSession } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Is this PID still alive?
 *
 * EPERM means the process exists but belongs to someone else — still alive.
 * ESRCH means it is gone.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Parse the elapsed-time column from `ps`, formatted `[[dd-]hh:]mm:ss`.
 * Returns seconds, or null if the shape is unrecognised.
 */
export function parseEtime(value: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return null;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/**
 * Map of pid -> seconds since that process started, via a single `ps` call.
 *
 * Used to reject PID reuse: a crashed session can leave a registry file behind, and
 * if the OS later recycles that PID the file would otherwise be reported as a live
 * Claude Code session.
 *
 * Elapsed time rather than start time, deliberately. `ps -o lstart=` renders local
 * time in a locale-dependent order while Claude Code writes `procStart` in UTC, so
 * comparing those two strings rejects every real session — measured 5 hours apart on
 * the author's machine. `etime` is a plain duration: no timezone, no locale, no
 * ordering. (`etimes`, the seconds-only variant, does not exist on macOS.)
 */
async function processAges(): Promise<Map<number, number> | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,etime='], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
    const map = new Map<number, number>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(' ');
      if (sep < 0) continue;
      const pid = Number(trimmed.slice(0, sep));
      if (!Number.isInteger(pid)) continue;
      const seconds = parseEtime(trimmed.slice(sep + 1));
      if (seconds !== null) map.set(pid, seconds);
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * How much younger a process may look than the session that claims it before we call
 * it a recycled PID. Generous: a false negative costs one phantom row in a live
 * snapshot, a false positive silently hides a real session.
 */
const PID_REUSE_TOLERANCE_SECONDS = 300;

function toSession(raw: unknown): LiveSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['pid'] !== 'number') return null;
  if (typeof r['sessionId'] !== 'string') return null;
  if (typeof r['cwd'] !== 'string') return null;

  const session: LiveSession = {
    pid: r['pid'],
    sessionId: r['sessionId'],
    cwd: r['cwd'],
    startedAt: typeof r['startedAt'] === 'number' ? r['startedAt'] : Date.now(),
    // Carried verbatim. An unrecognised status must surface, not be coerced.
    status: typeof r['status'] === 'string' ? r['status'] : 'unknown',
    kind: typeof r['kind'] === 'string' ? r['kind'] : 'interactive',
  };

  if (typeof r['name'] === 'string') session.name = r['name'];
  if (typeof r['waitingFor'] === 'string') session.waitingFor = r['waitingFor'];
  if (typeof r['version'] === 'string') session.version = r['version'];
  if (typeof r['entrypoint'] === 'string') session.entrypoint = r['entrypoint'];
  if (typeof r['procStart'] === 'string') session.procStart = r['procStart'];
  if (typeof r['updatedAt'] === 'number') session.updatedAt = r['updatedAt'];
  if (typeof r['statusUpdatedAt'] === 'number') session.statusUpdatedAt = r['statusUpdatedAt'];

  return session;
}

/**
 * Every Claude Code session running right now.
 *
 * Note there is exactly one entry per session, not per agent: subagents run inside
 * their parent and share its sessionId, so a session with five subagents working
 * appears here once. That is the "N subagents count as 1" rule, and it needs no code.
 */
export async function readLiveSessions(): Promise<LiveSession[]> {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files = entries.filter((f) => f.endsWith('.json'));
  const parsed: LiveSession[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(path.join(dir, file), 'utf8');
    } catch {
      continue; // session exited mid-read
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue; // torn write
    }
    const session = toSession(raw);
    if (!session) continue;
    if (EXCLUDED_KINDS.has(session.kind)) continue; // infrastructure, not a coding session
    if (!pidAlive(session.pid)) continue;
    parsed.push(session);
  }

  if (parsed.length === 0) return [];

  const ages = await processAges();
  if (!ages) return parsed;

  // Fail open throughout: this guard exists only to reject a recycled PID, and
  // anything it cannot read must never cost us a real session.
  const now = Date.now();
  return parsed.filter((s) => {
    const processAge = ages.get(s.pid);
    if (processAge === undefined) return true; // liveness already vouched for it
    const sessionAge = (now - s.startedAt) / 1000;
    if (!Number.isFinite(sessionAge) || sessionAge <= 0) return true;
    // A recycled PID belongs to a process much younger than the session claims to be.
    return sessionAge - processAge <= PID_REUSE_TOLERANCE_SECONDS;
  });
}
