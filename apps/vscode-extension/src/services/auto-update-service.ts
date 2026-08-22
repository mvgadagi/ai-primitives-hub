/**
 * Auto-Update Service
 * Handles automatic bundle updates in the background
 * Uses existing RegistryManager.updateBundle() for actual update logic
 *
 * Thin wrapper around `@ai-primitives-hub/app`'s `AutoUpdateCore` (the
 * strangler-fig-ported orchestration logic) — adapts this extension's
 * injected bundle/source operations, `BundleUpdateNotifications`, and
 * `RegistryStorage` to the port shapes `AutoUpdateCore` depends on, and
 * forwards its generic log events to the extension's own `Logger`. See
 * ADR-0005.
 */

import {
  AutoUpdateCore,
} from '@ai-primitives-hub/app';
import type {
  LogEvent,
} from '@ai-primitives-hub/app';
import type {
  BundleOperations,
  SourceOperations,
} from '@ai-primitives-hub/core';
// RegistryManager import removed to avoid circular dependency
// Operations are injected via small interfaces typed with domain models
import {
  BundleUpdateNotifications,
} from '../notifications/bundle-update-notifications';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  Logger,
} from '../utils/logger';
import {
  UpdateCheckResult,
} from './update-cache';

/**
 * Options for auto-update operations
 */
export interface AutoUpdateOptions {
  bundleId: string;
  targetVersion: string;
  showProgress: boolean;
}

export type {
  BundleOperations,
  SourceOperations,
} from '@ai-primitives-hub/core';

/**
 * Auto-update service
 * Orchestrates automatic bundle updates with progress tracking and notifications
 * Uses dependency injection to avoid circular dependencies
 */
export class AutoUpdateService {
  private readonly core: AutoUpdateCore;

  constructor(
    bundleOps: BundleOperations,
    sourceOps: SourceOperations,
    private readonly bundleNotifications: BundleUpdateNotifications,
    private readonly storage: RegistryStorage
  ) {
    const logger = Logger.getInstance();

    this.core = new AutoUpdateCore({
      bundleOps,
      sourceOps,
      notifier: bundleNotifications,
      preferences: storage,
      onLog: (event: LogEvent) => this.forwardLogEvent(logger, event)
    });
  }

  private forwardLogEvent(logger: Logger, event: LogEvent): void {
    switch (event.level) {
      case 'debug': {
        logger.debug(event.message, event.error);
        break;
      }
      case 'info': {
        logger.info(event.message);
        break;
      }
      case 'warn': {
        logger.warn(event.message, event.error);
        break;
      }
      case 'error': {
        logger.error(event.message, event.error);
        break;
      }
    }
  }

  /**
   * Update a single bundle automatically with rollback on failure
   * Prevents concurrent updates and shows notifications on completion
   * @param options
   */
  public async autoUpdateBundle(options: AutoUpdateOptions): Promise<void> {
    return this.core.autoUpdateBundle(options);
  }

  /**
   * Update multiple bundles with controlled concurrency (batch size 3)
   * Processes bundles in parallel batches and reports summary
   * @param updates
   */
  public async autoUpdateBundles(updates: UpdateCheckResult[]): Promise<void> {
    return this.core.autoUpdateBundles(updates);
  }

  /**
   * Check if auto-update is enabled for a bundle
   * @param bundleId
   */
  public async isAutoUpdateEnabled(bundleId: string): Promise<boolean> {
    return this.core.isAutoUpdateEnabled(bundleId);
  }

  /**
   * Get auto-update preferences for all bundles as a simple lookup map
   *
   * This is used by UI layers (tree view, marketplace) to avoid
   * per-bundle storage I/O when rendering lists of bundles.
   */
  public async getAllAutoUpdatePreferences(): Promise<Record<string, boolean>> {
    return this.core.getAllAutoUpdatePreferences();
  }

  /**
   * Enable or disable auto-update for a bundle
   *
   * ⚠️  WARNING: This method is a low-level storage update. To ensure UI components
   * stay in sync, use RegistryManager.enableAutoUpdate() or disableAutoUpdate() instead.
   * Direct calls bypass the event emission mechanism and may leave UI in inconsistent state.
   * @param bundleId The bundle ID
   * @param enabled Whether to enable auto-update
   */
  public async setAutoUpdate(bundleId: string, enabled: boolean): Promise<void> {
    return this.core.setAutoUpdate(bundleId, enabled);
  }

  /**
   * Check if an update is currently in progress for a bundle
   * @param bundleId
   */
  public isUpdateInProgress(bundleId: string): boolean {
    return this.core.isUpdateInProgress(bundleId);
  }
}
