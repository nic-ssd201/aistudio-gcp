// Terratest coverage for the sa-factory module.
//
// Each test follows the same shape:
//   1. Apply the example terraform against a scratch project.
//   2. Read outputs (SA email, etc.).
//   3. Call GCP APIs to verify the IAM surface matches expectations.
//   4. Defer a destroy so nothing lingers even on test failure.
//
// The TEST_PROJECT_ID env var selects the project. Do not point this at a real
// environment — tests create and destroy real resources.
package test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestSAFactoryMinimal exercises the default-only path:
//   - SA is created
//   - Default observability roles (logging.logWriter, monitoring.metricWriter,
//     cloudtrace.agent) are bound at project level
//   - aiplatform.user is NOT bound (vertex_ai_enabled defaults to false)
func TestSAFactoryMinimal(t *testing.T) {
	t.Parallel()

	projectID := getProjectID(t)
	uniqueID := strings.ToLower(random.UniqueId())
	namePrefix := fmt.Sprintf("tt-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/sa-factory/examples/minimal",
		Vars: map[string]interface{}{
			"project_id":  projectID,
			"name_prefix": namePrefix,
		},
		NoColor: true,
	}

	defer terraform.Destroy(t, opts)
	terraform.InitAndApply(t, opts)

	email := terraform.Output(t, opts, "email")
	accountID := terraform.Output(t, opts, "account_id")

	assert.Equal(t, "sa-"+namePrefix, accountID)
	assert.Contains(t, email, ".iam.gserviceaccount.com")
	assert.Contains(t, email, accountID)

	ctx := context.Background()

	// Default observability bindings should exist.
	assertProjectRole(t, ctx, projectID, email, "roles/logging.logWriter")
	assertProjectRole(t, ctx, projectID, email, "roles/monitoring.metricWriter")
	assertProjectRole(t, ctx, projectID, email, "roles/cloudtrace.agent")

	// Opt-in roles must not leak into the minimal path.
	assertProjectRoleAbsent(t, ctx, projectID, email, "roles/aiplatform.user")
}

// TestSAFactoryFull exercises the full input surface:
//   - Default observability roles are bound
//   - vertex_ai_enabled=true grants aiplatform.user
//   - Bucket binding is attached at the bucket level (not project-wide)
//   - Secret binding is attached at the secret level (not project-wide)
func TestSAFactoryFull(t *testing.T) {
	t.Parallel()

	projectID := getProjectID(t)
	uniqueID := strings.ToLower(random.UniqueId())
	namePrefix := fmt.Sprintf("tt-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/sa-factory/examples/full",
		Vars: map[string]interface{}{
			"project_id":  projectID,
			"name_prefix": namePrefix,
			"region":      "us-central1",
		},
		NoColor: true,
	}

	defer terraform.Destroy(t, opts)
	terraform.InitAndApply(t, opts)

	email := terraform.Output(t, opts, "email")
	bucket := terraform.Output(t, opts, "bucket_name")
	secretID := terraform.Output(t, opts, "secret_id")

	ctx := context.Background()

	// Defaults and Vertex role at project level.
	assertProjectRole(t, ctx, projectID, email, "roles/logging.logWriter")
	assertProjectRole(t, ctx, projectID, email, "roles/aiplatform.user")

	// Scoped bindings on the prerequisite resources.
	assertBucketRole(t, ctx, bucket, email, "roles/storage.objectAdmin")
	assertSecretRole(t, ctx, projectID, secretID, email, "roles/secretmanager.secretAccessor")

	// Negative check: the bucket role is NOT bound at project level (it's scoped
	// to the bucket). If this fails, something is granting roles/storage.objectAdmin
	// at project scope and we've regressed on least-privilege.
	assertProjectRoleAbsent(t, ctx, projectID, email, "roles/storage.objectAdmin")
}

// TestSAFactoryAccountIDValidation checks that terraform rejects invalid names
// at plan time without making any API calls. Runs as a quick smoke test with
// no external dependencies beyond `terraform validate`.
func TestSAFactoryAccountIDValidation(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		invalid string
	}{
		{"uppercase", "BadName"},
		{"leading_hyphen", "-foo"},
		{"trailing_hyphen", "foo-"},
		{"too_short", "a"},
		{"too_long", strings.Repeat("x", 25)},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			opts := &terraform.Options{
				TerraformDir: "../modules/sa-factory/examples/minimal",
				Vars: map[string]interface{}{
					"project_id":  "nonexistent-project-validation-only",
					"name_prefix": tc.invalid,
				},
				NoColor: true,
			}
			_, err := terraform.InitAndPlanE(t, opts)
			assert.Error(t, err, "expected validation to reject %q", tc.invalid)
		})
	}
}
