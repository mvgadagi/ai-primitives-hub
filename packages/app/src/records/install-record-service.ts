/**
 * Install record service: record a tool's install of a bundle in the shared
 * record, and remove the files that install superseded (contract C3, U1 shape;
 * workflow W1 steps 6–13).
 *
 * `recordInstall` turns the writer's `written` list into recorded files
 * (git-root-relative, confined, checksummed from the bytes on disk, merged MCP
 * config files left out), replaces only `bundles.<id>.tools.<tool>`, records
 * the sanitized source, moves the entry out of the other repository file,
 * brings sibling tool entries that share its files to the same version
 * (BR8.3), and saves the target file first, then the other one. It deletes
 * nothing: the superseded files come back in `RecordChange.deletedFiles`, and
 * the caller passes the change to `deleteSuperseded` after the save (BR3.4).
 * `listEntries` gives the `status` rows (BR9.2) and `holdingLocation` the file
 * an entry is re-recorded in (BR6.5).
 *
 * Rules: BR1.2, BR1.4–BR1.7, BR3.1, BR3.2, BR3.4, BR3.6, BR3.7, BR6.5, BR8.3, BR9.2; NFR4.2, NFR4.5, NFR4.9.
 * @module records/install-record-service
 */
import * as path from 'node:path';
import {
  type BundleRecord,
  FORBIDDEN_KEYS,
  type InstallRecord,
  LOCAL_RECORD_FILE_NAME,
  RECORD_FILE_NAME,
  type RecordChange,
  type RecordedFile,
  recordError,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  type SourceRecord,
  type SourceType,
  TARGET_TYPES,
  type ToolEntry,
  UNKNOWN_TOOL_NAME,
  WORKSPACE_ROOT_TOKEN,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts,
} from '@ai-primitives-hub/infra';
import {
  resolveMcpLayoutConfig,
} from '../install/layout-resolver';
import {
  confinePath,
  resolveDeleteTarget,
} from './confine-path';
import {
  removeExcluded,
} from './git-root';
import type {
  LoadedRecord,
  RecordStore,
} from './record-store';
import {
  sanitizeSource,
} from './sanitize-source';

/**
 * Every `SourceType` value as a key; typing it as `Record<SourceType, true>`
 * makes the compiler reject a missing or extra value, so it stays in step
 * with the union in core.
 */
const SOURCE_TYPE_KEYS: Readonly<Record<SourceType, true>> = {
  github: true,
  local: true,
  'awesome-copilot': true,
  'local-awesome-copilot': true,
  apm: true,
  'local-apm': true,
  skills: true,
  'local-skills': true,
  'azure-devops': true,
  artifactory: true
};

/** Every `SourceType` value, the only `sourceType` a new entry may carry (BR1.4). */
export const RECORD_SOURCE_TYPES: readonly SourceType[] = Object.keys(SOURCE_TYPE_KEYS) as SourceType[];

/** Source details passed to `recordInstall`: the C1 fields plus the key they are recorded under. */
export interface RecordSourceInput {
  /** Key of the source in `sources` (BR3.2). */
  sourceId: string;
  /** Source type; must equal `RecordInstallInput.sourceType` (BR3.7). */
  type: string;
  /** Source URL; credentials are removed before it is recorded (NFR4.5). */
  url: string;
  branch?: string;
  collectionsPath?: string;
  indexFile?: string;
  authMode?: string;
  credentialRef?: string;
  /** Any other field is dropped, never recorded. */
  [key: string]: unknown;
}

/** U1 `recordInstall` input (functional-spec W1; amends C3). */
export interface RecordInstallInput {
  /** File the entry is recorded in, from `RecordStore.resolveRepository` and the commit mode. */
  location: RecordLocation;
  /** Bundle id from the manifest. */
  bundleId: string;
  /** Bundle version from the manifest. */
  version: string;
  /** The target's type, never the user's target name (BR1.2). */
  tool: string;
  /** The full source: `sourceId`, `type`, `url` and optional fields (BR3.2). */
  source: RecordSourceInput;
  /** A `SourceType` value equal to `source.type` (BR1.4, BR3.7). */
  sourceType: string;
  /** The writer's `written` list, as absolute paths (BR1.7). */
  writtenPaths: readonly string[];
  /**
   * Absolute workspace root the writer installed into, where its merged MCP
   * config files sit (BR1.7). Defaults to the record's root.
   */
  workspaceRoot?: string;
  /**
   * Shared-folder sync (BR8.3). `true` (default) brings every sibling entry of
   * the bundle (another tool, either repository file, sharing a path with this
   * tool's new or previous files) to this version and shared file list; a
   * function limits that to the tools it accepts (e.g. those with a mapped
   * target); `false` syncs and reports none. Pass `false` when re-recording a
   * sibling after its own writer ran, so the sync never loops.
   */
  syncSiblings?: boolean | ((tool: string) => boolean);
}

/** One sibling entry found by the shared-folder sync (BR8.3). */
export interface SiblingSync {
  /** The sibling's tool key. */
  tool: string;
  /** Its version now: the new version when synced, its old one otherwise. */
  version: string;
  /** The file that holds the sibling, for re-recording it there (BR6.5). */
  location: RecordLocation;
  /** `false` when `syncSiblings` did not accept the tool: the entry was left unchanged and is out of date. */
  synced: boolean;
}

/** Outcome of {@link InstallRecordService.recordInstall}. */
export interface RecordInstallResult extends RecordChange {
  /** Non-fatal problems from the saves, for the caller to log. */
  warnings: string[];
  /** Sibling entries found by the shared-folder sync, sorted by tool; empty for an uninstall (BR8.3). */
  siblings: SiblingSync[];
}

/** One `status` row: one (bundle, tool) entry of a record file (entities.md `StatusRow`, BR9.2). */
export interface StatusRow {
  bundleId: string;
  tool: string;
  level: RecordLevel;
  version: string;
  /** Absolute path of the record file the entry is in. */
  record: string;
  /** `true` for an entry under the `unknown` tool that must be reinstalled. */
  needsReinstall: boolean;
}

/** Outcome of {@link InstallRecordService.deleteSuperseded}. */
export interface DeleteSupersededResult {
  /** Root-relative paths that were removed. */
  deleted: string[];
  /** One message per path that was skipped or could not be removed. */
  warnings: string[];
}

/** Dependencies of an {@link InstallRecordService}. */
export interface InstallRecordServiceOptions {
  /** Record store; loads and saves both repository files. */
  store: RecordStore;
  /** Filesystem port used for confinement, checksums and deletions. */
  fs: RecordFs;
  /** Clock for `installedAt`; defaults to the current time. */
  now?: () => Date;
}

/**
 * Root-relative paths of every repository-scope MCP config file in the
 * built-in layouts, e.g. `.vscode/mcp.json`. These files are merged, not
 * owned, so they are never recorded (BR1.7).
 */
const mergedMcpConfigPaths = (): string[] => {
  const prefix = WORKSPACE_ROOT_TOKEN;
  const paths = new Set<string>();
  for (const type of TARGET_TYPES) {
    const config = resolveMcpLayoutConfig(type, 'repository', [defaultLayouts]);
    if (config?.path.startsWith(prefix)) {
      paths.add(config.path.slice(prefix.length).replaceAll('\\', '/').replace(/^\/+/, ''));
    }
  }
  return [...paths];
};

const MERGED_MCP_CONFIG_PATHS = mergedMcpConfigPaths();

/**
 * Whether a root-relative path is a merged MCP config file of the install's
 * workspace. The workspace root may sit below the git root, so the layout
 * path is taken relative to it. Only that exact path counts: a bundle file
 * with the same name elsewhere (e.g. a plugin's own `plugins/foo/.mcp.json`)
 * is owned by the bundle and is recorded.
 * @param relative - Path relative to the git root, forward slashes.
 * @param workspacePrefix - Workspace root relative to the git root, forward slashes; `''` when they are the same.
 * @returns Whether to leave the path out of the record.
 */
export const isMergedMcpConfigPath = (relative: string, workspacePrefix = ''): boolean =>
  MERGED_MCP_CONFIG_PATHS.some((mcpPath) => relative === (workspacePrefix === '' ? mcpPath : `${workspacePrefix}/${mcpPath}`));

/**
 * Code-unit order, the same order the canonical serializer uses.
 * @param left - First text.
 * @param right - Second text.
 */
const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const isOutside = (relative: string): boolean =>
  relative === '' || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);

const createBundle = (): BundleRecord => {
  const bundle = Object.create(null) as BundleRecord;
  bundle.tools = Object.create(null) as BundleRecord['tools'];
  return bundle;
};

/**
 * Prototype-free copy of a recorded file's path and checksum.
 * @param file - Recorded file to copy.
 */
const copyRecordedFile = (file: RecordedFile): RecordedFile => {
  const copy = Object.create(null) as RecordedFile;
  copy.path = file.path;
  copy.checksum = file.checksum;
  return copy;
};

/**
 * Every installed path listed by any entry of the given records.
 * @param records - Records to scan.
 */
const listedPaths = (records: readonly InstallRecord[]): Set<string> => {
  const listed = new Set<string>();
  for (const record of records) {
    for (const bundle of Object.values(record.bundles)) {
      for (const entry of Object.values(bundle.tools)) {
        for (const file of entry.files) {
          listed.add(file.path);
        }
      }
    }
  }
  return listed;
};

/** Records installs in the shared install record (contract C3). */
export class InstallRecordService {
  private readonly store: RecordStore;
  private readonly fs: RecordFs;
  private readonly now: () => Date;

  public constructor(options: InstallRecordServiceOptions) {
    this.store = options.store;
    this.fs = options.fs;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Reject a tool, source type or key the record cannot hold (BR1.2, BR1.4, BR3.7).
   * @param input - Install to record.
   */
  private validateInput(input: RecordInstallInput): void {
    if (!(TARGET_TYPES as readonly string[]).includes(input.tool)) {
      throw recordError('RECORD.UNKNOWN_TOOL', { detail: `tool ${JSON.stringify(input.tool)} is not a target type` });
    }
    if (!(RECORD_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
      throw recordError('RECORD.MALFORMED', { detail: `sourceType ${JSON.stringify(input.sourceType)} is not a source type` });
    }
    if (input.sourceType !== input.source.type) {
      throw recordError('RECORD.MALFORMED', {
        detail: `sourceType ${JSON.stringify(input.sourceType)} does not match source.type ${JSON.stringify(input.source.type)}`
      });
    }
    for (const [name, value] of [['bundleId', input.bundleId], ['sourceId', input.source.sourceId], ['version', input.version]] as const) {
      if (typeof value !== 'string' || value === '' || FORBIDDEN_KEYS.has(value)) {
        throw recordError('RECORD.MALFORMED', { detail: `${name} ${JSON.stringify(value)} cannot be recorded` });
      }
    }
  }

  /**
   * The other repository file at the same root, if the location is a repository file.
   * @param location - Target location.
   */
  private otherLocation(location: RecordLocation): RecordLocation | undefined {
    if (location.level !== 'repository') {
      return undefined;
    }
    const isLocal = location.commitMode === 'local-only';
    return {
      level: 'repository',
      root: location.root,
      path: path.join(location.root, isLocal ? RECORD_FILE_NAME : LOCAL_RECORD_FILE_NAME),
      commitMode: isLocal ? 'commit' : 'local-only'
    };
  }

  /**
   * An absolute written path as a path relative to the root, before confinement.
   * Falls back to real paths when the root was given through a symlink (e.g.
   * `/var` and `/private/var` on macOS).
   * @param root - Level root.
   * @param written - Absolute path from the writer.
   */
  private async toRelative(root: string, written: string): Promise<string> {
    const absolute = path.resolve(root, written);
    const direct = path.relative(root, absolute);
    if (!isOutside(direct)) {
      return direct.split(path.sep).join('/');
    }
    try {
      const realRoot = await this.fs.realpath(root);
      const realParent = await this.fs.realpath(path.dirname(absolute));
      const real = path.relative(realRoot, path.join(realParent, path.basename(absolute)));
      if (!isOutside(real)) {
        return real.split(path.sep).join('/');
      }
    } catch {
      // Reported below as outside the root.
    }
    throw recordError('RECORD.PATH_OUTSIDE_ROOT', { file: written, detail: 'the written file is outside the repository root' });
  }

  /**
   * The workspace root relative to the record root, forward slashes; `''` when
   * they are the same folder (also through a symlink) or the workspace is not below it.
   * @param root - Level root.
   * @param workspaceRoot - Workspace root the writer installed into.
   */
  private async workspacePrefix(root: string, workspaceRoot: string | undefined): Promise<string> {
    if (workspaceRoot === undefined || path.resolve(workspaceRoot) === path.resolve(root)) {
      return '';
    }
    try {
      return await this.toRelative(root, workspaceRoot);
    } catch {
      return '';
    }
  }

  /**
   * Recorded files for the writer's `written` list (BR1.5–BR1.7).
   * @param root - Level root.
   * @param writtenPaths - Absolute paths from the writer.
   * @param workspaceRoot - Workspace root the writer installed into; defaults to `root`.
   */
  private async toRecordedFiles(root: string, writtenPaths: readonly string[], workspaceRoot?: string): Promise<RecordedFile[]> {
    const workspacePrefix = await this.workspacePrefix(root, workspaceRoot);
    const files = new Map<string, RecordedFile>();
    for (const written of writtenPaths) {
      const relative = await confinePath(this.fs, root, await this.toRelative(root, written));
      if (files.has(relative) || isMergedMcpConfigPath(relative, workspacePrefix)) {
        continue;
      }
      const file = Object.create(null) as RecordedFile;
      file.path = relative;
      file.checksum = await this.fs.hashFile(path.join(root, ...relative.split('/')));
      files.set(relative, file);
    }
    return [...files.values()].toSorted((a, b) => compareText(a.path, b.path));
  }

  /**
   * Remove an entry from a record, and its bundle when no tool is left (BR3.6).
   * @param record - Record to change.
   * @param bundleId - Bundle id.
   * @param tool - Tool key.
   * @returns The removed entry, if there was one.
   */
  private removeEntry(record: InstallRecord, bundleId: string, tool: string): ToolEntry | undefined {
    const bundle = Object.hasOwn(record.bundles, bundleId) ? record.bundles[bundleId] : undefined;
    if (bundle === undefined || !Object.hasOwn(bundle.tools, tool)) {
      return undefined;
    }
    const entry = bundle.tools[tool];
    delete bundle.tools[tool];
    if (Object.keys(bundle.tools).length === 0) {
      delete record.bundles[bundleId];
    }
    return entry;
  }

  /**
   * Remove a source from a record when no entry in it uses the source any more.
   * @param record - Record to change.
   * @param sourceId - Source key of the removed entry.
   */
  private dropUnusedSource(record: InstallRecord, sourceId: string): void {
    if (!Object.hasOwn(record.sources, sourceId)) {
      return;
    }
    const used = Object.values(record.bundles)
      .some((bundle) => Object.values(bundle.tools).some((entry) => entry.sourceId === sourceId));
    if (!used) {
      delete record.sources[sourceId];
    }
  }

  /**
   * Save a changed repository file, or remove it when it has no bundles left
   * (BR3.6; uninstall of the last entry). Removing the local-only file also
   * removes its line from `info/exclude` (BR2.3).
   * @param other - The file, as loaded and changed.
   */
  private async saveOther(other: LoadedRecord): Promise<string[]> {
    if (Object.keys(other.record.bundles).length > 0) {
      return (await this.store.save(other.location, other.record)).warnings;
    }
    const name = path.basename(other.location.path);
    try {
      await this.fs.unlink(other.location.path);
    } catch (error) {
      return [`Could not remove the empty record ${name}: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (other.location.level === 'repository' && other.location.commitMode === 'local-only') {
      const excluded = await removeExcluded(this.fs, other.location.root, name);
      return excluded.warning === undefined ? [] : [excluded.warning];
    }
    return [];
  }

  /**
   * Shared-folder sync (BR8.3), in memory. A sibling is another tool's entry
   * of the bundle, in either loaded file, listing a path the installed tool
   * wrote now or listed before. An accepted sibling takes the new version; its
   * shared paths are replaced by the new files at those paths (checksums
   * refreshed), and shared paths no longer written leave its list, so they
   * become delete candidates under keep-if-listed. Its own files stay listed.
   * A sibling not accepted is left unchanged. Entries under `unknown` are never siblings.
   * @param loaded - The target file, then the other repository file.
   * @param change - What the installed tool wrote.
   * @param change.bundleId - Bundle id.
   * @param change.tool - The installed tool.
   * @param change.version - Its new version.
   * @param change.files - Its new recorded files.
   * @param change.previousPaths - Paths its previous entry listed, in either file.
   * @param change.accepts - Which sibling tools to sync.
   * @returns The siblings found, sorted by tool, and the files changed.
   */
  private syncSiblingEntries(
    loaded: readonly LoadedRecord[],
    change: {
      bundleId: string;
      tool: string;
      version: string;
      files: readonly RecordedFile[];
      previousPaths: ReadonlySet<string>;
      accepts: (tool: string) => boolean;
    }
  ): { siblings: SiblingSync[]; changed: Set<LoadedRecord> } {
    const newByPath = new Map(change.files.map((file) => [file.path, file]));
    const isShared = (recorded: RecordedFile): boolean => change.previousPaths.has(recorded.path) || newByPath.has(recorded.path);
    const siblings: SiblingSync[] = [];
    const changed = new Set<LoadedRecord>();
    for (const file of loaded) {
      const bundle = Object.hasOwn(file.record.bundles, change.bundleId) ? file.record.bundles[change.bundleId] : undefined;
      for (const [tool, entry] of Object.entries(bundle?.tools ?? {})) {
        if (tool === change.tool || tool === UNKNOWN_TOOL_NAME || !entry.files.some((recorded) => isShared(recorded))) {
          continue;
        }
        if (!change.accepts(tool)) {
          siblings.push({ tool, version: entry.version, location: file.location, synced: false });
          continue;
        }
        entry.files = entry.files.flatMap((recorded) => {
          if (!isShared(recorded)) {
            return [recorded];
          }
          const written = newByPath.get(recorded.path);
          return written === undefined ? [] : [copyRecordedFile(written)];
        });
        entry.version = change.version;
        entry.installedAt = this.now().toISOString();
        siblings.push({ tool, version: change.version, location: file.location, synced: true });
        changed.add(file);
      }
    }
    return { siblings: siblings.toSorted((left, right) => compareText(left.tool, right.tool)), changed };
  }

  /**
   * Record that a tool installed a bundle (workflow W1 steps 6–12).
   *
   * Loads both repository files, replaces only `bundles.<bundleId>.tools.<tool>`
   * in the target file, records the source, moves the entry out of the other
   * file, brings sibling entries that share its files to the same version and
   * shared file list (BR8.3, see `syncSiblings`), and saves the target file
   * first, then the other one if it changed. Deletes nothing; the delete
   * candidates are checked against every entry of both files after the sync
   * (keep-if-listed, NFR4.9).
   * @param input - The U1 `recordInstall` input.
   * @returns The change, with the superseded files to delete after the save and the siblings found.
   * @throws {RegistryError} `RECORD.UNKNOWN_TOOL` for a tool that is not a target
   * type; `RECORD.MALFORMED` for a bad source type, a mismatch with `source.type`,
   * or a source without a type or url; `RECORD.PATH_OUTSIDE_ROOT` for a written
   * path outside the root; any `RECORD.*` error from loading or saving. The record
   * on disk is unchanged when the target save fails.
   */
  public async recordInstall(input: RecordInstallInput): Promise<RecordInstallResult> {
    this.validateInput(input);
    const source: SourceRecord = sanitizeSource(input.source);
    const { location, bundleId, tool } = input;
    const target = await this.store.load(location);
    const otherLocation = this.otherLocation(location);
    const other = otherLocation === undefined ? undefined : await this.store.load(otherLocation);
    const files = await this.toRecordedFiles(location.root, input.writtenPaths, input.workspaceRoot);

    const previous = [this.removeEntry(target.record, bundleId, tool)];
    const moved = other === undefined ? undefined : this.removeEntry(other.record, bundleId, tool);
    previous.push(moved);
    if (other !== undefined && moved !== undefined) {
      // The other file no longer needs the source when nothing else in it uses it.
      this.dropUnusedSource(other.record, moved.sourceId);
    }

    const entry = Object.create(null) as ToolEntry;
    entry.version = input.version;
    entry.sourceId = input.source.sourceId;
    entry.sourceType = input.sourceType;
    entry.installedAt = this.now().toISOString();
    entry.files = files;
    if (!Object.hasOwn(target.record.bundles, bundleId)) {
      target.record.bundles[bundleId] = createBundle();
    }
    target.record.bundles[bundleId].tools[tool] = entry;
    target.record.sources[input.source.sourceId] = source;

    const loaded = other === undefined ? [target] : [target, other];
    const sync = input.syncSiblings === false
      ? { siblings: [], changed: new Set<LoadedRecord>() }
      : this.syncSiblingEntries(loaded, {
        bundleId,
        tool,
        version: input.version,
        files,
        previousPaths: new Set(previous.flatMap((prior) => prior?.files.map((file) => file.path) ?? [])),
        accepts: typeof input.syncSiblings === 'function' ? input.syncSiblings : () => true
      });

    const newPaths = new Set(files.map((file) => file.path));
    const stillListed = listedPaths(loaded.map((file) => file.record));
    const deletedFiles: string[] = [];
    const keptSharedFiles: string[] = [];
    for (const old of previous.flatMap((prior) => prior?.files ?? [])) {
      const oldPath = old.path;
      if (newPaths.has(oldPath) || deletedFiles.includes(oldPath) || keptSharedFiles.includes(oldPath)) {
        continue;
      }
      (stillListed.has(oldPath) ? keptSharedFiles : deletedFiles).push(oldPath);
    }

    const warnings = [...(await this.store.save(location, target.record)).warnings];
    if (other !== undefined && (moved !== undefined || sync.changed.has(other))) {
      warnings.push(...(await this.saveOther(other)));
    }
    const synced = sync.siblings.filter((sibling) => sibling.synced);
    return {
      changedEntries: [{ bundleId, tool }, ...synced.map((sibling) => ({ bundleId, tool: sibling.tool }))],
      deletedFiles: deletedFiles.toSorted(compareText),
      keptSharedFiles: keptSharedFiles.toSorted(compareText),
      location,
      warnings,
      siblings: sync.siblings
    };
  }

  /**
   * Record that a tool's install of a bundle was removed (repository-scope
   * uninstall, FR4.1 U1 part, FR4.2).
   *
   * Loads both repository files and removes only `bundles.<bundleId>.tools.<tool>`
   * from whichever of them holds it, and the bundle when no tool is left. A
   * source no entry uses any more is dropped. The removed entry's files come
   * back in `deletedFiles`, except any path another entry in either file still
   * lists, which goes to `keptSharedFiles`. Each changed file is saved, or
   * removed when it has no bundles left. Deletes no installed file: pass the
   * result to {@link deleteSuperseded} after this returns.
   * @param input - The file the caller resolved (either repository file), the bundle id and the tool.
   * @param input.location - A repository record location; both files at its root are read.
   * @param input.bundleId - Bundle id.
   * @param input.tool - The target's type.
   * @returns The change: the file the entry was removed from, the files to delete and the shared files kept.
   * @throws {RegistryError} `RECORD.ENTRY_NOT_FOUND` when neither file has the
   * entry (nothing is changed); any `RECORD.*` error from loading or saving.
   */
  public async recordUninstall(input: { location: RecordLocation; bundleId: string; tool: string }): Promise<RecordInstallResult> {
    const { location, bundleId, tool } = input;
    const first = await this.store.load(location);
    const otherLocation = this.otherLocation(location);
    const loaded = otherLocation === undefined ? [first] : [first, await this.store.load(otherLocation)];

    const changed: { file: LoadedRecord; entry: ToolEntry }[] = [];
    for (const file of loaded) {
      const entry = this.removeEntry(file.record, bundleId, tool);
      if (entry !== undefined) {
        changed.push({ file, entry });
      }
    }
    if (changed.length === 0) {
      throw recordError('RECORD.ENTRY_NOT_FOUND', {
        file: path.basename(location.path),
        detail: `no entry for bundle ${JSON.stringify(bundleId)} and tool ${JSON.stringify(tool)}`,
        context: { bundleId, tool }
      });
    }

    const stillListed = listedPaths(loaded.map((file) => file.record));
    const deletedFiles = new Set<string>();
    const keptSharedFiles = new Set<string>();
    for (const { file, entry } of changed) {
      for (const recorded of entry.files) {
        (stillListed.has(recorded.path) ? keptSharedFiles : deletedFiles).add(recorded.path);
      }
      this.dropUnusedSource(file.record, entry.sourceId);
    }

    const warnings: string[] = [];
    for (const { file } of changed) {
      warnings.push(...(await this.saveOther(file)));
    }
    return {
      changedEntries: [{ bundleId, tool }],
      deletedFiles: [...deletedFiles].toSorted(compareText),
      keptSharedFiles: [...keptSharedFiles].toSorted(compareText),
      location: changed[0].file.location,
      warnings,
      siblings: []
    };
  }

  /**
   * One status row per (bundle, tool) entry of the given record files, sorted
   * by bundle, then tool, then record path (BR9.2). Every file is loaded and
   * checked first; a missing file has no rows.
   * @param locations - Record files to list, e.g. `RecordSelection.locations`.
   * @returns The rows.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public async listEntries(locations: readonly RecordLocation[]): Promise<StatusRow[]> {
    const rows: StatusRow[] = [];
    for (const location of locations) {
      const { record } = await this.store.load(location);
      for (const [bundleId, bundle] of Object.entries(record.bundles)) {
        for (const [tool, entry] of Object.entries(bundle.tools)) {
          rows.push({
            bundleId,
            tool,
            level: location.level,
            version: entry.version,
            record: location.path,
            needsReinstall: tool === UNKNOWN_TOOL_NAME || entry.needsReinstall === true
          });
        }
      }
    }
    return rows.toSorted((left, right) =>
      compareText(left.bundleId, right.bundleId) || compareText(left.tool, right.tool) || compareText(left.record, right.record));
  }

  /**
   * The record file that holds `bundles.<bundleId>.tools.<tool>`, so an update
   * or replay re-records the entry there and keeps its commit mode (BR6.5).
   * @param locations - Record files to search, committed first.
   * @param bundleId - Bundle id.
   * @param tool - Tool key.
   * @returns The first file holding the entry, or `undefined` when none does.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public async holdingLocation(locations: readonly RecordLocation[], bundleId: string, tool: string): Promise<RecordLocation | undefined> {
    for (const location of locations) {
      const { record } = await this.store.load(location);
      if (Object.hasOwn(record.bundles, bundleId) && Object.hasOwn(record.bundles[bundleId].tools, tool)) {
        return location;
      }
    }
    return undefined;
  }

  /**
   * Delete the superseded files of a saved change (W1 step 13, BR3.4, NFR4.2).
   *
   * Each path goes through the delete-time confinement check; only a regular
   * file or a symlink (never followed) is removed. A folder, a refused path or
   * a failed removal is a warning; the saved record is not changed.
   * @param change - The change returned by {@link recordInstall}, after it was saved.
   * @returns The removed paths and one warning per skipped path.
   */
  public async deleteSuperseded(change: Pick<RecordChange, 'deletedFiles' | 'location'>): Promise<DeleteSupersededResult> {
    const deleted: string[] = [];
    const warnings: string[] = [];
    for (const recordedPath of change.deletedFiles) {
      const decision = await resolveDeleteTarget(this.fs, change.location.root, recordedPath);
      if (decision.status === 'missing') {
        continue;
      }
      if (decision.status === 'skip') {
        warnings.push(`Did not remove ${recordedPath}: ${decision.reason}.`);
        continue;
      }
      try {
        await this.fs.unlink(decision.absolute);
        deleted.push(recordedPath);
      } catch (error) {
        warnings.push(`Could not remove ${recordedPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { deleted, warnings };
  }

  /**
   * Delete the superseded files of several saved changes from one command run
   * (update, replay), once every save has run (FR3.2, NFR4.9).
   *
   * Each change's `deletedFiles` was worked out when that change was saved, so
   * a later change in the same run may list one of those paths again. Both
   * repository files at each change's root are loaded again here, and a path
   * any entry still lists is kept; the rest go through {@link deleteSuperseded}.
   * @param changes - The saved changes, in the order they were made.
   * @returns The removed paths and one warning per skipped path.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public async deleteSupersededAfterAll(changes: readonly Pick<RecordChange, 'deletedFiles' | 'location'>[]): Promise<DeleteSupersededResult> {
    const listedByRecord = new Map<string, Set<string>>();
    const handled = new Set<string>();
    const result: DeleteSupersededResult = { deleted: [], warnings: [] };
    for (const change of changes) {
      let listed = listedByRecord.get(change.location.path);
      if (listed === undefined) {
        const other = this.otherLocation(change.location);
        const locations = other === undefined ? [change.location] : [change.location, other];
        const records: InstallRecord[] = [];
        for (const location of locations) {
          records.push((await this.store.load(location)).record);
        }
        listed = listedPaths(records);
        listedByRecord.set(change.location.path, listed);
      }
      const still = listed;
      const deletedFiles = change.deletedFiles.filter((recordedPath) => {
        const key = `${change.location.root}\u0000${recordedPath}`;
        if (still.has(recordedPath) || handled.has(key)) {
          return false;
        }
        handled.add(key);
        return true;
      });
      const removal = await this.deleteSuperseded({ deletedFiles, location: change.location });
      result.deleted.push(...removal.deleted);
      result.warnings.push(...removal.warnings);
    }
    return result;
  }
}
