##############################################################################
# lb/main.tf
# Global External HTTPS Application Load Balancer fronting Cloud Run.
#
# Resources created
# -----------------
# 1. google_compute_global_address           — static public IP
# 2. google_certificate_manager_certificate  — Google-managed TLS cert
# 3. google_certificate_manager_certificate_map + entry — binds cert to LB
# 4. google_compute_region_network_endpoint_group (Serverless NEG) — target
# 5. google_compute_backend_service          — CDN + Cloud Armor attachment
# 6. google_compute_security_policy          — Cloud Armor (OWASP + rate limit)
# 7. google_compute_url_map                  — routes /* to backend
# 8. google_compute_target_https_proxy       — terminates TLS
# 9. google_compute_global_forwarding_rule   — :443 → proxy
# 10. google_compute_url_map (redirect)      — http → https
# 11. google_compute_target_http_proxy       — for :80 redirect
# 12. google_compute_global_forwarding_rule  — :80 → redirect proxy
#
# Design notes
# ------------
# * Serverless NEG: the correct backend type for Cloud Run; a regular instance
#   group backend cannot address Cloud Run services. The NEG lives in a region,
#   the backend service is global — this is the standard pattern.
# * Certificate Manager (not compute ssl certificates): the newer API supports
#   multi-SAN managed certs and certificate maps, which the global HTTPS proxy
#   requires for modern cert management. Legacy compute ssl_certificate resources
#   are sunset.
# * Cloud Armor OWASP rules: Google's preconfigured WAF rule sets are referenced
#   by their well-known names. The "owasp-crs-v033-stable" set covers the
#   OWASP Core Rule Set; additional targeted rules cover XSS, sqli, rce, etc.
# * Rate limit: 1000 rpm/IP default. K-12 staff never legitimately exceeds this
#   from a single IP; any traffic above that is bot/scanner activity.
# * Geo restriction: optional. If var.geo_restriction_countries is non-empty,
#   a DENY rule is added for those countries at priority 500 (before rate limit).
# * CDN: enabled by default. Cloud Run already handles dynamic SSR; CDN is most
#   useful for Next.js static assets (/_next/static/*). Cache mode is
#   USE_ORIGIN_HEADERS so Next.js cache-control headers are respected.
##############################################################################

locals {
  name_prefix = "aistudio-${var.environment}"

  # Resolve the effective domains list: prefer var.domains; fall back to
  # var.certificate_domain for callers still using the scaffold variable.
  effective_domains = length(var.domains) > 0 ? var.domains : (
    var.certificate_domain != "" ? [var.certificate_domain] : []
  )

  labels = merge(
    var.labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "lb"
    }
  )
}

# ---------------------------------------------------------------------------
# 1. Static global IP
# ---------------------------------------------------------------------------

resource "google_compute_global_address" "lb" {
  project      = var.project_id
  name         = "${local.name_prefix}-lb-ip"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
  labels       = local.labels
}

# ---------------------------------------------------------------------------
# 2–3. Managed TLS certificate (Certificate Manager)
# ---------------------------------------------------------------------------

resource "google_certificate_manager_certificate" "lb" {
  project     = var.project_id
  name        = "${local.name_prefix}-cert"
  description = "Google-managed TLS cert for AI Studio ${var.environment}"
  labels      = local.labels

  managed {
    domains = local.effective_domains
  }
}

resource "google_certificate_manager_certificate_map" "lb" {
  project     = var.project_id
  name        = "${local.name_prefix}-cert-map"
  description = "Certificate map for ${var.environment} LB"
  labels      = local.labels
}

resource "google_certificate_manager_certificate_map_entry" "lb" {
  project      = var.project_id
  name         = "${local.name_prefix}-cert-entry"
  map          = google_certificate_manager_certificate_map.lb.name
  certificates = [google_certificate_manager_certificate.lb.id]
  # PRIMARY entry matches all hostnames not covered by a more specific entry.
  matcher = "PRIMARY"
}

# ---------------------------------------------------------------------------
# 4. Serverless NEG — wraps the Cloud Run service as an LB backend
# ---------------------------------------------------------------------------

resource "google_compute_region_network_endpoint_group" "cloud_run" {
  provider              = google-beta
  project               = var.project_id
  name                  = "${local.name_prefix}-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.cloud_run_region

  cloud_run {
    service = var.cloud_run_service_name
  }
}

# ---------------------------------------------------------------------------
# 6. Cloud Armor security policy (created before backend service references it)
# ---------------------------------------------------------------------------

resource "google_compute_security_policy" "armor" {
  project     = var.project_id
  name        = "${local.name_prefix}-armor"
  description = "OWASP managed rules + rate limit for AI Studio ${var.environment}"
  # labels is not a supported argument on google_compute_security_policy (provider ~> 6.0).

  # ---- OWASP Core Rule Set (CRS) — highest priority block ----------------
  # Covers SQL injection, XSS, remote code execution, local file inclusion,
  # scanner detection, protocol attacks. Rule priority 1000–1099 reserved.

  rule {
    action   = "deny(403)"
    priority = 1000
    match {
      expr {
        # Preconfigured WAF rule: SQL injection (OWASP CRS Level 1)
        expression = "evaluatePreconfiguredExpr('sqli-v33-stable')"
      }
    }
    description = "Block SQL injection (OWASP CRS sqli)"
  }

  rule {
    action   = "deny(403)"
    priority = 1001
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('xss-v33-stable')"
      }
    }
    description = "Block XSS (OWASP CRS xss)"
  }

  rule {
    action   = "deny(403)"
    priority = 1002
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('lfi-v33-stable')"
      }
    }
    description = "Block local file inclusion (OWASP CRS lfi)"
  }

  rule {
    action   = "deny(403)"
    priority = 1003
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('rce-v33-stable')"
      }
    }
    description = "Block remote code execution (OWASP CRS rce)"
  }

  rule {
    action   = "deny(403)"
    priority = 1004
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('scannerdetection-v33-stable')"
      }
    }
    description = "Block scanner detection (OWASP CRS scannerdetection)"
  }

  # ---- Geo restriction (optional, priority 500) -------------------------
  # Applied before rate-limit so blocked countries don't consume rate-limit
  # tokens. Only created when var.geo_restriction_countries is non-empty.

  dynamic "rule" {
    for_each = length(var.geo_restriction_countries) > 0 ? [1] : []
    content {
      action   = "deny(403)"
      priority = 500
      match {
        expr {
          expression = "origin.region_code.matches('${join("|", var.geo_restriction_countries)}')"
        }
      }
      description = "Geo-restriction: block traffic from specified countries"
    }
  }

  # ---- Rate limit (priority 2000) ----------------------------------------
  # 1000 rpm/IP default — well above legitimate single-user traffic at SSD.
  # Throttle (not hard-deny) so legitimate bursty users get 429 and retry.

  rule {
    action   = "throttle"
    priority = 2000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      rate_limit_threshold {
        count        = var.rate_limit_rpm
        interval_sec = 60
      }
      enforce_on_key = "IP"
    }
    description = "Rate limit: ${var.rate_limit_rpm} rpm/IP"
  }

  # ---- Default allow rule (lowest priority) ------------------------------

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default: allow all traffic not matched by higher-priority rules"
  }
}

# ---------------------------------------------------------------------------
# 5. Backend service — attaches NEG, CDN, Armor
# ---------------------------------------------------------------------------

resource "google_compute_backend_service" "web" {
  project               = var.project_id
  name                  = "${local.name_prefix}-backend"
  protocol              = "HTTPS"
  port_name             = "http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  timeout_sec           = 30
  security_policy       = google_compute_security_policy.armor.id

  backend {
    group = google_compute_region_network_endpoint_group.cloud_run.id
  }

  # Cloud CDN — only useful for static assets; Next.js sets long cache-control
  # headers on /_next/static/* so CDN hit rates should be high in practice.
  dynamic "cdn_policy" {
    for_each = var.enable_cdn ? [1] : []
    content {
      cache_mode                   = "USE_ORIGIN_HEADERS"
      signed_url_cache_max_age_sec = 3600

      cache_key_policy {
        include_host         = true
        include_protocol     = true
        include_query_string = true
      }
    }
  }

  enable_cdn = var.enable_cdn

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# ---------------------------------------------------------------------------
# 7. URL map — routes all traffic to the backend
# ---------------------------------------------------------------------------

resource "google_compute_url_map" "https" {
  project         = var.project_id
  name            = "${local.name_prefix}-urlmap"
  default_service = google_compute_backend_service.web.id
}

# ---------------------------------------------------------------------------
# 8. HTTPS target proxy (references certificate map)
# ---------------------------------------------------------------------------

resource "google_compute_target_https_proxy" "web" {
  project         = var.project_id
  name            = "${local.name_prefix}-https-proxy"
  url_map         = google_compute_url_map.https.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.lb.id}"
}

# ---------------------------------------------------------------------------
# 9. Forwarding rule — :443 → HTTPS proxy
# ---------------------------------------------------------------------------

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "${local.name_prefix}-https"
  target                = google_compute_target_https_proxy.web.id
  port_range            = "443"
  ip_address            = google_compute_global_address.lb.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  labels                = local.labels
}

# ---------------------------------------------------------------------------
# 10–12. HTTP → HTTPS redirect
# ---------------------------------------------------------------------------

resource "google_compute_url_map" "http_redirect" {
  project = var.project_id
  name    = "${local.name_prefix}-http-redirect"

  default_url_redirect {
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    https_redirect         = true
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.project_id
  name    = "${local.name_prefix}-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "http_redirect" {
  project               = var.project_id
  name                  = "${local.name_prefix}-http"
  target                = google_compute_target_http_proxy.redirect.id
  port_range            = "80"
  ip_address            = google_compute_global_address.lb.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  labels                = local.labels
}
