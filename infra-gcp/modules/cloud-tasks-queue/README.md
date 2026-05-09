# cloud-tasks-queue

A single Cloud Tasks queue. Used by the document-processing pipeline to fan
out async work from the upload routes to the document-processor Cloud Run
worker.

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `queue_name` | Full queue name (callers prepend env if desired) | required |
| `region` | Queue location (must match the worker region) | `us-west1` |
| `max_dispatches_per_second` | Token-bucket cap | 10 |
| `max_concurrent_dispatches` | In-flight cap | 5 |
| `max_attempts` | Retry attempts before permanent failure | 5 |
| `min_backoff` / `max_backoff` | Exponential backoff bounds | `10s` / `300s` |
| `max_doublings` | Doublings before backoff plateaus | 4 |

## Outputs

| Name | Description |
|------|-------------|
| `queue_id` | Fully-qualified resource path (`projects/.../locations/.../queues/...`) — pass to the producer's `PROCESSING_QUEUE_NAME` env var |
| `queue_name` | Queue short name |

## IAM (provisioned by the caller, not this module)

- The **producer SA** (cloud-run-web) needs `roles/cloudtasks.enqueuer` on
  this queue.
- The **invoker SA** (configured per-task via `oidcToken`) needs
  `roles/run.invoker` on the target Cloud Run worker.

## Tuning the queue against the worker

`max_concurrent_dispatches` is the queue-level cap on simultaneously in-flight
HTTP dispatches. The worker-level cap is `cloud-run-worker.max_instances ×
cloud-run-worker.concurrency` — for the document-processor that's `max_instances
× 1` (workers default `concurrency = 1` because each request is long-running
and CPU-bound).

When tuning, keep:

```
queue.max_concurrent_dispatches  ≤  worker.max_instances × worker.concurrency
```

Otherwise the queue dispatches faster than the worker can scale, Cloud Tasks
sees the rejected requests as failures, and retries pile up — death spiral.

For long tasks (the document-processor runs 30s–1800s per task), with the
default `max_concurrent_dispatches = 5` and worker `max_instances = 10`, you
have room for 2× burst before the queue starts back-pressuring. If you bump
the queue cap, bump the worker cap too.
