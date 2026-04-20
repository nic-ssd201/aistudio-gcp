output "model_armor_template_names" {
  description = "Map of template ID to full Model Armor template resource name"
  value = {
    for k, v in google_model_armor_template.this : k => v.name
  }
}

output "vertex_api_enabled" {
  description = "Whether Vertex AI API is enabled"
  value       = google_project_service.aiplatform.id != "" ? true : false
}

output "enable_claude_models" {
  description = "Whether Claude model access was requested (requires manual quota steps — see module README)"
  value       = var.enable_claude_models
}
