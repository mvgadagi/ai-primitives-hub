/**
 * Install record wiring for the CLI (workflows W1, W4–W8; BR2.1–BR2.4,
 * BR3.3–BR3.5, BR4.2, BR6.1–BR6.5).
 *
 * This is the CLI composition root for the install record: it builds a
 * `RecordStore` and an `InstallRecordService` on `NodeRecordFs` and the
 * 3.0.0 `RecordSchemaValidator`, stamped `ai-primitives-hub-cli@<version>`.
 * It also selects the record a command acts on, builds the configured-source
 * map for the source trust gate, adapts record entries to the legacy
 * lockfile shapes today's fetch code reads, and renders the `Record:` line
 * and the `level` / `records` JSON fields. User level records into the
 * shared user record (`AppStoragePaths.userRecord`, rooted at home); the old
 * 2.0.0 user lockfile is read but never written here. The writing helpers
 * run `migrateRecords` for their level before the first record change
 * (BR18.1): repository level renames and merges the old `prompt-registry.*`
 * files at the git root; user level imports the old user lockfile once. Reads
 * (`status`), workspace scope and an old-format `--lockfile` never migrate.
 * @module framework/install-record
 */
import * as path from 'node:path';
import {
  assertUserFolderInsideHome,
  findLockfile,
  InstallRecordService,
  type LockfileBundleEntry,
  type LockfileSourceEntry,
  migrateRecords,
  type MigrationReport,
  readLockfile,
  type RecordSelection,
  type RecordSourceInput,
  RecordStore,
  resolveLayoutAsync,
  resolveUserConfigPaths,
  resolveUserHome,
  selectRecord,
  type TargetLayout,
} from '@ai-primitives-hub/app';
import {
  DEFAULT_LOCAL_HUB_ID,
  expandPath,
  IMPORTED_USER_LOCKFILE_FIELD,
  type InstallationScope,
  type InstallRecord,
  isRecordError,
  matchKindRoute,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  RegistryError,
  type RegistrySource,
  type RepositoryExclusion,
  type SourceRecord,
  type Target,
  type ToolEntry,
  UNKNOWN_TOOL_NAME,
} from '@ai-primitives-hub/core';
import {
  FileSystemLayoutConfigLoader,
  GitInfoExclude,
  NodeRecordFs,
  RecordSchemaValidator,
  resolveUserConfigDir,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  CLI_VERSION,
} from '../version';
import type {
  Context,
} from './context';
import {
  createHubManager,
} from './hub-manager';

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
  /** What the migration run before this action did; absent when there was nothing to migrate (BR22.1). */
  migration?: MigrationReport;
}

/**
 * Migrate the old stores of a level into its loaded record files before the
 * first record change (BR18.1). The level root is the locations' root: the
 * git root for both repository files, home for the user record, whose old
 * user lockfile is imported once (BR20.1).
 * @param ctx - CLI context, for the old user lockfile path.
 * @param store - Store the locations are loaded with.
 * @param fs - Filesystem port.
 * @param targets - Both repository files, or the user record.
 * @returns The report, or `undefined` when there was nothing to migrate.
 * @throws {RegistryError} A `RECORD.*` error naming the file.
 */
const migrateLevel = async (
  ctx: Context,
  store: RecordStore,
  fs: RecordFs,
  targets: readonly RecordLocation[]
): Promise<MigrationReport | undefined> => {
  const level = targets[0].level;
  return migrateRecords({
    store,
    fs,
    level,
    root: targets[0].root,
    targets,
    ...(level === 'user' ? { oldUserLockfile: resolveUserConfigPaths(ctx.env).userLockfile } : {}),
    now: () => new Date()
  });
};

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
  const file = typeof error.context?.file === 'string' ? error.context.file : undefined;
  const detail = typeof error.context?.detail === 'string' ? error.context.detail : undefined;
  let message = `${command}: ${error.message}`;
  if (file !== undefined) {
    message += ` File: ${file}.`;
  }
  if (detail !== undefined) {
    message += ` Reason: ${detail}.`;
  }
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
  const store = new RecordStore({ fs, validator: new RecordSchemaValidator(), generatedBy: CLI_RECORD_GENERATED_BY });
  const service = new InstallRecordService({ store, fs });
  const workspaceRoot = target.rootPath ?? ctx.cwd();
  try {
    const [committed, localOnly] = await store.resolveRepository({ start: workspaceRoot });
    await store.load(committed);
    await store.load(localOnly);
    const migration = await migrateLevel(ctx, store, fs, [committed, localOnly]);
    await store.load(committed);
    await store.load(localOnly);
    return {
      location: target.commitMode === 'local-only' ? localOnly : committed,
      service,
      workspaceRoot,
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
  const loader = new FileSystemLayoutConfigLoader({ cwd: ctx.cwd(), fs: ctx.fs, userConfigDir: resolveUserConfigDir(ctx.env) });
  const layout = await resolveLayoutAsync(target, loader);
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
  const store = new RecordStore({ fs, validator: new RecordSchemaValidator(), generatedBy: CLI_RECORD_GENERATED_BY });
  const service = new InstallRecordService({ store, fs });
  const home = resolveUserHome(ctx.env);
  try {
    const location = store.resolveUser({ home, path: new XdgAppStorage(ctx.env).getPaths().userRecord });
    await store.load(location);
    const { layout, baseDir } = await resolveUserTargetLayout(ctx, target, home);
    const routes = Object.values(layout.kindRoutes);
    const folders = new Set(routes.length === 0 ? [baseDir] : routes.map((route) => path.join(baseDir, route)));
    for (const folder of folders) {
      await assertUserFolderInsideHome(fs, home, folder);
    }
    const migration = await migrateLevel(ctx, store, fs, [location]);
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
  /** Root-relative files kept because another entry still lists them. */
  kept: string[];
  /** Non-fatal problems: skipped deletions or a record file that could not be removed. */
  warnings: string[];
}

/**
 * Bundles whose only tool across the given records is `unknown` (BR21.3).
 * @param records - The level's loaded records.
 * @returns Their bundle ids.
 */
const loneUnknownBundles = (records: readonly InstallRecord[]): Set<string> => {
  const tools = new Map<string, Set<string>>();
  for (const record of records) {
    for (const [bundleId, bundle] of Object.entries(record.bundles)) {
      tools.set(bundleId, new Set([...(tools.get(bundleId) ?? []), ...Object.keys(bundle.tools)]));
    }
  }
  return new Set([...tools].filter(([, names]) => names.size === 1 && names.has(UNKNOWN_TOOL_NAME)).map(([bundleId]) => bundleId));
};

/**
 * Load and check both repository record files and migrate the old
 * `prompt-registry.*` files at the git root before anything is removed
 * (repository-scope uninstall, FR4.1 U1 part; BR18.1). Call only for
 * repository-scope targets. A bundle with no entry for the target's type here
 * is not in the map, so the caller can fall back to the old store for it.
 * @param ctx - CLI context; `ctx.cwd()` is the fallback start folder.
 * @param target - Effective repository-scope target.
 * @param options - `dryRun`: a preview, which never migrates (BR18.1).
 * @param options.dryRun - `true` for `--dry-run`.
 * @param fs - Filesystem port; `NodeRecordFs` unless a test passes one.
 * @returns The location, service, tool, the bundles recorded for that tool and the migration report.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was removed.
 */
export const prepareRepositoryUninstall = async (
  ctx: Context,
  target: Target,
  options: { dryRun?: boolean } = {},
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryUninstall> => {
  const store = new RecordStore({ fs, validator: new RecordSchemaValidator(), generatedBy: CLI_RECORD_GENERATED_BY });
  const service = new InstallRecordService({ store, fs });
  const workspaceRoot = target.rootPath ?? ctx.cwd();
  try {
    const [committed, localOnly] = await store.resolveRepository({ start: workspaceRoot });
    await store.load(committed);
    await store.load(localOnly);
    const migration = options.dryRun === true ? undefined : await migrateLevel(ctx, store, fs, [committed, localOnly]);
    const entries = new Map<string, string[]>();
    const records: InstallRecord[] = [];
    for (const location of [committed, localOnly]) {
      const { record } = await store.load(location);
      records.push(record);
      for (const [bundleId, bundle] of Object.entries(record.bundles)) {
        if (!Object.hasOwn(bundle.tools, target.type)) {
          continue;
        }
        const paths = bundle.tools[target.type].files.map((file) => file.path);
        entries.set(bundleId, [...new Set([...(entries.get(bundleId) ?? []), ...paths])]);
      }
    }
    return {
      location: target.commitMode === 'local-only' ? localOnly : committed,
      service,
      tool: target.type,
      // Same adapter and root the repository-scope writer used at install time.
      exclusion: new GitInfoExclude({ fs: ctx.fs, workspaceRoot }),
      entries: new Map([...entries].toSorted(([left], [right]) => (left < right ? -1 : (left > right ? 1 : 0)))),
      loneUnknown: loneUnknownBundles(records),
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
  const store = new RecordStore({ fs, validator: new RecordSchemaValidator(), generatedBy: CLI_RECORD_GENERATED_BY });
  const service = new InstallRecordService({ store, fs });
  const home = resolveUserHome(ctx.env);
  try {
    const location = store.resolveUser({ home, path: new XdgAppStorage(ctx.env).getPaths().userRecord });
    await store.load(location);
    const migration = options.dryRun === true ? undefined : await migrateLevel(ctx, store, fs, [location]);
    const { record } = await store.load(location);
    const entries = new Map<string, string[]>();
    for (const bundleId of Object.keys(record.bundles).toSorted()) {
      const tools = record.bundles[bundleId].tools;
      if (Object.hasOwn(tools, target.type)) {
        entries.set(bundleId, tools[target.type].files.map((file) => file.path));
      }
    }
    // Once the old user lockfile was imported, the user level no longer reads it (BR20.1).
    const imported = record[IMPORTED_USER_LOCKFILE_FIELD] !== undefined;
    const keepPaths = entries.size === 0 || imported ? new Map<string, Set<string>>() : await oldUserLockfilePaths(ctx, target, home);
    return {
      location,
      service,
      tool: target.type,
      entries,
      keepPaths,
      loneUnknown: loneUnknownBundles([record]),
      ignoresOldStore: imported,
      ...(migration === undefined ? {} : { migration })
    };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
};

/**
 * Remove one bundle's entry for the target's type from the repository
 * records, then delete its files except those another entry still lists.
 * @param prepared - Result of {@link prepareRepositoryUninstall}.
 * @param bundleId - Bundle to uninstall.
 * @returns The record path, removed and kept files, and warnings.
 * @throws {RegistryError} `RECORD.ENTRY_NOT_FOUND` or another `RECORD.*` error naming the file.
 */
export const recordRepositoryUninstall = async (
  prepared: PreparedRepositoryUninstall,
  bundleId: string
): Promise<RecordedRepositoryUninstall> => {
  let change;
  try {
    change = await prepared.service.recordUninstall({ location: prepared.location, bundleId, tool: prepared.tool });
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
  const keep = prepared.keepPaths?.get(bundleId);
  const keptForOld = keep === undefined ? [] : change.deletedFiles.filter((file) => keep.has(file));
  const removal = await prepared.service.deleteSuperseded({
    location: change.location,
    // Files the old user lockfile still lists stay on disk for it.
    deletedFiles: keep === undefined ? change.deletedFiles : change.deletedFiles.filter((file) => !keep.has(file))
  });
  const warnings = [...change.warnings, ...removal.warnings];
  if (change.location.commitMode === 'local-only' && removal.deleted.length > 0 && prepared.exclusion !== undefined) {
    // A local-only install listed its files in `.git/info/exclude`; drop the
    // entries of the files removed, as the old uninstall path did.
    try {
      await prepared.exclusion.remove(removal.deleted.map((relative) => path.join(change.location.root, ...relative.split('/'))));
    } catch (error) {
      warnings.push(`Could not update .git/info/exclude: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    lockfile: change.location.path,
    removed: removal.deleted,
    kept: [...change.keptSharedFiles, ...keptForOld],
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
  let change;
  try {
    change = await prepared.service.recordUninstall({ location: prepared.location, bundleId, tool: UNKNOWN_TOOL_NAME });
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
  return {
    lockfile: change.location.path,
    removed: [],
    kept: [...change.deletedFiles, ...change.keptSharedFiles].toSorted(),
    warnings: change.warnings
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
  const store = new RecordStore({ fs, validator: new RecordSchemaValidator(), generatedBy: CLI_RECORD_GENERATED_BY });
  const service = new InstallRecordService({ store, fs });
  const userLockfile = resolveUserConfigPaths(ctx.env).userLockfile;
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
      userRecord: new XdgAppStorage(ctx.env).getPaths().userRecord,
      home: resolveUserHome(ctx.env)
    });
    const selection = await select();
    if (input.write !== true || selection.locations.length === 0) {
      return { selection, store, service, fs };
    }
    const targets = selection.level === 'user' ? selection.locations : await store.resolveRepository({ start: selection.root });
    if (targets[0].root !== selection.root) {
      return { selection, store, service, fs };
    }
    const migration = await migrateLevel(ctx, store, fs, targets);
    return { selection: await select(), store, service, fs, ...(migration === undefined ? {} : { migration }) };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError(input.command, error) : error;
  }
};

/**
 * Configured sources by id for the source trust gate (NFR4.11): the active
 * hub's sources first, then detached (`default-local`) sources whose id the
 * active hub does not use. A hub that cannot be read contributes no source,
 * so its entries fall back to the record's copy without credentials.
 * @param ctx - CLI context.
 * @returns Configured sources keyed by id, in lookup order.
 */
export const configuredSources = async (ctx: Context): Promise<Map<string, RegistrySource>> => {
  const manager = createHubManager({ ctx });
  const sources = new Map<string, RegistrySource>();
  let active: RegistrySource[] = [];
  try {
    active = await manager.listSources();
  } catch {
    // No readable active hub: no configured source from it.
  }
  const detached = (await manager.listSourcesAcrossAllHubs()).filter((source) => source.hubId === DEFAULT_LOCAL_HUB_ID);
  for (const source of [...active, ...detached]) {
    if (!sources.has(source.id)) {
      sources.set(source.id, source);
    }
  }
  return sources;
};

/**
 * A decided record source in the legacy lockfile shape today's fetch and
 * update code reads. Only the fields the record carries are copied; an
 * `authMode` other than `bearer` / `anonymous` is dropped.
 * @param source - Source from `resolveRecordSource` (or a record's copy).
 * @returns The legacy source entry.
 */
export const toLockfileSourceEntry = (source: SourceRecord): LockfileSourceEntry => ({
  type: source.type,
  url: source.url,
  ...(typeof source.branch === 'string' ? { branch: source.branch } : {}),
  ...(typeof source.collectionsPath === 'string' ? { collectionsPath: source.collectionsPath } : {}),
  ...(typeof source.indexFile === 'string' ? { indexFile: source.indexFile } : {}),
  ...(source.authMode === 'bearer' || source.authMode === 'anonymous' ? { authMode: source.authMode } : {}),
  ...(typeof source.credentialRef === 'string' ? { credentialRef: source.credentialRef } : {})
});

/**
 * A record tool entry in the legacy lockfile bundle shape. Record entries
 * carry per-file checksums and no bundle archive checksum, so the legacy
 * archive checksum check does not apply; `recordInstall` re-checksums the
 * written files.
 * @param entry - Tool entry from a 3.0.0 record.
 * @returns The legacy bundle entry.
 */
export const toLockfileBundleEntry = (entry: ToolEntry): LockfileBundleEntry => ({
  version: entry.version,
  sourceId: entry.sourceId,
  sourceType: entry.sourceType,
  installedAt: entry.installedAt,
  files: entry.files.map((file) => ({ path: file.path, checksum: file.checksum }))
});

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
 * @returns The output fields.
 */
export const recordOutputFields = async (selection: RecordSelection, fs: RecordFs): Promise<RecordOutputFields> => {
  if (selection.locations.length === 0) {
    return { level: selection.level, records: selection.oldLockfile === undefined ? [] : [selection.oldLockfile] };
  }
  const existing: string[] = [];
  for (const location of selection.locations) {
    if (await fs.exists(location.path)) {
      existing.push(location.path);
    }
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
