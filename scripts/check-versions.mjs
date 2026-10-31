#!/usr/bin/env node
/**
 * Checks that the released packages share one version (ADR-0011).
 *
 * core, infra, app, cli and the VS Code extension are released together, so
 * their package.json versions must be equal. The scaffold template must ask
 * for that same CLI version, otherwise new collection repositories install
 * an older CLI.
 *
 * Usage: node scripts/check-versions.mjs [repo-root]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** package.json files that carry the shared version, relative to the repo root. */
export const UNIFIED_PACKAGE_FILES = [
  'packages/core/package.json',
  'packages/infra/package.json',
  'packages/app/package.json',
  'packages/cli/package.json',
  'apps/vscode-extension/package.json'
];

/** Scaffold template whose CLI dev dependency must match the shared version. */
export const SCAFFOLD_TEMPLATE_FILE = 'apps/vscode-extension/templates/scaffolds/github/package.template.json';

const CLI_PACKAGE_NAME = '@ai-primitives-hub/cli';

// The VS Code Marketplace accepts only major.minor.patch, so the committed
// shared version never carries a prerelease suffix.
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

const readJson = (rootDir, relativePath) =>
  JSON.parse(readFileSync(path.join(rootDir, relativePath), 'utf8'));

/**
 * Collects every versioning problem in the repository.
 * @param {string} rootDir - Repository root.
 * @returns {{ version: string | undefined, problems: string[] }} The shared version when all packages agree, and the problems found.
 */
export function checkVersions(rootDir) {
  const entries = UNIFIED_PACKAGE_FILES.map((file) => {
    const { name, version } = readJson(rootDir, file);
    return { file, name, version };
  });

  const problems = [];
  const versions = new Set(entries.map((entry) => entry.version));
  if (versions.size > 1) {
    const lines = entries.map((entry) => `  ${entry.name}@${entry.version} (${entry.file})`);
    problems.push(`The released packages must share one version:\n${lines.join('\n')}`);
    return { version: undefined, problems };
  }

  const [version] = versions;
  if (typeof version !== 'string' || !STABLE_VERSION.test(version)) {
    problems.push(`The shared version must be major.minor.patch, got "${version}".`);
    return { version: undefined, problems };
  }

  const template = readJson(rootDir, SCAFFOLD_TEMPLATE_FILE);
  const expectedRange = `^${version}`;
  const actualRange = template.devDependencies?.[CLI_PACKAGE_NAME];
  if (actualRange !== expectedRange) {
    problems.push(
      `${SCAFFOLD_TEMPLATE_FILE} must depend on ${CLI_PACKAGE_NAME} "${expectedRange}", got "${actualRange}".`
    );
  }

  return { version, problems };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootDir = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { version, problems } = checkVersions(rootDir);
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`${problem}\n`);
    }
    process.stderr.write('See docs/contributor-guide/releasing.md#versioning.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`All released packages are at ${version}.\n`);
  }
}
