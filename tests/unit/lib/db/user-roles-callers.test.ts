/**
 * CI guard: addUserRole / removeUserRole caller allowlist
 *
 * `addUserRole` and `removeUserRole` bump `role_version` but do NOT call
 * `pollingSessionCache.invalidateUser(sub)`.  That is safe for JIT-provisioning
 * callers because no polling-cache entry can exist at provisioning time.  But if
 * a future developer wires either helper to an admin UI or scheduled job (where
 * the target user may already have an active cache entry), the stale-role window
 * opens back up.
 *
 * This test enforces the allowlist statically via source-code grep so the
 * constraint is checked on every CI run — a new caller must be added here
 * intentionally and the developer is reminded to either:
 *   a) call `pollingSessionCache.invalidateUser(sub)` post-commit, or
 *   b) confirm the new caller is also JIT-only (no active cache entry possible).
 *
 * Pattern: grep the compiled source for import statements or dynamic require()
 * calls that reference the helpers.  We search TypeScript source directly
 * (pre-compile) because that is what is available in CI before a build step.
 */

import { execSync } from "child_process"
import path from "path"

const ROOT = path.resolve(__dirname, "../../../..")

/**
 * Returns the list of source files (relative to repo root) that contain a
 * non-comment reference to `fnName` — specifically an import statement or a
 * call expression.  Excludes the definition file itself and test files.
 *
 * Uses two patterns:
 *   1. `import { ... fnName ... }` — catches named imports
 *   2. `fnName(` — catches call expressions
 *
 * This is deliberately coarser than a full AST parse but avoids the false
 * positives that a plain `grep fnName` would produce for comment-only
 * references (e.g. the "do not call this directly" note in user-management.actions.ts).
 */
function findCallers(fnName: string): string[] {
  try {
    // Match lines that are either:
    //   a) an import statement containing the function name, or
    //   b) a direct call expression (fnName followed by '(')
    // The leading non-whitespace/comment check is handled by anchoring to
    // 'import' or the call pattern — this correctly ignores '// addUserRole('
    // because grep -E matches against each line and comment lines don't start
    // with 'import'.  For call expressions, a comment '// addUserRole(' would
    // still match; that edge case doesn't exist in our codebase, but if it did
    // the false positive would only expand the allowlist requirement — it would
    // never silently drop a real caller.
    const pattern = `(import[[:space:]].*${fnName}|${fnName}\\()`
    const raw = execSync(
      `grep -rEl --include="*.ts" --include="*.tsx" --include="*.js" '${pattern}' "${ROOT}"`,
      { encoding: "utf8" }
    )
    return raw
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .filter((f) => !f.includes("node_modules"))
      .filter((f) => !f.endsWith("user-roles.ts")) // definition file
      .filter((f) => !f.includes("/tests/"))       // test files
      .map((f) => path.relative(ROOT, f))
  } catch {
    // grep exits non-zero when no matches found
    return []
  }
}

const ALLOWED_ADD_ROLE_CALLERS = new Set([
  "lib/auth/resolve-user.ts",
  "actions/db/get-current-user-action.ts",
  // Index re-exports — these don't call the function, they just re-export it.
  "lib/db/drizzle/index.ts",
])

const ALLOWED_REMOVE_ROLE_CALLERS = new Set([
  // Index re-exports only — no production caller uses removeUserRole directly yet.
  "lib/db/drizzle/index.ts",
])

describe("addUserRole / removeUserRole caller allowlist", () => {
  it("addUserRole is only imported by known JIT-provisioning modules", () => {
    const callers = findCallers("addUserRole")
    const unknown = callers.filter((f) => !ALLOWED_ADD_ROLE_CALLERS.has(f))

    expect(unknown).toEqual(
      // Fail with a descriptive message listing the unexpected callers.
      // If you are adding a legitimate new caller, add it to ALLOWED_ADD_ROLE_CALLERS
      // above AND ensure you call pollingSessionCache.invalidateUser(sub) post-commit
      // (or confirm the path is JIT-only so no cache entry can pre-exist).
      []
    )
  })

  it("removeUserRole is only imported by known JIT-provisioning modules", () => {
    const callers = findCallers("removeUserRole")
    const unknown = callers.filter((f) => !ALLOWED_REMOVE_ROLE_CALLERS.has(f))

    expect(unknown).toEqual(
      // Same invariant as addUserRole — see comment above.
      []
    )
  })
})
