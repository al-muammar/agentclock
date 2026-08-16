import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTERS, describeAgents, readLive, resolveAgents } from './agents/index.js';
import { Anonymizer } from './project.js';
import { computeStats } from './stats.js';
import { duration, parseHourRange, parseWindow, type HourRange } from './format.js';
import { agentclockDir, defaultOnePagerPath, defaultReportPath } from './paths.js';
import { loadArchive, mergeArchive, saveArchive, emptyArchive } from './archive.js';
import { renderReport } from './render/html.js';
import { renderOnePager } from './render/onepager.js';
import {
  CLEAR_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  renderAgents,
  renderNow,
  renderStats,
  renderTimeline,
} from './render/term.js';
import { scanSessions } from './scan.js';

export const VERSION = '0.2.0';

const HELP = `
  agentclock — how many coding agents you run, and how many are working

  Usage
    agentclock                 Build the dashboard and open it
    agentclock now             What is running right now
    agentclock timeline        Per-day activity timeline
    agentclock watch           Live view, refreshing in place
    agentclock stats           Historical summary in the terminal
    agentclock report          Build the dashboard
    agentclock pdf             One-page PDF summary, for sharing
    agentclock agents          Which agents are installed and readable
    agentclock menubar         Install the macOS menu bar badge (macOS only)
    agentclock --help

  Options
    --agent <ids>           Only these agents: claude, codex  (default: all found)
    --since <window>        Time window: 7d, 24h, 90m  (default 30d)
    --all                   No window; everything on disk
    --anonymize             Replace project and session names with stable pseudonyms
    -o, --out <file>        Where to write the dashboard or the PDF
    --no-open               Write the file without opening it
    --hours <range>         Zoom the timeline: 9-18, 09:30-13:00
    --interval <seconds>    Refresh rate for watch  (default 2)
    --no-archive            Do not read or update ~/.agentclock/archive.jsonl
    --json                  Machine-readable output
    --verbose               Report parse throughput
    --version

  Notes
    Subagents are part of their parent session and are never counted separately,
    whichever agent ran them. A Claude session and a Codex session working at the
    same moment count as two.
    Claude Code deletes transcripts after 30 days; agentclock keeps what it has
    already seen in ~/.agentclock/archive.jsonl, so history outlives the sweep.
    "agentclock menubar" compiles a small native app from source and installs it
    to /Applications; "agentclock menubar uninstall" removes it again.
`;

interface Options {
  command: string;
  /** Second bare word, e.g. the "uninstall" in `agentclock menubar uninstall`. */
  subcommand: string | null;
  /** Agent ids from --agent, or null for "every agent found on this machine". */
  agents: string[] | null;
  since: number | null;
  all: boolean;
  anonymize: boolean;
  json: boolean;
  verbose: boolean;
  out: string | null;
  open: boolean;
  archive: boolean;
  interval: number;
  hours: HourRange | null;
}

/** `--agent claude,codex` and `--agent claude --agent codex` both work. */
function addAgents(options: Options, value: string): void {
  const ids = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  options.agents = [...(options.agents ?? []), ...ids];
}

export function parseArgs(argv: string[]): { options: Options; error?: string } {
  const options: Options = {
    command: 'report',
    subcommand: null,
    agents: null,
    since: 30 * 86_400_000,
    all: false,
    anonymize: false,
    json: false,
    verbose: false,
    out: null,
    open: true,
    archive: true,
    interval: 2,
    hours: null,
  };

  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--all':
        options.all = true;
        break;
      case '--anonymize':
      case '--anonymise':
        options.anonymize = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--no-open':
        options.open = false;
        break;
      case '--agent':
      case '--agents': {
        const value = argv[++i];
        if (!value) {
          return {
            options,
            error: `--agent needs an agent id: ${ADAPTERS.map((a) => a.id).join(', ')}`,
          };
        }
        addAgents(options, value);
        break;
      }
      case '--hours': {
        const value = argv[++i];
        if (!value) return { options, error: '--hours needs a range, e.g. --hours 9-18' };
        const range = parseHourRange(value);
        if (range === null) {
          return { options, error: `Not a valid hour range: ${value}. Try 9-18 or 09:30-13:00.` };
        }
        options.hours = range;
        break;
      }
      case '--no-archive':
        options.archive = false;
        break;
      case '--interval': {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value <= 0) {
          return { options, error: '--interval needs a number of seconds' };
        }
        options.interval = value;
        break;
      }
      case '-o':
      case '--out': {
        const value = argv[++i];
        if (!value) return { options, error: '--out needs a file path' };
        options.out = path.resolve(value);
        break;
      }
      case '--since': {
        const value = argv[++i];
        if (!value) return { options, error: '--since needs a window, e.g. --since 7d' };
        const ms = parseWindow(value);
        if (ms === null)
          return { options, error: `Not a valid window: ${value}. Try 7d, 24h or 90m.` };
        options.since = ms;
        break;
      }
      default:
        if (arg.startsWith('--agent=') || arg.startsWith('--agents=')) {
          addAgents(options, arg.slice(arg.indexOf('=') + 1));
          break;
        }
        if (arg.startsWith('--since=')) {
          const ms = parseWindow(arg.slice('--since='.length));
          if (ms === null) return { options, error: `Not a valid window: ${arg}` };
          options.since = ms;
          break;
        }
        if (arg.startsWith('--hours=')) {
          const range = parseHourRange(arg.slice('--hours='.length));
          if (range === null) return { options, error: `Not a valid hour range: ${arg}` };
          options.hours = range;
          break;
        }
        if (arg.startsWith('--out=')) {
          options.out = path.resolve(arg.slice('--out='.length));
          break;
        }
        if (arg.startsWith('-')) return { options, error: `Unknown option: ${arg}` };
        rest.push(arg);
    }
  }

  if (rest.length > 0) options.command = rest[0]!;
  if (rest.length > 1) options.subcommand = rest[1]!;
  return { options };
}

async function commandAgents(options: Options): Promise<number> {
  const infos = await describeAgents();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(infos, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(renderAgents(infos));
  return 0;
}

async function commandNow(options: Options): Promise<number> {
  const { adapters, error } = await resolveAgents(options.agents);
  if (error) {
    process.stderr.write(`  ${error}\n\n`);
    return 2;
  }

  const snapshot = await readLive(adapters);
  const anon = new Anonymizer(options.anonymize);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(renderNow(snapshot, anon));
  return 0;
}

/** Scan every selected agent with a progress line, then reduce to stats. */
async function gather(options: Options) {
  const { adapters, error } = await resolveAgents(options.agents);
  if (error) return { error } as const;

  const isTty = process.stderr.isTTY === true;
  const quiet = options.json || !isTty;

  // The archive both preserves sessions an agent has already swept and lets an
  // unchanged file be skipped entirely on a later run.
  const archive = options.archive ? await loadArchive() : emptyArchive();

  const scan = await scanSessions(adapters, {
    skip: (file) => {
      const known = archive.byFile.get(file.file);
      return known !== undefined && known.mtimeMs === file.mtimeMs && known.size === file.size;
    },
    onProgress: (done, total) => {
      if (quiet || total < 40) return;
      if (done % 25 !== 0 && done !== total) return;
      process.stderr.write(`\r  reading sessions ${done}/${total}`);
    },
  });
  if (!quiet) process.stderr.write(`\r${' '.repeat(40)}\r`);

  const all = mergeArchive(archive, scan.records);

  if (options.archive) {
    // Never let a write failure cost the user their report. Note this saves every
    // record, including agents outside the current selection — a `--agent codex`
    // run must not amputate the Claude history.
    try {
      await saveArchive(all);
    } catch (err) {
      if (options.verbose) {
        process.stderr.write(
          `  could not update archive: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  // Filter only when the agents were named explicitly. Without --agent the default
  // is everything already known, which includes agents whose files have since been
  // deleted and so no longer `detect()`.
  const selected = new Set(options.agents ?? []);
  const records = selected.size > 0 ? all.filter((r) => selected.has(r.agent)) : all;

  const window = options.all
    ? undefined
    : { from: Date.now() - (options.since ?? 30 * 86_400_000), to: Date.now() };

  return { adapters, scan, records, stats: computeStats(records, window) } as const;
}

/** Live view that redraws in place. Terminal-only replacement for a menu bar. */
async function commandWatch(options: Options): Promise<number> {
  const { adapters, error } = await resolveAgents(options.agents);
  if (error) {
    process.stderr.write(`  ${error}\n\n`);
    return 2;
  }

  const anon = new Anonymizer(options.anonymize);
  const interval = Math.max(1, options.interval) * 1000;
  let stop = false;

  const restore = () => {
    process.stdout.write(SHOW_CURSOR);
  };
  const onSignal = () => {
    stop = true;
    restore();
    process.stdout.write('\n');
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.stdout.write(HIDE_CURSOR);

  try {
    while (!stop) {
      const snapshot = await readLive(adapters);
      const hint = `  ${SHOW_CURSOR}refreshing every ${options.interval}s · ctrl-c to stop\n`;
      process.stdout.write(CLEAR_SCREEN + renderNow(snapshot, anon) + hint + HIDE_CURSOR);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  } finally {
    restore();
  }
  return 0;
}

/** Does this executable exist on PATH? */
function haveCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, ['--version'], (err) => resolve(!err));
  });
}

/**
 * Build and install the macOS menu bar app.
 *
 * The app is shipped as source, not as a binary, and compiled on the machine that
 * runs it. That is what keeps it out of Gatekeeper's way: code compiled locally is
 * never quarantined, so there is no "unidentified developer" dialog and no need for
 * a paid Developer ID. It also means the npm package stays a single dependency-free
 * download rather than carrying a prebuilt executable for each architecture.
 */
async function commandMenubar(options: Options): Promise<number> {
  const w = (s: string) => process.stdout.write(s);

  if (process.platform !== 'darwin') {
    process.stderr.write('\n  The menu bar app is macOS only.\n\n');
    return 1;
  }

  // dist/cli.js -> the package root, which holds macos/ in both a git checkout
  // and an installed package.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const macosDir = path.join(root, 'macos');
  try {
    await access(path.join(macosDir, 'Makefile'));
  } catch {
    process.stderr.write(
      `\n  Could not find the menu bar sources at ${macosDir}.\n` +
        '  Reinstall agentclock, or build from a git checkout with `npm run menubar:install`.\n\n',
    );
    return 1;
  }

  const uninstall = options.subcommand === 'uninstall' || options.subcommand === 'remove';

  if (!uninstall && !(await haveCommand('swiftc'))) {
    process.stderr.write(
      '\n  The menu bar app is compiled on your machine, and swiftc was not found.\n' +
        '  Install the Xcode Command Line Tools, then try again:\n\n' +
        '      xcode-select --install\n\n',
    );
    return 1;
  }

  // Never build inside the package: a global npm install may live somewhere this
  // user cannot write.
  const build = path.join(agentclockDir(), 'menubar-build');
  await mkdir(build, { recursive: true });

  if (!uninstall) w('\n  Compiling the menu bar app…\n\n');

  const code = await new Promise<number>((resolve) => {
    const child = spawn(
      'make',
      ['-C', macosDir, uninstall ? 'uninstall' : 'install', `BUILD=${build}`],
      {
        stdio: 'inherit',
      },
    );
    child.on('error', () => resolve(-1));
    child.on('close', (c) => resolve(c ?? 1));
  });

  if (code === -1) {
    process.stderr.write(
      '\n  Could not run `make`. Install the Xcode Command Line Tools:\n\n' +
        '      xcode-select --install\n\n',
    );
    return 1;
  }
  if (code !== 0) return code;

  w(
    uninstall
      ? '\n  Removed. The badge is gone from your menu bar.\n\n'
      : '\n  Look for the ◐ in your menu bar. Click it for the session list.\n' +
          '  Remove it again with: agentclock menubar uninstall\n\n',
  );
  return 0;
}

function windowLabel(options: Options): string {
  if (options.all) return 'All time';
  const ms = options.since ?? 30 * 86_400_000;
  return `Last ${duration(ms)}`;
}

/** Open a file in the platform's default handler. Failure is non-fatal. */
async function openFile(file: string): Promise<boolean> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  return new Promise((resolve) => {
    execFile(command, [file], (err) => resolve(!err));
  });
}

async function commandReport(options: Options): Promise<number> {
  const gathered = await gather(options);
  if ('error' in gathered) {
    process.stderr.write(`  ${gathered.error}\n\n`);
    return 2;
  }

  const { stats, adapters } = gathered;
  const live = await readLive(adapters);
  const anon = new Anonymizer(options.anonymize);

  const html = renderReport({
    stats,
    live,
    anon,
    sources: adapters.map((a) => ({ id: a.id, name: a.name, root: a.root() })),
    windowLabel: windowLabel(options),
    generatedAt: Date.now(),
    zoom: options.hours,
  });

  const out = options.out ?? defaultReportPath();
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, html, 'utf8');

  const size = (Buffer.byteLength(html) / 1024).toFixed(0);
  process.stdout.write(`\n  Dashboard written to ${out} (${size} KB)\n`);

  if (options.open) {
    const opened = await openFile(out);
    if (!opened) process.stdout.write('  Open it in a browser to view.\n');
  }
  process.stdout.write('\n');
  return 0;
}

/** One page, for handing to someone: the vital numbers and the best day in the window. */
async function commandOnePager(options: Options): Promise<number> {
  const gathered = await gather(options);
  if ('error' in gathered) {
    process.stderr.write(`  ${gathered.error}\n\n`);
    return 2;
  }
  const { stats } = gathered;
  const anon = new Anonymizer(options.anonymize);

  const pdf = renderOnePager({
    stats,
    anon,
    windowLabel: windowLabel(options),
    generatedAt: Date.now(),
  });

  const out = options.out ?? defaultOnePagerPath();
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, pdf);

  process.stdout.write(`\n  One-pager written to ${out} (${(pdf.length / 1024).toFixed(0)} KB)\n`);

  if (options.open) {
    const opened = await openFile(out);
    if (!opened) process.stdout.write('  Open it in a PDF viewer to read it.\n');
  }
  process.stdout.write('\n');
  return 0;
}

async function commandTimeline(options: Options): Promise<number> {
  const gathered = await gather(options);
  if ('error' in gathered) {
    process.stderr.write(`  ${gathered.error}\n\n`);
    return 2;
  }
  const { stats } = gathered;

  if (options.json) {
    process.stdout.write(`${JSON.stringify(stats.timeline, null, 2)}\n`);
    return 0;
  }

  // Leave room for the date column, the totals, and a little breathing space.
  const width = process.stdout.columns ?? 100;
  process.stdout.write(renderTimeline(stats, Math.max(24, width - 36), options.hours));
  return 0;
}

async function commandStats(options: Options): Promise<number> {
  const started = Date.now();
  const gathered = await gather(options);
  if ('error' in gathered) {
    process.stderr.write(`  ${gathered.error}\n\n`);
    return 2;
  }
  const { scan, stats } = gathered;
  const anon = new Anonymizer(options.anonymize);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          summary: stats.summary,
          agents: stats.agents,
          concurrency: stats.concurrency,
          days: stats.days,
          projects: stats.projects.map((p) => ({ ...p, project: anon.project(p.project) })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(renderStats(stats, anon));

  // Files an adapter found but cannot read are stated even without --verbose:
  // a report that quietly covers half the history is worse than a noisy one.
  for (const agent of scan.agents) {
    if (agent.unreadable > 0) {
      process.stderr.write(
        `  ${agent.name}: skipped ${agent.unreadable} file(s) — ${agent.unreadableReason}\n\n`,
      );
    }
  }

  if (options.verbose) {
    const elapsed = Date.now() - started;
    const pct = scan.lines > 0 ? ((100 * scan.parsedLines) / scan.lines).toFixed(1) : '0';
    const perAgent = scan.agents.map((a) => `${a.agent} ${a.scanned}/${a.found}`).join(' · ');
    process.stderr.write(
      `  ${scan.scanned} files · ${scan.lines.toLocaleString()} lines · ` +
        `${scan.parsedLines.toLocaleString()} parsed (${pct}%) · ${elapsed}ms\n` +
        `  ${perAgent}\n\n`,
    );
  }

  return 0;
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const { options, error } = parseArgs(argv);
  if (error) {
    process.stderr.write(`  ${error}\n\n  Run agentclock --help for usage.\n\n`);
    return 2;
  }

  switch (options.command) {
    case 'now':
      return commandNow(options);
    case 'stats':
      return commandStats(options);
    case 'report':
      return commandReport(options);
    case 'pdf':
      return commandOnePager(options);
    case 'timeline':
      return commandTimeline(options);
    case 'watch':
      return commandWatch(options);
    case 'menubar':
      return commandMenubar(options);
    case 'agents':
      return commandAgents(options);
    default:
      process.stderr.write(
        `  Unknown command: ${options.command}\n\n  Run agentclock --help for usage.\n\n`,
      );
      return 2;
  }
}
