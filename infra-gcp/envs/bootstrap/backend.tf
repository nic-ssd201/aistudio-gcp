terraform {
  backend "gcs" {
    # Bucket and prefix are supplied at init time via -backend-config or a backend.hcl file:
    #
    #   terraform init \
    #     -backend-config="bucket=ssd201-aistudio-tfstate-shared" \
    #     -backend-config="prefix=bootstrap/<env>"
    #
    # Example prefixes:
    #   bootstrap/dev      → dev bootstrap state
    #   bootstrap/staging  → staging bootstrap state
    #   bootstrap/prod     → prod bootstrap state
    #
    # All three env bootstrap states share the same GCS bucket (ssd201-aistudio-tfstate-shared,
    # see envs/bootstrap/variables.tf for the default) but are isolated by prefix so they can
    # be applied independently.
  }
}
