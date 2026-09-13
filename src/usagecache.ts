import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { agentclockDir, burnStatePath, quotaCachePath } from './paths.js';
import { fetchQuota, snapshotFromScopes } from './quota.js';
import type { QuotaFailure, QuotaScope, QuotaSnapshot } from './quota.js';
import { readSessionBurn, type BurnState, type SessionBurn } from './burn.js';
import { readLiveSessions } from './registry.js';
import type { LiveSession } from './types.js';

/**
 * `~/.agentclock/usage.json` — written by the CLI, read by the menu bar app.
 *
 * The menu bar reads a file rather than fetching because that is the whole reason
 * it can refresh every two seconds: reading this file costs about a millisecond,
 * where spawning Node costs ~130. Quota moves on five-hour boundaries, so the CLI
 * refreshing it once a minute is ample.
 *
 * Percentages, reset times and token counts. Never a credential.
 */
interface CacheFile {
  v: 1;
  fetchedAt: number;
  scopes: QuotaScope[];
  sessions: SessionBurn[];
}

export interface UsageSnapshot {
  quota: QuotaSnapshot | null;
  sessions: SessionBurn[];
  /** Why there is no fresh quota, when there isn't one. */
  failure?: QuotaFailure;
}

function emptyCache(): CacheFile {
  return { v: 1, fetchedAt: 0, scopes: [], sessions: [] };
}

async function load(): Promise<CacheFile> {
  let text: string;
  try {
    text = await readFile(quotaCachePath(), 'utf8');
  } catch {
    return emptyCache();
  }
  try {
    const parsed = JSON.parse(text) as CacheFile;
    if (parsed?.v !== 1) return emptyCache();
    return {
      v: 1,
      fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    // A corrupt cache must never make the tool unusable — same rule as archive.ts.
    return emptyCache();
  }
}

/** Reading cursors. Absent or unreadable just means the next pass re-reads. */
async function loadCursors(): Promise<BurnState> {
  try {
    const parsed = JSON.parse(await readFile(burnStatePath(), 'utf8')) as BurnState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Temp plus rename, as archive.ts does — a reader must never catch a half-write. */
async function writeAtomic(target: string, body: string, tag: string): Promise<void> {
  const dir = agentclockDir();
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${tag}.${process.pid}.tmp`);
  await writeFile(temp, body, 'utf8');
  await rename(temp, target);
}

/** Whatever is on disk, without touching the network. */
export async function readCached(): Promise<UsageSnapshot> {
  const cache = await load();
  const quota = snapshotFromScopes(cache.scopes, cache.fetchedAt, true);
  const snapshot: UsageSnapshot = { quota, sessions: cache.sessions };
  // Say why it is empty rather than leaving the reader to guess whether the quota
  // is unknown or genuinely zero.
  if (!quota) snapshot.failure = 'no-snapshot';
  return snapshot;
}

export interface RefreshOptions {
  /** Live sessions to measure. Read from the registry when omitted. */
  sessions?: LiveSession[];
}

/**
 * Refresh the quota and the per-session burn, and write both.
 *
 * Fails toward showing something. A fetch that cannot happen leaves the previous
 * scopes in place and reports why, rather than blanking the badge — hiding a real
 * number is worse than showing an old one with its age attached, which is the same
 * call registry.ts makes about phantom sessions.
 */
export async function refreshUsage(options: RefreshOptions = {}): Promise<UsageSnapshot> {
  const cache = await load();
  const priorCursors = await loadCursors();
  const sessions = options.sessions ?? (await readLiveSessions());

  // Burn is local and cheap, so it is remeasured on every call.
  let burn: SessionBurn[] = cache.sessions;
  let cursors: BurnState = priorCursors;
  try {
    const measured = await readSessionBurn(sessions, priorCursors);
    burn = measured.burn;
    cursors = measured.state;
  } catch {
    // Keep the previous figures rather than dropping to zero.
  }

  // Callers decide when to refresh: the CLI fetches because the user asked, and
  // the menu bar paces itself. There is deliberately no age check here — one that
  // silently skipped the fetch would make `agentclock usage` report a stale
  // number while looking like it had just asked.
  let scopes = cache.scopes;
  let fetchedAt = cache.fetchedAt;
  let failure: QuotaFailure | undefined;
  let stale = true;

  const result = await fetchQuota();
  if (result.ok) {
    scopes = result.snapshot.scopes;
    fetchedAt = result.snapshot.fetchedAt;
    stale = false;
  } else {
    failure = result.reason;
  }

  const next: CacheFile = { v: 1, fetchedAt, scopes, sessions: burn };
  try {
    await writeAtomic(quotaCachePath(), `${JSON.stringify(next, null, 2)}\n`, 'usage');
    // Not pretty-printed and not next to the snapshot: this is bookkeeping, it is
    // the larger of the two by an order of magnitude, and nothing reads it on the
    // two-second path.
    await writeAtomic(burnStatePath(), JSON.stringify(cursors), 'burn');
  } catch {
    // A cache we cannot write is not a reason to withhold the number.
  }

  const snapshot: UsageSnapshot = {
    quota: snapshotFromScopes(scopes, fetchedAt, stale),
    sessions: burn,
  };
  if (failure !== undefined) snapshot.failure = failure;
  return snapshot;
}
