/**
 * Prints one version's CHANGELOG section, for `gh release create --notes-file`.
 *
 * The changelog is the only source of release notes. Anything worth telling
 * someone deciding whether to upgrade is already written there, and generating
 * notes from commit subjects instead would say which files moved rather than
 * what changed.
 *
 *   node scripts/release-notes.mjs 0.4.0
 */
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(2);
}

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const start = changelog.indexOf(`## [${version}]`);
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}

// Everything up to the next top-level heading, minus the heading itself: the
// release page already shows the version and the date.
const rest = changelog.slice(start);
const next = rest.indexOf('\n## ', 1);
const section = next === -1 ? rest : rest.slice(0, next);
const body = section.split('\n').slice(1).join('\n').trim();

if (!body) {
  console.error(`the ${version} section of CHANGELOG.md is empty`);
  process.exit(1);
}
console.log(body);
