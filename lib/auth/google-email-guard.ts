/**
 * google-email-guard.ts
 *
 * Pure helper for the NextAuth `signIn` callback's email-verification gate.
 * Extracted so the logic can be unit-tested without importing the full
 * NextAuth config (which requires DB connections and edge-runtime env vars).
 *
 * Security note: `=== true` (not `!== false`) is intentional — an absent,
 * stringified ("true"), or otherwise non-boolean claim is treated as
 * unverified, which is defense-in-depth against providers that omit or
 * mangle the field.
 */

/**
 * Returns `true` only when the Google profile carries `email_verified: true`
 * (the boolean literal). Every other value — `false`, `undefined`, `"true"`,
 * `null` — returns `false` and the caller should reject the sign-in.
 */
export function hasVerifiedGoogleEmail(
  profile: { email_verified?: unknown } | null | undefined
): boolean {
  return profile?.email_verified === true
}
