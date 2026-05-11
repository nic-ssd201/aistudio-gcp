# Bootstrap env root — project-level primitives
#
# Apply this root FIRST, once per environment, before applying envs/dev|staging|prod.
# It owns the shared project, state bucket, WIF pool, billing budgets, and the
# breakglass notification channel that ensures budgets fire on day 1.
#
# Usage:
#   terraform init \
#     -backend-config="bucket=ssd201-aistudio-tfstate-shared" \
#     -backend-config="prefix=bootstrap/dev"
#   terraform apply -var-file=dev.tfvars
#
# Downstream env roots (envs/dev, envs/staging, envs/prod) consume this root's
# outputs via data "terraform_remote_state" "bootstrap".

module "bootstrap" {
  source = "../../modules/bootstrap"

  host_project_id       = var.host_project_id
  org_id                = var.org_id
  billing_account       = var.billing_account
  state_bucket_name     = var.state_bucket_name
  state_bucket_location = var.region
  github_repo           = var.github_repo
  openclaw_local_issuer = var.openclaw_local_issuer
  breakglass_email      = var.breakglass_email

  budgets = {
    "aistudio-${var.env}-monthly" = {
      amount_usd            = var.budget_amount_usd
      project_ids           = [var.env_project_id]
      threshold_percents    = var.budget_threshold_percents
      notification_channels = var.budget_notification_channels
      # If notification_channels is empty, modules/bootstrap/budgets.tf automatically
      # falls back to the breakglass channel via coalescelist().
    }
  }

  labels = merge(
    var.labels,
    {
      environment = var.env
      managed-by  = "terraform"
    },
  )
}
