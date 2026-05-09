"use client"

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';

export default function SignOutPage() {
  const router = useRouter();
  // Guard against React Strict Mode's double-invocation of effects in development:
  // without this, two POSTs land on /api/auth/signout — harmless since signOut()
  // is idempotent, but produces a duplicate console.error on the second call and
  // is confusing noise in dev tools network panels.
  const signOutStarted = useRef(false);

  useEffect(() => {
    if (signOutStarted.current) return;
    signOutStarted.current = true;

    // Security dependency: this page relies on middleware.ts setting
    // `X-Frame-Options: DENY` on every response. Without it an attacker could
    // embed this page in an invisible iframe and trigger an unconditional
    // signOut() on mount — a clickjacking-based logout CSRF. Do not remove
    // the X-Frame-Options header from middleware without re-evaluating this.
    //
    // signOut() from next-auth/react posts to /api/auth/signout with a CSRF
    // token automatically, preventing CSRF-triggered logout via GET requests.
    // .catch() ensures a network blip doesn't strand the user on "Signing out…" forever.
    // Note: signOut() is local-only — it clears the NextAuth session cookie but
    // does NOT revoke the Google OAuth grant at accounts.google.com. After
    // sign-out, returning users may be silently re-authenticated via their
    // active Google session. This is the expected SSO behaviour for Workspace
    // deployments. If explicit account-switching UX is needed, change
    // `prompt: "consent"` → `prompt: "select_account"` in auth.ts.
    signOut({ callbackUrl: '/' }).catch((err) => {
      // In the normal (success) path, signOut() triggers navigation before this
      // Promise settles, so this catch block is dead code in ~99% of runs.
      // It only fires if the underlying fetch throws before navigation begins
      // (e.g. network down, 5xx on /api/auth/signout) — in that case we log
      // and redirect so the user isn't stranded on "Signing out…" indefinitely.
      // eslint-disable-next-line no-console -- client component; @/lib/logger is server-only, no client telemetry shim available
      console.error('[signout] signOut() failed, redirecting to / anyway:', err)
      router.push('/')
    });
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <p className="text-lg text-muted-foreground">Signing out…</p>
        {/* No <noscript> fallback: NextAuth v5's POST handler enforces CSRF
            (double-submit cookie) and would reject a bare form POST without the
            csrfToken hidden field. Without JS, the user is stuck on this page —
            acceptable since modern browsers all execute JS. */}
      </div>
    </div>
  );
}
