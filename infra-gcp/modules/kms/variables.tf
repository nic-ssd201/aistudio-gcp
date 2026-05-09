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

variable "keyring_name" {
  type        = string
  description = "KMS keyring name (default: aistudio-{env})"
  default     = ""
}

variable "keys" {
  type = map(object({
    rotation_period = optional(string, "7776000s") # 90 days
    purpose         = string
  }))
  description = "KMS keys to create (name -> spec with rotation_period and purpose)"
  default = {
    alloydb    = { purpose = "AlloyDB CMEK" }
    storage    = { purpose = "Cloud Storage CMEK" }
    secrets    = { purpose = "Secret Manager CMEK" }
    artifacts  = { purpose = "Artifact Registry CMEK" }
    audit-logs = { purpose = "Audit log bucket CMEK" }
  }
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}

variable "signing_keys" {
  type = map(object({
    algorithm = optional(string, "RSA_SIGN_PKCS1_2048_SHA256")
    purpose   = string
  }))
  description = "ASYMMETRIC_SIGN keys (separate from CMEK keys above — different purpose, algorithm, and rotation semantics). NOTE: Cloud KMS does NOT support automatic rotation for asymmetric keys (https://cloud.google.com/kms/docs/key-rotation) — new versions must be created manually via gcloud or the API. IAM bindings are intentionally out-of-module: callers wire roles/cloudkms.signerVerifier in their own env file using google_kms_crypto_key_iam_member, so cross-module ordering with service-account modules is explicit."
  default     = {}

  # Catch typos at `terraform plan` instead of `apply`. Restricted to the
  # PKCS#1 v1.5 RSA-SHA256 algorithms — KmsJwtService hardcodes JWT `alg: "RS256"`
  # in both the header and the JWK, which per RFC 7518 §3.3 is PKCS#1 v1.5 only.
  # PSS variants would map to `alg: "PS256"` (RFC 7518 §3.5) and would need a
  # separate code path; rejecting them here prevents the silent footgun where
  # KMS produces a PSS signature but the header advertises RS256.
  validation {
    condition = alltrue([
      for k, v in var.signing_keys : contains(
        [
          "RSA_SIGN_PKCS1_2048_SHA256",
          "RSA_SIGN_PKCS1_3072_SHA256",
          "RSA_SIGN_PKCS1_4096_SHA256",
        ],
        v.algorithm,
      )
    ])
    error_message = "signing_keys[*].algorithm must be one of the PKCS#1 v1.5 RSA-SHA256 KMS algorithms (RSA_SIGN_PKCS1_2048_SHA256, RSA_SIGN_PKCS1_3072_SHA256, RSA_SIGN_PKCS1_4096_SHA256). PSS variants (PS256) and other algorithms are not supported by KmsJwtService."
  }
}
