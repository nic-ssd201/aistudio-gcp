// Terratest plan-only smoke tests for the scheduler module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestSchedulerPlanNoJobs verifies the module plans cleanly with an empty
// jobs map (no Cloud Scheduler jobs to create).
func TestSchedulerPlanNoJobs(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/scheduler",
		Vars: map[string]interface{}{
			"project_id":         project,
			"environment":        "dev",
			"scheduler_sa_email": fmt.Sprintf("scheduler-sa@%s.iam.gserviceaccount.com", project),
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with no scheduler jobs")
}

// TestSchedulerPlanWithCloudRunJob exercises the cloud_run_job target_type
// path and a url target_type in the same map.
func TestSchedulerPlanWithCloudRunJob(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/scheduler",
		Vars: map[string]interface{}{
			"project_id":         project,
			"environment":        "dev",
			"region":             "us-west1",
			"scheduler_sa_email": fmt.Sprintf("scheduler-sa@%s.iam.gserviceaccount.com", project),
			"jobs": map[string]interface{}{
				"db-migrate-nightly": map[string]interface{}{
					"schedule":    "0 2 * * *",
					"time_zone":   "America/Los_Angeles",
					"target_type": "cloud_run_job",
					"job_name":    "db-migrate",
				},
				"health-ping": map[string]interface{}{
					"schedule":    "*/5 * * * *",
					"target_type": "url",
					"url":         "https://aistudio-dev.ssd.example/api/health",
					"http_method": "GET",
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with mixed scheduler job types")
}

// TestSchedulerPlanInvalidEnvironment verifies the environment constraint.
func TestSchedulerPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/scheduler",
		Vars: map[string]interface{}{
			"project_id":         project,
			"environment":        "nightly", // invalid
			"scheduler_sa_email": fmt.Sprintf("scheduler-sa@%s.iam.gserviceaccount.com", project),
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'nightly'")
}
