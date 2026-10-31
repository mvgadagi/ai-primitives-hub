/**
 * Extension record adapter contract (U3; BR11.4–BR11.6, NFR4.12,
 * NFR4.13, NFR4.15, NFR5.2).
 *
 * The extension runs as the `vscode` host and installs, updates, uninstalls
 * and switches a repository bundle through `BundleInstaller`,
 * `RegistryManager` and `BundleScopeCommands` against a real temp git root.
 * Other tools' entries are written through the adapter's own
 * `InstallRecordService`; old `prompt-registry` files through app's
 * `json-lockfile-store`. Only `vscode.window`, the workspace lookup and
 * `RegistryStorage` (the configured sources) are stubbed in that suite.
 *
 * Covered elsewhere: refusing actions on an entry only `kiro` holds
 * (`cli-managed-guard.test.ts`).
 *
 * The user record suite (U4; BR14.1, BR14.3, BR16.x) installs a user-scope
 * bundle through `RegistryManager.installBundle` from a configured local
 * source into a temp `HOME` (the profile-retirement case through
 * `BundleInstaller.installFromBuffer`, so `installBundle`'s old-version
 * cleanup cannot remove the RegistryStorage entry for it); `XDG_CONFIG_HOME`
 * is a per-test temp folder (`test/unit.setup.js`), so the shared user record
 * is never the real one. `RegistryStorage` is real there (its folder is the
 * temp `globalStorageUri`).
 *
 * The older-records suite (U5; BR18.1, BR19.1, BR20.2, BR21.4, BR22.2)
 * runs `RegistryManager` against a real temp git root, a temp `HOME` and a
 * real `RegistryStorage` with a configured local source: a write action
 * migrates the old `prompt-registry.lock.json` or this profile's
 * RegistryStorage user entries first, a migrated `unknown` entry is updated,
 * uninstalled or refused, and each report is shown once per `globalState` key.
 */
import * as assert from 'node:assert';
import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  pathToFileURL,
} from 'node:url';
import {
  emptyLockfile,
  type LockfileFs,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
} from '@ai-primitives-hub/app';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleScopeCommands,
} from '../../src/commands/bundle-scope-commands';
import type {
  BundleInstaller,
} from '../../src/services/bundle-installer';
import {
  ExtensionRecordAdapter,
  MIGRATION_LOG_PREFIX,
} from '../../src/services/extension-record-adapter';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  ScopeConflictResolver,
} from '../../src/services/scope-conflict-resolver';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  VsCodeAppStorage,
} from '../../src/storage/vscode-app-storage';
import type {
  Bundle,
  InstalledBundle,
  RegistrySource,
  RepositoryCommitMode,
} from '../../src/types/registry';
import {
  Logger,
} from '../../src/utils/logger';
import {
  createMockContext,
  initGitRoot,
  LOCAL_RECORD_FILE,
  overrideEnv,
  RECORD_FILE,
  snapshotTree,
} from '../helpers/install-record-test-helpers';

const BUNDLE_ID = 'record-bundle';
const OLD_LOCKFILE = 'prompt-registry.lock.json';
const HELLO = '.github/prompts/hello.prompt.md';
const STYLE = '.github/instructions/style.instructions.md';
const SOURCE = { id: 'acme-github', name: 'Acme', type: 'github', url: 'https://github.com/acme/tools', enabled: true, priority: 0 };

/** A bundle version: its bundle-relative files and manifest items. */
interface BundleVersion {
  version: string;
  files: Record<string, string>;
  items: { id: string; file: string; type: string }[];
}

/** 1.0.0 writes a prompt and an instruction. */
const V1: BundleVersion = {
  version: '1.0.0',
  files: { 'prompts/hello.prompt.md': '# Hello 1.0.0\n', 'instructions/style.instructions.md': 'Use strict TypeScript.\n' },
  items: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }, { id: 'style', file: 'instructions/style.instructions.md', type: 'instructions' }]
};

/** 1.1.0 changes the prompt and drops the instruction. */
const V2: BundleVersion = {
  version: '1.1.0',
  files: { 'prompts/hello.prompt.md': '# Hello 1.1.0\n' },
  items: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }]
};

/**
 * Record checksum of a text.
 * @param text - File content.
 */
const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/**
 * Deployment manifest of a bundle version.
 * @param bundle - Bundle version.
 * @param bundleId - Bundle id the manifest declares.
 */
const manifestOf = (bundle: BundleVersion, bundleId = BUNDLE_ID): string => {
  const prompts = bundle.items.map((item) => `  - id: ${item.id}\n    file: ${item.file}\n    type: ${item.type}\n`).join('');
  return `id: ${bundleId}\nversion: ${bundle.version}\nname: Record Bundle\ndescription: Test\nauthor: test\nprompts:\n${prompts}`;
};

/**
 * Zip a bundle version with its deployment manifest.
 * @param bundle - Bundle version.
 * @param bundleId - Bundle id the manifest declares.
 */
const zipOf = (bundle: BundleVersion, bundleId = BUNDLE_ID): Buffer => {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('deployment-manifest.yml', Buffer.from(manifestOf(bundle, bundleId)));
  for (const [file, content] of Object.entries(bundle.files)) {
    zip.addFile(file, Buffer.from(content));
  }
  return zip.toBuffer();
};

/**
 * Write a bundle version's folder: its manifest and files.
 * @param dir - Bundle folder.
 * @param bundle - Bundle version.
 * @param bundleId - Bundle id the manifest declares.
 */
const writeBundleDir = (dir: string, bundle: BundleVersion, bundleId = BUNDLE_ID): void => {
  for (const [file, content] of Object.entries({ 'deployment-manifest.yml': manifestOf(bundle, bundleId), ...bundle.files })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
};

/** `LockfileFs` over Node's filesystem, for writing old-file fixtures. */
const nodeLockfileFs: LockfileFs = {
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  writeFile: (file, contents) => fs.promises.writeFile(file, contents),
  exists: (file) => Promise.resolve(fs.existsSync(file)),
  mkdir: async (dir, options) => {
    await fs.promises.mkdir(dir, options);
  }
};

suite('ExtensionRecordAdapter: repository installs through the extension', function () {
  this.timeout(20_000);

  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;
  let root: string;
  let manager: RegistryManager;
  let installer: BundleInstaller;
  let showError: sinon.SinonStub;
  let showInfo: sinon.SinonStub;
  let showWarning: sinon.SinonStub;

  const abs = (relative: string): string => path.join(root, ...relative.split('/'));
  const read = (relative: string): string => fs.readFileSync(abs(relative), 'utf8');
  const readRecord = (file: string = RECORD_FILE): any => fs.existsSync(abs(file)) ? JSON.parse(read(file)) : null;
  const toolsOf = (file: string = RECORD_FILE, bundleId = BUNDLE_ID): Record<string, any> => readRecord(file)?.bundles[bundleId]?.tools ?? {};

  const bundleOf = (version: string, sourceId = SOURCE.id): Bundle => ({
    id: BUNDLE_ID, name: 'Record Bundle', version, description: 'Test', author: 'test', sourceId,
    environments: [], tags: [], lastUpdated: '', size: '', dependencies: [], license: 'MIT', manifestUrl: '', downloadUrl: ''
  });

  const install = (bundle: BundleVersion, options: { commitMode?: RepositoryCommitMode; sourceId?: string } = {}): Promise<InstalledBundle> =>
    installer.installFromBuffer(bundleOf(bundle.version, options.sourceId), zipOf(bundle), { scope: 'repository', commitMode: options.commitMode ?? 'commit' }, 'github');

  const listed = async (): Promise<InstalledBundle> => {
    const item = (await manager.listInstalledBundles('repository')).find((bundle) => bundle.bundleId === BUNDLE_ID);
    assert.ok(item, `${BUNDLE_ID} is listed`);
    return item;
  };

  const update = async (bundle: BundleVersion): Promise<void> => {
    await installer.update(await listed(), bundleOf(bundle.version), zipOf(bundle), 'github');
  };

  /**
   * Record another tool's entry in the committed record file, as that tool's own install would.
   * @param tool - Tool key.
   * @param files - Root-relative files; created when missing.
   * @param bundleId - Bundle id.
   */
  const recordOtherTool = async (tool: string, files: string[], bundleId = BUNDLE_ID): Promise<void> => {
    for (const file of files.filter((candidate) => !fs.existsSync(abs(candidate)))) {
      fs.mkdirSync(path.dirname(abs(file)), { recursive: true });
      fs.writeFileSync(abs(file), `# ${tool}\n`);
    }
    const adapter = manager.getRecordAdapter();
    const [committed] = await adapter.locations(root);
    await adapter.service.recordInstall({
      location: committed, bundleId, version: '1.0.0', tool,
      source: { sourceId: SOURCE.id, type: 'github', url: SOURCE.url }, sourceType: 'github',
      writtenPaths: files.map((file) => abs(file)), syncSiblings: false
    });
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-record-')));
    root = path.join(tempRoot, 'repo');
    fs.mkdirSync(root, { recursive: true });
    initGitRoot(root);

    (RegistryManager as any).instance = undefined;
    manager = RegistryManager.getInstance({
      ...createMockContext(sandbox),
      globalStorageUri: vscode.Uri.file(path.join(tempRoot, 'global'))
    });
    const storage = sandbox.createStubInstance(RegistryStorage);
    storage.getSources.resolves([SOURCE] as any);
    storage.getInstalledBundles.resolves([]);
    storage.getInstalledBundle.resolves(undefined);
    storage.getCachedSourceBundles.resolves([]);
    (manager as any).storage = storage;
    installer = manager.getBundleInstaller();

    const scopeSelectionUI = require('../../src/utils/scope-selection-ui');
    sandbox.stub(scopeSelectionUI, 'getWorkspaceRoot').returns(root);
    sandbox.stub(scopeSelectionUI, 'hasOpenWorkspace').returns(true);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(root), name: 'repo', index: 0 }]);
    showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
    (RegistryManager as any).instance = undefined;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('install records the vscode entry with the written files and the configured source', async () => {
    await install(V1);

    const record = readRecord();
    const { installedAt, ...entry } = record.bundles[BUNDLE_ID].tools.vscode;
    assert.deepStrictEqual(Object.keys(record.bundles[BUNDLE_ID].tools), ['vscode']);
    assert.ok(!Number.isNaN(Date.parse(installedAt)));
    assert.deepStrictEqual(entry, {
      version: '1.0.0',
      sourceId: SOURCE.id,
      sourceType: 'github',
      files: [
        { path: STYLE, checksum: sha256(V1.files['instructions/style.instructions.md']) },
        { path: HELLO, checksum: sha256(V1.files['prompts/hello.prompt.md']) }
      ]
    });
    assert.deepStrictEqual(record.sources[SOURCE.id], { type: 'github', url: SOURCE.url });
    assert.strictEqual(read(HELLO), V1.files['prompts/hello.prompt.md']);
  });

  const refusedInstalls: { name: string; arrange: () => void; sourceId?: string; expected: RegExp | { code: string }; errorShown: boolean }[] = [
    { name: 'an unconfigured source id', arrange: () => undefined, sourceId: 'not-configured', expected: /source not-configured is not configured/, errorShown: false },
    {
      name: 'a RECORD.MALFORMED record',
      arrange: () => fs.writeFileSync(abs(RECORD_FILE), '{ "version": '),
      expected: { code: 'RECORD.MALFORMED' },
      errorShown: true
    }
  ];

  refusedInstalls.forEach(({ name, arrange, sourceId, expected, errorShown }) => {
    test(`install with ${name} is refused before any file is written`, async () => {
      arrange();
      const before = snapshotTree(root);

      await assert.rejects(install(V1, { sourceId }), expected);

      assert.deepStrictEqual(snapshotTree(root), before);
      assert.ok(!fs.existsSync(path.join(tempRoot, 'global', 'bundles')), 'no bundle cache written');
      assert.strictEqual(showError.callCount, errorShown ? 1 : 0);
      if (errorShown) {
        assert.ok(String(showError.firstCall.args[0]).includes(RECORD_FILE), String(showError.firstCall.args[0]));
      }
    });
  });

  test('uninstall removes only the vscode entry; the kiro entry and its files stay byte-identical', async () => {
    await install(V1);
    await recordOtherTool('kiro', ['.kiro/steering/hello.md']);
    const kiroBefore = JSON.stringify(toolsOf().kiro);
    const kiroFile = read('.kiro/steering/hello.md');

    await manager.uninstallBundle(BUNDLE_ID, 'repository');

    assert.deepStrictEqual(Object.keys(toolsOf()), ['kiro']);
    assert.strictEqual(JSON.stringify(toolsOf().kiro), kiroBefore);
    assert.strictEqual(read('.kiro/steering/hello.md'), kiroFile);
    assert.ok(!fs.existsSync(abs(HELLO)) && !fs.existsSync(abs(STYLE)), 'vscode files deleted');
  });

  const modifiedFileCases: { action: string; run: () => Promise<void>; vscodeAfter: string[] | undefined }[] = [
    { action: 'uninstall', run: () => manager.uninstallBundle(BUNDLE_ID, 'repository'), vscodeAfter: undefined },
    { action: 'update', run: () => update(V2), vscodeAfter: [HELLO] }
  ];

  modifiedFileCases.forEach(({ action, run, vscodeAfter }) => {
    test(`${action} keeps a locally modified file it would otherwise delete`, async () => {
      await install(V1);
      fs.writeFileSync(abs(STYLE), 'My own rules.\n');

      await run();

      assert.strictEqual(read(STYLE), 'My own rules.\n');
      assert.deepStrictEqual(toolsOf().vscode?.files.map((file: { path: string }) => file.path), vscodeAfter);
    });
  });

  test('update in place moves a copilot-cli sibling to the new version and deletes its dropped file; a kiro sibling is reported out of date', async () => {
    await install(V1);
    await recordOtherTool('copilot-cli', [HELLO, STYLE]);
    await recordOtherTool('kiro', [HELLO]);
    const kiroBefore = toolsOf().kiro;

    await update(V2);

    const tools = toolsOf();
    assert.deepStrictEqual(Object.keys(tools).toSorted(), ['copilot-cli', 'kiro', 'vscode']);
    for (const tool of ['vscode', 'copilot-cli']) {
      assert.strictEqual(tools[tool].version, '1.1.0', tool);
      assert.deepStrictEqual(tools[tool].files, [{ path: HELLO, checksum: sha256(V2.files['prompts/hello.prompt.md']) }], tool);
    }
    assert.deepStrictEqual(tools.kiro, kiroBefore);
    assert.ok(!fs.existsSync(abs(STYLE)), 'the dropped file is deleted');
    assert.strictEqual(read(HELLO), V2.files['prompts/hello.prompt.md']);
    const message = String(showInfo.firstCall?.args[0]);
    assert.ok(showInfo.calledOnce && message.includes('kiro (1.0.0)') && message.includes('out of date'), message);
  });

  test('commit-mode switch moves the entry unchanged to the local-only file and excludes only paths no committed entry lists', async () => {
    await install(V1);
    await recordOtherTool('copilot-cli', [HELLO]);
    fs.writeFileSync(abs(STYLE), 'My own rules.\n');
    const vscodeBefore = toolsOf().vscode;
    showWarning.resolves('Switch');
    const repositoryScopeService = installer.createRepositoryScopeService();
    assert.ok(repositoryScopeService);

    await new BundleScopeCommands(manager, sandbox.createStubInstance(ScopeConflictResolver), repositoryScopeService)
      .switchCommitMode(BUNDLE_ID, 'local-only');

    assert.deepStrictEqual(toolsOf(LOCAL_RECORD_FILE).vscode, vscodeBefore, 'moved unchanged, modified file checksum included');
    assert.deepStrictEqual(Object.keys(toolsOf()), ['copilot-cli']);
    const exclude = read('.git/info/exclude').split('\n');
    assert.ok(exclude.includes(STYLE), exclude.join('\n'));
    assert.ok(!exclude.includes(HELLO), exclude.join('\n'));
  });
});

suite('user record (U4)', function () {
  this.timeout(20_000);

  /** Home-relative files the vscode user layout writes for {@link V1}. */
  const USER_HELLO = '.copilot/prompts/hello.prompt.md';
  const USER_STYLE = '.copilot/instructions/style.instructions.md';
  const WSL_LOG = 'The shared user record is not used in WSL';

  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;
  let home: string;
  let globalStorage: string;
  let localSource: RegistrySource;
  let manager: RegistryManager;
  let storage: RegistryStorage;
  let showError: sinon.SinonStub;
  let restoreEnv: () => void;

  const userPath = (relative: string): string => path.join(home, ...relative.split('/'));
  const userRecordPath = (): string => storage.getPaths().userRecord;
  const readUserRecord = (): any => fs.existsSync(userRecordPath()) ? JSON.parse(fs.readFileSync(userRecordPath(), 'utf8')) : null;
  const listedUser = async (): Promise<InstalledBundle | undefined> =>
    (await manager.listInstalledBundles('user')).find((bundle) => bundle.bundleId === BUNDLE_ID);
  const installUser = (): Promise<InstalledBundle> => manager.installBundle(BUNDLE_ID, { scope: 'user' });
  /** The 1.0.0 bundle as the configured local source lists it. */
  const v1Bundle = (): Bundle => {
    const bundleDir = path.join(localSource.url, BUNDLE_ID);
    return {
      id: BUNDLE_ID, name: 'Record Bundle', version: V1.version, description: 'Test', author: 'test', sourceId: localSource.id,
      environments: [], tags: [], lastUpdated: '', size: '', dependencies: [], license: 'MIT',
      manifestUrl: pathToFileURL(path.join(bundleDir, 'deployment-manifest.yml')).href, downloadUrl: pathToFileURL(bundleDir).href
    };
  };

  setup(async () => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-user-record-')));
    home = path.join(tempRoot, 'home');
    fs.mkdirSync(home, { recursive: true });
    restoreEnv = overrideEnv({ HOME: home, USERPROFILE: home });
    // `User/globalStorage/<id>`, so the user MCP config derived from it stays in the temp folder.
    globalStorage = path.join(tempRoot, 'User', 'globalStorage', 'acme.extension');

    // A configured local source holding the bundle at 1.0.0, in the source cache.
    const sourceDir = path.join(tempRoot, 'source');
    writeBundleDir(path.join(sourceDir, BUNDLE_ID), V1);
    localSource = { id: 'acme-local', name: 'Acme local', type: 'local', url: sourceDir, enabled: true, priority: 0 };

    (RegistryManager as any).instance = undefined;
    manager = RegistryManager.getInstance({ ...createMockContext(sandbox), globalStorageUri: vscode.Uri.file(globalStorage) });
    storage = manager.getStorage();
    await storage.initialize();
    await storage.addSource(localSource);
    await storage.cacheSourceBundles(localSource.id, [v1Bundle()]);

    showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
    restoreEnv();
    (RegistryManager as any).instance = undefined;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('the user record path is under XDG_CONFIG_HOME, not under globalStorageUri', () => {
    const userRecord = new VsCodeAppStorage({ ...createMockContext(sandbox), globalStorageUri: vscode.Uri.file(globalStorage) }).getPaths().userRecord;

    assert.strictEqual(userRecord, path.join(process.env.XDG_CONFIG_HOME ?? '', 'ai-primitives-hub', 'ai-primitives-hub.user.lock.json'));
    assert.ok(!userRecord.startsWith(globalStorage), userRecord);
  });

  test('a user-scope install records the vscode entry with home-relative paths in the user record, not in RegistryStorage', async () => {
    const recordInstallation = sandbox.spy(RegistryStorage.prototype, 'recordInstallation');

    await installUser();

    const record = readUserRecord();
    const { installedAt, ...entry } = record.bundles[BUNDLE_ID].tools.vscode;
    assert.deepStrictEqual(Object.keys(record.bundles[BUNDLE_ID].tools), ['vscode']);
    assert.ok(!Number.isNaN(Date.parse(installedAt)));
    assert.deepStrictEqual(entry, {
      version: '1.0.0',
      sourceId: localSource.id,
      sourceType: 'local',
      files: [
        { path: USER_STYLE, checksum: sha256(V1.files['instructions/style.instructions.md']) },
        { path: USER_HELLO, checksum: sha256(V1.files['prompts/hello.prompt.md']) }
      ]
    });
    assert.strictEqual(fs.readFileSync(userPath(USER_HELLO), 'utf8'), V1.files['prompts/hello.prompt.md']);
    assert.strictEqual(recordInstallation.callCount, 0, 'RegistryStorage.recordInstallation is not called');
    assert.deepStrictEqual(await storage.getInstalledBundles('user'), []);
  });

  test('an action on a bundle only copilot-cli holds in the user record is refused with RECORD.CLI_MANAGED; the record is unchanged', async () => {
    const adapter = new ExtensionRecordAdapter({
      sources: { listSources: () => Promise.resolve([localSource]) },
      hostTool: 'vscode',
      userRecordPath: userRecordPath(),
      env: { HOME: home }
    });
    const location = adapter.userLocation();
    for (const [bundleId, tool, file] of [['vscode-bundle', 'vscode', '.copilot/prompts/mine.prompt.md'], [BUNDLE_ID, 'copilot-cli', '.copilot/prompts/cli.prompt.md']]) {
      fs.mkdirSync(path.dirname(userPath(file)), { recursive: true });
      fs.writeFileSync(userPath(file), `# ${tool}\n`);
      await adapter.service.recordInstall({
        location, bundleId, version: '1.0.0', tool,
        source: { sourceId: localSource.id, type: 'local', url: localSource.url }, sourceType: 'local',
        writtenPaths: [userPath(file)], workspaceRoot: home, syncSiblings: false
      });
    }
    const before = fs.readFileSync(userRecordPath(), 'utf8');

    await assert.rejects(adapter.assertUserHostTool(BUNDLE_ID, 'uninstall'), (error: Error & { code?: string }) => {
      assert.strictEqual(error.code, 'RECORD.CLI_MANAGED');
      assert.ok(error.message.includes('copilot-cli') && error.message.includes('user target'), error.message);
      return true;
    });

    assert.strictEqual(fs.readFileSync(userRecordPath(), 'utf8'), before);
  });

  test('a user-scope install retires this profile\'s RegistryStorage entry; a shared path and a regular file only the old entry lists stay', async () => {
    // The profile's own 0.9.0 install: its bundle cache, a symlink into it and the RegistryStorage entry.
    const cacheDir = path.join(globalStorage, 'bundles', BUNDLE_ID);
    const oldVersion: BundleVersion = {
      version: '0.9.0',
      files: { 'prompts/hello.prompt.md': '# Hello 0.9.0\n', 'prompts/old.prompt.md': '# Old\n' },
      items: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }, { id: 'old', file: 'prompts/old.prompt.md', type: 'prompt' }]
    };
    writeBundleDir(cacheDir, oldVersion);
    const shared = userPath(USER_HELLO);
    const oldOnly = userPath('.copilot/prompts/old.prompt.md');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.symlinkSync(path.join(cacheDir, 'prompts', 'hello.prompt.md'), shared, 'file');
    fs.writeFileSync(oldOnly, 'My own copy.\n');
    await storage.recordInstallation({
      bundleId: BUNDLE_ID, version: '0.9.0', installedAt: '2026-10-01T10:00:00.000Z', scope: 'user', installPath: cacheDir,
      manifest: {} as InstalledBundle['manifest'], sourceId: localSource.id, sourceType: 'local'
    });
    assert.strictEqual((await listedUser())?.version, '0.9.0');
    assert.strictEqual(readUserRecord(), null);

    // Through the installer, so only the install's own retirement can remove the
    // RegistryStorage entry (not `installBundle`'s old-version cleanup).
    await manager.getBundleInstaller().installFromBuffer(v1Bundle(), zipOf(V1), { scope: 'user' }, 'local');

    assert.strictEqual(await storage.getInstalledBundle(BUNDLE_ID, 'user'), undefined, 'the RegistryStorage entry is retired');
    assert.strictEqual(fs.readFileSync(shared, 'utf8'), V1.files['prompts/hello.prompt.md'], 'the path both list stays');
    assert.ok(!fs.lstatSync(oldOnly).isSymbolicLink() && fs.readFileSync(oldOnly, 'utf8') === 'My own copy.\n', 'the regular file stays');
    const listed = await listedUser();
    assert.deepStrictEqual({ version: listed?.version, recordOrigin: listed?.recordOrigin }, { version: '1.0.0', recordOrigin: 'install-record' });

    await manager.uninstallBundle(BUNDLE_ID, 'user');

    assert.strictEqual(await listedUser(), undefined);
  });

  test('concurrent user-scope installs of different bundles all end up in the user record under vscode', async () => {
    const ids = ['concurrent-a', 'concurrent-b', 'concurrent-c'];
    const installer = manager.getBundleInstaller();

    await Promise.all(ids.map((id) => {
      const version: BundleVersion = {
        version: '1.0.0',
        files: { [`prompts/${id}.prompt.md`]: `# ${id}\n` },
        items: [{ id, file: `prompts/${id}.prompt.md`, type: 'prompt' }]
      };
      return installer.installFromBuffer({ ...v1Bundle(), id }, zipOf(version, id), { scope: 'user' }, 'local');
    }));

    const record = readUserRecord();
    assert.deepStrictEqual(Object.keys(record.bundles).toSorted(), ids);
    for (const id of ids) {
      assert.deepStrictEqual(Object.keys(record.bundles[id].tools), ['vscode'], id);
      assert.deepStrictEqual(record.bundles[id].tools.vscode.files.map((file: { path: string }) => file.path), [`.copilot/prompts/${id}.prompt.md`], id);
    }
  });

  test('a profile activated at user scope is recorded only in the user record; deactivating it uninstalls its bundles and files', async () => {
    const ids = ['profile-a', 'profile-b'];
    const files = ids.map((id) => userPath(`.copilot/prompts/${id}.prompt.md`));
    const bundles = ids.map((id, index): Bundle => {
      const dir = path.join(localSource.url, id);
      writeBundleDir(dir, { version: '1.0.0', files: { [`prompts/${id}.prompt.md`]: `# ${id}\n` }, items: [{ id, file: `prompts/${id}.prompt.md`, type: 'prompt' }] }, id);
      return { ...v1Bundle(), id, name: `Team bundle ${index}`, manifestUrl: pathToFileURL(path.join(dir, 'deployment-manifest.yml')).href, downloadUrl: pathToFileURL(dir).href };
    });
    await storage.cacheSourceBundles(localSource.id, [v1Bundle(), ...bundles]);
    await storage.addProfile({
      id: 'team', name: 'Team', description: '', icon: '', active: false, createdAt: '', updatedAt: '',
      bundles: ids.map((id) => ({ id, version: '1.0.0', sourceId: localSource.id, required: true }))
    });
    const recordInstallation = sandbox.spy(RegistryStorage.prototype, 'recordInstallation');

    await manager.activateProfile('team');

    assert.strictEqual(recordInstallation.callCount, 0, 'RegistryStorage.recordInstallation is not called');
    assert.deepStrictEqual(await storage.getInstalledBundles('user'), []);
    assert.deepStrictEqual(ids.map((id) => Object.keys(readUserRecord()?.bundles[id]?.tools ?? {})), [['vscode'], ['vscode']]);
    assert.ok(files.every((file) => fs.existsSync(file)), 'both bundles are installed');

    await manager.deactivateProfile('team');

    assert.deepStrictEqual(ids.filter((id) => readUserRecord()?.bundles[id] !== undefined), [], 'both are gone from the user record');
    assert.deepStrictEqual(files.filter((file) => fs.existsSync(file)), [], 'their files are removed');
  });

  test('a hub profile activated at user scope is recorded in the user record; activating another hub profile uninstalls its bundle and files', async () => {
    const hubStorage = new HubStorage(path.join(tempRoot, 'hubs'));
    const hubManager = new HubManager(hubStorage, {} as any, process.cwd(), undefined, manager);
    manager.setHubManager(hubManager);
    const hubProfile = (id: string, bundleIds: string[]) => ({
      id, name: id, description: '', icon: '', active: false, createdAt: '', updatedAt: '',
      bundles: bundleIds.map((bundleId) => ({ id: bundleId, version: '1.0.0', source: localSource.id, required: true }))
    });
    await hubStorage.saveHub('acme-hub', {
      version: '1.0.0', metadata: { name: 'Acme hub', description: '', maintainer: 'test', updatedAt: '' }, sources: [],
      profiles: [hubProfile('hub-team', [BUNDLE_ID]), hubProfile('hub-empty', [])]
    }, { type: 'local', location: path.join(tempRoot, 'hub') });
    await hubStorage.setActiveHubId('acme-hub');

    await hubManager.activateProfile('acme-hub', 'hub-team', { installBundles: true });

    assert.deepStrictEqual(await storage.getInstalledBundles('user'), []);
    assert.deepStrictEqual(Object.keys(readUserRecord()?.bundles[BUNDLE_ID]?.tools ?? {}), ['vscode']);
    assert.ok(fs.existsSync(userPath(USER_HELLO)), 'the bundle is installed');

    await hubManager.activateProfile('acme-hub', 'hub-empty', { installBundles: true });

    assert.strictEqual(readUserRecord()?.bundles[BUNDLE_ID], undefined, 'the bundle is gone from the user record');
    assert.ok(!fs.existsSync(userPath(USER_HELLO)) && !fs.existsSync(userPath(USER_STYLE)), 'its files are removed');
  });

  test('a user-scope install from a local-skills source records the skill folder files in the user record; uninstall removes them', async () => {
    const skillsSource: RegistrySource = { id: 'acme-skills', name: 'Acme skills', type: 'local-skills', url: path.join(tempRoot, 'skills'), enabled: true, priority: 0 };
    await storage.addSource(skillsSource);
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addFile('skills/review/SKILL.md', Buffer.from('---\nname: review\n---\n# Review\n'));
    zip.addFile('skills/review/checklist.md', Buffer.from('- tests\n'));
    const recordInstallation = sandbox.spy(RegistryStorage.prototype, 'recordInstallation');

    const installed = await manager.getBundleInstaller().installFromBuffer(
      { ...v1Bundle(), id: 'review-skill', sourceId: skillsSource.id }, zip.toBuffer(), { scope: 'user' }, 'local-skills');

    assert.strictEqual(installed.recordOrigin, 'install-record');
    assert.deepStrictEqual(readUserRecord().bundles['review-skill'].tools.vscode.files.map((file: { path: string }) => file.path).toSorted(),
      ['.copilot/skills/review/SKILL.md', '.copilot/skills/review/checklist.md']);
    assert.strictEqual(recordInstallation.callCount, 0, 'RegistryStorage.recordInstallation is not called');

    await manager.uninstallBundle('review-skill', 'user');

    assert.strictEqual(readUserRecord()?.bundles['review-skill'], undefined);
    assert.ok(!fs.existsSync(userPath('.copilot/skills/review/SKILL.md')) && !fs.existsSync(userPath('.copilot/skills/review/checklist.md')), 'the skill files are removed');
  });

  test('a user-scope skill install writes over a skill folder a copilot-cli user entry lists without the overwrite prompt; its files and both entries stay', async () => {
    const skillsSource: RegistrySource = { id: 'acme-skills', name: 'Acme skills', type: 'local-skills', url: path.join(tempRoot, 'skills'), enabled: true, priority: 0 };
    await storage.addSource(skillsSource);
    const skill = { 'SKILL.md': '---\nname: review\n---\n# Review\n', 'checklist.md': '- tests\n' };
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    // The CLI's copilot-cli entry for the same skill files, in the shared `~/.copilot/skills`.
    const cliFiles = Object.entries(skill).map(([name, content]) => {
      zip.addFile(`skills/review/${name}`, Buffer.from(content));
      const file = userPath(`.copilot/skills/review/${name}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    });
    const adapter = new ExtensionRecordAdapter({
      sources: { listSources: () => Promise.resolve([skillsSource]) },
      hostTool: 'vscode',
      userRecordPath: userRecordPath(),
      env: { HOME: home }
    });
    await adapter.service.recordInstall({
      location: adapter.userLocation(), bundleId: 'review-skill', version: '1.0.0', tool: 'copilot-cli',
      source: { sourceId: skillsSource.id, type: 'local-skills', url: skillsSource.url }, sourceType: 'local-skills',
      writtenPaths: cliFiles, workspaceRoot: home, syncSiblings: false
    });
    const showWarning = vscode.window.showWarningMessage as sinon.SinonStub;

    await manager.getBundleInstaller().installFromBuffer(
      { ...v1Bundle(), id: 'review-skill', sourceId: skillsSource.id }, zip.toBuffer(), { scope: 'user' }, 'local-skills');

    assert.ok(!showWarning.getCalls().some((call) => String(call.args[0]).includes('already exists')), 'no overwrite prompt');
    assert.deepStrictEqual(cliFiles.filter((file) => !fs.existsSync(file)), [], 'the copilot-cli entry\'s files stay');
    assert.deepStrictEqual(Object.keys(readUserRecord().bundles['review-skill'].tools).toSorted(), ['copilot-cli', 'vscode']);
  });

  test('a user-scope uninstall after ~/.copilot is re-pointed outside home is refused with RECORD.PATH_OUTSIDE_ROOT; the outside file stays', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    await installUser();
    const outside = path.join(tempRoot, 'outside-copilot');
    fs.cpSync(userPath('.copilot'), outside, { recursive: true });
    fs.rmSync(userPath('.copilot'), { recursive: true });
    fs.symlinkSync(outside, userPath('.copilot'), 'dir');

    await assert.rejects(manager.uninstallBundle(BUNDLE_ID, 'user'), { code: 'RECORD.PATH_OUTSIDE_ROOT' });

    assert.strictEqual(fs.readFileSync(path.join(outside, 'prompts', 'hello.prompt.md'), 'utf8'), V1.files['prompts/hello.prompt.md']);
  });

  test('a user-scope install with a malformed user record shows one error naming the file and writes nothing to the user folders', async () => {
    const malformed = '{ "version": "3.0.0", ';
    fs.mkdirSync(path.dirname(userRecordPath()), { recursive: true });
    fs.writeFileSync(userRecordPath(), malformed);

    await assert.rejects(installUser(), { code: 'RECORD.MALFORMED' });

    assert.deepStrictEqual(snapshotTree(home), new Map(), 'nothing written under home');
    assert.strictEqual(fs.readFileSync(userRecordPath(), 'utf8'), malformed);
    assert.strictEqual(showError.callCount, 1);
    assert.ok(String(showError.firstCall.args[0]).includes(userRecordPath()), String(showError.firstCall.args[0]));
  });

  test('in WSL a user-scope install is recorded in RegistryStorage, the user record is never created, and that is logged once', async () => {
    sandbox.stub(vscode.env, 'remoteName').value('wsl');
    const info = sandbox.stub(Logger.getInstance(), 'info');

    await installUser();
    await manager.listInstalledBundles('user');

    assert.strictEqual((await storage.getInstalledBundle(BUNDLE_ID, 'user'))?.version, '1.0.0');
    assert.ok(!fs.existsSync(userRecordPath()), 'no user record');
    assert.strictEqual(info.getCalls().filter((call) => String(call.args[0]).includes(WSL_LOG)).length, 1);
  });
});

suite('older records (U5)', function () {
  this.timeout(20_000);

  const OTHER_ID = 'other-bundle';
  /** File the old `prompt-registry.lock.json` entry lists, root-relative. */
  const OLD_FILE = '.github/prompts/old.prompt.md';
  /** Home-relative file this profile's 0.9.0 install synced. */
  const USER_HELLO = '.copilot/prompts/hello.prompt.md';
  /** The other bundle: one prompt of its own. */
  const OTHER: BundleVersion = {
    version: '1.0.0',
    files: { 'prompts/other.prompt.md': '# Other\n' },
    items: [{ id: 'other', file: 'prompts/other.prompt.md', type: 'prompt' }]
  };
  /** This profile's RegistryStorage install of the bundle. */
  const V0: BundleVersion = {
    version: '0.9.0',
    files: { 'prompts/hello.prompt.md': '# Hello 0.9.0\n' },
    items: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }]
  };

  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;
  let root: string;
  let home: string;
  let globalStorage: string;
  let localSource: RegistrySource;
  let manager: RegistryManager;
  let storage: RegistryStorage;
  let shown: Map<string, unknown>;
  let showInfo: sinon.SinonStub;
  let showWarning: sinon.SinonStub;
  let restoreEnv: () => void;

  /** `globalState` over {@link shown}, so two adapters can share it. */
  const globalState = (): Pick<vscode.Memento, 'get' | 'update'> => ({
    get: <T>(key: string): T | undefined => shown.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      shown.set(key, value);
      return Promise.resolve();
    }
  });
  const abs = (relative: string): string => path.join(root, ...relative.split('/'));
  const userPath = (relative: string): string => path.join(home, ...relative.split('/'));
  const readRecord = (): any => fs.existsSync(abs(RECORD_FILE)) ? JSON.parse(fs.readFileSync(abs(RECORD_FILE), 'utf8')) : null;
  const readUserRecord = (): any => {
    const file = storage.getPaths().userRecord;
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  const messages = (): string[] => [...showInfo.getCalls(), ...showWarning.getCalls()].map((call) => String(call.args[0]));

  /**
   * A bundle of the configured local source at 1.0.0.
   * @param bundleId - Bundle id.
   */
  const sourceBundle = (bundleId: string): Bundle => {
    const dir = path.join(localSource.url, bundleId);
    return {
      id: bundleId, name: bundleId, version: V1.version, description: 'Test', author: 'test', sourceId: localSource.id,
      environments: [], tags: [], lastUpdated: '', size: '', dependencies: [], license: 'MIT',
      manifestUrl: pathToFileURL(path.join(dir, 'deployment-manifest.yml')).href, downloadUrl: pathToFileURL(dir).href
    };
  };

  /**
   * Write `prompt-registry.lock.json` at the git root with the bundle at 0.9.0, listing {@link OLD_FILE}.
   * @param bundleId - Bundle id.
   */
  const writeOldLockfile = async (bundleId: string): Promise<void> => {
    fs.mkdirSync(path.dirname(abs(OLD_FILE)), { recursive: true });
    fs.writeFileSync(abs(OLD_FILE), 'old content');
    const lock = upsertSource(upsertBundleEntry(emptyLockfile('prompt-registry@2.0.0'), bundleId, {
      version: '0.9.0', sourceId: localSource.id, sourceType: 'local', installedAt: '2026-10-01T10:00:00.000Z',
      files: [{ path: OLD_FILE, checksum: sha256('old content').slice('sha256:'.length) }]
    }), localSource.id, { type: 'local', url: localSource.url });
    await writeLockfile(abs(OLD_LOCKFILE), lock, nodeLockfileFs);
  };

  /** This profile's 0.9.0 user install: its bundle cache, a symlink into it and the RegistryStorage entry. */
  const recordProfileInstall = async (): Promise<void> => {
    const cacheDir = path.join(globalStorage, 'bundles', BUNDLE_ID);
    writeBundleDir(cacheDir, V0);
    fs.mkdirSync(path.dirname(userPath(USER_HELLO)), { recursive: true });
    fs.symlinkSync(path.join(cacheDir, 'prompts', 'hello.prompt.md'), userPath(USER_HELLO), 'file');
    await storage.recordInstallation({
      bundleId: BUNDLE_ID, version: V0.version, installedAt: '2026-10-01T10:00:00.000Z', scope: 'user', installPath: cacheDir,
      manifest: {} as InstalledBundle['manifest'], sourceId: localSource.id, sourceType: 'local'
    });
  };

  setup(async () => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-old-records-')));
    root = path.join(tempRoot, 'repo');
    fs.mkdirSync(root, { recursive: true });
    initGitRoot(root);
    home = path.join(tempRoot, 'home');
    fs.mkdirSync(home, { recursive: true });
    restoreEnv = overrideEnv({ HOME: home, USERPROFILE: home });
    globalStorage = path.join(tempRoot, 'User', 'globalStorage', 'acme.extension');

    // A configured local source holding both bundles at 1.0.0, in the source cache.
    const sourceDir = path.join(tempRoot, 'source');
    writeBundleDir(path.join(sourceDir, BUNDLE_ID), V1);
    writeBundleDir(path.join(sourceDir, OTHER_ID), OTHER, OTHER_ID);
    localSource = { id: 'acme-local', name: 'Acme local', type: 'local', url: sourceDir, enabled: true, priority: 0 };

    shown = new Map();
    (RegistryManager as any).instance = undefined;
    manager = RegistryManager.getInstance({
      ...createMockContext(sandbox),
      globalStorageUri: vscode.Uri.file(globalStorage),
      globalState: { ...globalState(), keys: () => [...shown.keys()], setKeysForSync: () => undefined }
    });
    storage = manager.getStorage();
    await storage.initialize();
    await storage.addSource(localSource);
    await storage.cacheSourceBundles(localSource.id, [sourceBundle(BUNDLE_ID), sourceBundle(OTHER_ID)]);

    const scopeSelectionUI = require('../../src/utils/scope-selection-ui');
    sandbox.stub(scopeSelectionUI, 'getWorkspaceRoot').returns(root);
    sandbox.stub(scopeSelectionUI, 'hasOpenWorkspace').returns(true);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(root), name: 'repo', index: 0 }]);
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
    restoreEnv();
    (RegistryManager as any).instance = undefined;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('a repository install migrates prompt-registry.lock.json and notifies once; the same report through another adapter is only logged', async () => {
    await writeOldLockfile('old-bundle');
    const migrate = sandbox.spy(manager.getRecordAdapter(), 'migrateBeforeWrite');
    const info = sandbox.spy(Logger.getInstance(), 'info');

    await manager.installBundle(BUNDLE_ID, { scope: 'repository', commitMode: 'commit' });

    const record = readRecord();
    assert.ok(!fs.existsSync(abs(OLD_LOCKFILE)), 'the old file is renamed');
    assert.deepStrictEqual(record.bundles['old-bundle'].tools, {
      unknown: {
        version: '0.9.0', sourceId: localSource.id, sourceType: 'local', installedAt: '2026-10-01T10:00:00.000Z',
        needsReinstall: true, files: [{ path: OLD_FILE, checksum: sha256('old content') }]
      }
    });
    assert.deepStrictEqual(Object.keys(record.bundles[BUNDLE_ID].tools), ['vscode']);
    const notices = (): unknown[][] => showInfo.getCalls().filter((call) => String(call.args[0]).startsWith('Migrated the')).map((call) => call.args);
    assert.deepStrictEqual(notices(), [['Migrated the repository install record: 1 bundle needs reinstalling.', 'Show details']]);

    const report = await migrate.firstCall.returnValue;
    assert.ok(report, 'the install ran a migration');
    new ExtensionRecordAdapter({ sources: { listSources: () => Promise.resolve([]) }, memento: globalState() })
      .showMigrationReport(report, abs(RECORD_FILE));

    assert.strictEqual(notices().length, 1, 'one notification per record path and migratedAt');
    assert.strictEqual(info.getCalls().filter((call) => String(call.args[0]).startsWith(MIGRATION_LOG_PREFIX)).length, 2, 'two log entries');
  });

  const profileCases: { name: string; wsl: boolean }[] = [
    { name: 'outside WSL a user write migrates this profile\'s RegistryStorage user entry under vscode with its file and removes it from RegistryStorage', wsl: false },
    { name: 'in WSL a user write leaves this profile\'s RegistryStorage user entry as it is', wsl: true }
  ];
  profileCases.forEach(({ name, wsl }) => {
    test(name, async () => {
      if (wsl) {
        sandbox.stub(vscode.env, 'remoteName').value('wsl');
      }
      await recordProfileInstall();

      await manager.installBundle(OTHER_ID, { scope: 'user' });

      const stored = await storage.getInstalledBundle(BUNDLE_ID, 'user');
      assert.strictEqual(fs.readFileSync(userPath(USER_HELLO), 'utf8'), V0.files['prompts/hello.prompt.md'], 'the synced file stays');
      if (wsl) {
        assert.strictEqual(stored?.version, V0.version);
        assert.strictEqual(readUserRecord(), null, 'no user record in WSL');
        return;
      }
      assert.strictEqual(stored, undefined, 'removed from RegistryStorage');
      const { installedAt: _installedAt, ...entry } = readUserRecord().bundles[BUNDLE_ID].tools.vscode;
      assert.deepStrictEqual(entry, {
        version: V0.version, sourceId: localSource.id, sourceType: 'local',
        files: [{ path: USER_HELLO, checksum: sha256(V0.files['prompts/hello.prompt.md']) }]
      });
    });
  });

  const loneUnknownCases: { action: string; run: () => Promise<void>; toolsAfter: string[]; message?: RegExp }[] = [
    { action: 'update installs it for vscode', run: () => manager.updateBundle(BUNDLE_ID), toolsAfter: ['vscode'] },
    {
      action: 'uninstall removes the entry',
      run: () => manager.uninstallBundle(BUNDLE_ID, 'repository'),
      toolsAfter: [],
      message: /Its tool was unknown, so its files were kept: \.github\/prompts\/old\.prompt\.md/
    },
    {
      action: 'move to user scope is refused with the reinstall hint',
      run: async () => {
        const repositoryScopeService = manager.getBundleInstaller().createRepositoryScopeService();
        assert.ok(repositoryScopeService);
        await new BundleScopeCommands(manager, sandbox.createStubInstance(ScopeConflictResolver), repositoryScopeService).moveToUser(BUNDLE_ID);
      },
      toolsAfter: ['unknown'],
      message: new RegExp(`${BUNDLE_ID} was migrated and its tool is unknown; reinstall it first`)
    }
  ];
  loneUnknownCases.forEach(({ action, run, toolsAfter, message }) => {
    test(`a bundle only an old prompt-registry file holds: ${action} and keeps the old file`, async () => {
      await writeOldLockfile(BUNDLE_ID);

      await run();

      assert.deepStrictEqual(Object.keys(readRecord()?.bundles[BUNDLE_ID]?.tools ?? {}), toolsAfter);
      assert.strictEqual(fs.readFileSync(abs(OLD_FILE), 'utf8'), 'old content');
      if (message !== undefined) {
        assert.ok(messages().some((shownMessage) => message.test(shownMessage)), messages().join('\n'));
      }
    });
  });
});
