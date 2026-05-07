// Terratest plan-only smoke tests for the lb module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestLBPlanMinimal verifies the load-balancer module plans with the minimum
// required inputs: project_id, environment, cloud_run_service_name, and domains.
func TestLBPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/lb",
		Vars: map[string]interface{}{
			"project_id":             project,
			"environment":            "dev",
			"cloud_run_service_name": "aistudio-web",
			"domains":                []string{"aistudio-dev.ssd.example"},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with minimal lb inputs")
}

// TestLBPlanProdWithGeo exercises the production path: geo restriction,
// rate limiting, CDN enabled, and the service URL informational field.
func TestLBPlanProdWithGeo(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-prod-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/lb",
		Vars: map[string]interface{}{
			"project_id":                project,
			"environment":               "prod",
			"region":                    "us-west1",
			"cloud_run_service_name":    "aistudio-web",
			"cloud_run_region":          "us-west1",
			"domains":                   []string{"aistudio.ssd.example"},
			"rate_limit_rpm":            600,
			"geo_restriction_countries": []string{"RU", "CN"},
			"enable_cdn":                true,
			"backend_service_url":       "https://aistudio-web-abc123-uw.a.run.app",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with full prod lb inputs")
}

// TestLBPlanInvalidEnvironment verifies the environment constraint.
func TestLBPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../modules/lb",
		Vars: map[string]interface{}{
			"project_id":             "aistudio-test-project",
			"environment":            "review", // invalid
			"cloud_run_service_name": "aistudio-web",
			"domains":                []string{"aistudio-test.example.com"},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'review'")
}
