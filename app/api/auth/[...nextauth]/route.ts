// NextAuth routes handle their own logging internally
// These are auto-generated handlers from the NextAuth library
import { createAuthHandlers } from "@/auth"

// Handlers are created once at module load (not per-request): Next.js route
// modules are singletons within a server process, so this is intentional and
// matches the pattern used by NextAuth's own documentation.
const handlers = createAuthHandlers()
export const { GET, POST } = handlers