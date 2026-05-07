import { NextResponse } from "next/server";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

/**
 * Federated sign-out endpoint.
 *
 * With Google OIDC the session cookie is cleared by the standard NextAuth
 * /api/auth/signout flow. This endpoint exists for backward compatibility
 * with any links that reference /api/auth/federated-signout; it simply
 * delegates to the standard signout route.
 */
export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.auth.federated-signout");
  const log = createLogger({ requestId, route: "api.auth.federated-signout" });

  log.info("GET /api/auth/federated-signout → delegating to NextAuth signout");
  timer({ status: "success" });

  return NextResponse.redirect(
    new URL("/api/auth/signout", process.env.AUTH_URL || "http://localhost:3000")
  );
}
