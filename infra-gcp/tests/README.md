# `/infra-gcp/tests/` — Terratest harness

Go tests for the Terraform modules in `/infra-gcp/modules/`. Each module ships with example terraform under `examples/<scenario>/`; the tests `apply` those examples against a real GCP project, call GCP APIs to verify the result, then `destroy`.

## Why real GCP

IAM bindings, service-networking peering, and Serverless VPC connectors all have server-side validation that `terraform plan` alone won't surface. Running against a scratch project is the only way to catch them before merge.

## Prerequisites

- Terraform `>= 1.6.0` on `PATH`
- Go `>= 1.22`
- A dedicated **scratch** GCP project (not dev/staging/prod). Recommended naming: `aistudio-terratest`.
- Application Default Credentials on the machine running tests, with enough permissions in the scratch project:
  - `roles/iam.serviceAccountAdmin`
  - `roles/resourcemanager.projectIamAdmin`
  - `roles/storage.admin`
  - `roles/secretmanager.admin`
  - *(Phase-0.4 tests only)* `roles/compute.networkAdmin`, `roles/servicenetworking.networksAdmin`, `roles/vpcaccess.admin`
- The relevant APIs enabled in the scratch project:
  ```bash
  gcloud services enable \
    iam.googleapis.com \
    cloudresourcemanager.googleapis.com \
    storage.googleapis.com \
    secretmanager.googleapis.com \
    aiplatform.googleapis.com \
    --project=$TEST_PROJECT_ID
  ```

## Running locally

```bash
# 1. Install dependencies.
cd infra-gcp/tests
go mod download

# 2. Point at your scratch project.
export TEST_PROJECT_ID=aistudio-terratest

# 3. Authenticate.
gcloud auth application-default login

# 4. Run all tests. -v streams progress; -timeout guards runaway applies.
go test -v -timeout 30m ./...

# Or run a single test:
go test -v -timeout 15m -run TestSAFactoryMinimal
```

Each test uses `t.Parallel()` and a random suffix, so you can run them concurrently without collisions. Terratest `Destroy` is deferred — tests clean up even on failure as long as you don't kill the process mid-apply.

## Running in CI

Add a workflow job that:

1. Authenticates to GCP via Workload Identity Federation (no long-lived keys).
2. Sets `TEST_PROJECT_ID` from a repo variable.
3. Runs `go test -v -timeout 30m ./...`.
4. On failure, runs `terraform destroy` against any stuck fixture directories as a safety net.

See `.github/workflows/infra-gcp-tests.yml` (to be added in P0.6).

## Writing new tests

Each module under `/infra-gcp/modules/` should ship at least:

- `examples/minimal/` — smallest viable invocation
- `examples/full/` — every input exercised
- A corresponding `<module>_test.go` with `Minimal`, `Full`, and validation-only cases

Use the helpers in `helpers.go` for IAM assertions. The pattern is always:

```go
func TestMyModuleMinimal(t *testing.T) {
    t.Parallel()
    projectID := getProjectID(t)
    uniqueID := strings.ToLower(random.UniqueId())

    opts := &terraform.Options{
        TerraformDir: "../modules/<module>/examples/minimal",
        Vars: map[string]interface{}{
            "project_id":  projectID,
            "name_prefix": fmt.Sprintf("tt-%s", uniqueID),
        },
        NoColor: true,
    }
    defer terraform.Destroy(t, opts)
    terraform.InitAndApply(t, opts)

    // ... assertions
}
```

Two negative checks are always worth including:

1. **Opt-in roles stay opt-in.** The minimal path should *not* carry opt-in roles.
2. **Least-privilege didn't regress.** If the module claims a role is bound at the resource level, it should NOT also be bound at project level.

`TestSAFactoryFull` has examples of both.

## Gotchas we've hit

- **IAM propagation lag.** Bindings can take 5–20 seconds to appear in `GetIamPolicy`. If you see flaky passes/failures, wrap the assertion in a retry loop — add to `helpers.go` when this happens.
- **Secret Manager replication.** The `auto` replication policy provisions the secret almost instantly, but `managed` can be slow. Examples use `auto` for that reason.
- **Bucket naming.** Bucket names are globally unique; randomize them (the tests do). A stale test that didn't destroy will claim the name forever.
- **Destroy order matters for PSA peering** (Phase 0.4). The `google_service_networking_connection` is slow to delete — `go test -timeout 30m` gives it room.
