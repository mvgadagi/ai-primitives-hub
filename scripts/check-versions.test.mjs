import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkVersions, SCAFFOLD_TEMPLATE_FILE, UNIFIED_PACKAGE_FILES } from './check-versions.mjs';

const SCRIPT = fileURLToPath(new URL('check-versions.mjs', import.meta.url));

const writeJson = (rootDir, relativePath, value) => {
  const file = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

const writeRepo = (rootDir, { versions = {}, version = '1.2.3', cliRange = `^${version}` } = {}) => {
  for (const file of UNIFIED_PACKAGE_FILES) {
    writeJson(rootDir, file, { name: `sample-${path.basename(path.dirname(file))}`, version: versions[file] ?? version });
  }
  writeJson(rootDir, SCAFFOLD_TEMPLATE_FILE, {
    name: '{{packageName}}',
    // `null` means the template has no CLI dependency at all.
    devDependencies: cliRange === null ? {} : { '@ai-primitives-hub/cli': cliRange }
  });
};

const runScript = (rootDir) => {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, rootDir], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
};

describe('check-versions', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'check-versions-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('accepts packages that share a version and a matching scaffold range', () => {
    writeRepo(rootDir);

    assert.deepEqual(checkVersions(rootDir), { version: '1.2.3', problems: [] });
  });

  it('lists every package when one version differs', () => {
    writeRepo(rootDir, { versions: { 'apps/vscode-extension/package.json': '0.0.3' } });

    const { version, problems } = checkVersions(rootDir);

    assert.equal(version, undefined);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /must share one version/);
    assert.match(problems[0], /sample-vscode-extension@0\.0\.3 \(apps\/vscode-extension\/package\.json\)/);
    assert.match(problems[0], /sample-cli@1\.2\.3 \(packages\/cli\/package\.json\)/);
  });

  it('rejects a prerelease shared version', () => {
    writeRepo(rootDir, { version: '1.3.0-alpha.0' });

    assert.deepEqual(checkVersions(rootDir).problems, ['The shared version must be major.minor.patch, got "1.3.0-alpha.0".']);
  });

  it('rejects a scaffold template that asks for an older CLI', () => {
    writeRepo(rootDir, { cliRange: '^0.1.0' });

    const { problems } = checkVersions(rootDir);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /must depend on @ai-primitives-hub\/cli "\^1\.2\.3", got "\^0\.1\.0"/);
  });

  it('rejects a scaffold template without the CLI dependency', () => {
    writeRepo(rootDir, { cliRange: null });

    assert.match(checkVersions(rootDir).problems[0], /got "undefined"/);
  });

  it('exits 0 and prints the shared version from the command line', () => {
    writeRepo(rootDir);

    const result = runScript(rootDir);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'All released packages are at 1.2.3.\n');
  });

  it('exits 1 and explains the mismatch from the command line', () => {
    writeRepo(rootDir, { versions: { 'packages/core/package.json': '1.2.4' } });

    const result = runScript(rootDir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must share one version/);
    assert.match(result.stderr, /releasing\.md#versioning/);
  });
});
