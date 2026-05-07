// Terratest plan-only smoke tests for the bootstrap module.
//
// These tests call InitAndPlanE (-refresh=false) rather than apply so they can
// run without real GCP credentials or an active project. Plan validation catches
// variable constraint violations, type errors, and missing required inputs before
// any API call is made.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestBootstrapPlanMinimal verifies that the bootstrap module produces a clean
// plan with the minimum required inputs.
func TestBootstrapPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/bootstrap",
		Vars: map[string]interface{}{
			"host_project_id":   fmt.Sprintf("aistudio-shared-%s", uniqueID),
			"org_id":            "123456789012",
			"billing_account":   "ABCDEF-123456-789012",
			"state_bucket_name": fmt.Sprintf("aistudio-tfstate-%s", uniqueID),
			"github_repo":       "psd401/aistudio",
			"breakglass_email":  "it-breakglass@example.org",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "terraform plan should succeed for minimal bootstrap inputs")
}

// TestBootstrapPlanWithBudgets verifies that the optional budgets map is
// accepted by the variable validation block (thresholds must be > 0 and <= 2.0).
func TestBootstrapPlanWithBudgets(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/bootstrap",
		Vars: map[string]interface{}{
			"host_project_id":   fmt.Sprintf("aistudio-shared-%s", uniqueID),
			"org_id":            "123456789012",
			"billing_account":   "ABCDEF-123456-789012",
			"state_bucket_name": fmt.Sprintf("aistudio-tfstate-%s", uniqueID),
			"github_repo":       "psd401/aistudio",
			"breakglass_email":  "it-breakglass@example.org",
			"budgets": map[string]interface{}{
				"Dev Environment": map[string]interface{}{
					"amount_usd":            5000,
					"threshold_percents":    []float64{0.5, 0.8, 1.0},
					"notification_channels": []string{},
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with valid budget thresholds")
}

// TestBootstrapPlanInvalidEmail verifies that the breakglass_email validation
// rejects a malformed address at plan time.
func TestBootstrapPlanInvalidEmail(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/bootstrap",
		Vars: map[string]interface{}{
			"host_project_id":   fmt.Sprintf("aistudio-shared-%s", uniqueID),
			"org_id":            "123456789012",
			"billing_account":   "ABCDEF-123456-789012",
			"state_bucket_name": fmt.Sprintf("aistudio-tfstate-%s", uniqueID),
			"github_repo":       "psd401/aistudio",
			"breakglass_email":  "not-an-email",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should fail when breakglass_email is not a valid address")
}

// TestBootstrapPlanInvalidBudgetThreshold verifies the budgets validation
// block rejects thresholds outside the allowed range (> 0 and <= 2.0).
func TestBootstrapPlanInvalidBudgetThreshold(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/bootstrap",
		Vars: map[string]interface{}{
			"host_project_id":   fmt.Sprintf("aistudio-shared-%s", uniqueID),
			"org_id":            "123456789012",
			"billing_account":   "ABCDEF-123456-789012",
			"state_bucket_name": fmt.Sprintf("aistudio-tfstate-%s", uniqueID),
			"github_repo":       "psd401/aistudio",
			"breakglass_email":  "it-breakglass@example.org",
			"budgets": map[string]interface{}{
				"Bad Budget": map[string]interface{}{
					"amount_usd":         1000,
					"threshold_percents": []float64{0.5, 3.0}, // 3.0 exceeds max 2.0
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should fail when budget threshold exceeds 2.0")
}
