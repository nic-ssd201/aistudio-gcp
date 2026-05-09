# syntax=docker.io/docker/dockerfile:1
#
# Document-processor Cloud Run Service container.
#
# Receives Cloud Tasks HTTP dispatches at POST /process-job and Cloud
# Scheduler dispatches at POST /admin/cleanup-jobs. Both endpoints verify
# the inbound OIDC ID token before doing any work — the receiver pins the
# expected invoker SA email so a misconfigured Tasks/Scheduler with the
# wrong SA can't kick the processor.
#
# Runtime: bun (matches the main Next.js image's deps-install stage). Bun
# handles TypeScript natively and respects the project's tsconfig `paths`,
# so the entrypoint can import `@/lib/...` directly without an esbuild step.
# This keeps the image small and the maintenance surface zero.

# ── deps stage ────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package.json bun.lock ./
COPY patches/ ./patches/

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ── runner stage ──────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runner
WORKDIR /app

# pdf-parse / mammoth / xlsx work on prebuilt binaries — libc6-compat covers
# the few native glibc shims they need on Alpine.
RUN apk add --no-cache libc6-compat curl

# Non-root user for least-privilege execution.
RUN addgroup --system --gid 1001 processor && \
    adduser --system --uid 1001 processor

COPY --from=deps --chown=processor:processor /app/node_modules ./node_modules
COPY --chown=processor:processor package.json bun.lock tsconfig.json ./
COPY --chown=processor:processor lib ./lib
COPY --chown=processor:processor infra/cloud-run-services/document-processor ./processor

USER processor

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Cloud Run expects PORT to be the listened-on port; the entrypoint reads it.
CMD ["bun", "run", "/app/processor/index.ts"]
