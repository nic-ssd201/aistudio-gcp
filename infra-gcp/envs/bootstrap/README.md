# envs/bootstrap — Bootstrap Env Root

This Terraform root owns the **project-level primitives** that must exist before any other env root can apply:

- The shared project (default `ssd201-aistudio-shared`; adopted via data source — never created/destroyed)
- GCS state bucket + CMEK KMS key ring
- Artifact Registry Docker repo
- Workload Identity Federation pool + providers (GitHub Actions, OpenClaw)
- Terraform runner and OpenClaw runtime service accounts
- Org-level audit log sink
- **Billing budgets** (one per env project)
- **Breakglass email notification channel** — ensures budget alerts fire on day 1 before observability channels exist

## Apply order

```
1. envs/bootstrap   (this root, once per env)
2. envs/dev         (or staging / prod)
```

The downstream env roots (`envs/dev`, `envs/staging`, `envs/prod`) consume this root's outputs via `data "terraform_remote_state" "bootstrap"`.

## One root, three envs

This root is parameterised by `var.env`. Supply values via a per-env tfvars file:

```bash
# Dev
terraform init \
  -backend-config="bucket=ssd201-aistudio-tfstate-shared" \
  -backend-config="prefix=bootstrap/dev"
terraform apply -var-file=dev.tfvars

# Staging
terraform init \
  -backend-config="bucket=ssd201-aistudio-tfstate-shared" \
  -backend-config="prefix=bootstrap/staging"
terraform apply -var-file=staging.tfvars

# Prod
terraform init \
  -backend-config="bucket=ssd201-aistudio-tfstate-shared" \
  -backend-config="prefix=bootstrap/prod"
terraform apply -var-file=prod.tfvars
```

Example tfvars files: `dev.tfvars.example`, `staging.tfvars.example`, `prod.tfvars.example`. Copy and rename (strip `.example`) to apply; real tfvars files are gitignored.

## Breakglass notification channel

The bootstrap module creates one `google_monitoring_notification_channel` (type `email`) using `var.breakglass_email`. This solves the chicken-and-egg problem:

- Budgets need notification channel IDs at apply time
- The observability module (which creates PagerDuty/Telegram channels) hasn't been applied yet on day 1

The breakglass channel is automatically used for any budget whose `notification_channels` list is empty, via `coalescelist()` in `modules/bootstrap/budgets.tf`. Once the observability module has been applied, update `budget_notification_channels` in the tfvars file and re-apply this root to add the real channels alongside the breakglass fallback.

## Why a separate root?

Previously `module "bootstrap"` lived inside each env's root (`envs/dev/main.tf`, etc.). The only way to apply bootstrap in isolation was `terraform apply -target=module.bootstrap.google_billing_budget.budgets` — a known Terraform anti-pattern (HashiCorp discourages `-target` for routine use).

By splitting bootstrap into its own root, you can:

- Apply bootstrap once with elevated Billing Admin credentials
- Apply the env root with narrower credentials (no billing account access required)
- Re-apply bootstrap independently when budgets or billing configurations change, without touching compute or networking resources

## Outputs consumed downstream

Downstream env roots reference this root's state with:

```hcl
data "terraform_remote_state" "bootstrap" {
  backend = "gcs"
  config = {
    bucket = "ssd201-aistudio-tfstate-shared"
    prefix = "bootstrap/<env>"
  }
}
```

Key outputs:
- `shared_project_id` — shared project ID
- `shared_project_number` — shared project number (WIF principalSet URNs)
- `artifact_registry_repository` — Docker repo URI
- `terraform_runner_sa_email` — SA email for CI/CD
- `openclaw_runtime_sa_email` — SA email for OpenClaw agent
- `breakglass_channel_id` — notification channel ID; available to pass into observability as a fallback
- `budget_names` — map of budget display name → resource name
