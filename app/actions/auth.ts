"use server"

import { createAuth } from "@/auth"
import { redirect } from "next/navigation"

export async function signOutAction() {
  const { auth, signOut } = createAuth();
  const session = await auth();

  if (session) {
    await signOut({ redirect: false });
  }

  redirect('/');
}
