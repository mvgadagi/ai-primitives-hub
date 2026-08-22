import {
  compareVersions,
  extractBundleIdentity,
  isSameBundleIdentity,
  isUpdateAvailable,
} from '@ai-primitives-hub/core';
import {
  SourceType,
} from '../types/registry';

/**
 * Utility for version comparison and management using semver library
 *
 * Thin delegator to `@ai-primitives-hub/core`'s pure `domain/bundle/version`
 * functions — kept as a class with static methods so existing call sites across
 * the extension are unchanged.
 * The original's debug/warn diagnostic logging on fallback paths
 * (coercion, string-comparison fallback) was dropped when the logic moved to
 * `core`'s side-effect-free domain layer; it was untested and non-behavioral.
 */
export class VersionManager {
  /**
   * Compare two semantic versions using semver.compare()
   *
   * Comparison strategy:
   * 1. Try semver.clean() for standard versions
   * 2. Fall back to semver.coerce() for non-standard versions
   * 3. Last resort: lexicographic string comparison
   * @param v1 - First version string
   * @param v2 - Second version string
   * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
   * @throws {Error} if either version is empty or exceeds maximum length
   */
  public static compareVersions(v1: string, v2: string): number {
    return compareVersions(v1, v2);
  }

  /**
   * Determine if an update is available using semver.gt()
   * @param installedVersion - Currently installed version
   * @param latestVersion - Latest available version
   * @returns True if update available (latest > installed)
   * @throws {Error} if either version is empty or invalid
   */
  public static isUpdateAvailable(installedVersion: string, latestVersion: string): boolean {
    return isUpdateAvailable(installedVersion, latestVersion);
  }

  /**
   * Check if two bundle IDs represent the same bundle identity
   * Handles versioned IDs and different source types
   * @param id1 - First bundle ID
   * @param type1 - Source type of first bundle
   * @param id2 - Second bundle ID
   * @param type2 - Source type of second bundle
   * @returns True if they represent the same bundle identity
   */
  public static isSameBundleIdentity(id1: string, type1: SourceType, id2: string, type2: SourceType): boolean {
    return isSameBundleIdentity(id1, type1, id2, type2);
  }

  /**
   * Extract bundle identity from GitHub bundle ID by removing version suffix
   *
   * GitHub bundle IDs follow the format: {owner}-{repo}-{version}
   * This method extracts {owner}-{repo} by identifying and removing the version suffix.
   *
   * For non-GitHub sources, the bundle ID is returned unchanged.
   * @example
   * extractBundleIdentity('microsoft-vscode-v1.0.0', 'github') // 'microsoft-vscode'
   * extractBundleIdentity('my-org-my-repo-2.1.3', 'github')    // 'my-org-my-repo'
   * extractBundleIdentity('owner-123-v1.0.0', 'github')        // 'owner-123'
   * extractBundleIdentity('bundle-id', 'local')                // 'bundle-id' (unchanged)
   * @param bundleId - Bundle ID potentially containing version suffix
   * @param sourceType - Source type of the bundle
   * @returns Bundle identity without version suffix (GitHub only)
   * @throws {Error} if bundleId exceeds maximum length
   */
  public static extractBundleIdentity(bundleId: string, sourceType: SourceType): string {
    return extractBundleIdentity(bundleId, sourceType);
  }
}
