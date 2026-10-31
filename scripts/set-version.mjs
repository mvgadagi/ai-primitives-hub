#!/usr/bin/env node
/**
 * Bumps the shared version of core, infra, app, cli and the VS Code
 * extension, and the scaffold template's CLI range (ADR-0011).
 *
 * Usage:
 *   node scripts/set-version.mjs <patch|minor|major> [repo-root]
 *   node scripts/set-version.mjs <patch|minor|major> --preid <id> --build <n> [repo-root]
 *
 * With --preid and --build the result is an npm-only prerelease of the next
 * version, e.g. `minor --preid alpha --build 42` on 0.3.0 gives
 * 0.4.0-alpha.42. The build number keeps repeated prereleases unique, since a
 * prerelease is never committed to main.
 *
 * Prints the new version on stdout.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { checkVersions, SCAFFOLD_TEMPLATE_FILE, UNIFIED_PACKAGE_FILES } from './check-versions.mjs';

const RELEASE_TYPES = new Set(['patch', 'minor', 'major']);
const PREID = /^[0-9A-Za-z-]+$/;
const BUILD = /^[1-9]\d*$/;

/**
 * Computes the next shared version.
 * @param {string} current - Current stable version, `major.minor.patch`.
 * @param {string} releaseType - `patch`, `minor` or `major`.
 * @param {{ preid?: string, build?: string }} [prerelease] - Prerelease id and build number.
 * @returns {string} The next version.
 */
export function nextVersion(current, releaseType, prerelease = {}) {
  if (!RELEASE_TYPES.has(releaseType)) {
    throw new Error(`Unsupported release type "${releaseType}"; use patch, minor or major.`);
  }
  const [major, minor, patch] = current.split('.').map(Number);
  const next = {
    major: `${major + 1}.0.0`,
    minor: `${major}.${minor + 1}.0`,
    patch: `${major}.${minor}.${patch + 1}`
  }[releaseType];

  const { preid, build } = prerelease;
  if (preid === undefined && build === undefined) {
    return next;
  }
  if (preid === undefined || !PREID.test(preid)) {
    throw new Error(`Prerelease id must contain only letters, numbers or '-', got "${preid}".`);
  }
  if (build === undefined || !BUILD.test(build)) {
    throw new Error(`Prerelease build must be a positive integer, got "${build}".`);
  }
  return `${next}-${preid}.${build}`;
}

/**
 * Replaces the first `"<key>": "<value>"` pair in a JSON file, keeping its formatting.
 * @param {string} file - Absolute file path.
 * @param {string} key - JSON key to replace.
 * @param {string} value - New string value.
 */
function replaceFirstJsonString(file, key, value) {
  const text = readFileSync(file, 'utf8');
  const pattern = new RegExp(`("${key.replaceAll('/', '\\/')}"\\s*:\\s*)"[^"]*"`);
  if (!pattern.test(text)) {
    throw new Error(`${file} has no "${key}" entry.`);
  }
  writeFileSync(file, text.replace(pattern, `$1"${value}"`));
}

/**
 * Writes a version to every released package and the scaffold template.
 * @param {string} rootDir - Repository root.
 * @param {string} version - Version to write.
 */
export function setVersion(rootDir, version) {
  for (const file of UNIFIED_PACKAGE_FILES) {
    replaceFirstJsonString(path.join(rootDir, file), 'version', version);
  }
  replaceFirstJsonString(path.join(rootDir, SCAFFOLD_TEMPLATE_FILE), '@ai-primitives-hub/cli', `^${version}`);
}

/**
 * Bumps the repository from its current shared version.
 * @param {string} rootDir - Repository root.
 * @param {string} releaseType - `patch`, `minor` or `major`.
 * @param {{ preid?: string, build?: string }} [prerelease] - Prerelease id and build number.
 * @returns {string} The version written.
 */
export function bumpVersion(rootDir, releaseType, prerelease) {
  const { version, problems } = checkVersions(rootDir);
  if (problems.length > 0) {
    throw new Error(`Fix the shared version before bumping it:\n${problems.join('\n')}`);
  }
  const next = nextVersion(version, releaseType, prerelease);
  setVersion(rootDir, next);
  return next;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { preid: { type: 'string' }, build: { type: 'string' } }
    });
    const [releaseType, root] = positionals;
    const rootDir = path.resolve(root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
    process.stdout.write(`${bumpVersion(rootDir, releaseType, values)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
