import {
  VersionConsolidator as VersionConsolidatorCore,
} from '@ai-primitives-hub/app';
import type {
  BundleVersion,
  ConsolidatedBundle,
} from '@ai-primitives-hub/app';
import {
  Bundle,
  SourceType,
} from '../types/registry';
import {
  Logger,
} from '../utils/logger';

export type {
  BundleVersion,
  ConsolidatedBundle,
} from '@ai-primitives-hub/app';

/**
 * Service for consolidating multiple bundle versions into single entries
 *
 * Thin delegator to `@ai-primitives-hub/app`'s `VersionConsolidator`
 * — kept as this same class
 * shape so existing call sites (`RegistryManager`) are unchanged. Forwards
 * the ported class's diagnostic log events to the extension's `Logger`.
 */
export class VersionConsolidator {
  private readonly core: VersionConsolidatorCore;

  /**
   * Create a new VersionConsolidator
   * @param maxCacheSize - Maximum number of bundle identities to cache (default: 1000)
   * @throws {Error} if maxCacheSize is not a positive number
   */
  constructor(maxCacheSize?: number) {
    const logger = Logger.getInstance();
    this.core = new VersionConsolidatorCore(maxCacheSize, (event) => {
      switch (event.level) {
        case 'debug': {
          logger.debug(event.message);
          break;
        }
        case 'warn': {
          logger.warn(event.message);
          break;
        }
        case 'error': {
          logger.error(event.message);
          break;
        }
        default: {
          logger.info(event.message);
        }
      }
    });
  }

  /**
   * Set a custom source type resolver function
   *
   * This allows the consolidator to accurately determine source types
   * instead of relying on heuristics.
   * @param resolver - Function that maps sourceId to SourceType
   */
  public setSourceTypeResolver(resolver: (sourceId: string) => SourceType): void {
    this.core.setSourceTypeResolver(resolver);
  }

  /**
   * Consolidate bundles by grouping versions of the same bundle
   *
   * For GitHub sources, bundles with the same owner/repo are grouped together
   * and only the latest version is returned. For non-GitHub sources, bundles
   * are returned unchanged.
   * @param bundles - Array of bundles from various sources
   * @returns Consolidated bundles with latest version metadata
   */
  public consolidateBundles(bundles: Bundle[]): ConsolidatedBundle[] {
    return this.core.consolidateBundles(bundles);
  }

  /**
   * Get all versions for a bundle identity
   *
   * Returns all versions sorted in descending semantic version order.
   * @param identity - Unique identifier for the bundle
   * @returns Array of version metadata sorted by version descending
   */
  public getAllVersions(identity: string): BundleVersion[] {
    return this.core.getAllVersions(identity);
  }

  /**
   * Get a specific version of a bundle
   *
   * This is useful when a user wants to install a specific version
   * instead of the latest version. Updates the access order for LRU tracking.
   * @param bundleIdentity - Unique identifier for the bundle
   * @param version - Specific version to retrieve
   * @returns Bundle version metadata, or undefined if not found
   */
  public getBundleVersion(bundleIdentity: string, version: string): BundleVersion | undefined {
    return this.core.getBundleVersion(bundleIdentity, version);
  }
}
