/**
 * Unit tests for the inline-vs-GCS result-storage decision.
 *
 * Mocks gcs-client at the module boundary so the GCS-write branch is
 * observable without hitting real storage.
 */

const uploadDocumentAtKeyMock = jest.fn();
jest.mock("@/lib/gcp/gcs-client", () => ({
  uploadDocumentAtKey: (...args: unknown[]) => uploadDocumentAtKeyMock(...args),
}));

import { persistResult } from "@/infra/cloud-run-services/document-processor/result-storage";

beforeEach(() => {
  uploadDocumentAtKeyMock.mockReset();
  uploadDocumentAtKeyMock.mockResolvedValue({
    key: "v2/results/job-1/result.json",
    bucket: "test-bucket",
  });
  delete process.env.INLINE_RESULT_MAX_BYTES;
});

describe("persistResult", () => {
  it("stores small results inline and does NOT call GCS", async () => {
    const result = await persistResult("job-1", {
      text: "small extracted text",
      chunks: ["small extracted text"],
      metadata: {},
    });

    expect(result.resultLocation).toBe("inline");
    expect(result.result).toBeDefined();
    expect(result.resultGcsKey).toBeUndefined();
    expect(uploadDocumentAtKeyMock).not.toHaveBeenCalled();
  });

  it("uploads to GCS at v2/results/<jobId>/result.json when over the inline limit", async () => {
    // Lower the limit so we don't have to construct a 400KB string.
    process.env.INLINE_RESULT_MAX_BYTES = "100";

    const big = "x".repeat(500);
    const out = await persistResult("job-1", { text: big });

    expect(out.resultLocation).toBe("gcs");
    expect(out.resultGcsKey).toBe("v2/results/job-1/result.json");
    expect(out.result).toBeUndefined();

    expect(uploadDocumentAtKeyMock).toHaveBeenCalledTimes(1);
    const callArg = uploadDocumentAtKeyMock.mock.calls[0][0];
    expect(callArg.key).toBe("v2/results/job-1/result.json");
    expect(callArg.contentType).toBe("application/json");
    expect(callArg.metadata.jobId).toBe("job-1");
    expect(Number.parseInt(callArg.metadata.sizeBytes, 10)).toBeGreaterThan(100);
    // Body is the JSON-encoded result.
    const body = (callArg.fileBuffer as Buffer).toString("utf8");
    expect(JSON.parse(body)).toEqual({ text: big });
  });

  it("falls back to the default limit when INLINE_RESULT_MAX_BYTES is malformed", async () => {
    process.env.INLINE_RESULT_MAX_BYTES = "not-a-number";

    // 500-byte payload is well under the 400KB default, so should stay inline.
    const out = await persistResult("job-1", { text: "x".repeat(500) });

    expect(out.resultLocation).toBe("inline");
    expect(uploadDocumentAtKeyMock).not.toHaveBeenCalled();
  });
});
