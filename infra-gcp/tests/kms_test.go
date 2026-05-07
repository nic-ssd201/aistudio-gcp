// Terratest plan-only smoke tests for the kms module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestKMSPlanMinimal verifies the default key set (alloydb, storage, secrets,
// artifacts, audit-logs) is accepted with the minimum required inputs.
func TestKMSPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/kms",
		Vars: map[string]interface{}{
			"project_id":  fmt.Sprintf("aistudio-dev-%s", uniqueID),
			"environment": "dev",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with minimal kms inputs")
}

// TestKMSPlanCustomKeys verifies that an explicit keys map (overriding the
// defaults) is accepted and plans cleanly.
func TestKMSPlanCustomKeys(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/kms",
		Vars: map[string]interface{}{
			"project_id":  fmt.Sprintf("aistudio-prod-%s", uniqueID),
			"environment": "prod",
			"region":      "us-west1",
			"keys": map[string]interface{}{
				"alloydb": map[string]interface{}{
					"purpose":         "AlloyDB CMEK",
					"rotation_period": "2592000s", // 30 days
				},
				"storage": map[string]interface{}{
					"purpose":         "Cloud Storage CMEK",
					"rotation_period": "7776000s", // 90 days
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with custom keys map")
}

// TestKMSPlanInvalidEnvironment verifies the environment validation block.
func TestKMSPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../modules/kms",
		Vars: map[string]interface{}{
			"project_id":  "aistudio-test-project",
			"environment": "local", // invalid
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment value 'local'")
}
