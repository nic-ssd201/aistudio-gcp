import { type NextRequest, NextResponse } from "next/server";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

/**
 * Federated sign-out endpoint.
 *
 * With Google OIDC the session cookie is cleared by the standard NextAuth
 * /api/auth/signout flow. This endpoint exists for backward compatibility
 * with any links that reference /api/auth/federated-signout; it simply
 * delegates to the standard signout route on the same origin.
 */
export async function GET(request: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.auth.federated-signout");
  const log = createLogger({ requestId, route: "api.auth.federated-signout" });

  log.info("GET /api/auth/federated-signout → delegating to NextAuth signout");
  timer({ status: "success" });

  // Use the request origin rather than AUTH_URL to avoid misconfigured-env
  // redirects to localhost in production.
  return NextResponse.redirect(
    new URL("/api/auth/signout", request.nextUrl.origin)
  );
}
