import { NextRequest, NextResponse } from "next/server";
import { createAuth } from "@/auth";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.auth.signout");
  const log = createLogger({ requestId, route: "api.auth.signout" });

  log.info("GET /api/auth/signout - User sign out requested");

  try {
    const { auth, signOut } = createAuth();
    const session = await auth();

    if (session) {
      log.debug("Session found, signing out");
      await signOut({ redirect: false });
      log.info("User signed out successfully");
    } else {
      log.debug("No active session");
    }

    timer({ status: "success" });
    return NextResponse.redirect(new URL("/", request.url));
  } catch (error) {
    timer({ status: "error" });
    log.error("Sign out error", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.redirect(new URL("/", request.url));
  }
}
