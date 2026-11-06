/**
 * Install record wiring for the CLI (workflows W1, W4–W8; BR2.1–BR2.4,
 * BR3.3–BR3.5, BR4.2, BR6.1–BR6.5).
 *
 * This is the CLI composition root for the install record: it builds a
 * `RecordStore` and an `InstallRecordService` on `NodeRecordFs` and the
 * 3.0.0 `RecordSchemaValidator`, stamped `ai-primitives-hub-cli@<version>`.
 * It also selects the record a command acts on, builds the configured-source
 * map for the source trust gate, and renders the `Record:` line
 * and the `level` / `records` JSON fields. User level keeps the old
 * lockfile path until U4. Old `prompt-registry.*` files are never read,
 * changed or deleted here (BR2.4).
 * @module framework/install-record
 */
import * as path from 'node:path';
import {
  createInstallRecordServices,
  findLockfile,
  type InstallRecordService,
  type InstallRecordServices,
  type RecordSelection,
  type RecordSourceInput,
  type RecordStore,
  resolveExcludeFile,
  resolveUserConfigPaths,
  selectRecord,
} from '@ai-primitives-hub/app';
import {
  compareCodeUnits,
  DEFAULT_LOCAL_HUB_ID,
  describeRecordError,
  type InstallationScope,
  isRecordError,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  RegistryError,
  type RegistrySource,
  type RepositoryExclusion,
  type Target,
} from '@ai-primitives-hub/core';
import {
  GitInfoExclude,
  NodeRecordFs,
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
   * in: the same file the record store adds the local-only record to.
   */
  exclusion: RepositoryExclusion;
}

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
 * @param fs - Filesystem port.
 */
const createRecordServices = (fs: RecordFs): InstallRecordServices =>
  createInstallRecordServices({ generatedBy: CLI_RECORD_GENERATED_BY, fs });

/** Both repository record files for a target, and the one its commit mode names. */
interface RepositoryRecords extends InstallRecordServices {
  /** Workspace root the writer installs into (where merged MCP config files sit). */
  workspaceRoot: string;
  /** The committed record file at the git root. */
  committed: RecordLocation;
  /** The local-only record file at the git root. */
  localOnly: RecordLocation;
  /** The file the target's commit mode names (BR2.2). */
  location: RecordLocation;
  /** The `info/exclude` section at the git root, in the file the record store uses (NFR4.6). */
  exclusion: RepositoryExclusion;
}

/**
 * Build the record services and locate both repository record files for a
 * repository-scope target (BR2.1, BR2.2). Loads nothing.
 *
 * The exclusion edits the `info/exclude` file app's `resolveExcludeFile`
 * finds (following `gitdir:` and `commondir` in a worktree), so the installed
 * files' entries and the local-only record's entry share one file. Without a
 * trusted git directory it keeps the writer's default, `<workspace>/.git/info/exclude`.
 * @param ctx - CLI context; `ctx.cwd()` is the fallback start folder.
 * @param target - Effective repository-scope target.
 * @param fs - Filesystem port.
 * @returns The services, the workspace root, the record locations and the exclusion.
 */
const openRepositoryRecords = async (ctx: Context, target: Target, fs: RecordFs): Promise<RepositoryRecords> => {
  const services = createRecordServices(fs);
  const workspaceRoot = target.rootPath ?? ctx.cwd();
  const [committed, localOnly] = await services.store.resolveRepository({ start: workspaceRoot });
  // An unreadable `.git` keeps the default file; the record store warns about it on save.
  const excludeFile = await resolveExcludeFile(fs, committed.root).catch(() => ({ warning: 'unreadable' }));
  return {
    ...services,
    workspaceRoot,
    committed,
    localOnly,
    location: target.commitMode === 'local-only' ? localOnly : committed,
    exclusion: 'file' in excludeFile
      // Exclude patterns are relative to the work tree root, which is the record root.
      ? new GitInfoExclude({ fs: ctx.fs, workspaceRoot: committed.root, excludePath: excludeFile.file })
      : new GitInfoExclude({ fs: ctx.fs, workspaceRoot })
  };
};

/**
 * Load and check both repository record files before anything is written
 * (W1 steps 2–4, BR3.5). Call only for repository-scope targets.
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
    await records.store.load(records.committed);
    await records.store.load(records.localOnly);
    return {
      location: records.location,
      service: records.service,
      workspaceRoot: records.workspaceRoot,
      exclusion: records.exclusion
    };
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
  /** `.git/info/exclude` section the repository-scope writer lists local-only files in. */
  exclusion: RepositoryExclusion;
  /**
   * Bundles with an entry for `tool` in either file, sorted, mapped to their
   * recorded root-relative paths (both files merged).
   */
  entries: Map<string, string[]>;
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
 * Load and check both repository record files before anything is removed
 * (repository-scope uninstall, FR4.1 U1 part). Call only for repository-scope
 * targets. A bundle with no entry for the target's type here is not in the
 * map, so the caller can fall back to the old store for it.
 * @param ctx - CLI context; `ctx.cwd()` is the fallback start folder.
 * @param target - Effective repository-scope target.
 * @param fs - Filesystem port; `NodeRecordFs` unless a test passes one.
 * @returns The location, service, tool and the bundles recorded for that tool.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was removed.
 */
export const prepareRepositoryUninstall = async (
  ctx: Context,
  target: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryUninstall> => {
  try {
    const { store, service, committed, localOnly, location, exclusion } = await openRepositoryRecords(ctx, target, fs);
    const entries = new Map<string, string[]>();
    for (const recordLocation of [committed, localOnly]) {
      const { record } = await store.load(recordLocation);
      for (const [bundleId, bundle] of Object.entries(record.bundles)) {
        if (!Object.hasOwn(bundle.tools, target.type)) {
          continue;
        }
        const paths = bundle.tools[target.type].files.map((file) => file.path);
        entries.set(bundleId, [...new Set([...(entries.get(bundleId) ?? []), ...paths])]);
      }
    }
    return {
      location,
      service,
      tool: target.type,
      // Same exclude file the install wrote the local-only entries to.
      exclusion,
      entries: new Map([...entries].toSorted(([left], [right]) => compareCodeUnits(left, right)))
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
  const removal = await prepared.service.deleteSuperseded(change);
  const warnings = [...change.warnings, ...removal.warnings];
  if (change.location.commitMode === 'local-only' && removal.deleted.length > 0) {
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
    kept: change.keptSharedFiles,
    warnings
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
}

/**
 * Select the record a command acts on and load every selected file before
 * anything is written (W4; BR6.1, BR6.2, NFR4.8). The old `prompt-registry.*`
 * file is found with today's upward walk from the selection's start folder.
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
  try {
    const selection = await selectRecord({
      store,
      fs,
      cwd: ctx.cwd(),
      given: {
        ...(input.lockfile === undefined || input.lockfile === '' ? {} : { lockfile: input.lockfile }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(target === undefined ? {} : { target: { scope: target.scope, rootPath: target.rootPath } })
      },
      findOldLockfile: (start) => findLockfile(start, ctx.fs, userLockfile),
      userLockfile
    });
    return { selection, store, service, fs };
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
