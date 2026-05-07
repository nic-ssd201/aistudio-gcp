// Helpers shared by all sa-factory tests. Kept in a separate file so individual
// test files stay focused on the scenario they exercise.
package test

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	cloudiam "cloud.google.com/go/iam"
	secretmanager "cloud.google.com/go/secretmanager/apiv1"
	"google.golang.org/api/cloudresourcemanager/v1"
	"google.golang.org/api/storage/v1"
)

// getProjectID returns the GCP project ID that tests run against. Requires
// TEST_PROJECT_ID to be set — we use a dedicated env var rather than the
// ambient GOOGLE_CLOUD_PROJECT to avoid accidentally creating test resources
// in a real environment project.
func getProjectID(t *testing.T) string {
	t.Helper()
	p := os.Getenv("TEST_PROJECT_ID")
	require.NotEmpty(t, p, "TEST_PROJECT_ID must be set for Terratest runs")
	return p
}

// memberFor wraps an SA email as an IAM member string.
func memberFor(email string) string {
	return "serviceAccount:" + email
}

// assertProjectRole fails the test if `email` does not have `role` bound at the
// project level of `projectID`.
func assertProjectRole(t *testing.T, ctx context.Context, projectID, email, role string) {
	t.Helper()
	svc, err := cloudresourcemanager.NewService(ctx)
	require.NoError(t, err)

	policy, err := svc.Projects.GetIamPolicy(
		projectID,
		&cloudresourcemanager.GetIamPolicyRequest{},
	).Context(ctx).Do()
	require.NoError(t, err)

	want := memberFor(email)
	for _, b := range policy.Bindings {
		if b.Role != role {
			continue
		}
		for _, m := range b.Members {
			if m == want {
				return
			}
		}
	}
	t.Errorf("project %s: role %s not bound to %s", projectID, role, want)
}

// assertProjectRoleAbsent fails the test if `email` *does* have `role` bound at
// the project level. Used to prove that opt-in roles (e.g. aiplatform.user)
// aren't granted when the corresponding input is false.
func assertProjectRoleAbsent(t *testing.T, ctx context.Context, projectID, email, role string) {
	t.Helper()
	svc, err := cloudresourcemanager.NewService(ctx)
	require.NoError(t, err)

	policy, err := svc.Projects.GetIamPolicy(
		projectID,
		&cloudresourcemanager.GetIamPolicyRequest{},
	).Context(ctx).Do()
	require.NoError(t, err)

	want := memberFor(email)
	for _, b := range policy.Bindings {
		if b.Role != role {
			continue
		}
		for _, m := range b.Members {
			if m == want {
				t.Errorf("project %s: role %s unexpectedly bound to %s", projectID, role, want)
				return
			}
		}
	}
}

// assertBucketRole fails the test if `email` does not have `role` on `bucket`.
func assertBucketRole(t *testing.T, ctx context.Context, bucket, email, role string) {
	t.Helper()
	svc, err := storage.NewService(ctx)
	require.NoError(t, err)

	policy, err := svc.Buckets.GetIamPolicy(bucket).Context(ctx).Do()
	require.NoError(t, err)

	want := memberFor(email)
	for _, b := range policy.Bindings {
		if b.Role != role {
			continue
		}
		for _, m := range b.Members {
			if m == want {
				return
			}
		}
	}
	t.Errorf("bucket %s: role %s not bound to %s", bucket, role, want)
}

// assertSecretRole fails the test if `email` does not have `role` on the given
// Secret Manager secret.
func assertSecretRole(t *testing.T, ctx context.Context, projectID, secretID, email, role string) {
	t.Helper()
	client, err := secretmanager.NewClient(ctx)
	require.NoError(t, err)
	defer client.Close()

	name := fmt.Sprintf("projects/%s/secrets/%s", projectID, secretID)
	policy, err := client.IAM(name).Policy(ctx)
	require.NoError(t, err)

	want := memberFor(email)
	for _, m := range policy.Members(cloudiam.RoleName(role)) {
		if m == want {
			return
		}
	}
	t.Errorf("secret %s: role %s not bound to %s", secretID, role, want)
}
