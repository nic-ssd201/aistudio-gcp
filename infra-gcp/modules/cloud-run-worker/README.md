# cloud-run-worker

Cloud Run v2 Service for HTTP-receiving background workers — sibling to
[`cloud-run-web`](../cloud-run-web) but tuned for queue-driven, long-running
work rather than user-facing request handling.

| Differs from `cloud-run-web` | Why |
|---|---|
| `INGRESS_TRAFFIC_INTERNAL_ONLY` | No public internet / LB; only Google services (Cloud Tasks, Cloud Scheduler, Eventarc) and VPC peers can call. The OIDC check at the application layer is the auth boundary. |
| `concurrency = 1` (default) | Each request is long-running and CPU/memory-bound. Queue in front, not concurrency in container. |
| Configurable request timeout (up to 60 min) | PDF/DOCX extraction can run minutes; default 1800s. Cloud Run's hard cap is 3600s. |
| No blue/green traffic split | Async work — a botched deploy just causes Cloud Tasks to retry against the prior revision. Always 100% to latest. |
| `cpu_idle = true` (always) | Workers don't need to stay warm between requests; pay only when processing. |

## Inputs

| Name | Description |
|------|-------------|
| `service_name` | Full Cloud Run service name (callers prepend env if desired) |
| `service_account_email` | SA the worker runs as |
| `image` | Container image URI |
| `vpc_connector` | Required — workers typically reach AlloyDB / private services |
| `request_timeout_seconds` | HTTP timeout in seconds (default 1800, max 3600) |
| `concurrency` | In-flight requests per instance (default 1) |
| `min_instances` / `max_instances` | Scaling bounds (default 0–10) |
| `cpu` / `memory` | Per-container limits (default 1 vCPU / 2Gi) |
| `health_check_path` | Probe path (default `/healthz`) |
| `env` / `secret_refs` | Plain and secret env vars |
| `labels` | Resource labels (merged) |

## Outputs

| Name | Description |
|------|-------------|
| `service_name` | Cloud Run service name |
| `service_url` | HTTPS endpoint Cloud Tasks / Scheduler dispatch to |

## VPC egress

The worker is wired with `vpc_access.egress = "ALL_TRAFFIC"`. This routes
**every** outbound request through the VPC connector — including:
- AlloyDB connections (the actual reason the connector is required)
- GCS reads / writes
- OIDC token verification fetches against `googleapis.com/oauth2/v3/certs`

If you change this to `PRIVATE_RANGES_ONLY` to save VPC connector quota
(e.g. on a small dev env), the worker can no longer reach Google's public
JWKS endpoint and **OIDC verification will fail closed on every request**.
Keep `ALL_TRAFFIC` unless you have a Private Google Access path configured
end-to-end.

## Image lifecycle

The module sets `lifecycle.ignore_changes = [image]` on the Cloud Run
service. Container image updates land via the CI pipeline's
`gcloud run deploy --image=…` (or equivalent), and Terraform deliberately
does NOT plan a change when the live image differs from
`var.image`. Two consequences:

1. **First apply** uses `var.image` (typically a `cloudrun/hello`
   placeholder so the service exists before the real image is built).
   CI then deploys the real image; Terraform doesn't fight it.
2. **Rolling back** to a known-good revision via `terraform apply` does
   NOT work — Terraform won't plan the image change. Either redeploy
   the prior tag via CI / `gcloud`, or split this into a Terraform-
   managed `image` bump if you want the rollback path through `tf apply`.
