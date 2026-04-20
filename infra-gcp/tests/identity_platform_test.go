// Terratest plan-only smoke tests for the identity-platform module.
package test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
)

// TestIdentityPlatformPlanMinimal verifies the module plans with only the
// required tenant_display_name and project metadata.
func TestIdentityPlatformPlanMinimal(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-dev-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/identity-platform",
		Vars: map[string]interface{}{
			"project_id":          project,
			"environment":         "dev",
			"tenant_display_name": "SSD Staff Dev",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with minimal identity-platform inputs")
}

// TestIdentityPlatformPlanWithOIDC exercises the oidc_providers list with a
// Google Workspace SSO provider. client_secret_value uses a placeholder —
// the variable is marked sensitive, so plan accepts any string value.
func TestIdentityPlatformPlanWithOIDC(t *testing.T) {
	t.Parallel()

	uniqueID := strings.ToLower(random.UniqueId())
	project := fmt.Sprintf("aistudio-prod-%s", uniqueID)

	opts := &terraform.Options{
		TerraformDir: "../modules/identity-platform",
		Vars: map[string]interface{}{
			"project_id":          project,
			"environment":         "prod",
			"tenant_display_name": "SSD Staff",
			"authorized_domains":  []string{"aistudio.ssd.example"},
			"oidc_providers": []map[string]interface{}{
				{
					"display_name":        "Google Workspace",
					"client_id":           "123456789-abc.apps.googleusercontent.com",
					"issuer":              "https://accounts.google.com",
					"client_secret_value": "placeholder-secret-value-for-plan-only",
				},
			},
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.NoError(t, err, "plan should succeed with OIDC provider configuration")
}

// TestIdentityPlatformPlanInvalidEnvironment verifies the environment constraint.
func TestIdentityPlatformPlanInvalidEnvironment(t *testing.T) {
	t.Parallel()

	opts := &terraform.Options{
		TerraformDir: "../modules/identity-platform",
		Vars: map[string]interface{}{
			"project_id":          "aistudio-test-project",
			"environment":         "integration", // invalid
			"tenant_display_name": "Test",
		},
		NoColor: true,
	}

	_, err := terraform.InitAndPlanE(t, opts)
	assert.Error(t, err, "plan should reject environment 'integration'")
}
