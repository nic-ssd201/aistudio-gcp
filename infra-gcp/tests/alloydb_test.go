// Terratest plan-only smoke tests for the alloydb module.
//
// AlloyDB requires vpc_self_link, psa_range, kms_key, and
// initial_user_password_secret — all cross-module references. The tests use
// placeholder values that satisfy type constraints without requiring real GCP
// resources.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestAlloyDBPlanDevSize verifies the default dev/staging footprint:
// cpu_count=2, enable_read_pool=false.
func TestAlloyDBPlanDevSize(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/alloydb",
		Vars: map[string]interface{}{
			"project_id":                   project,
			"environment":                  "dev",
			"vpc_self_link":                fmt.Sprintf("projects/%s/global/networks/aistudio-vpc", project),
			"psa_range":                    "10.100.0.0/16",
			"kms_key":                      fmt.Sprintf("projects/%s/locations/us-west1/keyRings/aistudio-dev/cryptoKeys/alloydb", project),
			"initial_user_password_secret": fmt.Sprintf("projects/%s/secrets/alloydb-postgres-password/versions/latest", project),
			"cpu_count":                    2,
			"enable_read_pool":             false,
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed for dev-size AlloyDB")
}

// TestAlloyDBPlanProdWithReadPool exercises the prod footprint:
// cpu_count=4, enable_read_pool=true.
func TestAlloyDBPlanProdWithReadPool(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-prod-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/alloydb",
		Vars: map[string]interface{}{
			"project_id":                   project,
			"environment":                  "prod",
			"region":                       "us-west1",
			"vpc_self_link":                fmt.Sprintf("projects/%s/global/networks/aistudio-vpc", project),
			"psa_range":                    "10.100.0.0/16",
			"kms_key":                      fmt.Sprintf("projects/%s/locations/us-west1/keyRings/aistudio-prod/cryptoKeys/alloydb", project),
			"initial_user_password_secret": fmt.Sprintf("projects/%s/secrets/alloydb-postgres-password/versions/latest", project),
			"cpu_count":                    4,
			"enable_read_pool":             true,
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed for prod AlloyDB with read pool")
}

// TestAlloyDBPlanInvalidCPU verifies the cpu_count validation block rejects
// values not in [2, 4, 8, 16].
func TestAlloyDBPlanInvalidCPU(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/alloydb",
		Vars: map[string]interface{}{
			"project_id":                   project,
			"environment":                  "dev",
			"vpc_self_link":                fmt.Sprintf("projects/%s/global/networks/aistudio-vpc", project),
			"psa_range":                    "10.100.0.0/16",
			"kms_key":                      fmt.Sprintf("projects/%s/locations/us-west1/keyRings/aistudio-dev/cryptoKeys/alloydb", project),
			"initial_user_password_secret": fmt.Sprintf("projects/%s/secrets/alloydb-postgres-password/versions/latest", project),
			"cpu_count":                    3, // invalid — not in [2, 4, 8, 16]
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject cpu_count=3")
}
