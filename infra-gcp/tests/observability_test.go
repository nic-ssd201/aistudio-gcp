// Terratest plan-only smoke tests for the observability module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestObservabilityPlanMinimal verifies the module plans with only the
// required audit_logs_bucket input and minimal SLO/alert configuration.
func TestObservabilityPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/observability",
		Vars: map[string]interface{}{
			"project_id":        project,
			"environment":       "dev",
			"audit_logs_bucket": fmt.Sprintf("%s-audit-logs", project),
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with minimal observability inputs")
}

// TestObservabilityPlanFull exercises SLOs, alert channels, uptime checks,
// and the FERPA audit bucket with a provided KMS key.
func TestObservabilityPlanFull(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-prod-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/observability",
		Vars: map[string]interface{}{
			"project_id":             project,
			"environment":            "prod",
			"region":                 "us-west1",
			"audit_logs_bucket":      fmt.Sprintf("%s-audit-logs", project),
			"ferpa_audit_kms_key":    fmt.Sprintf("projects/%s/locations/us-west1/keyRings/aistudio-prod/cryptoKeys/audit-logs", project),
			"budget_alert_threshold": 20000,
			"slos": []map[string]interface{}{
				{
					"display_name":    "Web Availability",
					"service_id":      "aistudio-web",
					"goal":            0.999,
					"type":            "availability",
					"calendar_period": "DAY",
				},
			},
			"uptime_urls": []map[string]interface{}{
				{
					"display_name": "AI Studio health",
					"host":         "aistudio.ssd.example",
					"path":         "/api/health",
					"port":         443,
					"use_ssl":      true,
					"validate_ssl": true,
				},
			},
			"alert_channels": []map[string]interface{}{
				{
					"display_name": "PagerDuty",
					"type":         "pagerduty",
					"sensitive_labels": map[string]interface{}{
						"service_key": "placeholder-pd-key",
					},
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with full observability inputs")
}

// TestObservabilityPlanInvalidEnvironment verifies the environment constraint.
func TestObservabilityPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../modules/observability",
		Vars: map[string]interface{}{
			"project_id":        "aistudio-test-project",
			"environment":       "test", // invalid
			"audit_logs_bucket": "aistudio-test-audit-logs",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'test'")
}
