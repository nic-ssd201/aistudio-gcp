import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

jest.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    accessSecretVersion: jest.fn().mockResolvedValue([{ payload: { data: "test" } }]),
  })),
}));

describe("debug mock", () => {
  it("should work", async () => {
    const client = new (SecretManagerServiceClient as any)();
    const result = await client.accessSecretVersion({ name: "test" });
    console.log("result:", result, Array.isArray(result));
    expect(Array.isArray(result)).toBe(true);
  });
});
