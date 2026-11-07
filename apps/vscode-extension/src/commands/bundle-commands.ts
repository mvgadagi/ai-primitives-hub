/**
 * Bundle Management Commands
 * Orchestrates bundle operations through specialized command handlers
 */

import {
  areAllFilesMissing,
} from '@ai-primitives-hub/app';
import {
  isRecordError,
  type RecordLocation,
  UNKNOWN_TOOL_NAME,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';
import {
  BundleUpdateNotifications,
} from '../notifications/bundle-update-notifications';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  Logger,
} from '../utils/logger';
import {
  getWorkspaceRoot,
} from '../utils/scope-selection-ui';
import {
  BundleBrowsingCommands,
} from './bundle-browsing-commands';
import {
  BundleInstallationCommands,
} from './bundle-installation-commands';
import {
  BundleUpdateCommands,
} from './bundle-update-commands';

/** A stale repository entry: one tool entry of a record file. */
interface StaleRow {
  bundleId: string;
  tool: string;
  location: RecordLocation;
}

/**
 * Bundle Commands Handler
 * Uses composition to delegate to specialized command handlers
 */
export class BundleCommands {
  private readonly installationCommands: BundleInstallationCommands;
  private readonly updateCommands: BundleUpdateCommands;
  private readonly browsingCommands: BundleBrowsingCommands;
  private readonly logger: Logger;

  constructor(private readonly registryManager: RegistryManager) {
    this.installationCommands = new BundleInstallationCommands(registryManager);

    const bundleNameResolver = async (bundleId: string) => await registryManager.getBundleName(bundleId);
    const bundleNotifications = new BundleUpdateNotifications(bundleNameResolver);
    this.updateCommands = new BundleUpdateCommands(registryManager, bundleNotifications);

    this.browsingCommands = new BundleBrowsingCommands(registryManager);
    this.logger = Logger.getInstance();
  }

  /**
   * Label of a stale row in messages.
   * @param row - Stale row.
   */
  private static rowLabel(row: StaleRow): string {
    return `${row.bundleId} (${row.tool})`;
  }

  /**
   * Stale rows of a workspace folder (BR12.2, BR21.5): one per bundle and
   * tool entry of both record files, offered only when the entry lists files
   * and every one of them is missing (app `areAllFilesMissing`). A migrated
   * `unknown` entry is never offered; it is on the reinstall list. The caller
   * migrates the old lockfiles first, so the rows come from the records only.
   * @param workspaceRoot - Absolute workspace folder path.
   * @throws {RegistryError} Any `RECORD.*` error from loading the record files.
   */
  private async findStaleRows(workspaceRoot: string): Promise<StaleRow[]> {
    const adapter = this.registryManager.getRecordAdapter();
    const rows: StaleRow[] = [];
    for (const located of await adapter.listAllEntries(workspaceRoot)) {
      if (located.tool === UNKNOWN_TOOL_NAME || located.entry.files.length === 0) {
        continue;
      }
      if (await areAllFilesMissing(adapter.fs, located.location.root, located.entry.files.map((file) => file.path))) {
        rows.push({ bundleId: located.bundleId, tool: located.tool, location: located.location });
      }
    }
    return rows;
  }

  // ===== Installation Commands =====

  /**
   * Search and install a bundle
   */
  public async searchAndInstall(): Promise<void> {
    return await this.installationCommands.searchAndInstall();
  }

  /**
   * Install a specific bundle
   * @param bundleId
   */
  public async installBundle(bundleId?: string): Promise<void> {
    return await this.installationCommands.installBundle(bundleId);
  }

  /**
   * Uninstall a bundle
   * @param bundleId
   */
  public async uninstallBundle(bundleId?: string): Promise<void> {
    return await this.installationCommands.uninstallBundle(bundleId);
  }

  // ===== Update Commands =====

  /**
   * Update a bundle
   * @param bundleId
   */
  public async updateBundle(bundleId?: string): Promise<void> {
    if (!bundleId) {
      return await this.updateCommands.checkAllUpdates();
    }
    await this.updateCommands.updateBundle(bundleId);
  }

  /**
   * Check for updates on a single bundle and show update dialog
   * @param bundleId
   */
  public async checkSingleBundleUpdate(bundleId: string): Promise<void> {
    return await this.updateCommands.checkSingleBundleUpdate(bundleId);
  }

  /**
   * Check for updates on all installed bundles
   */
  public async checkAllUpdates(): Promise<void> {
    return await this.updateCommands.checkAllUpdates();
  }

  /**
   * Update all bundles with available updates
   */
  public async updateAllBundles(): Promise<void> {
    return await this.updateCommands.updateAllBundles();
  }

  /**
   * Enable auto-update for a bundle
   * @param bundleId
   */
  public async enableAutoUpdate(bundleId?: string): Promise<void> {
    return await this.updateCommands.enableAutoUpdate(bundleId);
  }

  /**
   * Disable auto-update for a bundle
   * @param bundleId
   */
  public async disableAutoUpdate(bundleId?: string): Promise<void> {
    return await this.updateCommands.disableAutoUpdate(bundleId);
  }

  // ===== Browsing Commands =====

  /**
   * View bundle details
   * @param bundleId
   */
  public async viewBundle(bundleId?: string): Promise<void> {
    return await this.browsingCommands.viewBundle(bundleId);
  }

  /**
   * Browse bundles by category
   */
  public async browseByCategory(): Promise<void> {
    return await this.browsingCommands.browseByCategory();
  }

  /**
   * Show popular bundles
   */
  public async showPopular(): Promise<void> {
    return await this.browsingCommands.showPopular();
  }

  /**
   * List installed bundles
   */
  public async listInstalled(): Promise<void> {
    return await this.browsingCommands.listInstalled();
  }

  // ===== Cleanup Commands =====

  /**
   * Clean up stale repository entries whose files are all missing (W13;
   * BR12.2, BR12.5, BR21.5). The old lockfiles are migrated first; rows then
   * come from both record files, for any tool but `unknown`. On confirm only
   * the entries are removed: no file is deleted, since none is left. The
   * batch stops at the first `RECORD.*` error and one message names the
   * removed and not-attempted rows.
   */
  public async cleanupStaleLockfileEntries(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();

    if (!workspaceRoot) {
      vscode.window.showWarningMessage('No workspace open. Please open a workspace to clean up stale repository bundles.');
      return;
    }

    const adapter = this.registryManager.getRecordAdapter();
    try {
      await adapter.migrateBeforeWrite('repository', workspaceRoot);
      const staleRows = await this.findStaleRows(workspaceRoot);

      if (staleRows.length === 0) {
        vscode.window.showInformationMessage('No stale repository bundle entries found.');
        return;
      }

      const bundleList = staleRows.map((row) => `• ${BundleCommands.rowLabel(row)}`).join('\n');
      const confirm = await vscode.window.showWarningMessage(
        `Found ${staleRows.length} stale bundle entr${staleRows.length === 1 ? 'y' : 'ies'} with all files missing:\n\n${bundleList}\n\nRemove these entries from the install records?`,
        { modal: true },
        'Remove', 'Cancel'
      );

      if (confirm !== 'Remove') {
        return;
      }

      const done: string[] = [];
      for (const [index, row] of staleRows.entries()) {
        try {
          await adapter.service.recordUninstall({ location: row.location, bundleId: row.bundleId, tool: row.tool });
          done.push(BundleCommands.rowLabel(row));
          this.logger.info(`Removed stale entry: ${BundleCommands.rowLabel(row)}`);
        } catch (error) {
          if (!isRecordError(error)) {
            throw error;
          }
          const notAttempted = staleRows.slice(index).map((stale) => BundleCommands.rowLabel(stale));
          this.logger.error(`Stale cleanup stopped at ${BundleCommands.rowLabel(row)}:`, error);
          adapter.showRecordError(error);
          vscode.window.showWarningMessage(
            `Stale cleanup stopped: ${error.code}. Removed: ${done.length === 0 ? 'none' : done.join(', ')}. Not attempted: ${notAttempted.join(', ')}.`
          );
          return;
        }
      }

      vscode.window.showInformationMessage(`Successfully removed ${done.length} stale bundle entries.`);
    } catch (error) {
      this.logger.error('Failed to clean up stale entries:', error instanceof Error ? error : undefined);
      if (adapter.showRecordError(error)) {
        return;
      }
      vscode.window.showErrorMessage(`Failed to clean up stale entries: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
