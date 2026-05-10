terraform {
  backend "gcs" {
    # Bucket and prefix are supplied at init time via -backend-config or a
    # backend.hcl file. The shared state bucket is created by envs/bootstrap
    # (default name `ssd201-aistudio-tfstate-shared`); per-env state is
    # isolated by prefix so all envs can share the same bucket.
    #
    #   terraform init \
    #     -backend-config="bucket=ssd201-aistudio-tfstate-shared" \
    #     -backend-config="prefix=envs/staging"
    #
    # Matches the envs/bootstrap/backend.tf pattern (no hardcoded values) so
    # callers can't accidentally land on a never-created bucket name. The
    # previous hardcoded value (`aistudio-tfstate-staging`) referenced a bucket
    # bootstrap never creates.
  }
}
