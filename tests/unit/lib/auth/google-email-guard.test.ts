/**
 * Unit tests for hasVerifiedGoogleEmail (lib/auth/google-email-guard.ts)
 *
 * Validates the security-critical email_verified check used by auth.ts's
 * signIn() callback to prevent unverified Google accounts from signing in.
 *
 * The function uses `=== true` (not `!== false`) so every non-boolean-true
 * value is treated as unverified — this covers absent claims, stringified
 * values, and explicitly false claims.
 *
 * If this gate breaks, resolveUserId's email-fallback path could fuse an
 * unverified attacker account into an existing verified user record.
 */

import { hasVerifiedGoogleEmail } from "@/lib/auth/google-email-guard"

describe("hasVerifiedGoogleEmail", () => {
  describe("returns true (allow sign-in) only for boolean true", () => {
    it("returns true when email_verified is boolean true", () => {
      expect(hasVerifiedGoogleEmail({ email_verified: true })).toBe(true)
    })
  })

  describe("returns false (reject sign-in) for all non-true values", () => {
    it("returns false when email_verified is boolean false", () => {
      expect(hasVerifiedGoogleEmail({ email_verified: false })).toBe(false)
    })

    it("returns false when email_verified is the string 'true'", () => {
      // Stringified claim — must NOT be accepted
      expect(hasVerifiedGoogleEmail({ email_verified: "true" })).toBe(false)
    })

    it("returns false when email_verified is the string 'false'", () => {
      expect(hasVerifiedGoogleEmail({ email_verified: "false" })).toBe(false)
    })

    it("returns false when email_verified is undefined", () => {
      // Absent claim — provider may omit it
      expect(hasVerifiedGoogleEmail({ email_verified: undefined })).toBe(false)
    })

    it("returns false when email_verified is null", () => {
      expect(hasVerifiedGoogleEmail({ email_verified: null })).toBe(false)
    })

    it("returns false when email_verified is 0", () => {
      expect(hasVerifiedGoogleEmail({ email_verified: 0 })).toBe(false)
    })

    it("returns false when email_verified is 1", () => {
      // Numeric truthy — must NOT be accepted
      expect(hasVerifiedGoogleEmail({ email_verified: 1 })).toBe(false)
    })

    it("returns false when the profile object is null", () => {
      expect(hasVerifiedGoogleEmail(null)).toBe(false)
    })

    it("returns false when the profile object is undefined", () => {
      expect(hasVerifiedGoogleEmail(undefined)).toBe(false)
    })

    it("returns false when the profile has no email_verified field", () => {
      expect(hasVerifiedGoogleEmail({})).toBe(false)
    })
  })
})
