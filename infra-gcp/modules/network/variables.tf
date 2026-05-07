variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev|staging|prod)"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "region" {
  type        = string
  description = "Primary GCP region"
  default     = "us-west1"
}

variable "vpc_name" {
  type        = string
  description = "VPC display name and resource prefix"
  default     = "aistudio-vpc"
}

variable "subnet_cidrs" {
  type        = map(string)
  description = "CIDR ranges for subnets; required keys: web, jobs, private-services"
  default = {
    web              = "10.0.1.0/24"
    jobs             = "10.0.2.0/24"
    private-services = "10.0.3.0/24"
  }
}

variable "enable_flow_logs" {
  type        = bool
  description = "Enable VPC Flow Logs on all subnets"
  default     = true
}

variable "enable_firewall_logs" {
  type        = bool
  description = "Enable firewall rule logging"
  default     = true
}

variable "enable_iap_ssh" {
  type        = bool
  description = "Create a firewall rule allowing IAP SSH ingress"
  default     = false
}

variable "firewall_deny_all_egress" {
  type        = bool
  description = "Add a deny-all-egress baseline firewall rule. Default true in prod, false in dev for debugging."
  default     = false
}

variable "connector_cidr" {
  type        = string
  description = "CIDR range for the Serverless VPC Access connector (must not overlap subnet_cidrs)"
  default     = "10.8.0.0/28"
}

variable "connector_min_instances" {
  type        = number
  description = "Minimum number of VPC connector instances"
  default     = 2
}

variable "connector_max_instances" {
  type        = number
  description = "Maximum number of VPC connector instances"
  default     = 10
}

variable "connector_machine_type" {
  type        = string
  description = "Machine type for VPC connector instances"
  default     = "e2-micro"
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
