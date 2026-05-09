/**
 * Enforced invariant: `useSession().update(` must not appear in production source.
 *
 * Context (`auth.ts:99-102`): the jwt() callback returns `null` on `trigger === "update"`,
 * which forces a full re-authentication.  This is intentional and correct for role
 * revocation/demotion — better to re-auth once than to serve a stale high-privilege
 * token.  However, the behaviour is **silent**: if any future code calls
 * `useSession().update(...)` it will silently log every affected user out, with no
 * obvious connection between the call site and the logged-out sessions.
 *
 * This test converts the comment-based GREP GUARD in auth.ts into an enforced
 * invariant that fails CI immediately and points back to auth.ts for context.
 *
 * Exclusions:
 *   - This test file itself (the pattern string it searches for)
 *   - `node_modules/` — third-party code may legitimately use update()
 *   - `.next/` — build artefacts
 *   - `docs/`  — documentation may describe the API without calling it
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// The literal string we're guarding against — split to avoid matching this file.
const FORBIDDEN = 'useSession' + '().update('

/** Recursively collect all .ts and .tsx source files under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const skip = new Set(['node_modules', '.next', 'docs', '.git'])
  const results: string[] = []

  function walk(current: string) {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return // permission or missing — skip
    }
    for (const entry of entries) {
      if (skip.has(entry)) continue
      const full = join(current, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        results.push(full)
      }
    }
  }

  walk(dir)
  return results
}

describe('useSession().update() invariant', () => {
  it('is not called anywhere in production or test source — would silently force re-auth for all affected users (see auth.ts:99-102)', () => {
    // Resolve the repo root relative to this test file.
    // __dirname = <repo>/tests/unit/lib/auth — four levels up is the repo root.
    const repoRoot = join(__dirname, '..', '..', '..', '..')

    const files = collectSourceFiles(repoRoot)
    const violations: string[] = []

    for (const file of files) {
      // Skip this guard file itself — it contains the forbidden string as a literal.
      if (file.includes('no-use-session-update')) continue
      // Skip auth.ts — it contains the GREP GUARD comment that documents *why*
      // useSession().update() is forbidden; the string appears as a comment, not
      // as a call site.
      if (file.endsWith('auth.ts')) continue

      let content: string
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue
      }

      if (content.includes(FORBIDDEN)) {
        violations.push(file)
      }
    }

    if (violations.length > 0) {
      const msg = [
        `Found ${violations.length} file(s) calling useSession().update():`,
        ...violations.map((f) => `  ${f}`),
        '',
        'CONTEXT: auth.ts returns null on trigger === "update", which forces',
        're-authentication for every affected user.  This is intentional for',
        'role revocation (fail-closed), but any call to useSession().update()',
        'will silently log users out with no obvious cause.',
        '',
        'Before adding a useSession().update() call, update the jwt() callback',
        'in auth.ts to handle the update trigger safely, then remove this guard.',
      ].join('\n')
      throw new Error(msg)
    }
  })
})
