output "vpc_self_link" {
  description = "VPC self-link"
  value       = google_compute_network.vpc.self_link
}

output "vpc_id" {
  description = "VPC resource ID"
  value       = google_compute_network.vpc.id
}

output "web_subnet_id" {
  description = "Web tier subnet ID"
  value       = google_compute_subnetwork.subnets["web"].id
}

output "jobs_subnet_id" {
  description = "Jobs tier subnet ID"
  value       = google_compute_subnetwork.subnets["jobs"].id
}

output "private_services_subnet_id" {
  description = "Private Services Access subnet ID (for AlloyDB)"
  value       = google_compute_subnetwork.subnets["private-services"].id
}

output "subnet_ids" {
  description = "Map of subnet key to subnet ID (all three subnets)"
  value       = { for k, v in google_compute_subnetwork.subnets : k => v.id }
}

output "serverless_connector_name" {
  description = "Serverless VPC Connector resource name (for Cloud Run vpc_access)"
  value       = google_vpc_access_connector.connector.id
}

output "psa_range" {
  description = "Private Services Access IP range name (for AlloyDB reserved_range_name)"
  value       = google_compute_global_address.psa_range.name
}

output "cloud_router_id" {
  description = "Cloud Router resource ID"
  value       = google_compute_router.nat.id
}

output "cloud_nat_id" {
  description = "Cloud NAT resource ID"
  value       = google_compute_router_nat.nat.id
}
