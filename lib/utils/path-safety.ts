/**
 * Storage-key path safety helpers.
 *
 * Used by routes that accept user-controlled object keys (image proxy,
 * document processor) before passing them to a storage SDK. Object stores
 * generally do not interpret `..` server-side, but our app composes keys
 * from path parts and then signs the joined string — without these checks
 * an attacker can use `..` to climb out of their own prefix and have a
 * signed URL issued for another user's object.
 */

/**
 * Reject anything that, once joined with `/`, could resolve to a path other
 * than the literal sequence of segments the caller intended:
 *  - `.` or `..`              → traversal
 *  - empty string             → produces `//`, ambiguous after normalization
 *  - contains `/` or `\`      → caller didn't actually split into segments
 *  - contains a NUL byte      → C-string truncation tricks
 */
export function isSafeStorageSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  if (segment.includes("\0")) return false;
  return true;
}

/** True iff every segment in `parts` is safe. */
export function areSafeStorageSegments(parts: readonly string[]): boolean {
  return parts.every(isSafeStorageSegment);
}

/**
 * Validate a `/`-joined storage key. Splits on `/` and applies the same
 * per-segment rules as `areSafeStorageSegments`. Use this when the caller
 * already has a string key (e.g. read from a request body) rather than
 * an array of path parts.
 */
export function isSafeStorageKey(key: string): boolean {
  if (key === "") return false;
  return areSafeStorageSegments(key.split("/"));
}
