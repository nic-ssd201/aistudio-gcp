"use client"

import { useEffect } from 'react';

export default function SignOutPage() {
  useEffect(() => {
    // Redirect to NextAuth's standard signout route (one hop, no intermediary)
    window.location.href = '/api/auth/signout';
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <p className="text-lg text-muted-foreground">Signing out...</p>
      </div>
    </div>
  );
}