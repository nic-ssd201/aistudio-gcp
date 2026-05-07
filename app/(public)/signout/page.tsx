"use client"

import { useEffect } from 'react';
import { signOut } from 'next-auth/react';

export default function SignOutPage() {
  useEffect(() => {
    // signOut() from next-auth/react posts to /api/auth/signout with a CSRF
    // token automatically, preventing CSRF-triggered logout via GET requests.
    signOut({ callbackUrl: '/' });
  }, []);

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
