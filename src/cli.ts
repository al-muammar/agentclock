import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Anonymizer } from './project.js';
import { computeStats } from './stats.js';
import { duration, parseWindow } from './format.js';
import { cctrackDir, defaultReportPath } from './paths.js';
import { readLiveSessions } from './registry.js';
import { renderReport } from './render/html.js';
import { renderNow, renderStats } from './render/term.js';
import { scanTranscripts } from './transcripts.js';

export const VERSION = '0.1.0';

const HELP = `
  cctrack — how many Claude Code sessions you run, and how many are working

  Usage
    cctrack                 Build the dashboard and open it
    cctrack now             What is running right now
    cctrack stats           Historical summary in the terminal
    cctrack report          Build the dashboard
    cctrack --help

  Options
    --since <window>        Time window: 7d, 24h, 90m  (default 30d)
    --all                   No window; everything on disk
    --anonymize             Replace project and session names with stable pseudonyms
    -o, --out <file>        Where to write the dashboard
    --no-open               Write the dashboard without opening it
    --json                  Machine-readable output
    --verbose               Report parse throughput
    --version

  Notes
    Subagents are part of their parent session and are never counted separately.
    Historical data comes from transcripts, which Claude Code deletes after 30 days.
`;

interface Options {
  command: string;
  since: number | null;
  all: boolean;
  anonymize: boolean;
  json: boolean;
  verbose: boolean;
  out: string | null;
  open: boolean;
}

export function parseArgs(argv: string[]): { options: Options; error?: string } {
  const options: Options = {
    command: 'report',
    since: 30 * 86_400_000,
    all: false,
    anonymize: false,
    json: false,
    verbose: false,
    out: null,
    open: true,
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
        if (arg.startsWith('--since=')) {
          const ms = parseWindow(arg.slice('--since='.length));
          if (ms === null) return { options, error: `Not a valid window: ${arg}` };
          options.since = ms;
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
  return { options };
}

async function commandNow(options: Options): Promise<number> {
  const sessions = await readLiveSessions();
  const anon = new Anonymizer(options.anonymize);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(renderNow(sessions, anon));
  return 0;
}

/** Scan transcripts with a progress line, then reduce to stats for the window. */
async function gather(options: Options) {
  const isTty = process.stderr.isTTY === true;
  const quiet = options.json || !isTty;

  const scan = await scanTranscripts({
    onProgress: (done, total) => {
      if (quiet || total < 40) return;
      if (done % 25 !== 0 && done !== total) return;
      process.stderr.write(`\r  reading transcripts ${done}/${total}`);
    },
  });
  if (!quiet) process.stderr.write(`\r${' '.repeat(40)}\r`);

  const window = options.all
    ? undefined
    : { from: Date.now() - (options.since ?? 30 * 86_400_000), to: Date.now() };

  return { scan, stats: computeStats(scan.records, window) };
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
  const { stats } = await gather(options);
  const live = await readLiveSessions();
  const anon = new Anonymizer(options.anonymize);

  const html = renderReport({
    stats,
    live,
    anon,
    windowLabel: windowLabel(options),
    generatedAt: Date.now(),
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

async function commandStats(options: Options): Promise<number> {
  const started = Date.now();
  const { scan, stats } = await gather(options);
  const anon = new Anonymizer(options.anonymize);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          summary: stats.summary,
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

  if (options.verbose) {
    const elapsed = Date.now() - started;
    const pct = scan.lines > 0 ? ((100 * scan.parsedLines) / scan.lines).toFixed(1) : '0';
    process.stderr.write(
      `  ${scan.scanned} files · ${scan.lines.toLocaleString()} lines · ` +
        `${scan.parsedLines.toLocaleString()} parsed (${pct}%) · ${elapsed}ms\n\n`,
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
    process.stderr.write(`  ${error}\n\n  Run cctrack --help for usage.\n\n`);
    return 2;
  }

  switch (options.command) {
    case 'now':
      return commandNow(options);
    case 'stats':
      return commandStats(options);
    case 'report':
      return commandReport(options);
    default:
      process.stderr.write(
        `  Unknown command: ${options.command}\n\n  Run cctrack --help for usage.\n\n`,
      );
      return 2;
  }
}
