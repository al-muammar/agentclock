#!/usr/bin/env node
import { run } from '../dist/cli.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  process.stderr.write(
    `\n  cctrack needs Node 18.17 or newer (found ${process.versions.node}).\n\n`,
  );
  process.exit(1);
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(
    `\n  cctrack failed: ${err instanceof Error ? err.message : String(err)}\n\n`,
  );
  process.exitCode = 1;
}
