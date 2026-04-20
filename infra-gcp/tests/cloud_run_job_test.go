// Terratest plan-only smoke tests for the cloud-run-job module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestCloudRunJobPlanMinimal verifies the module plans with only the required
// inputs and defaults for timeout, retries, and parallelism.
func TestCloudRunJobPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/cloud-run-job",
		Vars: map[string]interface{}{
			"project_id":            project,
			"environment":           "dev",
			"job_name":              "db-migrate",
			"service_account_email": fmt.Sprintf("jobs-sa@%s.iam.gserviceaccount.com", project),
			"image":                 fmt.Sprintf("us-west1-docker.pkg.dev/%s/aistudio/jobs:latest", project),
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with minimal cloud-run-job inputs")
}

// TestCloudRunJobPlanFull exercises the full input surface: VPC connector,
// custom timeout, retries, parallelism, secret refs, and env vars.
func TestCloudRunJobPlanFull(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-prod-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/cloud-run-job",
		Vars: map[string]interface{}{
			"project_id":            project,
			"environment":           "prod",
			"region":                "us-west1",
			"job_name":              "db-migrate",
			"service_account_email": fmt.Sprintf("jobs-sa@%s.iam.gserviceaccount.com", project),
			"image":                 fmt.Sprintf("us-west1-docker.pkg.dev/%s/aistudio/jobs:v1.0.0", project),
			"vpc_connector":         fmt.Sprintf("projects/%s/locations/us-west1/connectors/aistudio-connector", project),
			"task_timeout_seconds":  1800,
			"retries":               2,
			"parallelism":           1,
			"cpu":                   "1",
			"memory":                "1Gi",
			"secret_refs": map[string]interface{}{
				"DATABASE_URL": fmt.Sprintf("projects/%s/secrets/database-url/versions/latest", project),
			},
			"env": map[string]interface{}{
				"RUN_MIGRATIONS": "true",
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with full cloud-run-job inputs")
}

// TestCloudRunJobPlanInvalidEnvironment verifies the environment constraint.
func TestCloudRunJobPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/cloud-run-job",
		Vars: map[string]interface{}{
			"project_id":            project,
			"environment":           "ci", // invalid
			"job_name":              "db-migrate",
			"service_account_email": fmt.Sprintf("jobs-sa@%s.iam.gserviceaccount.com", project),
			"image":                 "us-west1-docker.pkg.dev/placeholder/aistudio/jobs:latest",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'ci'")
}
