/**
 * Record selection: which install record file(s) a command acts on, and why
 * (workflow W4; BR6.1, BR6.2; NFR4.8).
 *
 * A level is given by, in order, `--lockfile` (that file's level), `--scope`,
 * or the resolved target's scope. Only `status` and a bare `install` have no
 * given level: they use the repository level when a new record file is at the
 * git root of the current folder or an old `prompt-registry.*` file is found
 * by today's upward walk, and the user level otherwise. Every repository
 * record file selected is loaded through the `RecordStore` before this
 * returns, so a hostile or malformed record stops the command with a
 * `RECORD.*` error before anything is written. With the shared user record
 * and home passed in, the user level selects that record (rooted at home)
 * and keeps the old user lockfile as its old store (BR15.1); workspace scope
 * keeps the old user lockfile only (RQ4).
 * @module records/select-record
 */
import * as path from 'node:path';
import {
  type InstallationScope,
  LOCAL_RECORD_FILE_NAME,
  RECORD_FILE_NAMES,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
} from '@ai-primitives-hub/core';
import type {
  RecordStore,
} from './record-store';

/** Why a {@link RecordSelection} picked its level (entities.md `RecordSelection.reason`). */
export type RecordSelectionReason =
  | 'lockfile-flag'
  | 'explicit-scope'
  | 'target-scope'
  | 'repository-record-found'
  | 'user-fallback';

/** The record file(s) a command acts on (entities.md `RecordSelection`). Never stored. */
export interface RecordSelection {
  /** Level of every selected file. */
  level: RecordLevel;
  /** Level root: the git root (or the `--lockfile` folder) at repository level; the home folder for the shared user record, else the user lockfile's folder. */
  root: string;
  /**
   * New 3.0.0 record files, loaded and checked: both repository files at the
   * git root (committed first), or the one `--lockfile` file. Empty at user
   * level and for an old-format `--lockfile`.
   */
  locations: RecordLocation[];
  /**
   * Old-store file for the same level: the `prompt-registry.*` file found by
   * today's walk (repository), the user lockfile (user), or a `--lockfile`
   * that is not a new record file. Read with today's code (BR10.1).
   */
  oldLockfile?: string;
  /** `true` when no level was given and it was inferred (BR6.2). */
  inferred: boolean;
  /** Why this level was picked. */
  reason: RecordSelectionReason;
}

/** Inputs of {@link selectRecord}. */
export interface SelectRecordOptions {
  /** Record store used to load every selected file. */
  store: RecordStore;
  /** Filesystem port, for the existence checks. */
  fs: RecordFs;
  /** Current folder; the start of every walk when no target root is given. */
  cwd: string;
  /** What the command was given; nothing for `status` and a bare `install`. */
  given?: {
    /** `--lockfile <path>`, absolute or relative to `cwd`. */
    lockfile?: string;
    /** `--scope`. */
    scope?: InstallationScope;
    /** The resolved target; its scope gives the level, its root the start folder. */
    target?: { scope: InstallationScope; rootPath?: string };
  };
  /**
   * Today's upward walk for an old `prompt-registry.*` file (app `findLockfile`),
   * passed in so this module does not depend on a delivery layer. A result equal
   * to {@link userLockfile} is not a repository file and is ignored.
   */
  findOldLockfile: (start: string) => Promise<string | null>;
  /** Absolute path of the user lockfile (`resolveUserConfigPaths(env).userLockfile`). */
  userLockfile: string;
  /**
   * The shared 3.0.0 user record (`AppStoragePaths.userRecord`, BR14.1). With
   * {@link home}, the user level selects it (BR15.1); without, the user level
   * keeps the old user lockfile only.
   */
  userRecord?: string;
  /** Home folder from `resolveUserHome`; the user level's root (BR14.3). */
  home?: string;
}

/**
 * Record level for an install scope: `repository` for repository targets,
 * `user` for user and workspace targets (both use the user lockfile today).
 * @param scope - Install scope.
 * @returns The record level.
 */
export const recordLevelForScope = (scope: InstallationScope): RecordLevel =>
  scope === 'repository' ? 'repository' : 'user';

const userSelection = (userLockfile: string, reason: RecordSelectionReason, inferred: boolean): RecordSelection => ({
  level: 'user',
  root: path.dirname(userLockfile),
  locations: [],
  oldLockfile: userLockfile,
  inferred,
  reason
});

/**
 * User selection on the shared user record (BR15.1): the loaded user
 * location, rooted at home, with the old user lockfile as old store when it
 * exists. Falls back to the old-only selection when the caller did not pass
 * the user record and home, and for workspace scope (RQ4).
 * @param options - Selection inputs.
 * @param reason - Why the user level was picked.
 * @param inferred - Whether the level was inferred.
 * @param scope - The given or target scope, when there is one.
 */
const sharedUserSelection = async (
  options: SelectRecordOptions,
  reason: RecordSelectionReason,
  inferred: boolean,
  scope?: InstallationScope
): Promise<RecordSelection> => {
  if (options.userRecord === undefined || options.home === undefined || scope === 'workspace') {
    return userSelection(options.userLockfile, reason, inferred);
  }
  const location = options.store.resolveUser({ home: options.home, path: options.userRecord });
  await options.store.load(location);
  const oldExists = await options.fs.exists(options.userLockfile);
  return {
    level: 'user',
    root: location.root,
    locations: [location],
    ...(oldExists ? { oldLockfile: options.userLockfile } : {}),
    inferred,
    reason
  };
};

/**
 * The old repository file found from `start`, ignoring the user lockfile the walk may fall back to.
 * @param options - Selection inputs.
 * @param start - Folder the walk starts from.
 */
const findOldRepositoryFile = async (options: SelectRecordOptions, start: string): Promise<string | undefined> => {
  const found = await options.findOldLockfile(start);
  return found === null || path.resolve(found) === path.resolve(options.userLockfile) ? undefined : found;
};

/**
 * Repository selection at the git root of `start`, with both new files loaded (NFR4.8).
 * @param options - Selection inputs.
 * @param start - Target root or current folder.
 * @param reason - Why the repository level was picked.
 * @param oldLockfile - Old file already found, if any.
 */
const repositorySelection = async (
  options: SelectRecordOptions,
  start: string,
  reason: RecordSelectionReason,
  oldLockfile?: string
): Promise<RecordSelection> => {
  const locations = await options.store.resolveRepository({ start });
  for (const location of locations) {
    await options.store.load(location);
  }
  const old = oldLockfile ?? await findOldRepositoryFile(options, start);
  return {
    level: 'repository',
    root: locations[0].root,
    locations,
    ...(old === undefined ? {} : { oldLockfile: old }),
    inferred: reason === 'repository-record-found',
    reason
  };
};

/**
 * Selection for `--lockfile <path>`: the level comes from the file (BR6.1).
 * The user lockfile is the user level; a new record file name is that one
 * repository file, loaded; any other name is an old-format file for today's code.
 * @param options - Selection inputs.
 * @param lockfile - The flag's value.
 */
const lockfileSelection = async (options: SelectRecordOptions, lockfile: string): Promise<RecordSelection> => {
  const absolute = path.resolve(options.cwd, lockfile);
  if (absolute === path.resolve(options.userLockfile)) {
    return userSelection(options.userLockfile, 'lockfile-flag', false);
  }
  if (options.userRecord !== undefined && absolute === path.resolve(options.userRecord)) {
    return sharedUserSelection(options, 'lockfile-flag', false);
  }
  const root = path.dirname(absolute);
  const name = path.basename(absolute);
  if (!(RECORD_FILE_NAMES as readonly string[]).includes(name)) {
    return { level: 'repository', root, locations: [], oldLockfile: absolute, inferred: false, reason: 'lockfile-flag' };
  }
  const location: RecordLocation = {
    level: 'repository',
    root,
    path: absolute,
    commitMode: name === LOCAL_RECORD_FILE_NAME ? 'local-only' : 'commit'
  };
  await options.store.load(location);
  return { level: 'repository', root, locations: [location], inferred: false, reason: 'lockfile-flag' };
};

/**
 * Choose the record file(s) a command acts on (W4 steps 1–3; BR6.1, BR6.2).
 * @param options - The store, filesystem, current folder, what the command was given and the old-store lookups.
 * @returns The level, root, loaded new record locations and the old-store file, if any.
 * @throws {RegistryError} Any `RECORD.*` error from loading a selected file; nothing was written.
 */
export const selectRecord = async (options: SelectRecordOptions): Promise<RecordSelection> => {
  const { given, cwd } = options;
  if (given?.lockfile !== undefined && given.lockfile !== '') {
    return lockfileSelection(options, given.lockfile);
  }
  const start = path.resolve(cwd, given?.target?.rootPath ?? cwd);
  if (given?.scope !== undefined) {
    return recordLevelForScope(given.scope) === 'repository'
      ? repositorySelection(options, start, 'explicit-scope')
      : sharedUserSelection(options, 'explicit-scope', false, given.scope);
  }
  if (given?.target !== undefined) {
    return recordLevelForScope(given.target.scope) === 'repository'
      ? repositorySelection(options, start, 'target-scope')
      : sharedUserSelection(options, 'target-scope', false, given.target.scope);
  }
  const [committed, localOnly] = await options.store.resolveRepository({ start: path.resolve(cwd) });
  const hasNewRecord = (await options.fs.exists(committed.path)) || (await options.fs.exists(localOnly.path));
  const old = hasNewRecord ? undefined : await findOldRepositoryFile(options, path.resolve(cwd));
  if (hasNewRecord || old !== undefined) {
    return repositorySelection(options, path.resolve(cwd), 'repository-record-found', old);
  }
  return sharedUserSelection(options, 'user-fallback', true);
};
