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
