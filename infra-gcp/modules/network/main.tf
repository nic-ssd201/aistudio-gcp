# network/main.tf
#
# Refactored from Haiku scaffold to close §3.2.1 gap list:
#   1. Single subnet_cidr scalar → for_each over subnet_cidrs map (web/jobs/private-services).
#   2. Added deny-all-egress baseline firewall (enabled via firewall_deny_all_egress var).
#   3. Added GCP health-check allow rule (required for HTTPS LB → Cloud Run path).
#
# Naming convention: all resources use var.vpc_name as prefix, not a derived "name" var,
# to stay consistent with how the env-level composition will call this module.

locals {
  labels = merge(
    var.labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "network"
    },
  )
}

# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = var.vpc_name
  description             = "AI Studio ${var.environment} VPC"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  mtu                     = 1460
}

# ---------------------------------------------------------------------------
# Subnets — one per entry in var.subnet_cidrs
# ---------------------------------------------------------------------------
# Keys must be: web, jobs, private-services
# The for_each key is used in the subnet name so operators can identify
# subnets without looking at CIDR ranges.

resource "google_compute_subnetwork" "subnets" {
  for_each = var.subnet_cidrs

  project                  = var.project_id
  name                     = "${var.vpc_name}-${each.key}-${var.region}"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = each.value
  private_ip_google_access = true

  dynamic "log_config" {
    for_each = var.enable_flow_logs ? [1] : []

    content {
      aggregation_interval = "INTERVAL_5_SEC"
      flow_sampling        = 0.5
      metadata             = "INCLUDE_ALL_METADATA"
    }
  }
}

# ---------------------------------------------------------------------------
# Cloud Router + Cloud NAT
# ---------------------------------------------------------------------------

resource "google_compute_router" "nat" {
  project = var.project_id
  name    = "${var.vpc_name}-nat-router"
  network = google_compute_network.vpc.id
  region  = var.region
}

resource "google_compute_router_nat" "nat" {
  project                            = var.project_id
  name                               = "${var.vpc_name}-nat"
  router                             = google_compute_router.nat.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# ---------------------------------------------------------------------------
# Private Services Access (AlloyDB peering range)
# ---------------------------------------------------------------------------

resource "google_compute_global_address" "psa_range" {
  project       = var.project_id
  name          = "${var.vpc_name}-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  address       = "10.100.0.0"
  prefix_length = 16 # /16 reserved per spec §3.2
  network       = google_compute_network.vpc.id
  description   = "PSA range for ${var.environment} AlloyDB"
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa_range.name]
}

# ---------------------------------------------------------------------------
# Serverless VPC Access connector (Cloud Run → VPC egress)
# ---------------------------------------------------------------------------

resource "google_vpc_access_connector" "connector" {
  project       = var.project_id
  name          = "${var.vpc_name}-connector"
  region        = var.region
  network       = google_compute_network.vpc.name
  ip_cidr_range = var.connector_cidr # must not overlap subnet_cidrs
  min_instances = var.connector_min_instances
  max_instances = var.connector_max_instances
  machine_type  = var.connector_machine_type
}

# ---------------------------------------------------------------------------
# Firewall: allow internal (intra-VPC + connector range)
# ---------------------------------------------------------------------------

resource "google_compute_firewall" "allow_internal" {
  project     = var.project_id
  name        = "${var.vpc_name}-allow-internal"
  network     = google_compute_network.vpc.name
  description = "Allow internal traffic from all subnets and Serverless VPC connector range."
  direction   = "INGRESS"
  priority    = 1000

  # Include all configured subnet CIDRs + connector range.
  source_ranges = concat(values(var.subnet_cidrs), [var.connector_cidr])

  allow { protocol = "tcp" }
  allow { protocol = "udp" }
  allow { protocol = "icmp" }

  dynamic "log_config" {
    for_each = var.enable_firewall_logs ? [1] : []
    content { metadata = "INCLUDE_ALL_METADATA" }
  }
}

# ---------------------------------------------------------------------------
# Firewall: GCP health-check allow (required for HTTPS LB → Cloud Run)
# ---------------------------------------------------------------------------
# Source ranges are the two canonical GCP health-check prober ranges.
# Without this rule, LB health probes are silently dropped and backends
# show as UNHEALTHY even when the service is running.

resource "google_compute_firewall" "allow_health_checks" {
  project     = var.project_id
  name        = "${var.vpc_name}-allow-health-checks"
  network     = google_compute_network.vpc.name
  description = "Allow GCP health-check probers (LB backend health checks)."
  direction   = "INGRESS"
  priority    = 1000

  source_ranges = [
    "35.191.0.0/16",  # GCP health-check probers
    "130.211.0.0/22", # GCP health-check probers (legacy range, still active)
  ]

  allow {
    protocol = "tcp"
    ports    = ["80", "443", "8080", "8443"]
  }

  dynamic "log_config" {
    for_each = var.enable_firewall_logs ? [1] : []
    content { metadata = "INCLUDE_ALL_METADATA" }
  }
}

# ---------------------------------------------------------------------------
# Firewall: deny-all egress (baseline; prod default = true)
# ---------------------------------------------------------------------------
# GCP's implicit egress policy is allow-all. In prod we enforce deny-all-egress
# and rely on explicit allow rules (Cloud NAT + VPC SC) for egress control.
# In dev this is toggled off by default to avoid blocking debugging workflows.
# Priority 65534 ensures existing higher-priority rules (e.g., allow-internal)
# win; this only catches traffic not matched by any other rule.

resource "google_compute_firewall" "deny_all_egress" {
  count = var.firewall_deny_all_egress ? 1 : 0

  project     = var.project_id
  name        = "${var.vpc_name}-deny-all-egress"
  network     = google_compute_network.vpc.name
  description = "Deny-all egress baseline. Explicit allow rules must be added for required egress paths."
  direction   = "EGRESS"
  priority    = 65534 # lowest explicit priority — only catches unmatched traffic

  destination_ranges = ["0.0.0.0/0"]

  deny { protocol = "all" }

  dynamic "log_config" {
    for_each = var.enable_firewall_logs ? [1] : []
    content { metadata = "INCLUDE_ALL_METADATA" }
  }
}

# ---------------------------------------------------------------------------
# Firewall: IAP SSH (optional, useful for debugging prod via IAP bastion)
# ---------------------------------------------------------------------------

resource "google_compute_firewall" "allow_iap_ssh" {
  count = var.enable_iap_ssh ? 1 : 0

  project     = var.project_id
  name        = "${var.vpc_name}-allow-iap-ssh"
  network     = google_compute_network.vpc.name
  description = "Allow IAP ingress to tcp/22 for bastion-less SSH."
  direction   = "INGRESS"
  priority    = 1000

  source_ranges = ["35.235.240.0/20"] # Identity-Aware Proxy ingress range

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  dynamic "log_config" {
    for_each = var.enable_firewall_logs ? [1] : []
    content { metadata = "INCLUDE_ALL_METADATA" }
  }
}
