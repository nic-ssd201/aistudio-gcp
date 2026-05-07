// Terratest plan-only smoke tests for the dlp module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestDLPPlanMinimal verifies the module plans with only the required inputs
// and an empty job_triggers list — the module creates its own findings topic.
func TestDLPPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/dlp",
		Vars: map[string]interface{}{
			"project_id":            project,
			"environment":           "dev",
			"create_findings_topic": true,
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with minimal dlp inputs")
}

// TestDLPPlanWithTriggers verifies the job_triggers list with multiple GCS
// buckets is accepted.
func TestDLPPlanWithTriggers(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-prod-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/dlp",
		Vars: map[string]interface{}{
			"project_id":  project,
			"environment": "prod",
			"job_triggers": []map[string]interface{}{
				{"bucket": fmt.Sprintf("%s-attachments", project)},
				{"bucket": fmt.Sprintf("%s-repository-documents", project)},
			},
			"create_findings_topic": true,
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with job triggers for two buckets")
}

// TestDLPPlanExternalTopic verifies that create_findings_topic=false with an
// explicit findings_pubsub_topic is accepted.
func TestDLPPlanExternalTopic(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/dlp",
		Vars: map[string]interface{}{
			"project_id":            project,
			"environment":           "dev",
			"create_findings_topic": false,
			"findings_pubsub_topic": fmt.Sprintf("projects/%s/topics/ferpa-dlp-findings", project),
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed when topic is externally managed")
}

// TestDLPPlanInvalidEnvironment verifies the environment constraint.
func TestDLPPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../modules/dlp",
		Vars: map[string]interface{}{
			"project_id":  "aistudio-test-project",
			"environment": "trial", // invalid
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'trial'")
}
