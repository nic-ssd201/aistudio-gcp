output "load_balancer_ip" {
  description = "Global external static IP — point DNS A record here after first apply"
  value       = module.lb.load_balancer_ip
}

output "web_service_url" {
  description = "Cloud Run service URL (direct; production traffic goes via LB)"
  value       = module.cloud_run_web.service_url
}

output "alloydb_cluster_name" {
  description = "AlloyDB cluster resource URI (for use in monitoring alert filters)"
  value       = module.alloydb.cluster_uri
}

output "vpc_connector_name" {
  description = "Serverless VPC Connector resource name (reference when adding new Cloud Run services)"
  value       = module.network.serverless_connector_name
}

output "artifact_registry_repo" {
  description = "Artifact Registry Docker repo URI (from bootstrap remote state)"
  value       = data.terraform_remote_state.bootstrap.outputs.artifact_registry_repository
}
