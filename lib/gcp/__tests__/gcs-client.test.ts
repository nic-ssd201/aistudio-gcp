/**
 * Unit tests for lib/gcp/gcs-client.ts.
 *
 * Mocks @google-cloud/storage so tests don't hit a real project. The goal at
 * E1 is to prove the surface (names, shapes, parameter passthrough) matches
 * lib/aws/s3-client.ts so E2's import swap is safe.
 */

import { Readable } from "node:stream"

// ---- mock @google-cloud/storage ----

type SaveArgs = {
  data: Buffer | Uint8Array | string
  options: Record<string, unknown>
}

const saveMock = jest.fn<Promise<void>, [unknown, unknown]>()
const getSignedUrlMock = jest.fn<Promise<[string]>, [Record<string, unknown>]>()
const existsMock = jest.fn<Promise<[boolean]>, []>()
const deleteMock = jest.fn<Promise<void>, [unknown?]>()
const getFilesMock = jest.fn<Promise<[Array<{ name: string; metadata: Record<string, unknown> }>]>, [unknown?]>()
const getMetadataMock = jest.fn<Promise<[Record<string, unknown>]>, []>()
const createReadStreamMock = jest.fn<Readable, []>()
const createResumableUploadMock = jest.fn<Promise<[string]>, [Record<string, unknown>]>()
const bucketExistsMock = jest.fn<Promise<[boolean]>, []>()

jest.mock("@google-cloud/storage", () => {
  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: () => ({
        exists: () => bucketExistsMock(),
        file: (_key: string) => ({
          save: (data: unknown, options: unknown) => saveMock(data, options),
          getSignedUrl: (opts: Record<string, unknown>) => getSignedUrlMock(opts),
          createResumableUpload: (opts: Record<string, unknown>) => createResumableUploadMock(opts),
          exists: () => existsMock(),
          delete: (opts?: unknown) => deleteMock(opts),
          getMetadata: () => getMetadataMock(),
          createReadStream: () => createReadStreamMock(),
        }),
        getFiles: (opts?: unknown) => getFilesMock(opts),
      }),
    })),
  }
})

// ---- mock @/lib/error-utils.createError to pass through ----

jest.mock("@/lib/error-utils", () => ({
  createError: (message: string, meta: { code: string; details?: unknown }) => {
    const err = new Error(message) as Error & { code: string; details?: unknown }
    err.code = meta.code
    err.details = meta.details
    return err
  },
}))

import {
  clearGCSCache,
  ensureDocumentsBucket,
  uploadDocument,
  uploadServerProxyDocument,
  getDocumentSignedUrl,
  deleteDocument,
  documentExists,
  listUserDocuments,
  generateUploadPresignedUrl,
  resumableUpload,
  getObjectStream,
  extractKeyFromUrl,
} from "../gcs-client"

const OLD_ENV = { ...process.env }

beforeEach(() => {
  clearGCSCache()
  process.env.GCS_BUCKET = "aistudio-test"
  process.env.GCP_PROJECT_ID = "test-project"
  saveMock.mockReset()
  getSignedUrlMock.mockReset()
  existsMock.mockReset()
  deleteMock.mockReset()
  getFilesMock.mockReset()
  getMetadataMock.mockReset()
  createReadStreamMock.mockReset()
  createResumableUploadMock.mockReset()
  bucketExistsMock.mockReset()
})

afterAll(() => {
  process.env = OLD_ENV
})

describe("ensureDocumentsBucket", () => {
  it("returns normally when the bucket exists", async () => {
    bucketExistsMock.mockResolvedValue([true])
    await expect(ensureDocumentsBucket()).resolves.toBeUndefined()
  })

  it("throws GCS_BUCKET_MISSING when the bucket doesn't exist", async () => {
    bucketExistsMock.mockResolvedValue([false])
    await expect(ensureDocumentsBucket()).rejects.toMatchObject({
      code: "GCS_BUCKET_MISSING",
    })
  })
})

describe("uploadDocument", () => {
  it("saves to GCS under userId/timestamp-filename and returns a signed URL", async () => {
    bucketExistsMock.mockResolvedValue([true])
    saveMock.mockResolvedValue()
    getSignedUrlMock.mockResolvedValue(["https://example/signed"])

    const result = await uploadDocument({
      userId: "u1",
      fileName: "doc.pdf",
      fileContent: Buffer.from("hello"),
      contentType: "application/pdf",
      metadata: { source: "test" },
    })

    expect(result.url).toBe("https://example/signed")
    expect(result.key).toMatch(/^u1\/\d+-doc\.pdf$/)
    expect(saveMock).toHaveBeenCalledTimes(1)
    const [, opts] = saveMock.mock.calls[0]
    expect(opts).toMatchObject({
      contentType: "application/pdf",
      resumable: false,
    })
    const metadataArg = (opts as { metadata: { metadata: Record<string, string> } }).metadata.metadata
    expect(metadataArg).toMatchObject({ userId: "u1", source: "test" })
  })
})

describe("uploadServerProxyDocument", () => {
  it("stores server-proxy uploads at the stable v2 job key", async () => {
    bucketExistsMock.mockResolvedValue([true])
    saveMock.mockResolvedValue()

    const result = await uploadServerProxyDocument({
      jobId: "job-123",
      fileName: "district plan.pdf",
      fileBuffer: Buffer.from("hello"),
      contentType: "application/pdf",
    })

    expect(result).toEqual({
      key: "v2/uploads/job-123/district_plan.pdf",
      bucket: "aistudio-test",
      sanitizedFileName: "district_plan.pdf",
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    const [, opts] = saveMock.mock.calls[0]
    expect(opts).toMatchObject({
      contentType: "application/pdf",
      resumable: false,
      metadata: {
        metadata: expect.objectContaining({
          jobId: "job-123",
          originalFileName: "district plan.pdf",
        }),
      },
    })
  })
})

describe("getDocumentSignedUrl", () => {
  it("returns a V4 read signed URL with the requested expiry", async () => {
    getSignedUrlMock.mockResolvedValue(["https://example/read"])
    const url = await getDocumentSignedUrl({ key: "u1/1-doc.pdf", expiresIn: 600 })
    expect(url).toBe("https://example/read")
    const opts = getSignedUrlMock.mock.calls[0][0]
    expect(opts).toMatchObject({ version: "v4", action: "read" })
  })
})

describe("deleteDocument", () => {
  it("delegates to file.delete with ignoreNotFound", async () => {
    deleteMock.mockResolvedValue()
    await deleteDocument("u1/1-doc.pdf")
    expect(deleteMock).toHaveBeenCalledWith({ ignoreNotFound: true })
  })
})

describe("documentExists", () => {
  it("returns true when the file exists", async () => {
    existsMock.mockResolvedValue([true])
    await expect(documentExists("u1/1-doc.pdf")).resolves.toBe(true)
  })
  it("returns false when it does not", async () => {
    existsMock.mockResolvedValue([false])
    await expect(documentExists("u1/none.pdf")).resolves.toBe(false)
  })
})

describe("listUserDocuments", () => {
  it("maps GCS file metadata to the S3-compatible shape", async () => {
    getFilesMock.mockResolvedValue([
      [
        {
          name: "u1/1-a.pdf",
          metadata: { size: "1234", updated: "2026-04-22T10:00:00Z" },
        },
        {
          name: "u1/2-b.pdf",
          metadata: { size: 5678, updated: "2026-04-22T11:00:00Z" },
        },
      ],
    ])

    const docs = await listUserDocuments("u1", 50)
    expect(docs).toHaveLength(2)
    expect(docs[0]).toMatchObject({ key: "u1/1-a.pdf", size: 1234 })
    expect(docs[0].lastModified).toBeInstanceOf(Date)
    expect(docs[1].size).toBe(5678)
  })
})

describe("generateUploadPresignedUrl", () => {
  it("binds metadata into x-goog-meta-* extension headers", async () => {
    bucketExistsMock.mockResolvedValue([true])
    getSignedUrlMock.mockResolvedValue(["https://example/put"])

    const { url, key, fields } = await generateUploadPresignedUrl({
      userId: "u1",
      fileName: "name with spaces.pdf",
      contentType: "application/pdf",
      fileSize: 1024,
      metadata: { department: "ops" },
    })

    expect(url).toBe("https://example/put")
    // filename sanitization preserved
    expect(key).toMatch(/^u1\/\d+-name_with_spaces\.pdf$/)
    expect(fields).toEqual({ "Content-Type": "application/pdf", "Content-Length": "1024" })

    const opts = getSignedUrlMock.mock.calls[0][0]
    expect(opts).toMatchObject({ version: "v4", action: "write", contentType: "application/pdf" })
    const headers = (opts as { extensionHeaders: Record<string, string> }).extensionHeaders
    expect(headers["x-goog-meta-userid"]).toBe("u1")
    expect(headers["x-goog-meta-department"]).toBe("ops")
  })
})

describe("getObjectStream", () => {
  it("returns stream + normalized content-length", async () => {
    getMetadataMock.mockResolvedValue([
      { contentType: "application/pdf", size: "4096", metadata: { userId: "u1" } },
    ])
    const fakeStream = new Readable({ read() { this.push(null) } })
    createReadStreamMock.mockReturnValue(fakeStream)

    const res = await getObjectStream("u1/1-doc.pdf")
    expect(res.contentType).toBe("application/pdf")
    expect(res.contentLength).toBe(4096)
    expect(res.metadata).toEqual({ userId: "u1" })
    expect(res.stream).toBe(fakeStream)
  })
})

describe("resumableUpload", () => {
  it("creates a resumable session URI and preserves upload headers", async () => {
    bucketExistsMock.mockResolvedValue([true])
    createResumableUploadMock.mockResolvedValue(["https://example/resumable-session"])

    const result = await resumableUpload({
      userId: "v2/uploads/job-123",
      fileName: "large file.pdf",
      contentType: "application/pdf",
      fileSize: 4096,
      metadata: { department: "ops" },
    })

    expect(result).toEqual({
      url: "https://example/resumable-session",
      key: expect.stringMatching(/^v2\/uploads\/job-123\/\d+-large_file\.pdf$/),
      fields: {
        "Content-Type": "application/pdf",
        "Content-Length": "4096",
      },
    })

    const opts = createResumableUploadMock.mock.calls[0][0]
    expect(opts).toMatchObject({
      metadata: {
        contentType: "application/pdf",
        metadata: expect.objectContaining({
          department: "ops",
          userId: "v2/uploads/job-123",
          originalName: "large file.pdf",
        }),
      },
    })
  })
})

describe("extractKeyFromUrl", () => {
  beforeEach(() => {
    process.env.GCS_BUCKET = "aistudio-test"
    clearGCSCache()
  })

  it("parses path-style URLs", async () => {
    await expect(
      extractKeyFromUrl("https://storage.googleapis.com/aistudio-test/u1/1-doc.pdf"),
    ).resolves.toBe("u1/1-doc.pdf")
  })
  it("parses virtual-host-style URLs", async () => {
    await expect(
      extractKeyFromUrl("https://aistudio-test.storage.googleapis.com/u1/1-doc.pdf"),
    ).resolves.toBe("u1/1-doc.pdf")
  })
  it("parses gs:// URIs", async () => {
    await expect(extractKeyFromUrl("gs://aistudio-test/u1/1-doc.pdf")).resolves.toBe(
      "u1/1-doc.pdf",
    )
  })
  it("returns null for a different bucket", async () => {
    await expect(
      extractKeyFromUrl("https://storage.googleapis.com/other-bucket/u1/1-doc.pdf"),
    ).resolves.toBeNull()
  })
  it("returns null for malformed input", async () => {
    await expect(extractKeyFromUrl("not a url")).resolves.toBeNull()
  })
})
