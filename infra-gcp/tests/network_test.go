// Terratest plan-only smoke tests for the network module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestNetworkPlanMinimal exercises the default-only code path: only
// project_id and environment are required; all other inputs use defaults.
func TestNetworkPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/network",
		Vars: map[string]interface{}{
			"project_id":  fmt.Sprintf("aistudio-dev-%s", uniqueID),
			"environment": "dev",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with minimal network inputs")
}

// TestNetworkPlanProd exercises the production configuration: deny-all-egress
// and IAP SSH rules both enabled, firewall logs on.
func TestNetworkPlanProd(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())

	opts := &terraform.Options{
		TerraformDir: "../modules/network",
		Vars: map[string]interface{}{
			"project_id":               fmt.Sprintf("aistudio-prod-%s", uniqueID),
			"environment":              "prod",
			"region":                   "us-west1",
			"vpc_name":                 "aistudio-vpc",
			"enable_flow_logs":         true,
			"enable_firewall_logs":     true,
			"enable_iap_ssh":           true,
			"firewall_deny_all_egress": true,
			"connector_min_instances":  2,
			"connector_max_instances":  10,
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with full prod network inputs")
}

// TestNetworkPlanInvalidEnvironment verifies the environment validation
// block rejects values outside dev/staging/prod.
func TestNetworkPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../modules/network",
		Vars: map[string]interface{}{
			"project_id":  "aistudio-test-project",
			"environment": "qa", // invalid
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment value 'qa'")
}
