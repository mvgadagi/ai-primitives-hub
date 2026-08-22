/**
 * Type guard utilities for runtime type checking
 * Provides safe type validation for external data
 */

/**
 * Type guard for array validation
 * @param value
 */
export function isArray<T>(value: unknown): value is T[] {
  return Array.isArray(value);
}

/**
 * Convert unknown error to Error object
 * @param error
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    return new Error(String(error.message));
  }

  return new Error('Unknown error occurred');
}

/**
 * Type guard for string validation
 * @param value
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Type guard for non-empty string validation
 * @param value
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
