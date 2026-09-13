import { isExpired, readCredential } from './credentials.js';

/**
 * The one endpoint agentclock talks to.
 *
 * This is what Claude Code's own `/usage` calls. It is internal to Claude Code and
 * carries no compatibility promise, which is why everything below treats every
 * field as optional and every failure as "show the cached value instead".
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Display names, taken from Claude Code so the two agree when a user reads both.
 * A scope missing from this table still renders — under its own key — because the
 * server's scope set is its own business and has grown before.
 */
const SCOPE_LABELS: Record<string, string> = {
  five_hour: 'session limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  seven_day_overage_included: 'Fable limit',
  overage: 'usage credit limit',
};

/** The order a person wants to read them in: shortest window first. */
const SCOPE_ORDER = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
];

export interface QuotaScope {
  /** Scope key exactly as the server named it. Unknown keys are carried, never dropped. */
  key: string;
  /** Human label. The scope's own key when we have no better name for it. */
  label: string;
  /** Percent of the allowance consumed, 0–100. */
  used: number;
  /** Percent remaining — what the user actually asked to see. */
  left: number;
  /** When this scope resets, epoch ms. Absent when the server did not say. */
  resetsAt?: number;
}

export interface QuotaSnapshot {
  scopes: QuotaScope[];
  /** The scope closest to exhaustion. What the badge follows. */
  binding?: QuotaScope;
  /** When this was fetched, epoch ms. */
  fetchedAt: number;
  /** True when it came off disk because a fresh fetch was not possible. */
  stale: boolean;
}

export type QuotaResult =
  | { ok: true; snapshot: QuotaSnapshot }
  | { ok: false; reason: QuotaFailure; snapshot?: QuotaSnapshot };

export type QuotaFailure =
  | 'no-credential'
  | 'expired'
  | 'unauthorized'
  | 'network'
  | 'bad-response'
  | 'no-snapshot';

/** What to tell the user about a failure. */
export function explain(reason: QuotaFailure): string {
  switch (reason) {
    case 'no-snapshot':
      return 'Nothing cached yet. Run `agentclock usage` to fetch it.';
    case 'no-credential':
      return process.platform === 'darwin'
        ? 'No Claude Code credential found. Sign in with `claude` first, and allow the Keychain prompt.'
        : `No credential found. Set ${'CLAUDE_CODE_OAUTH_TOKEN'} (see \`claude setup-token\`).`;
    case 'expired':
    case 'unauthorized':
      return 'The stored credential has expired. Run `claude` once to refresh it.';
    case 'network':
      return 'Could not reach api.anthropic.com.';
    case 'bad-response':
      return 'The usage endpoint answered in a shape agentclock does not recognise.';
  }
}

/**
 * Normalise a reset time.
 *
 * Seen as an ISO string; epoch seconds and epoch ms are accepted too because this
 * response is not a stable format and guessing wrong by a factor of 1000 would put
 * the reset in 1970 or the year 56000 rather than failing visibly.
 */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return undefined;
    // Anything below this is too small to be milliseconds for a current date.
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Utilization is already a percent.
 *
 * Worth stating because it is easy to get backwards: the response also carries a
 * `limits` array, and for the same window it reports `percent: 3` beside
 * `utilization: 3`. Treating utilization as a 0–1 fraction and scaling it turns 3%
 * used into 100% used — a saturated meter on an almost untouched quota, which is
 * the worst direction for this particular number to be wrong in.
 */
function toPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Pull the scopes out of the response, whatever else it happens to contain. */
export function parseQuota(body: unknown, fetchedAt: number): QuotaSnapshot | null {
  if (typeof body !== 'object' || body === null) return null;

  const scopes: QuotaScope[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    const used = toPercent(entry['utilization']);
    if (used === null) continue;

    const scope: QuotaScope = {
      key,
      label: SCOPE_LABELS[key] ?? key.replace(/_/g, ' '),
      used,
      left: 100 - used,
    };
    const resetsAt = toEpochMs(entry['resets_at'] ?? entry['resetsAt']);
    if (resetsAt !== undefined) scope.resetsAt = resetsAt;
    scopes.push(scope);
  }

  if (scopes.length === 0) return null;

  scopes.sort((a, b) => {
    const ai = SCOPE_ORDER.indexOf(a.key);
    const bi = SCOPE_ORDER.indexOf(b.key);
    // Unknown scopes sort last but keep their relative order.
    return (ai === -1 ? SCOPE_ORDER.length : ai) - (bi === -1 ? SCOPE_ORDER.length : bi);
  });

  // The binding limit is the one closest to exhaustion — the number that decides
  // when work stops, which is the number the badge exists to show.
  const binding = scopes.reduce((worst, s) => (s.used > worst.used ? s : worst), scopes[0]!);

  return { scopes, binding, fetchedAt, stale: false };
}

/** Ask the server. Never throws; every failure is a typed result. */
export async function fetchQuota(): Promise<QuotaResult> {
  const credential = await readCredential();
  if (!credential) return { ok: false, reason: 'no-credential' };
  if (isExpired(credential)) return { ok: false, reason: 'expired' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${credential.token}`,
        accept: 'application/json',
        'user-agent': 'agentclock',
      },
      signal: controller.signal,
    });
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized' };
  }
  if (!response.ok) return { ok: false, reason: 'network' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'bad-response' };
  }

  const snapshot = parseQuota(body, Date.now());
  if (!snapshot) return { ok: false, reason: 'bad-response' };
  return { ok: true, snapshot };
}

/** Rebuild the derived fields on scopes that came back off disk. */
export function snapshotFromScopes(
  scopes: QuotaScope[],
  fetchedAt: number,
  stale: boolean,
): QuotaSnapshot | null {
  const usable = scopes.filter((s) => typeof s?.key === 'string' && typeof s?.used === 'number');
  if (usable.length === 0) return null;
  const binding = usable.reduce((worst, s) => (s.used > worst.used ? s : worst), usable[0]!);
  return { scopes: usable, binding, fetchedAt, stale };
}
