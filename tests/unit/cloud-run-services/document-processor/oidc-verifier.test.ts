/**
 * Unit tests for the OIDC verifier the processor uses to authenticate
 * inbound Cloud Tasks / Cloud Scheduler requests.
 *
 * We mock jose's createRemoteJWKSet + jwtVerify so the tests don't make
 * network calls to Google's JWKS endpoint. Each test threads a
 * synthesized payload through the verifier and asserts the email/audience
 * pinning logic.
 */

const jwtVerifyMock = jest.fn();
jest.mock("jose", () => ({
  createRemoteJWKSet: jest.fn(() => "<MOCK-JWKS>"),
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
}));

import { verifyOidcToken } from "@/infra/cloud-run-services/document-processor/oidc-verifier";

const VALID_HEADER = "Bearer eyJhbGciOiJSUzI1NiJ9.test.signature";
const SA_EMAIL = "doc-proc@aistudio-staging.iam.gserviceaccount.com";
const AUDIENCE = "https://aistudio-doc-processor-abc.run.app/process-job";

beforeEach(() => {
  jwtVerifyMock.mockReset();
});

describe("verifyOidcToken — happy path", () => {
  it("returns the decoded claims when signature, audience, email all match", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        email: SA_EMAIL,
        email_verified: true,
        sub: "12345",
        aud: AUDIENCE,
        iss: "https://accounts.google.com",
      },
    });

    const claims = await verifyOidcToken(VALID_HEADER, {
      audience: AUDIENCE,
      expectedEmail: SA_EMAIL,
    });

    expect(claims).toEqual({
      email: SA_EMAIL,
      sub: "12345",
      aud: AUDIENCE,
      iss: "https://accounts.google.com",
    });
    expect(jwtVerifyMock).toHaveBeenCalledTimes(1);
    // Confirm the verifier was given the expected pinning options.
    const opts = jwtVerifyMock.mock.calls[0][2];
    expect(opts.audience).toBe(AUDIENCE);
    expect(opts.algorithms).toEqual(["RS256"]);
    expect(opts.issuer).toEqual([
      "https://accounts.google.com",
      "accounts.google.com",
    ]);
  });
});

describe("verifyOidcToken — failure cases", () => {
  it.each([
    ["missing header", undefined],
    ["non-Bearer scheme", "Basic abcd"],
    ["empty Bearer", "Bearer "],
  ])("rejects %s", async (_label, header) => {
    await expect(
      verifyOidcToken(header as string | undefined, {
        audience: AUDIENCE,
        expectedEmail: SA_EMAIL,
      }),
    ).rejects.toThrow(/missing or malformed Authorization header/);
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it("propagates jose verification errors (bad signature, expired, audience mismatch)", async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error("signature verification failed"));
    await expect(
      verifyOidcToken(VALID_HEADER, {
        audience: AUDIENCE,
        expectedEmail: SA_EMAIL,
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it("rejects when the email claim doesn't match the expected SA", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        email: "attacker@example.com",
        email_verified: true,
        sub: "9999",
        aud: AUDIENCE,
        iss: "https://accounts.google.com",
      },
    });

    await expect(
      verifyOidcToken(VALID_HEADER, {
        audience: AUDIENCE,
        expectedEmail: SA_EMAIL,
      }),
    ).rejects.toThrow(/email claim mismatch/);
  });

  it("rejects when email_verified is not strictly true", async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        email: SA_EMAIL,
        email_verified: false,
        sub: "12345",
        aud: AUDIENCE,
        iss: "https://accounts.google.com",
      },
    });

    await expect(
      verifyOidcToken(VALID_HEADER, {
        audience: AUDIENCE,
        expectedEmail: SA_EMAIL,
      }),
    ).rejects.toThrow(/email_verified claim is not true/);
  });
});
