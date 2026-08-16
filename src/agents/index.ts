import type { LiveSession } from '../types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import type { AgentAdapter, AgentInfo } from './types.js';

export type { AgentAdapter, AgentInfo, AgentListing } from './types.js';
export { claudeAdapter, CLAUDE_ID } from './claude.js';
export { codexAdapter, CODEX_ID } from './codex.js';

/**
 * Every agent agentclock knows how to read, in the order they are reported.
 *
 * Adding one is a single file plus a line here. Nothing downstream of the scanner
 * knows an agent's name: spans, stats, the archive and both renderers all work off
 * `SessionRecord.agent` as an opaque string.
 */
export const ADAPTERS: readonly AgentAdapter[] = [claudeAdapter, codexAdapter];

export function adapterById(id: string): AgentAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

/** Display name for an agent id, falling back to the id itself. */
export function agentName(id: string): string {
  return adapterById(id)?.name ?? id;
}

export interface Selection {
  adapters: AgentAdapter[];
  error?: string;
}

/**
 * Resolve `--agent` into adapters.
 *
 * With no selection, every agent that has data on this machine is read. An explicit
 * selection is honoured even when the agent has nothing on disk — asking for codex
 * and getting a silent claude-only report would be worse than an empty one.
 */
export async function resolveAgents(ids: string[] | null): Promise<Selection> {
  if (ids && ids.length > 0) {
    const adapters: AgentAdapter[] = [];
    for (const id of ids) {
      const adapter = adapterById(id);
      if (!adapter) {
        return {
          adapters: [],
          error: `Unknown agent: ${id}. Known agents: ${ADAPTERS.map((a) => a.id).join(', ')}.`,
        };
      }
      if (!adapters.includes(adapter)) adapters.push(adapter);
    }
    return { adapters };
  }

  const present = await Promise.all(ADAPTERS.map((a) => a.detect()));
  const detected = ADAPTERS.filter((_, i) => present[i]);
  // Nothing detected: keep every adapter so the empty-state message is about
  // having no sessions, not about having picked no agents.
  return { adapters: detected.length > 0 ? detected : [...ADAPTERS] };
}

export async function describeAgents(): Promise<AgentInfo[]> {
  return Promise.all(
    ADAPTERS.map(async (a) => {
      const info: AgentInfo = {
        id: a.id,
        name: a.name,
        root: a.root(),
        present: await a.detect(),
        live: typeof a.live === 'function',
      };
      if (a.liveNote) info.liveNote = a.liveNote;
      return info;
    }),
  );
}

export interface LiveSnapshot {
  sessions: LiveSession[];
  /** Agents in the selection that cannot report live state, and why. */
  blind: Array<{ id: string; name: string; note: string }>;
}

/** Live sessions across every selected agent that publishes them. */
export async function readLive(adapters: readonly AgentAdapter[]): Promise<LiveSnapshot> {
  const sessions: LiveSession[] = [];
  const blind: LiveSnapshot['blind'] = [];

  for (const adapter of adapters) {
    if (typeof adapter.live !== 'function') {
      blind.push({
        id: adapter.id,
        name: adapter.name,
        note: adapter.liveNote ?? 'publishes no live session state',
      });
      continue;
    }
    try {
      sessions.push(...(await adapter.live()));
    } catch {
      // A broken registry must not take the whole snapshot down with it.
    }
  }

  return { sessions, blind };
}
