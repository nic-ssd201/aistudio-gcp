// Terratest plan-only smoke tests for the vpc-sc module.
//
// VPC Service Controls inputs are org-level, not project-level: the module
// takes access_policy_name (numeric org policy ID) and project_numbers (not
// project IDs). Placeholder strings satisfy the type constraints without
// needing real GCP credentials.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestVPCSCPlanDryRun verifies the module plans with enforce_mode=false
// (dry-run perimeter) and the default restricted services.
func TestVPCSCPlanDryRun(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/vpc-sc",
		Vars: map[string]interface{}{
			"access_policy_name": "1234567890",
			"perimeter_name":     fmt.Sprintf("aistudio_dev_%s", uniqueID),
			"environment":        "dev",
			"project_numbers":    []string{"111111111111"},
			"enforce_mode":       false,
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed for dry-run VPC-SC perimeter")
}

// TestVPCSCPlanProdEnforced verifies the module plans with enforce_mode=true
// and additional ingress/egress rules.
func TestVPCSCPlanProdEnforced(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/vpc-sc",
		Vars: map[string]interface{}{
			"access_policy_name": "9876543210",
			"perimeter_name":     fmt.Sprintf("aistudio_prod_%s", uniqueID),
			"environment":        "prod",
			"project_numbers":    []string{"222222222222", "333333333333"},
			"enforce_mode":       true,
			"restricted_services": []string{
				"aiplatform.googleapis.com",
				"alloydb.googleapis.com",
				"secretmanager.googleapis.com",
				"storage.googleapis.com",
				"artifactregistry.googleapis.com",
			},
			"ingress_rules": []map[string]interface{}{
				{
					"identity_type": "ANY_SERVICE_ACCOUNT",
					"identities":    []string{"serviceAccount:terraform@example-project.iam.gserviceaccount.com"},
					"access_level":  "*",
					"services":      []string{"storage.googleapis.com"},
				},
			},
			"egress_rules": []map[string]interface{}{
				{
					"identity_type": "ANY_IDENTITY",
					"services":      []string{"identitytoolkit.googleapis.com"},
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with enforced prod VPC-SC perimeter")
}

// TestVPCSCPlanInvalidEnvironment verifies the environment constraint.
func TestVPCSCPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../modules/vpc-sc",
		Vars: map[string]interface{}{
			"access_policy_name": "1234567890",
			"perimeter_name":     "aistudio_test_perimeter",
			"environment":        "test", // invalid
			"project_numbers":    []string{"111111111111"},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'test'")
}
