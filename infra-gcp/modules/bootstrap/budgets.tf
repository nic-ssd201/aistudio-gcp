# bootstrap/budgets.tf
#
# §6.2: Billing budgets live here — bootstrap holds the billing association and is the
# correct home for billing-account-level controls. The observability module retains its
# log-based FERPA tripwire metric; these are the real cost-governance alerts.
#
# One google_billing_budget resource is created per entry in var.budgets.
# Env compositions wire one budget per env project via the module "bootstrap" block.

resource "google_billing_budget" "budgets" {
  for_each = var.budgets

  billing_account = var.billing_account
  display_name    = each.key

  budget_filter {
    projects               = [for p in each.value.project_ids : "projects/${p}"]
    credit_types_treatment = each.value.credit_types_treatment
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(each.value.amount_usd)
    }
  }

  dynamic "threshold_rules" {
    for_each = each.value.threshold_percents
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = threshold_rules.value > 1.0 ? "FORECASTED_SPEND" : "CURRENT_SPEND"
    }
  }

  all_updates_rule {
    # coalescelist: if caller supplies notification_channels, use them; otherwise
    # fall back to the breakglass email channel so alerts fire on day 1 even
    # when observability hasn't been applied yet.
    monitoring_notification_channels = coalescelist(
      each.value.notification_channels,
      [google_monitoring_notification_channel.breakglass.id],
    )
    pubsub_topic                   = each.value.pubsub_topic
    schema_version                 = "1.0"
    disable_default_iam_recipients = false
  }
}
