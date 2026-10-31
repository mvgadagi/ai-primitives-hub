/**
 * Extension record adapter: the extension's composition of the shared
 * install record (U3; BR11.1–BR11.9, BR12.1, NFR4.12, NFR4.15, NFR5.2).
 *
 * Wires app's `RecordStore` and `InstallRecordService` to infra's
 * `NodeRecordFs` and `RecordSchemaValidator`, stamps
 * `generatedBy = ai-primitives-hub-extension@<version>`, and records every
 * repository install under the host tool from `detectHostApp()`. It holds no
 * record logic of its own; it supplies the extension-side inputs the app
 * functions need:
 * - `resolveRoot`: the record root of a workspace folder (git root, or the folder);
 * - `assertHostTool`: refuse actions on bundles only another tool's entry holds;
 * - `buildSource`: the configured source an install records (active hub,
 *   then detached `default-local`, then any stored source);
 * - `showRecordError`: one error notification with "Open file";
 * - the user record (BR16.x): its location under the home folder, the
 *   pre-write home check of the user target folders, the other-tool refusal
 *   and the profile-retirement order (unsync, then remove the installation);
 * - `migrateBeforeWrite` (U5; BR18.1, BR18.2, BR20.2, BR22.2): app's
 *   `migrateRecords` for a level before an action's first record change, with
 *   this profile's RegistryStorage user installs as host-tool entries, and the
 *   report shown once;
 * - the old `prompt-registry.lock.json` files at the record root, read only
 *   (listing and the local-modification check); writes migrate them first.
 * @module services/extension-record-adapter
 */
import * as path from 'node:path';
import {
  assertUserFolderInsideHome,
  getLockfilePathForMode,
  InstallRecordService,
  type Lockfile,
  type LockfileBundleEntry,
  type LockfileFs,
  type MigratedEntry,
  migrateRecords,
  type MigrationReport,
  readLockfile,
  RECORD_SOURCE_TYPES,
  type RecordSourceDescriptor,
  type RecordSourceInput,
  RecordStore,
  resolveUserConfigPaths,
  resolveUserHome,
} from '@ai-primitives-hub/app';
import {
  DEFAULT_LOCAL_HUB_ID,
  isRecordError,
  type LockfileSourceDescriptor,
  RECORD_NAME_PATTERN,
  recordError,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  type RegistryError,
  type RegistrySource,
  type TargetType,
  type ToolEntry,
  UNKNOWN_TOOL_NAME,
} from '@ai-primitives-hub/core';
import {
  NodeRecordFs,
  RecordSchemaValidator,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import type {
  InstalledBundle,
  RepositoryCommitMode,
} from '../types/registry';
import {
  type CliManagedAction,
  cliManagedError,
  cliManagedMessage,
  markErrorShown,
  wasErrorShown,
} from '../utils/cli-managed';
import {
  detectHostApp,
} from '../utils/host-app';
import {
  Logger,
} from '../utils/logger';
import {
  getExtensionRecordGeneratedBy,
} from './install-record-listing';
import {
  createInstalledBundleFromLockfile,
} from './installed-bundle-from-entry';

/** Largest old lockfile read, in bytes (the record cap). */
const OLD_LOCKFILE_MAX_BYTES = 10 * 1024 * 1024;

/** Optional source fields copied from a configured source's `config` (C1). */
const SOURCE_CONFIG_FIELDS = ['branch', 'collectionsPath', 'indexFile', 'authMode', 'credentialRef'] as const;

/** Where configured sources come from. */
export interface RecordSourcesPort {
  /** Every stored source, hub-provisioned and detached ones included (`RegistryStorage.getSources`). */
  listSources(): Promise<RegistrySource[]>;
  /** Active hub id, when a hub is active. */
  getActiveHubId?(): Promise<string | null>;
}

/** Dependencies of an {@link ExtensionRecordAdapter}. */
export interface ExtensionRecordAdapterOptions {
  /** Configured sources for `buildSource`. */
  sources: RecordSourcesPort;
  /** Filesystem port; `NodeRecordFs` by default. */
  fs?: RecordFs;
  /** Host tool; `detectHostApp()` by default. */
  hostTool?: TargetType;
  /** Absolute user record path (`AppStoragePaths.userRecord`); the user record is not used without it. */
  userRecordPath?: string;
  /** Environment for the home folder (`resolveUserHome`) and the CLI's old user lockfile; `process.env` by default. */
  env?: Record<string, string | undefined>;
  /** This profile's RegistryStorage user installs, migrated at user level outside WSL (BR20.2); none without it. */
  profileStore?: ProfileStorePort;
  /** Where shown migration reports are remembered (BR22.2): the extension's `globalState`; in memory without it. */
  memento?: Pick<vscode.Memento, 'get' | 'update'>;
}

/** This profile's RegistryStorage user installs, as user-level migration reads and retires them (BR20.2). */
export interface ProfileStorePort {
  /** RegistryStorage installs with scope `user` (`RegistryStorage.getInstalledBundles('user')`). */
  getInstalledBundles(): Promise<InstalledBundle[]>;
  /** Absolute user files the profile synced for a bundle (`UserScopeService.syncedTargetPaths`). */
  syncedTargetPaths(bundleId: string): Promise<string[]>;
  /** Removes the RegistryStorage install without touching its files (`RegistryStorage.removeInstallation`). */
  removeInstallation(bundleId: string): Promise<void>;
}

/** Prefix of the globalState key remembering a shown migration report (BR22.2). */
export const MIGRATION_SHOWN_KEY_PREFIX = 'aiPrimitivesHub.migrationShown';

/** Prefix of the log line holding a migration report. */
export const MIGRATION_LOG_PREFIX = 'Install record migration';

/** Button of the migration notification that opens the output channel. */
const SHOW_DETAILS = 'Show details';

/** One tool entry of a bundle, with the record file holding it. */
export interface LocatedToolEntry {
  location: RecordLocation;
  tool: string;
  entry: ToolEntry;
}

/** One tool entry of any bundle in a record file. */
export interface LocatedBundleToolEntry extends LocatedToolEntry {
  bundleId: string;
}

/** One old `prompt-registry` lockfile at a workspace root. */
export interface OldLockfile {
  /** Absolute file path. */
  path: string;
  /** Commit mode the file stands for. */
  commitMode: RepositoryCommitMode;
  /** Parsed content; `null` when absent or unreadable. */
  lock: Lockfile | null;
}

/** A bundle entry of an old `prompt-registry` lockfile, with the file holding it. */
export interface OldBundleEntry {
  old: OldLockfile & { lock: Lockfile };
  entry: LockfileBundleEntry;
}

/**
 * The refusal of a move or commit-mode switch of a bundle whose only entry is
 * `unknown` (BR21.4): its files cannot be moved for a tool nobody knows.
 * @param bundleId - Refused bundle.
 * @param action - Refused action.
 * @returns A `RECORD.CLI_MANAGED` error, so callers show it as the other refusals.
 */
const unknownToolError = (bundleId: string, action: CliManagedAction): RegistryError =>
  recordError('RECORD.CLI_MANAGED', {
    message: `${bundleId} was migrated and its tool is unknown; reinstall it first`,
    hint: '',
    context: { bundleId, action, tool: UNKNOWN_TOOL_NAME }
  });

/**
 * Whether a report records anything besides the user record's import marker.
 * @param report
 */
const hasMigrated = (report: MigrationReport): boolean =>
  [report.renamed, report.mergedFrom, report.needsReinstall, report.versionConflicts, report.droppedFiles, report.droppedEntries]
    .some((list) => list.length > 0);

/**
 * The notification text of a migration report (BR22.2).
 * @param report - The report.
 */
const migrationMessage = (report: MigrationReport): string => {
  const count = report.needsReinstall.length;
  if (count > 0) {
    return `Migrated the ${report.level} install record: ${count} bundle${count === 1 ? ' needs' : 's need'} reinstalling.`;
  }
  const done = [
    ...report.renamed.map((renamed) => `renamed ${path.basename(renamed.from)} to ${path.basename(renamed.to)}`),
    ...report.mergedFrom.map((merged) => `merged ${path.isAbsolute(merged) ? path.basename(merged) : merged}`)
  ];
  return `Migrated the ${report.level} install record${done.length === 0 ? '.' : `: ${done.join(', ')}.`}`;
};

/**
 * Forward-slash form of a recorded path.
 * @param recordedPath - Path as recorded.
 */
const toSlashes = (recordedPath: string): string => recordedPath.replaceAll('\\', '/');

/**
 * `LockfileFs` over `RecordFs`; writes go to an exclusive temp file renamed over the target.
 */
class RecordLockfileFs implements LockfileFs {
  public constructor(private readonly fs: RecordFs) {}

  public async readFile(file: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.fs.readCapped(file, OLD_LOCKFILE_MAX_BYTES));
  }

  public async writeFile(file: string, contents: string): Promise<void> {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await this.fs.writeFile(temp, contents);
    try {
      await this.fs.rename(temp, file);
    } catch (error) {
      await this.fs.unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  public exists(file: string): Promise<boolean> {
    return this.fs.exists(file);
  }

  public remove(file: string): Promise<void> {
    return this.fs.unlink(file);
  }
}

/** The extension's composition of the shared install record. */
export class ExtensionRecordAdapter {
  public readonly fs: RecordFs;
  public readonly store: RecordStore;
  public readonly service: InstallRecordService;
  /** The tool every extension install is recorded under. */
  public readonly hostTool: TargetType;
  private readonly sources: RecordSourcesPort;
  private readonly lockfileFs: LockfileFs;
  private readonly logger = Logger.getInstance();
  /** The user level's home folder; the root of every user record path (BR14.3). */
  public readonly home: string;
  private readonly userRecordPath: string | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly profileStore: ProfileStorePort | undefined;
  private readonly memento: Pick<vscode.Memento, 'get' | 'update'> | undefined;
  /** Shown migration reports when no memento is given. */
  private readonly shownMigrations = new Set<string>();
  private loggedWslUserRecord = false;
  /** Tail of the job chain of each record file, by resolved path; see {@link serialize}. */
  private readonly recordQueues = new Map<string, Promise<unknown>>();

  public constructor(options: ExtensionRecordAdapterOptions) {
    this.fs = options.fs ?? new NodeRecordFs();
    this.store = new RecordStore({ fs: this.fs, validator: new RecordSchemaValidator(), generatedBy: getExtensionRecordGeneratedBy() });
    this.service = new InstallRecordService({ store: this.store, fs: this.fs });
    this.hostTool = options.hostTool ?? detectHostApp();
    this.sources = options.sources;
    this.lockfileFs = new RecordLockfileFs(this.fs);
    this.env = options.env ?? process.env;
    this.home = resolveUserHome(this.env);
    this.userRecordPath = options.userRecordPath;
    this.profileStore = options.profileStore;
    this.memento = options.memento;
  }

  /**
   * Whether any of the paths is missing.
   * @param root - Root the paths are relative to.
   * @param paths - Root-relative paths.
   */
  private async anyMissing(root: string, paths: readonly string[]): Promise<boolean> {
    for (const recordedPath of paths) {
      try {
        if (await this.fs.lstat(path.join(root, ...recordedPath.split('/'))) === undefined) {
          return true;
        }
      } catch (error) {
        this.logger.warn(`Failed to check file existence for ${recordedPath}:`, error instanceof Error ? error : undefined);
      }
    }
    return false;
  }

  /**
   * Whether an action may run on a bundle with these entry tools; a lone
   * `unknown` entry is refused here for a move or switch (BR21.4).
   * @param bundleId - Bundle the action targets.
   * @param action - The action.
   * @param tools - Tools of the bundle's entries at the level.
   * @returns `false` when another tool's refusal applies.
   * @throws {RegistryError} The reinstall hint for a move or switch of a lone `unknown` entry.
   */
  private isAllowed(bundleId: string, action: CliManagedAction, tools: readonly string[]): boolean {
    if (tools.length === 0 || tools.includes(this.hostTool)) {
      return true;
    }
    if (tools.length === 1 && tools[0] === UNKNOWN_TOOL_NAME) {
      if (action === 'update' || action === 'uninstall') {
        return true;
      }
      throw unknownToolError(bundleId, action);
    }
    return false;
  }

  /**
   * This profile's RegistryStorage user installs as host-tool entries (BR20.2):
   * the files the profile synced, home-relative, and the configured source
   * when there is one. Linked `local-skills` installs stay in RegistryStorage
   * (their files follow the source folder), and so does an install with no
   * source id or source type.
   */
  private async buildProfileEntries(): Promise<MigratedEntry[]> {
    const entries: MigratedEntry[] = [];
    for (const installed of await this.profileStore?.getInstalledBundles() ?? []) {
      if (installed.sourceType === 'local-skills') {
        continue;
      }
      let source: RecordSourceInput | undefined;
      try {
        source = await this.buildSource(installed.sourceId);
      } catch {
        // Not a configured source: the entry keeps its id and type only.
      }
      const sourceType = installed.sourceType ?? source?.type;
      if (installed.sourceId === undefined || sourceType === undefined || !RECORD_NAME_PATTERN.test(sourceType)) {
        this.logger.warn(`Not migrating the profile install of ${installed.bundleId}: it records no source id or source type`);
        continue;
      }
      const files = (await this.profileStore?.syncedTargetPaths(installed.bundleId) ?? [])
        .map((file) => ({ path: toSlashes(path.relative(this.home, file)) }));
      const { sourceId: _sourceId, ...recordedSource } = source ?? { sourceId: '' };
      entries.push({
        bundleId: installed.bundleId,
        tool: this.hostTool,
        version: installed.version,
        sourceId: installed.sourceId,
        sourceType,
        installedAt: installed.installedAt,
        files,
        source: source === undefined ? undefined : recordedSource,
        from: 'profile-registry-storage'
      });
    }
    return entries;
  }

  /**
   * Remove migrated profile installs from RegistryStorage, files untouched
   * (BR20.2). Failures are logged and shown in one warning.
   * @param bundleIds - Bundles to remove.
   */
  private async retireProfileInstalls(bundleIds: readonly string[]): Promise<void> {
    const failed: string[] = [];
    for (const bundleId of bundleIds) {
      try {
        await this.profileStore?.removeInstallation(bundleId);
      } catch (error) {
        failed.push(bundleId);
        this.logger.error(`Could not remove the migrated profile install of ${bundleId}`, error instanceof Error ? error : undefined);
      }
    }
    if (failed.length > 0) {
      void vscode.window.showWarningMessage(
        `Migrated the user install record, but could not remove the old profile entries of ${failed.join(', ')}. They are removed on the next change.`
      );
    }
  }

  /**
   * Run a record mutation after every earlier one queued for the same record
   * file. `InstallRecordService` loads, changes and saves the whole file, so
   * concurrent mutations of one file would lose entries (last save wins).
   * A job that fails does not stop the next one; its error goes to its caller.
   * @param recordPath - Record file the job changes.
   * @param work - The mutation.
   * @returns What `work` returns.
   */
  public serialize<T>(recordPath: string, work: () => Promise<T>): Promise<T> {
    const key = path.resolve(recordPath);
    const previous = this.recordQueues.get(key) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.recordQueues.set(key, tail);
    void tail.then(() => {
      if (this.recordQueues.get(key) === tail) {
        this.recordQueues.delete(key);
      }
    });
    return run;
  }

  /**
   * Both old `prompt-registry` lockfiles at the record root of a workspace
   * folder (its git root), committed first. Old files anywhere else are
   * ignored. An unreadable file is logged and given as `lock: null`.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public async readOldLockfiles(workspaceFolder: string): Promise<OldLockfile[]> {
    const root = await this.resolveRoot(workspaceFolder);
    const files: OldLockfile[] = [];
    for (const commitMode of ['commit', 'local-only'] as const) {
      const file = getLockfilePathForMode(root, commitMode);
      let lock: Lockfile | null = null;
      try {
        lock = await readLockfile(file, this.lockfileFs);
      } catch (error) {
        this.logger.warn(`Could not read ${path.basename(file)}:`, error instanceof Error ? error : undefined);
      }
      files.push({ path: file, commitMode, lock });
    }
    return files;
  }

  /**
   * Record root of a workspace folder (BR2.1): its git root, or the folder itself.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public async resolveRoot(workspaceFolder: string): Promise<string> {
    const [committed] = await this.store.resolveRepository({ start: workspaceFolder });
    return committed.root;
  }

  /**
   * Both repository record files of a workspace folder, committed first.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public locations(workspaceFolder: string): Promise<[RecordLocation, RecordLocation]> {
    return this.store.resolveRepository({ start: workspaceFolder });
  }

  /**
   * Load and check both record files, so a bad record stops an install before
   * any file is written (NFR5.2), and give the file for the commit mode.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param commitMode - Commit mode of the install.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async prepareInstall(workspaceFolder: string, commitMode: RepositoryCommitMode): Promise<RecordLocation> {
    const [committed, localOnly] = await this.locations(workspaceFolder);
    await this.store.load(committed);
    await this.store.load(localOnly);
    return commitMode === 'local-only' ? localOnly : committed;
  }

  /**
   * Every tool entry of a bundle in both record files, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findEntries(workspaceFolder: string, bundleId: string): Promise<LocatedToolEntry[]> {
    const entries: LocatedToolEntry[] = [];
    for (const location of await this.locations(workspaceFolder)) {
      const { record } = await this.store.load(location);
      const bundle = Object.hasOwn(record.bundles, bundleId) ? record.bundles[bundleId] : undefined;
      for (const [tool, entry] of Object.entries(bundle?.tools ?? {})) {
        entries.push({ location, tool, entry });
      }
    }
    return entries;
  }

  /**
   * The host tool's entry of a bundle, from the first file holding it (BR6.5).
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findHostEntry(workspaceFolder: string, bundleId: string): Promise<LocatedToolEntry | undefined> {
    return (await this.findEntries(workspaceFolder, bundleId)).find((located) => located.tool === this.hostTool);
  }

  /**
   * Every tool entry of every bundle in both record files, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async listAllEntries(workspaceFolder: string): Promise<LocatedBundleToolEntry[]> {
    const entries: LocatedBundleToolEntry[] = [];
    for (const location of await this.locations(workspaceFolder)) {
      const { record } = await this.store.load(location);
      for (const [bundleId, bundle] of Object.entries(record.bundles)) {
        for (const [tool, entry] of Object.entries(bundle.tools)) {
          entries.push({ bundleId, location, tool, entry });
        }
      }
    }
    return entries;
  }

  /**
   * Every root-relative path an entry of one record file lists.
   * @param location - Record file.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async listedPathsIn(location: RecordLocation): Promise<Set<string>> {
    const { record } = await this.store.load(location);
    const listed = new Set<string>();
    for (const bundle of Object.values(record.bundles)) {
      for (const entry of Object.values(bundle.tools)) {
        for (const file of entry.files) {
          listed.add(file.path);
        }
      }
    }
    return listed;
  }

  /**
   * Refuse an action on a bundle whose record entries all belong to another
   * tool (BR11.2, NFR4.12). A bundle with a host-tool entry, or with no record
   * entry, is allowed. A bundle whose only entry is `unknown` (migrated, BR21.4)
   * is allowed for update and uninstall, and refused for a move or a
   * commit-mode switch with a reinstall hint.
   * @param bundleId - Bundle the action targets.
   * @param action - The action, for the message.
   * @param workspaceFolder - Absolute workspace folder path.
   * @throws {RegistryError} `RECORD.CLI_MANAGED` naming the tool, or the reinstall hint; any `RECORD.*` error from loading.
   */
  public async assertHostTool(bundleId: string, action: CliManagedAction, workspaceFolder: string): Promise<void> {
    const tools = (await this.findEntries(workspaceFolder, bundleId)).map((located) => located.tool);
    if (this.isAllowed(bundleId, action, tools)) {
      return;
    }
    throw cliManagedError(bundleId, action, tools.toSorted()[0]);
  }

  /**
   * Whether user installs are recorded in the shared user record (BR16.x): a
   * user record path is configured and the extension does not run in WSL,
   * where user files go to the Windows home, outside the WSL home the record
   * is rooted at. The WSL case is logged once.
   */
  public usesSharedUserRecord(): boolean {
    if (vscode.env.remoteName === 'wsl') {
      if (!this.loggedWslUserRecord) {
        this.loggedWslUserRecord = true;
        this.logger.info('The shared user record is not used in WSL; user installs are tracked by the extension only.');
      }
      return false;
    }
    return this.userRecordPath !== undefined;
  }

  /**
   * The user record location, rooted at the home folder (BR14.2, BR14.3).
   * @throws {Error} When no user record path is configured.
   */
  public userLocation(): RecordLocation {
    if (this.userRecordPath === undefined) {
      throw new Error('No user record path is configured for the extension record adapter');
    }
    return this.store.resolveUser({ home: this.home, path: this.userRecordPath });
  }

  /**
   * Load and check the user record, then refuse any user target folder
   * outside the home folder, before any file is written (NFR5.2, NFR4.16).
   * @param folders - Absolute folders the user install writes into.
   * @returns The user location.
   * @throws {RegistryError} Any `RECORD.*` error from loading; `RECORD.PATH_OUTSIDE_ROOT` for a folder outside home.
   */
  public async prepareUserInstall(folders: readonly string[]): Promise<RecordLocation> {
    const location = this.userLocation();
    await this.store.load(location);
    for (const folder of folders) {
      await assertUserFolderInsideHome(this.fs, this.home, folder);
    }
    return location;
  }

  /**
   * Every tool entry of a bundle in the user record.
   * @param bundleId - Bundle id.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findUserEntries(bundleId: string): Promise<LocatedToolEntry[]> {
    const location = this.userLocation();
    const { record } = await this.store.load(location);
    const bundle = Object.hasOwn(record.bundles, bundleId) ? record.bundles[bundleId] : undefined;
    return Object.entries(bundle?.tools ?? {}).map(([tool, entry]) => ({ location, tool, entry }));
  }

  /**
   * The host tool's entry of a bundle in the user record.
   * @param bundleId - Bundle id.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findUserHostEntry(bundleId: string): Promise<LocatedToolEntry | undefined> {
    return (await this.findUserEntries(bundleId)).find((located) => located.tool === this.hostTool);
  }

  /**
   * Every tool entry of every bundle in the user record.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async listUserEntries(): Promise<LocatedBundleToolEntry[]> {
    const location = this.userLocation();
    const { record } = await this.store.load(location);
    const entries: LocatedBundleToolEntry[] = [];
    for (const [bundleId, bundle] of Object.entries(record.bundles)) {
      for (const [tool, entry] of Object.entries(bundle.tools)) {
        entries.push({ bundleId, location, tool, entry });
      }
    }
    return entries;
  }

  /**
   * Refuse an action on a user-level bundle whose user record entries all
   * belong to another tool (BR11.2, NFR4.12 at user level). A bundle with a
   * host-tool entry, or with no user record entry, is allowed; a lone
   * `unknown` entry as in {@link assertHostTool} (BR21.4).
   * @param bundleId - Bundle the action targets.
   * @param action - The action, for the message.
   * @throws {RegistryError} `RECORD.CLI_MANAGED` naming the tool and "a <tool> user target", or the reinstall hint; any `RECORD.*` error from loading.
   */
  public async assertUserHostTool(bundleId: string, action: CliManagedAction): Promise<void> {
    const tools = (await this.findUserEntries(bundleId)).map((located) => located.tool);
    if (this.isAllowed(bundleId, action, tools)) {
      return;
    }
    const tool = tools.toSorted()[0];
    throw recordError('RECORD.CLI_MANAGED', {
      message: cliManagedMessage(bundleId, action, tool).replace(`<a ${tool} target>`, `<a ${tool} user target>`),
      hint: '',
      context: { bundleId, action, tool, level: 'user' }
    });
  }

  /**
   * Retire a bundle's profile-level (user) installation (BR16.x): unsync its
   * user files except those any user record entry still lists, then remove
   * the installation. Errors propagate; nothing is swallowed.
   * @param bundleId - Bundle being retired, for the log.
   * @param unsync - Removes the bundle's user files, leaving every path in `keep`.
   * @param removeInstallation - Removes the extension's installation of the bundle.
   * @throws {RegistryError} Any `RECORD.*` error from loading the user record; nothing is removed then.
   */
  public async retireProfileEntry(
    bundleId: string,
    unsync: (keep: Set<string>) => Promise<void>,
    removeInstallation: () => Promise<void>
  ): Promise<void> {
    const location = this.userLocation();
    const keep = new Set<string>();
    for (const listed of await this.listedPathsIn(location)) {
      keep.add(path.join(location.root, ...listed.split('/')));
    }
    this.logger.debug(`Retiring the profile installation of ${bundleId}; ${keep.size} user record path(s) kept`);
    await unsync(keep);
    await removeInstallation();
  }

  /**
   * Configured sources in lookup order, one per id: the active hub's sources,
   * then detached (`default-local`) sources, then any other stored source.
   */
  public async configuredSources(): Promise<RegistrySource[]> {
    const all = await this.sources.listSources();
    const activeHubId = (await this.sources.getActiveHubId?.()) ?? null;
    const rank = (source: RegistrySource): number => {
      if (activeHubId !== null && source.hubId === activeHubId) {
        return 0;
      }
      return source.hubId === DEFAULT_LOCAL_HUB_ID ? 1 : 2;
    };
    const ordered = all.map((source, index) => ({ source, index }))
      .toSorted((left, right) => rank(left.source) - rank(right.source) || left.index - right.index);
    const byId = new Map<string, RegistrySource>();
    for (const { source } of ordered) {
      if (!byId.has(source.id)) {
        byId.set(source.id, source);
      }
    }
    return [...byId.values()];
  }

  /**
   * The source an install records (NFR4.15): the configured source with this
   * id, mapped to the C1 fields (`type`, `url`, `branch`, `collectionsPath`,
   * `indexFile`, `authMode`, `credentialRef`).
   * @param sourceId - Source id of the bundle.
   * @throws {Error} When the id is unknown or its type is not a `SourceType`.
   */
  public async buildSource(sourceId: string | undefined): Promise<RecordSourceInput> {
    const configured = sourceId === undefined ? undefined : (await this.configuredSources()).find((candidate) => candidate.id === sourceId);
    if (configured === undefined || !(RECORD_SOURCE_TYPES as readonly string[]).includes(configured.type)) {
      throw new Error(`source ${sourceId ?? '(none)'} is not configured; add it or reinstall from a configured source`);
    }
    const source: RecordSourceInput = { sourceId: configured.id, type: configured.type, url: configured.url };
    for (const field of SOURCE_CONFIG_FIELDS) {
      const value = configured.config?.[field];
      if (typeof value === 'string') {
        source[field] = value;
      }
    }
    return source;
  }

  /**
   * Show a `RECORD.*` error once: one error notification naming the file, with
   * an "Open file" button, and the full detail in the log (NFR5.2).
   * @param error - Anything thrown.
   * @param written - Absolute files the writer wrote before the error; they are left in place.
   * @param root - Record root, to open a file named relative to it.
   * @returns `true` when `error` was a `RECORD.*` error (other than `RECORD.CLI_MANAGED`) and was shown, now or before.
   */
  public showRecordError(error: unknown, written: readonly string[] = [], root?: string): boolean {
    if (!isRecordError(error) || error.code === 'RECORD.CLI_MANAGED') {
      // The other-tool refusal is a warning, shown by `showCliManagedWarning`.
      return false;
    }
    if (wasErrorShown(error)) {
      return true;
    }
    const file = typeof error.context?.file === 'string' ? error.context.file : undefined;
    const detail = typeof error.context?.detail === 'string' ? error.context.detail : undefined;
    const message = [
      error.message,
      file === undefined ? '' : `File: ${file}.`,
      detail === undefined ? '' : `Reason: ${detail}.`,
      written.length === 0 ? '' : `These files were written and left in place: ${written.join(', ')}.`,
      error.hint ?? ''
    ].filter((part) => part !== '').join(' ');
    this.logger.error(`${error.code}: ${message}`, error);
    markErrorShown(error);
    const target = file === undefined || (!path.isAbsolute(file) && root === undefined) ? undefined : path.resolve(root ?? '', file);
    const actions = target === undefined ? [] : ['Open file'];
    void Promise.resolve(vscode.window.showErrorMessage(message, ...actions)).then((choice) => {
      if (choice === 'Open file' && target !== undefined) {
        void vscode.window.showTextDocument(vscode.Uri.file(target));
      }
    });
    return true;
  }

  /**
   * Bundles of the old `prompt-registry` lockfiles at the record root, as
   * listing items. A bundle in both old files is listed once, from the committed file.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public async listOldBundles(workspaceFolder: string): Promise<InstalledBundle[]> {
    const bundles: InstalledBundle[] = [];
    const seen = new Set<string>();
    const root = await this.resolveRoot(workspaceFolder);
    for (const old of await this.readOldLockfiles(workspaceFolder)) {
      for (const [bundleId, entry] of Object.entries(old.lock?.bundles ?? {})) {
        if (seen.has(bundleId)) {
          this.logger.error(`Bundle ${bundleId} exists in both lockfiles - manual resolution required`);
          continue;
        }
        seen.add(bundleId);
        bundles.push(createInstalledBundleFromLockfile(bundleId, entry, {
          installPath: path.join(root, '.github'),
          filesMissing: await this.anyMissing(root, entry.files.map((file) => toSlashes(file.path))),
          commitModeOverride: old.commitMode
        }));
      }
    }
    return bundles;
  }

  /**
   * A bundle's entry in the old `prompt-registry` lockfiles, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   */
  public async findOldEntry(workspaceFolder: string, bundleId: string): Promise<OldBundleEntry | undefined> {
    for (const old of await this.readOldLockfiles(workspaceFolder)) {
      if (old.lock !== null && Object.hasOwn(old.lock.bundles, bundleId)) {
        return { old: { ...old, lock: old.lock }, entry: old.lock.bundles[bundleId] };
      }
    }
    return undefined;
  }

  /**
   * Remap a source id in both record files (BR11.9), through
   * `InstallRecordService.remapSource`. The caller migrates the old
   * `prompt-registry` files first (BR18.1), so none is left to change.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param from - Source id being retired.
   * @param to - Replacement source id.
   * @param descriptor - Replacement source as resolved by app's `remapBundleSource`.
   * @throws {RegistryError} Any `RECORD.*` error from the record remap.
   */
  public async remapSource(workspaceFolder: string, from: string, to: string, descriptor: LockfileSourceDescriptor): Promise<void> {
    let recordDescriptor: RecordSourceDescriptor = { ...descriptor };
    try {
      const { sourceId: _sourceId, ...decided } = await this.buildSource(to);
      recordDescriptor = decided;
    } catch {
      // Not a configured source here: record the descriptor app resolved.
    }
    const result = await this.service.remapSource({ root: await this.resolveRoot(workspaceFolder), from, to, descriptor: recordDescriptor });
    result.warnings.forEach((warning) => this.logger.warn(warning));
  }

  /**
   * A bundle's `unknown` entry when it is the bundle's only entry at the level
   * (BR21.4): a migrated bundle no tool has reinstalled yet.
   * @param bundleId - Bundle id.
   * @param workspaceFolder - Absolute workspace folder path for the repository level; the user level without it.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findLoneUnknownEntry(bundleId: string, workspaceFolder?: string): Promise<LocatedToolEntry | undefined> {
    const entries = workspaceFolder === undefined ? await this.findUserEntries(bundleId) : await this.findEntries(workspaceFolder, bundleId);
    return entries.length === 1 && entries[0].tool === UNKNOWN_TOOL_NAME ? entries[0] : undefined;
  }

  /**
   * Migrate the older records of a level into its 3.0.0 records before an
   * action's first record change (W24; BR18.1, BR18.2). Called only at the
   * write entry points, never from a lookup or a listing.
   *
   * - repository level: app's `migrateRecords` at the git root of `root`,
   *   which renames and merges `prompt-registry.lock.json` and
   *   `prompt-registry.local.lock.json` there;
   * - user level, outside WSL: the same on the user record, importing the
   *   CLI's old user lockfile once and this profile's RegistryStorage user
   *   installs under the host tool (BR20.2); each of those is then removed from
   *   RegistryStorage without touching its files. A failed removal is logged
   *   and shown once; the next run removes it. In WSL nothing is migrated.
   *
   * The report is logged and shown once (see {@link showMigrationReport}).
   * Runs in the record file's queue, after any earlier change of it.
   * @param level - Level the action changes.
   * @param root - Repository: a workspace folder or its git root. User: ignored (the home folder).
   * @returns The report, or `undefined` when there was nothing to migrate.
   * @throws {RegistryError} Any `RECORD.*` error from the migration, after it was shown once; nothing was written then.
   */
  public async migrateBeforeWrite(level: RecordLevel, root: string): Promise<MigrationReport | undefined> {
    if (level === 'user' && !this.usesSharedUserRecord()) {
      return undefined;
    }
    const targets = level === 'user' ? [this.userLocation()] : await this.locations(root);
    return this.serialize(targets[0].path, async () => {
      const profileEntries = level === 'user' ? await this.buildProfileEntries() : [];
      let report: MigrationReport | undefined;
      try {
        report = await migrateRecords({
          store: this.store,
          fs: this.fs,
          level,
          root: targets[0].root,
          targets,
          ...(level === 'user' ? { oldUserLockfile: resolveUserConfigPaths(this.env).userLockfile, profileEntries } : {}),
          now: () => new Date()
        });
      } catch (error) {
        this.showRecordError(error, [], targets[0].root);
        throw error;
      }
      if (report !== undefined) {
        await this.retireProfileInstalls(profileEntries.map((entry) => entry.bundleId));
        this.showMigrationReport(report, targets[0].path);
      }
      return report;
    });
  }

  /**
   * Log a migration report and show it once (BR22.2, NFR5.4): one information
   * notification per record path and `migratedAt`, remembered in
   * `globalState`, with "Show details" opening the output channel. A report
   * that only marks the user record as imported is logged without a notification.
   * @param report - The report.
   * @param recordPath - Record file the report belongs to (the committed file at repository level).
   */
  public showMigrationReport(report: MigrationReport, recordPath: string): void {
    this.logger.info(`${MIGRATION_LOG_PREFIX} (${recordPath}): ${JSON.stringify(report)}`);
    const key = `${MIGRATION_SHOWN_KEY_PREFIX}:${recordPath}:${report.migratedAt}`;
    if (!hasMigrated(report) || this.shownMigrations.has(key) || this.memento?.get<boolean>(key) === true) {
      return;
    }
    this.shownMigrations.add(key);
    void Promise.resolve(this.memento?.update(key, true)).catch((error: unknown) => {
      this.logger.warn(`Could not remember the migration notification ${key}:`, error instanceof Error ? error : undefined);
    });
    void Promise.resolve(vscode.window.showInformationMessage(migrationMessage(report), SHOW_DETAILS)).then((choice) => {
      if (choice === SHOW_DETAILS) {
        this.logger.show();
      }
    });
  }
}
