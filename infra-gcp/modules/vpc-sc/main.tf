##############################################################################
# vpc-sc/main.tf
# Creates: VPC Service Controls perimeter around AI Studio project(s).
# Spec ref: terraform-arch.md §3.3
#
# ⚠️  DRY-RUN FIRST — CRITICAL OPERATING PROCEDURE ⚠️
# This module defaults to dry-run mode (var.enforce_mode = false).
# In dry-run mode, violations are LOGGED but NOT BLOCKED.
# DO NOT promote to enforce_mode = true until:
#   1. Dry-run has been running for at least 7 days with zero unexpected
#      violations in the vpc_sc_violations log-based metric.
#   2. All ingress rules for Console, GitHub Actions WIF, and Workspace IdP
#      have been verified to produce zero violations.
#   3. Nic has explicitly approved promotion.
#
# The access policy is created out-of-band at org level.
# Pass its name via var.access_policy_name.
##############################################################################

locals {
  module_labels = merge(
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "vpc-sc"
    },
    var.labels
  )

  # Project number references for the perimeter resource list.
  # Format required by VPC-SC: "projects/<number>"
  project_resources = [
    for n in var.project_numbers : "projects/${n}"
  ]

  # Default restricted services from spec §3.3 merged with caller-supplied list.
  effective_restricted_services = length(var.restricted_services) > 0 ? var.restricted_services : [
    "aiplatform.googleapis.com",
    "alloydb.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
  ]
}

###############################################################################
# 1. Service perimeter
#    Uses use_explicit_dry_run_spec = true so spec + status can differ:
#    - spec = desired config (always present)
#    - status = enforced config (only populated when enforce_mode = true)
#
# FERPA-REVIEW: The perimeter wraps all project_numbers. If multiple projects
# are included (e.g., aistudio-prod + aistudio-shared), confirm that cross-
# project service calls (e.g., Cloud Run → Secret Manager in shared project)
# are covered by ingress rules, not silently broken.
###############################################################################
resource "google_access_context_manager_service_perimeter" "this" {
  parent = "accessPolicies/${var.access_policy_name}"
  name   = "accessPolicies/${var.access_policy_name}/servicePerimeters/${var.perimeter_name}"
  title  = "AI Studio ${title(var.environment)} Perimeter"

  perimeter_type = "PERIMETER_TYPE_REGULAR"

  # Always populate spec (dry-run config).
  use_explicit_dry_run_spec = true

  spec {
    resources           = local.project_resources
    restricted_services = local.effective_restricted_services

    # Ingress rules — who can call into the perimeter.
    dynamic "ingress_policies" {
      for_each = local.default_ingress_rules
      content {
        ingress_from {
          identity_type = lookup(ingress_policies.value, "identity_type", "ANY_IDENTITY")
          identities    = try(ingress_policies.value.identities, [])
          sources {
            # Allow from all sources by default; narrow in var.ingress_rules.
            access_level = lookup(ingress_policies.value, "access_level", "*")
          }
        }
        ingress_to {
          resources = ["*"]
          dynamic "operations" {
            for_each = lookup(ingress_policies.value, "services", local.effective_restricted_services)
            content {
              service_name = operations.value
              method_selectors { method = "*" }
            }
          }
        }
      }
    }

    # Caller-supplied ingress rules (appended).
    dynamic "ingress_policies" {
      for_each = var.ingress_rules
      content {
        ingress_from {
          identity_type = lookup(ingress_policies.value, "identity_type", "ANY_IDENTITY")
          identities    = try(ingress_policies.value.identities, [])
          sources {
            access_level = lookup(ingress_policies.value, "access_level", "*")
          }
        }
        ingress_to {
          resources = ["*"]
          dynamic "operations" {
            for_each = lookup(ingress_policies.value, "services", local.effective_restricted_services)
            content {
              service_name = operations.value
              method_selectors { method = "*" }
            }
          }
        }
      }
    }

    # Egress rules — allow to identitytoolkit (user auth flow).
    egress_policies {
      egress_from {
        identity_type = "ANY_IDENTITY"
      }
      egress_to {
        resources = ["*"]
        operations {
          service_name = "identitytoolkit.googleapis.com"
          method_selectors { method = "*" }
        }
      }
    }

    # Caller-supplied egress rules (appended).
    dynamic "egress_policies" {
      for_each = var.egress_rules
      content {
        egress_from {
          identity_type = lookup(egress_policies.value, "identity_type", "ANY_IDENTITY")
          identities    = try(egress_policies.value.identities, [])
        }
        egress_to {
          resources = ["*"]
          dynamic "operations" {
            for_each = lookup(egress_policies.value, "services", [])
            content {
              service_name = operations.value
              method_selectors { method = "*" }
            }
          }
        }
      }
    }
  }

  # status = enforced config.
  # Populated only when enforce_mode = true.
  # FERPA-REVIEW: In enforce mode, any missing ingress rule causes real access
  # denials. Promote only after 7 days clean dry-run per spec §3.3.
  dynamic "status" {
    for_each = var.enforce_mode ? [1] : []
    content {
      resources           = local.project_resources
      restricted_services = local.effective_restricted_services

      # Mirror ingress/egress from spec block.
      dynamic "ingress_policies" {
        for_each = local.default_ingress_rules
        content {
          ingress_from {
            identity_type = lookup(ingress_policies.value, "identity_type", "ANY_IDENTITY")
            identities    = try(ingress_policies.value.identities, [])
            sources {
              access_level = lookup(ingress_policies.value, "access_level", "*")
            }
          }
          ingress_to {
            resources = ["*"]
            dynamic "operations" {
              for_each = lookup(ingress_policies.value, "services", local.effective_restricted_services)
              content {
                service_name = operations.value
                method_selectors { method = "*" }
              }
            }
          }
        }
      }

      dynamic "ingress_policies" {
        for_each = var.ingress_rules
        content {
          ingress_from {
            identity_type = lookup(ingress_policies.value, "identity_type", "ANY_IDENTITY")
            identities    = try(ingress_policies.value.identities, [])
            sources {
              access_level = lookup(ingress_policies.value, "access_level", "*")
            }
          }
          ingress_to {
            resources = ["*"]
            dynamic "operations" {
              for_each = lookup(ingress_policies.value, "services", local.effective_restricted_services)
              content {
                service_name = operations.value
                method_selectors { method = "*" }
              }
            }
          }
        }
      }

      egress_policies {
        egress_from {
          identity_type = "ANY_IDENTITY"
        }
        egress_to {
          resources = ["*"]
          operations {
            service_name = "identitytoolkit.googleapis.com"
            method_selectors { method = "*" }
          }
        }
      }

      dynamic "egress_policies" {
        for_each = var.egress_rules
        content {
          egress_from {
            identity_type = lookup(egress_policies.value, "identity_type", "ANY_IDENTITY")
            identities    = try(egress_policies.value.identities, [])
          }
          egress_to {
            resources = ["*"]
            dynamic "operations" {
              for_each = lookup(egress_policies.value, "services", [])
              content {
                service_name = operations.value
                method_selectors { method = "*" }
              }
            }
          }
        }
      }
    }
  }
}

###############################################################################
# 2. Default ingress rules (built-in, not caller-supplied)
#    - Google Cloud Console access for Nic
#    - Workspace IdP token flows
#    - GitHub Actions WIF calls
#
# FERPA-REVIEW: These are permissive by default (ANY_IDENTITY from access level "*").
# For production enforcement, replace with explicit principal lists:
#   - Nic's Workspace identity for Console access
#   - GitHub Actions WIF SA email
#   - Workspace IdP service principal
# Leaving as ANY_IDENTITY with a broad access level for dry-run phase to avoid
# bootstrapping lockouts. Tighten before enforce_mode = true.
###############################################################################
locals {
  default_ingress_rules = [
    {
      # Google Cloud Console and gcloud CLI access.
      identity_type = "ANY_IDENTITY"
      access_level  = "*"
      services      = local.effective_restricted_services
    },
    {
      # Workspace IdP token flows (identitytoolkit calls from within the perimeter).
      identity_type = "ANY_IDENTITY"
      access_level  = "*"
      services      = ["identitytoolkit.googleapis.com"]
    },
  ]
}
