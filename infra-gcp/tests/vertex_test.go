// Terratest plan-only smoke tests for the vertex module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestVertexPlanMinimal verifies the module plans with only the required
// project/env inputs and default model armor templates.
func TestVertexPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/vertex",
		Vars: map[string]interface{}{
			"project_id":  project,
			"environment": "dev",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with minimal vertex inputs")
}

// TestVertexPlanWithClaudeAndSA exercises the optional inputs:
// enable_claude_models=true and cloud_run_sa_email set.
func TestVertexPlanWithClaudeAndSA(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-prod-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/vertex",
		Vars: map[string]interface{}{
			"project_id":           project,
			"environment":          "prod",
			"region":               "us-west1",
			"enable_claude_models": true,
			"cloud_run_sa_email":   fmt.Sprintf("web-sa@%s.iam.gserviceaccount.com", project),
			"model_armor_templates": map[string]interface{}{
				"aistudio-default": map[string]interface{}{},
				"aistudio-strict":  map[string]interface{}{},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with Claude models and SA email set")
}

// TestVertexPlanNoTemplates verifies that an empty model_armor_templates map
// is accepted (no model armor resources created).
func TestVertexPlanNoTemplates(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/vertex",
		Vars: map[string]interface{}{
			"project_id":            project,
			"environment":           "dev",
			"model_armor_templates": map[string]interface{}{},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with empty model_armor_templates")
}

// TestVertexPlanInvalidEnvironment verifies the environment constraint.
func TestVertexPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../modules/vertex",
		Vars: map[string]interface{}{
			"project_id":  "aistudio-test-project",
			"environment": "canary", // invalid
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'canary'")
}
