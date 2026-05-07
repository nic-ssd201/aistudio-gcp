import { test, expect } from '@playwright/test'

/**
 * E2E tests for the sign-out flow (PR #6 — Google OIDC only).
 *
 * Verified behaviors:
 *   - Navigating to /signout initiates the NextAuth POST sign-out
 *   - After sign-out the user lands on the landing page (/)
 *   - An already-signed-out user hitting /signout doesn't error
 *   - Protected routes redirect to the landing page after sign-out
 *
 * These tests run without an authenticated session (unauthenticated context)
 * to verify the page renders gracefully and the redirect works whether or
 * not a session is present. Authenticated sign-out is covered by the
 * golden-path auth E2E (requires PLAYWRIGHT_AUTH_ENABLED=true).
 *
 * Implementation notes:
 * - /signout calls signOut() from next-auth/react via useEffect, which
 *   POSTs to /api/auth/signout with a CSRF token (NextAuth double-submit).
 * - We mock the NextAuth signout endpoint to verify the POST is attempted
 *   and the redirect to / follows.
 */

test.describe('Sign-out page — unauthenticated context', () => {
  test('renders the signing-out message and makes the CSRF-protected POST to /api/auth/signout', async ({ page }) => {
    // Mock the NextAuth CSRF endpoint so signOut() can obtain a csrfToken without
    // a live auth server.  NextAuth's signOut() fetches /api/auth/csrf first (GET)
    // to retrieve the token for the double-submit CSRF check, then POSTs to
    // /api/auth/signout with that token in the body.
    await page.route('/api/auth/csrf', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ csrfToken: 'test-csrf-token' }),
      })
    })

    // Mock the NextAuth signout endpoint so we don't need a live auth server.
    // NextAuth's POST /api/auth/signout returns a redirect to callbackUrl.
    await page.route('/api/auth/signout', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: '/' }),
      })
    })

    // Set up the waitForRequest listener BEFORE navigating so the useEffect-
    // triggered POST is captured. This asserts that signOut() actually fires
    // a POST (not a GET) — locking in the CSRF-safe double-submit behavior.
    const signoutPost = page.waitForRequest(
      (req) => req.url().includes('/api/auth/signout') && req.method() === 'POST',
      { timeout: 5000 }
    )

    await page.goto('/signout')

    // Assert the POST was actually made (CSRF-protected, not a bare GET).
    await signoutPost

    // The signing-out message should be visible during the transition.
    // (It may disappear quickly once signOut() resolves — assert it appeared.)
    await expect(page.getByText('Signing out')).toBeVisible({ timeout: 5000 })

    // After signOut() resolves, the mocked endpoint returned { url: '/' } so
    // NextAuth's redirect handling should navigate to the landing page.
    // This pins the post-POST redirect behavior — if signOut()'s redirect broke
    // (e.g. callbackUrl ignored), the user would remain on /signout indefinitely.
    await expect(page).toHaveURL('/', { timeout: 5000 })
  })

  test('does not render a <noscript> form that would bypass CSRF', async ({ page }) => {
    // Verify the broken no-JS fallback was removed (PR #6 eighth-round fix).
    // A bare <noscript> form POST without csrfToken would be rejected by NextAuth v5.
    await page.goto('/signout')
    const noscriptForms = page.locator('noscript form')
    await expect(noscriptForms).toHaveCount(0)
  })

  // NOTE — secondary auth cookies (PKCE code_verifier, OAuth state, OIDC nonce)
  // are set by NextAuth during the authorization request and are scoped to the
  // /api/auth/ path.  NextAuth v5 sets them as HttpOnly, SameSite=Lax cookies
  // that expire after the authorization code exchange completes (typically within
  // seconds).  They are NOT cleared by signOut() because they are transient
  // per-authorization-request cookies, not long-lived session cookies.  In
  // practice they will already be expired (or cleared by the browser after the
  // tab closes) long before a user clicks sign-out.  If explicit clearing of
  // PKCE/state/nonce cookies ever becomes a hard requirement, add a signout
  // route handler that calls response.cookies.delete() on each before delegating
  // to NextAuth's signOut().
})

test.describe('Sign-out — authenticated golden path', () => {
  test.skip(
    !process.env.PLAYWRIGHT_AUTH_ENABLED,
    'Requires authenticated Playwright context — set PLAYWRIGHT_AUTH_ENABLED=true to run'
  )

  test('signing out lands on the landing page and clears the session', async ({ page }) => {
    // Navigate to a protected route to confirm session is active.
    await page.goto('/dashboard')
    await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 10000 })

    // Trigger sign-out via the /signout page.
    await page.goto('/signout')

    // Should end up on the landing page (callbackUrl: '/').
    await page.waitForURL((url) => url.pathname === '/', { timeout: 15000 })
    await expect(page).toHaveURL('/')

    // Attempting to access a protected route should now redirect to /.
    await page.goto('/dashboard')
    await page.waitForURL((url) => url.pathname === '/', { timeout: 10000 })
    await expect(page).toHaveURL('/')
  })
})
