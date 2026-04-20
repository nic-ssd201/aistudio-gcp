// Terratest plan-only smoke tests for the secrets module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestSecretsPlanEmpty verifies the module plans with an empty secrets map
// (no secrets to create beyond what the module itself provisions).
func TestSecretsPlanEmpty(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/secrets",
		Vars: map[string]interface{}{
			"project_id":  project,
			"environment": "dev",
			"kms_key":     fmt.Sprintf("projects/%s/locations/us-west1/keyRings/aistudio-dev/cryptoKeys/secrets", project),
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with an empty secrets map")
}

// TestSecretsPlanWithSecrets verifies that the secrets map with accessor SA
// emails and rotation periods is accepted.
func TestSecretsPlanWithSecrets(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/secrets",
		Vars: map[string]interface{}{
			"project_id":  project,
			"environment": "dev",
			"region":      "us-west1",
			"kms_key":     fmt.Sprintf("projects/%s/locations/us-west1/keyRings/aistudio-dev/cryptoKeys/secrets", project),
			"secrets": map[string]interface{}{
				"alloydb-postgres-password": map[string]interface{}{
					"description":        "AlloyDB initial postgres user password",
					"rotation_period":    "7776000s",
					"accessor_sa_emails": []string{fmt.Sprintf("web-sa@%s.iam.gserviceaccount.com", project)},
				},
				"openai-api-key": map[string]interface{}{
					"description": "OpenAI API key",
				},
				"nextauth-secret": map[string]interface{}{
					"description": "NextAuth secret for session signing",
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with secrets map")
}

// TestSecretsPlanInvalidEnvironment verifies environment constraint.
func TestSecretsPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/secrets",
		Vars: map[string]interface{}{
			"project_id":  project,
			"environment": "uat", // invalid
			"kms_key":     fmt.Sprintf("projects/%s/locations/us-west1/keyRings/aistudio-dev/cryptoKeys/secrets", project),
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'uat'")
}
