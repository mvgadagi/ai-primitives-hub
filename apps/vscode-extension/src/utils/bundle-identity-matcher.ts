/**
 * Bundle Identity Matcher Utility
 *
 * Provides centralized logic for matching bundle identities across different source types.
 * For GitHub sources, matches by identity (owner-repo) ignoring version suffixes.
 * For other sources, requires exact ID match.
 */

import {
  bundleIdentitiesMatch,
  bundleIdHasVersionSuffix,
  extractBaseBundleId,
} from '@ai-primitives-hub/core';
import {
  SourceType,
} from '../types/registry';

/**
 * Version suffix regex pattern used across the codebase.
 * Re-exported from `@ai-primitives-hub/core`'s `domain/bundle/identity-matcher`
 */
export {
  VERSION_SUFFIX_REGEX,
} from '@ai-primitives-hub/core';

/**
 * Bundle Identity Matcher
 * Centralized utility for comparing bundle identities.
 *
 * Thin delegator to `@ai-primitives-hub/core`'s pure
 * `domain/bundle/identity-matcher` functions — kept as this same object
 * shape so existing call sites across the extension are unchanged.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
export const BundleIdentityMatcher = {
  /**
   * Check if two bundle IDs match based on source type
   * @param bundleId1 - First bundle ID to compare
   * @param bundleId2 - Second bundle ID to compare
   * @param sourceType - Source type determining matching strategy
   * @returns True if bundles match according to source type rules
   * @example
   * ```typescript
   * // GitHub bundles match by identity (ignoring version)
   * BundleIdentityMatcher.matches(
   *     'owner-repo-v1.0.0',
   *     'owner-repo-v2.0.0',
   *     'github'
   * ); // Returns: true
   *
   * // Non-GitHub bundles require exact match
   * BundleIdentityMatcher.matches(
   *     'local-bundle-v1.0.0',
   *     'local-bundle-v2.0.0',
   *     'local'
   * ); // Returns: false
   * ```
   */
  matches: (
    bundleId1: string,
    bundleId2: string,
    sourceType: SourceType
  ): boolean => {
    return bundleIdentitiesMatch(bundleId1, bundleId2, sourceType);
  },

  /**
   * Extract base ID without version suffix
   * @param bundleId - Bundle ID potentially containing version suffix
   * @returns Base bundle ID without version
   * @example
   * ```typescript
   * BundleIdentityMatcher.extractBaseId('my-bundle-v1.0.0');
   * // Returns: 'my-bundle'
   * ```
   */
  extractBaseId: (bundleId: string): string => {
    return extractBaseBundleId(bundleId);
  },

  /**
   * Check if bundle ID contains a version suffix
   * @param bundleId - Bundle ID to check
   * @returns True if bundle ID contains version suffix
   */
  hasVersionSuffix: (bundleId: string): boolean => {
    return bundleIdHasVersionSuffix(bundleId);
  }
};
