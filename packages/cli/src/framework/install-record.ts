/**
 * Install record wiring for the CLI (workflows W1, W4–W8; BR2.1–BR2.4,
 * BR3.3–BR3.5, BR4.2, BR6.1–BR6.5).
 *
 * This is the CLI composition root for the install record: it builds a
 * `RecordStore` and an `InstallRecordService` on `NodeRecordFs` and the
 * 3.0.0 `RecordSchemaValidator`, stamped `ai-primitives-hub-cli@<version>`.
 * It also selects the record a command acts on, builds the configured-source
 * map for the source trust gate, and renders the `Record:` line
 * and the `level` / `records` JSON fields. User level records into the
 * shared user record (`AppStoragePaths.userRecord`, rooted at home); the old
 * 2.0.0 user lockfile is read but never written here. The writing helpers
 * run app's `migrateLevel` for their level before the first record change
 * (BR18.1): repository level renames and merges the old `prompt-registry.*`
 * files at the git root; user level imports the old user lockfile once. Reads
 * (`status`), workspace scope and an old-format `--lockfile` never migrate.
 * @module framework/install-record
 */
import * as path from 'node:path';
import {
  assertUserFolderInsideHome,
  createInstallRecordServices,
  findLockfile,
  type InstallRecordService,
  type InstallRecordServices,
  type Lockfile,
  type LockfileSourceEntry,
  migrateLevel,
  type MigrationReport,
  orderConfiguredSources,
  readLockfile,
  type RecordInstallInput,
  type RecordInstallResult,
  type RecordSelection,
  type RecordSourceInput,
  type RecordStore,
  resolveExcludeFile,
  resolveLayoutAsync,
  resolveUserConfigPaths,
  resolveUserHome,
  selectRecord,
  type StatusRow,
  type TargetLayout,
} from '@ai-primitives-hub/app';
import {
  describeRecordError,
  expandPath,
  IMPORTED_USER_LOCKFILE_FIELD,
  type InstallationScope,
  isRecordError,
  matchKindRoute,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  RegistryError,
  type RegistrySource,
  type RepositoryExclusion,
  type Target,
  type TokenProvider,
  UNKNOWN_TOOL_NAME,
} from '@ai-primitives-hub/core';
import {
  FileSystemLayoutConfigLoader,
  GitInfoExclude,
  NodeRecordFs,
  resolveUserConfigDir,
  StaticTokenProvider,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  CLI_VERSION,
} from '../version';
import type {
  Context,
} from './context';
import {
  readTargetsSafely,
  resolveTarget,
  resolveTargetName,
} from './error';
import {
  createHubManager,
} from './hub-manager';
import {
  loadTargets,
  resolveEffectiveTarget,
  type TargetOverrides,
} from './target';

/** Writer stamp for records written by the CLI. */
export const CLI_RECORD_GENERATED_BY = `ai-primitives-hub-cli@${CLI_VERSION}`;

/**
 * The env a target writer expands `${HOME}` and `~` against. For a
 * user-scope target `HOME` is the user level's home from `resolveUserHome`,
 * so an empty `HOME` falls back the same way the pre-write folder check
 * does (NFR4.17); repository and workspace scope get `env` unchanged.
 * @param env - CLI environment (`ctx.env`).
 * @param scope - Effective scope of the target.
 * @returns The env to give the writer.
 */
export const writerEnv = (env: Record<string, string | undefined>, scope: InstallationScope): Record<string, string | undefined> =>
  (scope === 'user' ? { ...env, HOME: resolveUserHome(env) } : env);

/** A repository install whose record files were loaded and checked before writing. */
export interface PreparedRepositoryRecord {
  /** The file the install is recorded in, from the commit mode (BR2.2). */
  location: RecordLocation;
  /** Service that records the install and removes superseded files. */
  service: InstallRecordService;
  /** Workspace root the writer installs into (where merged MCP config files sit). */
  workspaceRoot: string;
  /**
   * `info/exclude` section the repository-scope writer lists local-only files
   * in: the same file the record store adds the local-only record to. Absent
   * at user level.
   */
  exclusion?: RepositoryExclusion;
  /** What the migration run before this action did; absent when there was nothing to migrate (BR22.1). */
  migration?: MigrationReport;
}

/**
 * The text lines of a migration report, printed before the `Record:` line (BR22.1).
 * @param report - The command's migration report, if one ran.
 * @returns The lines, newline-terminated; empty when the report has nothing to show.
 */
export const renderMigration = (report: MigrationReport | undefined): string => {
  if (report === undefined) {
    return '';
  }
  const droppedFiles = report.droppedFiles.length;
  const droppedEntries = report.droppedEntries.length;
  const lines = [
    ...report.renamed.map((renamed) => `  renamed ${renamed.from} → ${renamed.to}`),
    ...report.mergedFrom.map((merged) => `  merged ${merged}`),
    ...report.needsReinstall.map((entry) => `  needs reinstall: ${entry.bundleId}@${entry.version} (tool unknown)`),
    ...report.versionConflicts.map((conflict) => `  version conflict: ${conflict.bundleId} kept ${conflict.kept}, dropped ${conflict.dropped}`),
    ...(droppedFiles > 0 ? [`  dropped ${String(droppedFiles)} file path${droppedFiles === 1 ? '' : 's'}`] : []),
    ...(droppedEntries > 0 ? [`  dropped ${String(droppedEntries)} already-recorded entr${droppedEntries === 1 ? 'y' : 'ies'}`] : []),
    ...report.warnings.map((warning) => `  warning: ${warning}`)
  ];
  return lines.length === 0 ? '' : `Migrated ${report.level} record:\n${lines.join('\n')}\n`;
};

/** What `recordRepositoryInstall` records. */
export interface RepositoryInstallToRecord {
  bundleId: string;
  version: string;
  /** The target's type (BR1.2). */
  tool: string;
  /** Full source details (BR3.2). */
  source: RecordSourceInput;
  /** The writer's `written` list, absolute paths (BR1.7). */
  writtenPaths: readonly string[];
}

/** Outcome of `recordRepositoryInstall`. */
export interface RecordedRepositoryInstall {
  /** Absolute path of the record file written. */
  lockfile: string;
  /** Root-relative superseded files that were removed. */
  deleted: string[];
  /** Non-fatal problems: exclude-file updates and skipped deletions. */
  warnings: string[];
}

/**
 * Re-raise a record error with the command name and its file in the message,
 * so text output shows it next to the code (BR4.2). Code, hint and context are kept.
 * @param command - Command name used as the message prefix.
 * @param error - A `RECORD.*` error.
 * @param written - Files already written, for an install that failed after the write.
 * @returns The error to throw.
 */
export const toCommandRecordError = (command: string, error: RegistryError, written?: readonly string[]): RegistryError => {
  let message = `${command}: ${describeRecordError(error)}`;
  if (written !== undefined && written.length > 0) {
    message += ` These files were written but are not recorded; run the install again to record them: ${written.join(', ')}`;
  }
  return new RegistryError({
    code: error.code,
    message,
    hint: error.hint,
    context: {
      ...error.context,
      ...(written !== undefined && written.length > 0 ? { written: [...written] } : {})
    },
    cause: error
  });
};

/**
 * Re-raise a record error with its file in the message, so text output shows
 * it next to the code (BR4.2). Code, hint and context are kept.
 * @param error - A `RECORD.*` error.
 * @param written - Files the writer already put down, when the failure came after the write (BR3.5).
 * @returns The error to throw.
 */
export const toInstallRecordError = (error: RegistryError, written?: readonly string[]): RegistryError =>
  toCommandRecordError('install', error, written);

/**
 * Record store and service for one CLI command, stamped with {@link CLI_RECORD_GENERATED_BY}.
 * @param fs - Filesystem port; `NodeRecordFs` by default.
 */
export const createRecordServices = (fs: RecordFs = new NodeRecordFs()): InstallRecordServices =>
  createInstallRecordServices({ generatedBy: CLI_RECORD_GENERATED_BY, fs });

/**
 * The shared user record location (BR14.2): `AppStoragePaths.userRecord`,
 * rooted at the user level's home from `resolveUserHome` (BR14.3). The
 * install, uninstall and selection paths and doctor all use it.
 * @param store - Record store.
 * @param env - Environment for the home and XDG folders (`ctx.env`).
 * @returns The user location.
 */
export const userRecordLocation = (store: RecordStore, env: Record<string, string | undefined>): RecordLocation =>
  store.resolveUser({ home: resolveUserHome(env), path: new XdgAppStorage(env).getPaths().userRecord });

/**
 * The layout config loader the CLI writers and record checks use: the
 * workspace, then the user config folder.
 * @param ctx - CLI context.
 * @returns The loader.
 */
export const createLayoutLoader = (ctx: Context): FileSystemLayoutConfigLoader =>
  new FileSystemLayoutConfigLoader({ cwd: ctx.cwd(), fs: ctx.fs, userConfigDir: resolveUserConfigDir(ctx.env) });

/**
 * Whether a target's installs are kept in an install record: the repository
 * records (BR2.1) or the shared user record (BR14.1). Workspace-scope targets
 * keep the old lockfile.
 * @param target - Effective target.
 */
export const usesInstallRecord = (target: Target): boolean => target.scope === 'repository' || target.scope === 'user';

/**
 * The `info/exclude` section at a git root, in the file app's
 * `resolveExcludeFile` finds (following `gitdir:` and `commondir` in a
 * worktree), so a writer's local-only entries and the local-only record's
 * entry share one file (NFR4.6).
 * @param ctx - CLI context; its filesystem edits the file.
 * @param fs - Record filesystem port, to find the file.
 * @param gitRoot - Git root (the record root); exclude patterns are relative to it.
 * @returns The exclusion, or `undefined` without a trusted git directory: the
 * writer then keeps its default, `<workspace>/.git/info/exclude`, and the
 * record store warns about it on save.
 */
const recordExclusion = async (ctx: Context, fs: RecordFs, gitRoot: string): Promise<RepositoryExclusion | undefined> => {
  const excludeFile = await resolveExcludeFile(fs, gitRoot).catch(() => ({ warning: 'unreadable' }));
  return 'file' in excludeFile
    ? new GitInfoExclude({ fs: ctx.fs, workspaceRoot: gitRoot, excludePath: excludeFile.file })
    : undefined;
};

/** The repository record files a target acts on, and the one it records in. */
interface RepositoryRecords extends InstallRecordServices {
  /** Workspace root the writer installs into (where merged MCP config files sit). */
  workspaceRoot: string;
  /** The record files: both files at the git root (committed first), or the ones given. */
  locations: readonly RecordLocation[];
  /** The file the target's commit mode names (BR2.2), or the first one given. */
  location: RecordLocation;
  /** The `info/exclude` section at the record root, in the file the record store uses (NFR4.6). */
  exclusion: RepositoryExclusion;
}

/**
 * Build the record services and locate the repository record files for a
 * repository-scope target (BR2.1, BR2.2). Without `given`, both files at the
 * target's git root are loaded and checked first (`RecordStore.loadRepository`).
 * @param ctx - CLI context; `ctx.cwd()` is the fallback start folder.
 * @param target - Effective repository-scope target.
 * @param fs - Filesystem port.
 * @param given - Record files already selected and checked (`--lockfile`); both files at the target's git root otherwise.
 * @returns The services, the workspace root, the record locations and the exclusion.
 * @throws {RegistryError} Any `RECORD.*` error from loading.
 */
const openRepositoryRecords = async (
  ctx: Context,
  target: Target,
  fs: RecordFs,
  given?: readonly RecordLocation[]
): Promise<RepositoryRecords> => {
  const services = createRecordServices(fs);
  const workspaceRoot = target.rootPath ?? ctx.cwd();
  const { locations, location } = given === undefined || given.length === 0
    ? await services.store.loadRepository({ start: workspaceRoot, commitMode: target.commitMode })
    : { locations: given, location: given[0] };
  return {
    ...services,
    workspaceRoot,
    locations,
    location,
    exclusion: (await recordExclusion(ctx, fs, location.root)) ?? new GitInfoExclude({ fs: ctx.fs, workspaceRoot })
  };
};

/**
 * Load and check both repository record files before anything is written
 * (W1 steps 2–4, BR3.5), then migrate the old `prompt-registry.*` files at
 * the git root into them (BR18.1). Call only for repository-scope targets.
 * @param ctx - CLI context; `ctx.cwd()` is the fallback start folder.
 * @param target - Effective repository-scope target.
 * @param fs - Filesystem port; `NodeRecordFs` unless a test passes one.
 * @returns The location to record in and the service to record with.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was written.
 */
export const prepareRepositoryRecord = async (
  ctx: Context,
  target: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryRecord> => {
  try {
    const records = await openRepositoryRecords(ctx, target, fs);
    const migration = await migrateLevel({ store: records.store, fs, targets: records.locations, env: ctx.env });
    for (const location of records.locations) {
      await records.store.load(location);
    }
    return {
      location: records.location,
      service: records.service,
      workspaceRoot: records.workspaceRoot,
      exclusion: records.exclusion,
      ...(migration === undefined ? {} : { migration })
    };
  } catch (error) {
    throw isRecordError(error) ? toInstallRecordError(error) : error;
  }
};

/**
 * The layout a user-scope target writes with and its base folder, expanded
 * the way the file-tree writer does with `HOME` set to the user level's home.
 * @param ctx - CLI context.
 * @param target - User-scope target.
 * @param home - Home folder from `resolveUserHome`.
 * @returns The layout and its absolute base folder.
 */
const resolveUserTargetLayout = async (
  ctx: Context,
  target: Target,
  home: string
): Promise<{ layout: TargetLayout; baseDir: string }> => {
  const layout = await resolveLayoutAsync(target, createLayoutLoader(ctx));
  return { layout, baseDir: path.resolve(expandPath(layout.baseDir, { ...ctx.env, HOME: home })) };
};

/**
 * Load and check the shared user record and refuse a target folder outside
 * home before anything is written (BR14.1, BR14.3, NFR4.16). Call only for
 * user-scope targets. Every folder the layout routes a kind into is checked
 * (the base folder when the layout has no route). Then the old 2.0.0 user
 * lockfile is imported once (BR18.1, BR20.1); it is never written by this path.
 * @param ctx - CLI context; `ctx.env` gives the home and XDG folders.
 * @param target - Effective user-scope target.
 * @param fs - Filesystem port; `NodeRecordFs` unless a test passes one.
 * @returns The user record location, the service to record with and home as root.
 * @throws {RegistryError} A `RECORD.*` error naming the file or folder; nothing was written.
 */
export const prepareUserRecord = async (
  ctx: Context,
  target: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryRecord> => {
  const { store, service } = createRecordServices(fs);
  try {
    const location = userRecordLocation(store, ctx.env);
    const home = location.root;
    await store.load(location);
    const { layout, baseDir } = await resolveUserTargetLayout(ctx, target, home);
    const routes = Object.values(layout.kindRoutes);
    const folders = new Set(routes.length === 0 ? [baseDir] : routes.map((route) => path.join(baseDir, route)));
    for (const folder of folders) {
      await assertUserFolderInsideHome(fs, home, folder);
    }
    const migration = await migrateLevel({ store, fs, targets: [location], env: ctx.env });
    await store.load(location);
    return { location, service, workspaceRoot: home, ...(migration === undefined ? {} : { migration }) };
  } catch (error) {
    throw isRecordError(error) ? toInstallRecordError(error) : error;
  }
};

/**
 * Record a repository install, then remove the files it superseded
 * (W1 steps 6–13). A failure here leaves the written files in place and the
 * error lists them (BR3.5).
 * @param prepared - Result of {@link prepareRepositoryRecord}.
 * @param install - What was installed.
 * @returns The record path, removed files and warnings.
 * @throws {RegistryError} A `RECORD.*` error naming the file and the written files.
 */
export const recordRepositoryInstall = async (
  prepared: PreparedRepositoryRecord,
  install: RepositoryInstallToRecord
): Promise<RecordedRepositoryInstall> => {
  let change;
  try {
    change = await prepared.service.recordInstall({
      location: prepared.location,
      bundleId: install.bundleId,
      version: install.version,
      tool: install.tool,
      source: install.source,
      sourceType: install.source.type,
      writtenPaths: install.writtenPaths,
      workspaceRoot: prepared.workspaceRoot
    });
  } catch (error) {
    throw isRecordError(error) ? toInstallRecordError(error, install.writtenPaths) : error;
  }
  const removal = await prepared.service.deleteSuperseded(change);
  return {
    lockfile: prepared.location.path,
    deleted: removal.deleted,
    warnings: [...change.warnings, ...removal.warnings]
  };
};

/** Both repository record files, loaded and checked for an uninstall. */
export interface PreparedRepositoryUninstall {
  /** The file named by the commit mode; `recordUninstall` reads both files from its root. */
  location: RecordLocation;
  /** Service that removes the entry and its files. */
  service: InstallRecordService;
  /** Tool key: the target's type (BR1.2). */
  tool: string;
  /** `.git/info/exclude` section the repository-scope writer lists local-only files in; absent at user level. */
  exclusion?: RepositoryExclusion;
  /**
   * Bundles with an entry for `tool` in either file, sorted, mapped to their
   * recorded root-relative paths (both files merged).
   */
  entries: Map<string, string[]>;
  /**
   * User level only: per bundle, the home-relative paths the old 2.0.0 user
   * lockfile still lists. They are kept, not deleted, on uninstall. Empty
   * once the user record carries the import marker (BR20.1).
   */
  keepPaths?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Bundles whose only entry at the level is `unknown`; a plain uninstall removes it and keeps its files (BR21.3). */
  loneUnknown?: ReadonlySet<string>;
  /** `true` at user level once the old user lockfile was imported: the old store is not read (BR20.1). */
  ignoresOldStore?: boolean;
  /** What the migration run before this action did; absent when there was nothing to migrate (BR22.1). */
  migration?: MigrationReport;
}

/** Outcome of `recordRepositoryUninstall`. */
export interface RecordedRepositoryUninstall {
  /** Absolute path of the record file the entry was removed from (it may now be deleted). */
  lockfile: string;
  /** Root-relative files that were removed. */
  removed: string[];
  /** Root-relative files kept: another entry still lists them, or they were changed or missing since the install. */
  kept: string[];
  /** Non-fatal problems: skipped deletions or a record file that could not be removed. */
  warnings: string[];
}

/**
 * Load and check both repository record files and migrate the old
 * `prompt-registry.*` files at the git root before anything is removed
 * (repository-scope uninstall, FR4.1 U1 part; BR18.1). Call only for
 * repository-scope targets. A bundle with no entry for the target's type here
 * is not in the map, so the caller can fall back to the old store for it.
 * @param ctx - CLI context; `ctx.cwd()` is the fallback start folder.
 * @param target - Effective repository-scope target.
 * @param options - Record files already selected and checked (`uninstall --lockfile`),
 * the first one recorded in (both files at the target's git root by default),
 * and `dryRun`: a preview. Neither a preview nor selected files migrate (BR18.1).
 * @param options.locations - The selected record files.
 * @param options.dryRun - `true` for `--dry-run`.
 * @param fs - Filesystem port; `NodeRecordFs` unless a test passes one.
 * @returns The location, service, tool, the bundles recorded for that tool and the migration report.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was removed.
 */
export const prepareRepositoryUninstall = async (
  ctx: Context,
  target: Target,
  options: { locations?: readonly RecordLocation[]; dryRun?: boolean } = {},
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryUninstall> => {
  try {
    const { store, service, locations, location, exclusion } = await openRepositoryRecords(ctx, target, fs, options.locations);
    const given = options.locations !== undefined && options.locations.length > 0;
    const migration = options.dryRun === true || given ? undefined : await migrateLevel({ store, fs, targets: locations, env: ctx.env });
    return {
      location,
      service,
      tool: target.type,
      // Same exclude file the install wrote the local-only entries to.
      exclusion,
      entries: await service.entriesForTool(locations, target.type),
      loneUnknown: new Set((await service.findLoneUnknown(locations)).keys()),
      ...(migration === undefined ? {} : { migration })
    };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
};

/**
 * Per bundle, the home-relative paths the old 2.0.0 user lockfile lists for
 * a user-scope target, resolved as the old uninstall does: `installedPath`
 * under the layout base folder when recorded, else the routed bundle path.
 * @param ctx - CLI context.
 * @param target - User-scope target.
 * @param home - Home folder from `resolveUserHome`.
 * @returns Paths by bundle id; empty when there is no old user lockfile.
 */
const oldUserLockfilePaths = async (ctx: Context, target: Target, home: string): Promise<Map<string, Set<string>>> => {
  const out = new Map<string, Set<string>>();
  const lock = await readLockfile(resolveUserConfigPaths(ctx.env).userLockfile, ctx.fs);
  if (lock === null || Object.keys(lock.bundles).length === 0) {
    return out;
  }
  const { layout, baseDir } = await resolveUserTargetLayout(ctx, target, home);
  for (const [bundleId, entry] of Object.entries(lock.bundles)) {
    const paths = new Set<string>();
    for (const file of entry.files) {
      let absolute: string | undefined;
      if (file.installedPath === undefined) {
        const route = matchKindRoute(file.path, layout.kindRoutes);
        absolute = route === null ? undefined : path.join(baseDir, route.outPrefix, route.tail);
      } else {
        absolute = path.join(baseDir, file.installedPath);
      }
      if (absolute !== undefined) {
        paths.add(path.relative(home, path.resolve(absolute)).split(path.sep).join('/'));
      }
    }
    out.set(bundleId, paths);
  }
  return out;
};

/**
 * Load and check the shared user record and import the old user lockfile
 * once before anything is removed (user-scope uninstall, BR14.1, BR18.1,
 * BR20.1). Call only for user-scope targets. A bundle with no entry for the
 * target's type here is not in the map. Paths the old user lockfile still
 * lists for the same bundle are kept on uninstall only while the user record
 * has no import marker.
 * @param ctx - CLI context; `ctx.env` gives the home and XDG folders.
 * @param target - Effective user-scope target.
 * @param options - `dryRun`: a preview, which never migrates (BR18.1).
 * @param options.dryRun - `true` for `--dry-run`.
 * @param fs - Filesystem port; `NodeRecordFs` unless a test passes one.
 * @returns The location, service, tool, the bundles recorded for that tool and the paths to keep.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was removed.
 */
export const prepareUserUninstall = async (
  ctx: Context,
  target: Target,
  options: { dryRun?: boolean } = {},
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryUninstall> => {
  const { store, service } = createRecordServices(fs);
  try {
    const location = userRecordLocation(store, ctx.env);
    await store.load(location);
    const migration = options.dryRun === true ? undefined : await migrateLevel({ store, fs, targets: [location], env: ctx.env });
    const { record } = await store.load(location);
    const entries = await service.entriesForTool([location], target.type);
    // Once the old user lockfile was imported, the user level no longer reads it (BR20.1).
    const imported = record[IMPORTED_USER_LOCKFILE_FIELD] !== undefined;
    const keepPaths = entries.size === 0 || imported ? new Map<string, Set<string>>() : await oldUserLockfilePaths(ctx, target, location.root);
    return {
      location,
      service,
      tool: target.type,
      entries,
      keepPaths,
      loneUnknown: new Set((await service.findLoneUnknown([location])).keys()),
      ignoresOldStore: imported,
      ...(migration === undefined ? {} : { migration })
    };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
};

/**
 * Load and check the install record a target installs into, before anything
 * is written: both repository files (BR3.5) or the shared user record with
 * the home check (BR14.3).
 * @param ctx - CLI context.
 * @param target - Effective target.
 * @returns The prepared record; `undefined` for a target that keeps the old lockfile ({@link usesInstallRecord}).
 * @throws {RegistryError} A `RECORD.*` error naming the file or folder; nothing was written.
 */
export const prepareRecordForTarget = async (ctx: Context, target: Target): Promise<PreparedRepositoryRecord | undefined> => {
  if (!usesInstallRecord(target)) {
    return undefined;
  }
  return target.scope === 'repository' ? prepareRepositoryRecord(ctx, target) : prepareUserRecord(ctx, target);
};

/**
 * Load and check the install record a target uninstalls from, before
 * anything is removed: both repository files (or the `--lockfile` ones) or
 * the shared user record.
 * @param ctx - CLI context.
 * @param target - Effective target.
 * @param options - `locations`: repository level only, the record files already
 * selected (`uninstall --lockfile`); `dryRun`: a preview, which never migrates (BR18.1).
 * @param options.locations - The selected record files.
 * @param options.dryRun - `true` for `--dry-run`.
 * @returns The prepared record; `undefined` for a target that keeps the old lockfile ({@link usesInstallRecord}).
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was removed.
 */
export const prepareUninstallForTarget = async (
  ctx: Context,
  target: Target,
  options: { locations?: readonly RecordLocation[]; dryRun?: boolean } = {}
): Promise<PreparedRepositoryUninstall | undefined> => {
  if (!usesInstallRecord(target)) {
    return undefined;
  }
  return target.scope === 'repository'
    ? prepareRepositoryUninstall(ctx, target, options)
    : prepareUserUninstall(ctx, target, { dryRun: options.dryRun });
};

/**
 * Remove one bundle's entry for the target's type from the repository
 * records, then delete its files except those another entry still lists and
 * those changed or missing since the install (app's `uninstallEntry`,
 * NFR4.13). Each changed file kept gets a warning.
 * @param prepared - Result of {@link prepareRepositoryUninstall}.
 * @param bundleId - Bundle to uninstall.
 * @returns The record path, removed and kept files, and warnings.
 * @throws {RegistryError} `RECORD.ENTRY_NOT_FOUND` or another `RECORD.*` error naming the file.
 */
export const recordRepositoryUninstall = async (
  prepared: PreparedRepositoryUninstall,
  bundleId: string
): Promise<RecordedRepositoryUninstall> => {
  let result;
  try {
    result = await prepared.service.uninstallEntry({
      location: prepared.location,
      bundleId,
      tool: prepared.tool,
      // Files the old user lockfile still lists stay on disk for it.
      keep: prepared.keepPaths?.get(bundleId)
    });
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
  const { change, deleted } = result;
  const warnings = [...result.warnings, ...result.modified.map((file) => `Did not remove ${file}: it was changed after install.`)];
  if (change.location.commitMode === 'local-only' && deleted.length > 0 && prepared.exclusion !== undefined) {
    // A local-only install listed its files in `.git/info/exclude`; drop the
    // entries of the files removed, as the old uninstall path did.
    try {
      await prepared.exclusion.remove(deleted.map((relative) => path.join(change.location.root, ...relative.split('/'))));
    } catch (error) {
      warnings.push(`Could not update .git/info/exclude: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    lockfile: change.location.path,
    removed: deleted,
    kept: result.kept,
    warnings
  };
};

/**
 * Remove a bundle's lone `unknown` entry from the level's records and keep
 * every file it listed: the tool that wrote them is not known (BR21.3).
 * @param prepared - Result of {@link prepareRepositoryUninstall} or {@link prepareUserUninstall}.
 * @param bundleId - Bundle whose only entry is `unknown`.
 * @returns The record path, no removed file, the kept files and warnings.
 * @throws {RegistryError} `RECORD.ENTRY_NOT_FOUND` or another `RECORD.*` error naming the file.
 */
export const recordUnknownUninstall = async (
  prepared: PreparedRepositoryUninstall,
  bundleId: string
): Promise<RecordedRepositoryUninstall> => {
  let result;
  try {
    result = await prepared.service.removeUnknownEntry(prepared.location, bundleId);
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
  return {
    lockfile: result.change.location.path,
    removed: result.deleted,
    kept: result.kept,
    warnings: result.warnings
  };
};

/** What a command was given that fixes the record level (BR6.1). */
export interface RecordSelectionInput {
  /** Command name, used as the prefix of a `RECORD.*` error message. */
  command: string;
  /** `--lockfile <path>` as typed (not a path found by an upward walk). */
  lockfile?: string;
  /** `--scope`. */
  scope?: InstallationScope;
  /**
   * `true` for an action that changes the selected record (update, replay):
   * the level is migrated before the selection is returned (BR18.1). Never
   * for a read such as `status`.
   */
  write?: boolean;
}

/** A selected record with the store and service to act on it. */
export interface PreparedRecordSelection {
  /** Level, root, loaded new record files and the old-store file (W4). */
  selection: RecordSelection;
  /** Store the selected files were loaded with. */
  store: RecordStore;
  /** Service to record, list and remove entries with. */
  service: InstallRecordService;
  /** Filesystem port the store and service use. */
  fs: RecordFs;
  /**
   * `info/exclude` section at the selected repository record's root, for the
   * writers of a replay or update, so their local-only entries go to the same
   * file as the local-only record's (NFR4.6). Absent at user level and without
   * a trusted git directory: the writer keeps its default.
   */
  exclusion?: RepositoryExclusion;
  /** What the migration run for a `write` selection did; absent when nothing was migrated (BR22.1). */
  migration?: MigrationReport;
}

/**
 * Select the record a command acts on and load every selected file before
 * anything is written (W4; BR6.1, BR6.2, NFR4.8). The old `prompt-registry.*`
 * file is found with today's upward walk from the selection's start folder.
 * With `input.write`, the selected level is migrated first and the selection
 * is made again on the migrated records (BR18.1). A selection with no new
 * record file (workspace scope, an old-format `--lockfile`, the CLI user
 * lockfile) and a `--lockfile` record outside the git root are never migrated.
 * @param ctx - CLI context; `ctx.cwd()` is the current folder.
 * @param input - Command name and the `--lockfile` / `--scope` values the person typed.
 * @param target - Resolved target, when the command has one: its scope gives the level, its root the start folder.
 * @param fs - Filesystem port; `NodeRecordFs` unless a test passes one.
 * @returns The selection with the store and service that loaded it.
 * @throws {RegistryError} A `RECORD.*` error naming the command and the file; nothing was written.
 */
export const prepareRecordSelection = async (
  ctx: Context,
  input: RecordSelectionInput,
  target?: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRecordSelection> => {
  const { store, service } = createRecordServices(fs);
  const userLockfile = resolveUserConfigPaths(ctx.env).userLockfile;
  const user = userRecordLocation(store, ctx.env);
  try {
    const select = (): Promise<RecordSelection> => selectRecord({
      store,
      fs,
      cwd: ctx.cwd(),
      given: {
        ...(input.lockfile === undefined || input.lockfile === '' ? {} : { lockfile: input.lockfile }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(target === undefined ? {} : { target: { scope: target.scope, rootPath: target.rootPath } })
      },
      findOldLockfile: (start) => findLockfile(start, ctx.fs, userLockfile),
      userLockfile,
      userRecord: user.path,
      home: user.root
    });
    let selection = await select();
    let migration: MigrationReport | undefined;
    if (input.write === true && selection.locations.length > 0) {
      const targets = selection.level === 'user' ? selection.locations : await store.resolveRepository({ start: selection.root });
      // A `--lockfile` record outside the git root is never migrated.
      if (targets[0].root === selection.root) {
        migration = await migrateLevel({ store, fs, targets, env: ctx.env });
        selection = await select();
      }
    }
    const exclusion = selection.level === 'repository' && selection.locations.length > 0
      ? await recordExclusion(ctx, fs, selection.root)
      : undefined;
    return {
      selection,
      store,
      service,
      fs,
      ...(exclusion === undefined ? {} : { exclusion }),
      ...(migration === undefined ? {} : { migration })
    };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError(input.command, error) : error;
  }
};

/**
 * A read-only record selection with its entries, used by `update` and
 * `uninstall <bundle-id>` run with no inferred target (BR23.3): the record
 * decides which tools act, and nothing has been migrated or written yet.
 */
export interface RecordDecision {
  /** What the person typed that fixes the level (`--lockfile`, `--scope`); never a target. */
  input: Omit<RecordSelectionInput, 'write'>;
  /** The selection, made with no target: the level from `--lockfile`, then `--scope`, then the default rule (BR6.2). */
  prepared: PreparedRecordSelection;
  /** Every (bundle, tool) entry of the selected 3.0.0 record files; bundles only an older store lists are not here. */
  rows: StatusRow[];
}

/**
 * Select the record with no target and list its entries (BR23.3). With
 * `options.write`, the level is migrated first (BR18.1); without it nothing is
 * migrated or written, so a command the record does not decide can still fail
 * with nothing changed (NFR4.27).
 * @param ctx - CLI context.
 * @param input - Command name and the `--lockfile` / `--scope` values typed.
 * @param options - `write`: migrate the level first (a real run, never `--dry-run`).
 * @param options.write - `true` to migrate before selecting.
 * @returns The selection and its entries.
 * @throws {RegistryError} A `RECORD.*` error naming the command and the file.
 */
export const prepareRecordDecision = async (
  ctx: Context,
  input: Omit<RecordSelectionInput, 'write'>,
  options: { write?: boolean } = {}
): Promise<RecordDecision> => {
  const prepared = await prepareRecordSelection(ctx, { ...input, write: options.write === true });
  const { selection, service } = prepared;
  try {
    const rows = selection.locations.length === 0 ? [] : await service.listEntries(selection.locations);
    return { input, prepared, rows };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError(input.command, error) : error;
  }
};

/**
 * The tools a bundle has entries for in a decision's rows, in row order.
 * @param rows - Rows of a {@link RecordDecision}.
 * @param bundleId - Bundle id.
 * @returns Its distinct tool keys.
 */
export const recordedTools = (rows: readonly StatusRow[], bundleId: string): string[] =>
  [...new Set(rows.filter((row) => row.bundleId === bundleId).map((row) => row.tool))];

/** Outcome of {@link prepareUnknownUninstall}. */
export type PreparedUnknownUninstall =
  /** The bundle is still a lone `unknown` entry: remove it with {@link recordUnknownUninstall}. */
  | { uninstall: PreparedRepositoryUninstall }
  /** The migration changed the bundle's entries: decide again on this post-migration selection. */
  | { changed: RecordDecision };

/**
 * Target-free prepare for `uninstall <bundle-id>` of a lone `unknown` entry
 * with no inferred target (BR23.3, BR21.3). The read-only decision only chose
 * the path: this selects the record again with `write` so the level is
 * migrated first (never under `--dry-run`, BR18.1), then reads the entry from
 * the post-migration records. No keep-path set is needed, because
 * {@link recordUnknownUninstall} keeps every file.
 * @param ctx - CLI context.
 * @param decision - The read-only decision that found the lone `unknown` entry.
 * @param bundleId - Bundle to uninstall.
 * @param options - `dryRun`: a preview, which never migrates.
 * @param options.dryRun - `true` for `--dry-run`.
 * @returns The prepared uninstall, or the post-migration decision when the entry is no longer a lone `unknown` one.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was removed.
 */
export const prepareUnknownUninstall = async (
  ctx: Context,
  decision: RecordDecision,
  bundleId: string,
  options: { dryRun?: boolean } = {}
): Promise<PreparedUnknownUninstall> => {
  const migrated = options.dryRun === true ? decision : await prepareRecordDecision(ctx, decision.input, { write: true });
  const tools = recordedTools(migrated.rows, bundleId);
  if (tools.length !== 1 || tools[0] !== UNKNOWN_TOOL_NAME) {
    return { changed: migrated };
  }
  const { selection, service, migration } = migrated.prepared;
  try {
    const location = await service.holdingLocation(selection.locations, bundleId, UNKNOWN_TOOL_NAME);
    return {
      uninstall: {
        location: location ?? selection.locations[0],
        service,
        tool: UNKNOWN_TOOL_NAME,
        entries: new Map(),
        loneUnknown: new Set((await service.findLoneUnknown(selection.locations)).keys()),
        ...(migration === undefined ? {} : { migration })
      }
    };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
};

/**
 * Configured sources by id for the source trust gate (NFR4.11), in app's
 * `orderConfiguredSources` order: the active hub's sources first, then
 * detached (`default-local`) sources whose id the active hub does not use. A
 * hub that cannot be read contributes no source, so its entries fall back to
 * the record's copy without credentials.
 * @param ctx - CLI context.
 * @returns Configured sources keyed by id, in lookup order.
 */
export const configuredSources = async (ctx: Context): Promise<Map<string, RegistrySource>> => {
  const manager = createHubManager({ ctx });
  // No readable active hub pointer: no source counts as the active hub's.
  const activeHubId = await manager.getActiveHubId().catch(() => null);
  const ordered = orderConfiguredSources(await manager.listSourcesAcrossAllHubs(), activeHubId);
  return new Map(ordered.map((source) => [source.id, source]));
};

/** Token provider that never returns a token. */
const NO_TOKENS: TokenProvider = new StaticTokenProvider('');

/**
 * The token provider for a planned entry's lookup and download: none for a
 * source the trust gate took from the record, so such a fetch runs without
 * credentials (NFR4.11).
 * @param tokens - The command's token provider.
 * @param fromRecordOnly - `true` when no configured source has the entry's id.
 * @returns The provider to fetch with.
 */
export const tokensForRecordSource = (tokens: TokenProvider, fromRecordOnly: boolean): TokenProvider =>
  fromRecordOnly ? NO_TOKENS : tokens;

/** A planned (bundle, tool) entry, as {@link recordPlannedInstall} re-records it. */
export interface PlannedRecordInstall {
  bundleId: string;
  tool: string;
  /** The file that holds the entry (BR6.5). */
  location: RecordLocation;
  sourceId: string;
  /** Source decided by the trust gate, in the legacy lockfile shape. */
  source: LockfileSourceEntry;
  /** Source type to record for the entry. */
  sourceType: string;
}

/**
 * Re-record a planned entry after its target's writer wrote it (W5 step 5,
 * W6 step 3). Superseded files are not deleted here: see {@link finishRecordRun}.
 * @param service - Record service of the selection.
 * @param item - The planned entry.
 * @param target - Effective target that wrote it; its root is the workspace root.
 * @param ctx - CLI context; `ctx.cwd()` is the fallback workspace root.
 * @param version - Version written.
 * @param written - The writer's `written` list, absolute paths.
 * @param syncSiblings - Which sibling entries sharing the files to sync (BR8.3).
 * @returns The record change.
 * @throws {RegistryError} A `RECORD.*` error naming the file.
 */
export const recordPlannedInstall = (
  service: InstallRecordService,
  item: PlannedRecordInstall,
  target: Target,
  ctx: Context,
  version: string,
  written: readonly string[],
  syncSiblings: RecordInstallInput['syncSiblings']
): Promise<RecordInstallResult> => service.recordInstall({
  location: item.location,
  bundleId: item.bundleId,
  version,
  tool: item.tool,
  source: { sourceId: item.sourceId, ...item.source },
  sourceType: item.sourceType,
  writtenPaths: written,
  // User level: home is the workspace root, as the user-scope install records it.
  workspaceRoot: item.location.level === 'user' ? item.location.root : (target.rootPath ?? ctx.cwd()),
  syncSiblings
});

/**
 * End a replay or update run: remove the superseded files only after every
 * save, keeping any file an entry of either file still lists (FR3.2, NFR4.9).
 * @param service - Record service of the selection.
 * @param changes - Every record change of the run.
 * @returns The warnings of the saves and of the removal.
 */
export const finishRecordRun = async (service: InstallRecordService, changes: readonly RecordInstallResult[]): Promise<string[]> => {
  const removal = await service.deleteSupersededAfterAll(changes);
  return [...changes.flatMap((change) => change.warnings), ...removal.warnings];
};

/** The selected level's old `prompt-registry.*` file and the bundles only it has (BR10.1). */
export interface OldFileOnlyBundles {
  /** Absolute path of the old file. */
  lockPath: string;
  /** The old file, read with today's code. */
  lock: Lockfile;
  /** Ids of the old file's bundles the new record does not have, in file order; may be empty. */
  bundleIds: string[];
}

/**
 * Read the selected level's old file and find the bundles the new record does
 * not have: today's code handles those, on that file, and the record wins for
 * the others (BR10.1; W5 step 6, W6 step 4, W8).
 * @param ctx - CLI context.
 * @param prepared - The command's record selection.
 * @returns The old file and its old-file-only bundles, or `undefined` when there is no readable old file.
 */
export const oldFileOnlyBundles = async (ctx: Context, prepared: PreparedRecordSelection): Promise<OldFileOnlyBundles | undefined> => {
  const lockPath = prepared.selection.oldLockfile;
  const lock = lockPath === undefined ? null : await readLockfile(lockPath, ctx.fs);
  if (lockPath === undefined || lock === null) {
    return undefined;
  }
  const recorded = new Set((await prepared.service.listEntries(prepared.selection.locations)).map((row) => row.bundleId));
  return { lockPath, lock, bundleIds: Object.keys(lock.bundles).filter((bundleId) => !recorded.has(bundleId)) };
};

/** How {@link prepareOldFileOnly} finds the target that writes the old-file-only bundles. */
export interface OldFileTargetInput {
  /** Command name, for the target errors. */
  command: string;
  /** The target to write with, already effective, when the command has one; it is used as is. */
  target?: Target;
  /** `--scope` / `--commit-mode` applied to an inferred target. */
  overrides?: TargetOverrides;
}

/** Old-file-only bundles with the target that writes them, or why no target could be found. */
export type OldFileOnlyPlan = OldFileOnlyBundles & ({ target: Target } | { reason: string });

/**
 * The old-file-only bundles and the target that writes them: the given
 * target, else the only configured target (BR23.2), made effective with the
 * overrides (BR10.1). With none or several configured, the reason is the
 * missing-target message.
 * @param ctx - CLI context.
 * @param prepared - The command's record selection.
 * @param resolve - Command name, the given target and the overrides.
 * @returns The bundles and their target or the reason none was found, or `undefined` when no bundle is only in the old file.
 */
export const prepareOldFileOnly = async (
  ctx: Context,
  prepared: PreparedRecordSelection,
  resolve: OldFileTargetInput
): Promise<OldFileOnlyPlan | undefined> => {
  const old = await oldFileOnlyBundles(ctx, prepared);
  if (old === undefined || old.bundleIds.length === 0) {
    return undefined;
  }
  if (resolve.target !== undefined) {
    return { ...old, target: resolve.target };
  }
  try {
    const targets = await readTargetsSafely(loadTargets(ctx));
    const name = targets.length === 1 ? targets[0].name : await resolveTargetName(undefined, resolve.command, ctx, () => loadTargets(ctx));
    const configured = await resolveTarget(name, resolve.command, ctx, () => loadTargets(ctx));
    return { ...old, target: resolveEffectiveTarget(ctx, configured, resolve.overrides) };
  } catch (error) {
    return { ...old, reason: error instanceof Error ? error.message : String(error) };
  }
};

/** The `level` and `records` fields every record command reports (BR6.3, NFR5.1). */
export interface RecordOutputFields {
  /** Level of the selected record. */
  level: RecordLevel;
  /** Absolute paths of the record files the command read or wrote. */
  records: string[];
}

/**
 * The `level` and `records` JSON fields for a selection: the selected new
 * record files that exist (the first one when none exists yet), or the old
 * store file at user level and for an old-format `--lockfile`.
 * @param selection - The command's record selection.
 * @param fs - Filesystem port, for the existence checks.
 * @param oldFileRead - The old-store file, when the command also read it (`status`):
 * listed after the existing new files, and instead of a new file that does not exist yet.
 * @returns The output fields.
 */
export const recordOutputFields = async (selection: RecordSelection, fs: RecordFs, oldFileRead?: string): Promise<RecordOutputFields> => {
  if (selection.locations.length === 0) {
    return { level: selection.level, records: selection.oldLockfile === undefined ? [] : [selection.oldLockfile] };
  }
  const existing: string[] = [];
  for (const location of selection.locations) {
    if (await fs.exists(location.path)) {
      existing.push(location.path);
    }
  }
  if (oldFileRead !== undefined) {
    existing.push(oldFileRead);
  }
  return { level: selection.level, records: existing.length > 0 ? existing : [selection.locations[0].path] };
};

/**
 * The `Record: <level> <path>` text line (BR6.3); several files are comma-separated.
 * @param fields - Output fields from {@link recordOutputFields}.
 * @returns The line, newline-terminated.
 */
export const renderRecordLine = (fields: RecordOutputFields): string =>
  `Record: ${fields.level} ${fields.records.join(', ')}\n`;
