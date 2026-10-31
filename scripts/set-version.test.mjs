import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkVersions, SCAFFOLD_TEMPLATE_FILE, UNIFIED_PACKAGE_FILES } from './check-versions.mjs';
import { bumpVersion, nextVersion } from './set-version.mjs';

const SCRIPT = fileURLToPath(new URL('set-version.mjs', import.meta.url));

const writeText = (rootDir, relativePath, text) => {
  const file = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const readText = (rootDir, relativePath) => readFileSync(path.join(rootDir, relativePath), 'utf8');

// Mirrors the real files: 2-space JSON, a later nested "version" key, trailing newline.
const packageText = (name, version) =>
  `{\n  "name": "${name}",\n  "version": "${version}",\n  "engines": {\n    "vscode": "^1.105.0"\n  },\n  "contributes": { "version": "keep" }\n}\n`;

const templateText = (range) =>
  `{\n  "name": "{{packageName}}",\n  "version": "1.0.0",\n  "devDependencies": {\n    "@ai-primitives-hub/cli": "${range}"\n  }\n}\n`;

const writeRepo = (rootDir, version = '0.2.1') => {
  for (const file of UNIFIED_PACKAGE_FILES) {
    writeText(rootDir, file, packageText(`sample-${path.basename(path.dirname(file))}`, version));
  }
  writeText(rootDir, SCAFFOLD_TEMPLATE_FILE, templateText(`^${version}`));
};

describe('nextVersion', () => {
  it('bumps patch, minor and major', () => {
    assert.equal(nextVersion('0.2.1', 'patch'), '0.2.2');
    assert.equal(nextVersion('0.2.1', 'minor'), '0.3.0');
    assert.equal(nextVersion('0.2.1', 'major'), '1.0.0');
  });

  it('builds a prerelease of the next version', () => {
    assert.equal(nextVersion('0.3.0', 'minor', { preid: 'alpha', build: '42' }), '0.4.0-alpha.42');
  });

  it('rejects an unknown release type', () => {
    assert.throws(() => nextVersion('0.2.1', 'prerelease'), /Unsupported release type "prerelease"/);
  });

  it('rejects an invalid prerelease id or build', () => {
    assert.throws(() => nextVersion('0.2.1', 'patch', { preid: 'al_pha', build: '1' }), /Prerelease id/);
    assert.throws(() => nextVersion('0.2.1', 'patch', { build: '1' }), /Prerelease id/);
    assert.throws(() => nextVersion('0.2.1', 'patch', { preid: 'alpha', build: '0' }), /positive integer/);
    assert.throws(() => nextVersion('0.2.1', 'patch', { preid: 'alpha' }), /positive integer/);
  });
});

describe('bumpVersion', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'set-version-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('writes the next version to every package and the scaffold range', () => {
    writeRepo(rootDir);

    assert.equal(bumpVersion(rootDir, 'minor'), '0.3.0');

    assert.deepEqual(checkVersions(rootDir), { version: '0.3.0', problems: [] });
  });

  it('changes only the version lines', () => {
    writeRepo(rootDir);

    bumpVersion(rootDir, 'patch');

    assert.equal(readText(rootDir, 'apps/vscode-extension/package.json'), packageText('sample-vscode-extension', '0.2.2'));
    assert.equal(readText(rootDir, SCAFFOLD_TEMPLATE_FILE), templateText('^0.2.2'));
  });

  it('refuses to bump packages that do not share a version', () => {
    writeRepo(rootDir);
    writeText(rootDir, 'packages/cli/package.json', packageText('sample-cli', '0.2.0'));

    assert.throws(() => bumpVersion(rootDir, 'patch'), /Fix the shared version before bumping it/);
    assert.match(readText(rootDir, 'packages/core/package.json'), /"version": "0\.2\.1"/);
  });

  it('prints the new version from the command line', () => {
    writeRepo(rootDir);

    const stdout = execFileSync(process.execPath, [SCRIPT, 'major', '--preid', 'beta', '--build', '7', rootDir], {
      encoding: 'utf8'
    });

    assert.equal(stdout, '1.0.0-beta.7\n');
    assert.match(readText(rootDir, 'packages/infra/package.json'), /"version": "1\.0\.0-beta\.7"/);
  });

  it('exits 1 with the reason from the command line', () => {
    writeRepo(rootDir);

    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, 'prerelease', rootDir], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => error.status === 1 && /Unsupported release type/.test(error.stderr)
    );
  });
});
