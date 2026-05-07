"use client"

import { useEffect, useRef } from 'react';
import { signOut } from 'next-auth/react';

export default function SignOutPage() {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // signOut() from next-auth/react posts to /api/auth/signout with a CSRF
    // token automatically, preventing CSRF-triggered logout via GET requests.
    signOut({ callbackUrl: '/' });
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <p className="text-lg text-muted-foreground">Signing out…</p>
        {/* No-JS / pre-hydration fallback: submits the NextAuth signout form
            directly. NextAuth's [...nextauth] POST handler handles CSRF. */}
        <noscript>
          <form ref={formRef} method="POST" action="/api/auth/signout">
            <input type="hidden" name="callbackUrl" value="/" />
            <button type="submit" className="mt-4 text-sm underline">
              Click here to complete sign-out
            </button>
          </form>
        </noscript>
      </div>
    </div>
  );
}
