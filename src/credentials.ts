import { execFile } from 'node:child_process';

/** The generic-password service Claude Code stores its OAuth credentials under. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Long-lived token from `claude setup-token`, and the only option off macOS. */
const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

export interface Credential {
  token: string;
  /** Epoch ms the token expires, when the store said so. */
  expiresAt?: number;
  /** Where it came from — surfaced in errors, never the token itself. */
  source: 'env' | 'keychain';
}

/**
 * Run a command and resolve its stdout, or null on any failure.
 *
 * Deliberately swallows stderr and the exit code. A denied Keychain prompt, a
 * missing entry and a machine with no `security` at all are all the same answer
 * here — no credential — and the caller has one path for all three.
 */
function output(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout);
    });
  });
}

/**
 * The only key we will take a token from.
 *
 * This must stay an exact path, never a search. The Keychain item is a single blob
 * holding credentials for *several* services — alongside `claudeAiOauth` it carries
 * an `mcpOAuth` map with one entry per authenticated MCP server (Sentry, Figma and
 * so on), each with its own `accessToken`. A "find the first accessToken" walk
 * picks whichever key happens to come first and would send a third party's bearer
 * token to api.anthropic.com. Ask for the Anthropic credential by name or fail.
 */
const CLAUDE_OAUTH_KEY = 'claudeAiOauth';

/**
 * Pull Claude Code's own access token out of the Keychain item.
 *
 * A bare value that is not JSON is treated as the token itself, which is the shape
 * `claude setup-token` hands out.
 */
export function extractToken(raw: string): { token: string; expiresAt?: number } | null {
  const text = raw.trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the whole value is the token.
    return { token: text };
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const entry = (parsed as Record<string, unknown>)[CLAUDE_OAUTH_KEY];
  if (typeof entry !== 'object' || entry === null) return null;

  const obj = entry as Record<string, unknown>;
  const token = obj['accessToken'];
  if (typeof token !== 'string' || !token.trim()) return null;

  const expiry = obj['expiresAt'];
  const result: { token: string; expiresAt?: number } = { token: token.trim() };
  if (typeof expiry === 'number' && Number.isFinite(expiry) && expiry > 0) {
    result.expiresAt = expiry;
  }
  return result;
}

/**
 * Read the OAuth access token Claude Code already holds.
 *
 * Goes through Apple-signed `/usr/bin/security` rather than a native Keychain
 * binding: a binding would be the tool's first runtime dependency, and `security`
 * has a stable code identity, so the user's "Always Allow" sticks. A locally
 * compiled helper is a different binary after every rebuild and would re-prompt
 * forever — the same ad-hoc-signing fact that rules out SMAppService for the menu
 * bar app.
 *
 * Returns null rather than throwing for every failure mode. agentclock has never
 * needed a credential to do its job and must still work without one.
 */
export async function readCredential(): Promise<Credential | null> {
  const fromEnv = process.env[TOKEN_ENV]?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };

  if (process.platform !== 'darwin') return null;

  const raw = await output('/usr/bin/security', [
    'find-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-w',
  ]);
  if (raw === null) return null;

  const found = extractToken(raw);
  if (!found) return null;

  const credential: Credential = { token: found.token, source: 'keychain' };
  if (found.expiresAt !== undefined) credential.expiresAt = found.expiresAt;
  return credential;
}

/** Has the store told us this token is already past its expiry? */
export function isExpired(credential: Credential, now = Date.now()): boolean {
  return credential.expiresAt !== undefined && credential.expiresAt <= now;
}
