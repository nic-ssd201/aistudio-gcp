// Terratest plan-only smoke tests for the iam module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestIAMPlanMinimal verifies that the iam module plans with only the required
// inputs and empty collections for all optional maps/lists.
func TestIAMPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/iam",
		Vars: map[string]interface{}{
			"project_id":  fmt.Sprintf("aistudio-dev-%s", uniqueID),
			"environment": "dev",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with minimal iam inputs")
}

// TestIAMPlanWithServiceAccounts exercises the service_accounts map and
// run_invoker_bindings list with valid inputs.
func TestIAMPlanWithServiceAccounts(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/iam",
		Vars: map[string]interface{}{
			"project_id":  project,
			"environment": "dev",
			"region":      "us-west1",
			"service_accounts": map[string]interface{}{
				"web": map[string]interface{}{
					"display_name": "AI Studio Web SA",
					"description":  "Service account for Cloud Run web service",
					"roles": []string{
						"roles/secretmanager.secretAccessor",
						"roles/aiplatform.user",
					},
				},
				"jobs": map[string]interface{}{
					"display_name": "AI Studio Jobs SA",
					"description":  "Service account for Cloud Run jobs",
					"roles": []string{
						"roles/storage.objectAdmin",
					},
				},
			},
			"run_invoker_bindings": []map[string]interface{}{
				{
					"target_kind": "job",
					"target_name": "db-migrate",
					"location":    "us-west1",
					"project_id":  project,
					"invoker_sa":  fmt.Sprintf("serviceAccount:scheduler@%s.iam.gserviceaccount.com", project),
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with service accounts and invoker bindings")
}

// TestIAMPlanInvalidInvokerTargetKind verifies the run_invoker_bindings
// validation block rejects target_kind values outside "service" | "job".
func TestIAMPlanInvalidInvokerTargetKind(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/iam",
		Vars: map[string]interface{}{
			"project_id":  project,
			"environment": "dev",
			"run_invoker_bindings": []map[string]interface{}{
				{
					"target_kind": "function", // invalid — must be service or job
					"target_name": "my-func",
					"location":    "us-west1",
					"project_id":  project,
					"invoker_sa":  fmt.Sprintf("serviceAccount:sched@%s.iam.gserviceaccount.com", project),
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject target_kind 'function'")
}

// TestIAMPlanInvalidEnvironment verifies the environment constraint.
func TestIAMPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../modules/iam",
		Vars: map[string]interface{}{
			"project_id":  "aistudio-test-project",
			"environment": "test", // invalid
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment value 'test'")
}
