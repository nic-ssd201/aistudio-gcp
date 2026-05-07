// Terratest plan-only smoke tests for the storage module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestStoragePlanDefaults verifies the storage module plans with only the
// required kms_key and project metadata, using the default buckets map.
func TestStoragePlanDefaults(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/storage",
		Vars: map[string]interface{}{
			"project_id":  project,
			"environment": "dev",
			"kms_key":     fmt.Sprintf("projects/%s/locations/us-west1/keyRings/aistudio-dev/cryptoKeys/storage", project),
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed using the default buckets map")
}

// TestStoragePlanCustomBuckets verifies that an explicit buckets map with
// lifecycle rules and retention settings is accepted.
func TestStoragePlanCustomBuckets(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-prod-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/storage",
		Vars: map[string]interface{}{
			"project_id":  project,
			"environment": "prod",
			"kms_key":     fmt.Sprintf("projects/%s/locations/us-west1/keyRings/aistudio-prod/cryptoKeys/storage", project),
			"buckets": map[string]interface{}{
				"attachments": map[string]interface{}{
					"name_suffix": "attachments",
					"location":    "us-west1",
					"versioning":  true,
					"lifecycle_rules": []map[string]interface{}{
						{
							"action":             "Delete",
							"age_days":           365,
							"storage_class":      "",
							"num_newer_versions": 0,
						},
					},
				},
				"audit-logs": map[string]interface{}{
					"name_suffix":    "audit-logs",
					"location":       "us-west1",
					"retention_days": 2555, // 7 years for FERPA
					"versioning":     false,
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with custom bucket definitions")
}

// TestStoragePlanInvalidEnvironment verifies the environment constraint is
// enforced at plan time.
func TestStoragePlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/storage",
		Vars: map[string]interface{}{
			"project_id":  project,
			"environment": "sandbox", // invalid
			"kms_key":     fmt.Sprintf("projects/%s/locations/us-west1/keyRings/aistudio-dev/cryptoKeys/storage", project),
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'sandbox'")
}
