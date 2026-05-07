"use client"

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';

export default function SignOutPage() {
  const router = useRouter();

  useEffect(() => {
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
      // Log so a partial-failure (e.g., 5xx clearing the cookie) is observable.
      // eslint-disable-next-line no-console
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
