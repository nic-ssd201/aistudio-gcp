# AI Studio on GCP — Demo Runbook

Vertical slice: **Google SSO → Chat with Gemini on Vertex AI**, end to end, running locally against the real `openclaw-gog-487717` GCP project.

Everything AWS-flavored (Cognito, Bedrock, S3, Secrets Manager, CloudWatch publishing) is left in place as dead code so the diff is small and easy to reason about. The live request path is 100% GCP.

---

## One-time setup (do this before the demo)

```bash
# 1. Install the gcloud SDK if you don't already have it, then:
gcloud auth login
gcloud config set project openclaw-gog-487717

# 2. Create Application Default Credentials (Vertex AI reads these).
gcloud auth application-default login

# 3. Enable the Vertex AI API on the project (once).
gcloud services enable aiplatform.googleapis.com \
  --project=openclaw-gog-487717

# 4. Confirm the OAuth Web client has the right callback URI:
#    GCP Console → APIs & Services → Credentials → [the Web client]
#    → Authorized redirect URIs must include:
#      http://localhost:3000/api/auth/callback/google

# 5. Confirm .env.local has the GCP_OAUTH_CLIENT_ID /
#    GCP_OAUTH_CLIENT_SECRET / GOOGLE_CLOUD_PROJECT values already set.
```

If `gcloud auth application-default login` wasn't run, Vertex calls will fail with `PERMISSION_DENIED` and the adapter will log a hint pointing at IAM. That's the single most likely demo-day trap.

---

## The three commands (the demo itself)

```bash
# Terminal 1 — boot Postgres in Docker
bun run db:up

# Wait a few seconds for the container to be healthy, then seed:
bun run db:seed

# Terminal 2 — start the Next.js dev server with local Postgres
bun run dev:local
```

Open http://localhost:3000 — you should get a Google sign-in page. Pick your Google account, approve the scopes, land on the dashboard.

Go to the Nexus chat, open the model selector, pick **"Gemini 1.5 Flash (Vertex)"**. Send a message. You should see a streaming response from Vertex AI.

---

## 60-second narrative

> "This is AI Studio, the app we built on AWS — same codebase, now running on GCP.
>
> 1. **Auth is Google SSO via Identity Platform.** We swapped out NextAuth's Cognito provider for the standard Google OIDC provider. One redirect, no passwords to migrate — everyone's Google identity Just Works.
>
> 2. **Chat runs on Vertex AI.** I'm sending this prompt to Gemini 1.5 Flash in us-central1. The app authenticates to Vertex via Application Default Credentials — no API keys in the app, no secrets in env vars. On Cloud Run, this becomes the attached service account, and the whole auth chain is invisible.
>
> 3. **The provider factory is pluggable.** Adding Vertex was a new `VertexAdapter` alongside the existing OpenAI, Bedrock, and Azure adapters — same interface, same streaming pipeline. The model selector picks it up automatically from the database.
>
> 4. **What's next:** wire Cloud SQL in place of Aurora, GCS in place of S3 for document uploads (adapter is already in place, feature-flagged), and redeploy to Cloud Run. None of that touches application code — it's all config + infra."

---

## What's live (GCP) vs. dead code (AWS)

| Layer | Live path | Dead path (still in the repo) |
|---|---|---|
| Auth | NextAuth + Google provider (`auth.ts`) | Cognito config (commented env vars only) |
| AI chat | `VertexAdapter` → Gemini via ADC | Bedrock / OpenAI / Azure adapters (untouched) |
| DB | Local Postgres in Docker (mimics Aurora) | Aurora via RDS Data API (not used locally) |
| Uploads | GCS adapter in `lib/aws/document-upload.ts` | S3 client remains for other callers |
| Metrics | Cloud Monitoring typed values (`int64Value`) | `CLOUDWATCH_METRICS_ENABLED=false` skips the publish |

The "dead" code still compiles — `typecheck` passes on the whole tree (5,281 files) — so we can pull CloudWatch and S3 out incrementally post-demo without risking the slice.

---

## Failure mode cheatsheet

| Symptom | Likely cause | Fix |
|---|---|---|
| Login returns `OAuthCallback` error | Redirect URI mismatch | Add `http://localhost:3000/api/auth/callback/google` in GCP Console |
| `GOOGLE_CLOUD_PROJECT env var is required` | `.env.local` not loaded | Check you're running `bun run dev:local`, not `npm run dev` from a different shell |
| `PERMISSION_DENIED` on first chat send | ADC missing or wrong project | Rerun `gcloud auth application-default login`, confirm `gcloud config list project` |
| Chat hangs, no stream | Vertex AI API disabled | `gcloud services enable aiplatform.googleapis.com` |
| "No models available" in selector | Seed didn't run or ran against wrong DB | `bun run db:reset && bun run db:seed` |

---

## Reset between dry-runs

```bash
bun run db:reset    # drops and re-creates postgres with clean schema
bun run db:seed     # re-seeds users + ai_models (incl. the Vertex row)
```

Test users after seed: `test@example.com` (admin), `staff@example.com`, `student@example.com` — but for the demo you'll sign in with your **actual** Google account via SSO. On first successful sign-in the app upserts a user row keyed by your Google `sub`, using your Google email as the fallback link to any pre-existing account with the same email.
