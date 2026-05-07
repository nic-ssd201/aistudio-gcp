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
    signOut({ callbackUrl: '/' }).catch(() => router.push('/'));
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
