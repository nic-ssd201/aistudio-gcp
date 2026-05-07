// Terratest plan-only smoke tests for the cloud-run-web module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestCloudRunWebPlanMinimal verifies the module accepts the required inputs
// with sensible defaults for all optional tunables.
func TestCloudRunWebPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/cloud-run-web",
		Vars: map[string]interface{}{
			"project_id":            project,
			"environment":           "dev",
			"service_account_email": fmt.Sprintf("web-sa@%s.iam.gserviceaccount.com", project),
			"image":                 fmt.Sprintf("us-west1-docker.pkg.dev/%s/aistudio/web:latest", project),
			"vpc_connector":         fmt.Sprintf("projects/%s/locations/us-west1/connectors/aistudio-connector", project),
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with minimal cloud-run-web inputs")
}

// TestCloudRunWebPlanProd exercises the production configuration:
// cpu_always_allocated=true, min_instances=1, higher concurrency, secret refs.
func TestCloudRunWebPlanProd(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-prod-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/cloud-run-web",
		Vars: map[string]interface{}{
			"project_id":            project,
			"environment":           "prod",
			"region":                "us-west1",
			"service_account_email": fmt.Sprintf("web-sa@%s.iam.gserviceaccount.com", project),
			"image":                 fmt.Sprintf("us-west1-docker.pkg.dev/%s/aistudio/web:v1.2.3", project),
			"vpc_connector":         fmt.Sprintf("projects/%s/locations/us-west1/connectors/aistudio-connector", project),
			"min_instances":         1,
			"max_instances":         100,
			"concurrency":           100,
			"cpu_always_allocated":  true,
			"cpu":                   "4",
			"memory":                "4Gi",
			"secret_refs": map[string]interface{}{
				"NEXTAUTH_SECRET": fmt.Sprintf("projects/%s/secrets/nextauth-secret/versions/latest", project),
				"DATABASE_URL":    fmt.Sprintf("projects/%s/secrets/database-url/versions/latest", project),
			},
			"env": map[string]interface{}{
				"NODE_ENV":                 "production",
				"NEXT_TELEMETRY_DISABLED":  "1",
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with full prod cloud-run-web inputs")
}

// TestCloudRunWebPlanInvalidEnvironment verifies the environment validation.
func TestCloudRunWebPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/cloud-run-web",
		Vars: map[string]interface{}{
			"project_id":            project,
			"environment":           "preview", // invalid
			"service_account_email": fmt.Sprintf("web-sa@%s.iam.gserviceaccount.com", project),
			"image":                 "us-west1-docker.pkg.dev/placeholder/aistudio/web:latest",
			"vpc_connector":         "projects/placeholder/locations/us-west1/connectors/aistudio-connector",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'preview'")
}
