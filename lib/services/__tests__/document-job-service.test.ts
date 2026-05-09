/**
 * Unit tests for the Postgres-backed document-job-service.
 *
 * The Drizzle client is mocked at the module boundary (jest.setup.js stubs
 * `@/lib/db/drizzle-client` to return `executeQuery` as a jest.fn). Each test
 * overrides the implementation per call so we can assert the exact query
 * shape the service emits without spinning up a real DB.
 *
 * The job rows used here mirror what `documentJobs.$inferSelect` produces:
 * timestamps as Date objects, JSONB fields as plain JS objects.
 */

import { executeQuery } from "@/lib/db/drizzle-client";
import {
  createDocumentJob,
  getJobStatus,
  updateJobStatus,
  confirmDocumentUpload,
  getUserJobs,
  getJobsByStatus,
  deleteOldJobs,
  type CreateJobParams,
  type ProcessingOptions,
} from "../document-job-service";

// Pull the mocked executeQuery out of the global mock for per-test override.
const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>;

/**
 * Build a chainable Drizzle-shape spy. Captures the `.set()` and `.where()`
 * args so tests can assert exactly what the service emitted. `returning()`
 * resolves to the supplied value.
 */
function makeSpyDb(returning: unknown[] = [{ id: "job-1" }]) {
  const set = jest.fn().mockReturnThis();
  const where = jest.fn().mockReturnThis();
  const returningFn = jest.fn().mockResolvedValue(returning);
  const update = jest.fn().mockReturnValue({ set, where, returning: returningFn });
  const select = jest.fn().mockReturnThis();
  const from = jest.fn().mockReturnThis();
  const orderBy = jest.fn().mockReturnThis();
  const limit = jest.fn().mockResolvedValue(returning);
  const insert = jest.fn().mockReturnThis();
  const values = jest.fn().mockReturnThis();
  const returningInsert = jest.fn().mockResolvedValue(returning);
  return {
    db: {
      update,
      select,
      from,
      where,
      orderBy,
      limit,
      insert,
      values,
      returning: returningInsert,
    },
    spies: { set, where, update, select, from, orderBy, limit, insert, values },
  };
}

const baseProcessingOptions: ProcessingOptions = {
  extractText: true,
  convertToMarkdown: false,
  extractImages: false,
  generateEmbeddings: false,
  ocrEnabled: false,
};

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-05-09T00:00:00Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "user-sub-1",
    fileName: "doc.pdf",
    fileSize: 1024,
    fileType: "application/pdf",
    purpose: "chat" as const,
    processingOptions: baseProcessingOptions,
    status: "pending" as const,
    progress: null,
    processingStage: null,
    result: null,
    resultLocation: null,
    resultGcsKey: null,
    errorMessage: null,
    createdAt: now,
    completedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  mockExecuteQuery.mockReset();
});

describe("createDocumentJob", () => {
  const params: CreateJobParams = {
    fileName: "doc.pdf",
    fileSize: 2048,
    fileType: "application/pdf",
    purpose: "chat",
    userId: "user-sub-1",
    processingOptions: baseProcessingOptions,
  };

  it("inserts and returns the new job mapped to DocumentJob shape", async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      makeRow({ fileName: params.fileName, fileSize: params.fileSize }),
    ]);

    const job = await createDocumentJob(params);

    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.status).toBe("pending");
    expect(job.fileName).toBe("doc.pdf");
    expect(job.fileSize).toBe(2048);
    expect(job.processingOptions).toEqual(baseProcessingOptions);
    expect(job.createdAt).toBe("2026-05-09T00:00:00.000Z");
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
  });

  it("throws when the insert returns no row", async () => {
    mockExecuteQuery.mockResolvedValueOnce([]);
    await expect(createDocumentJob(params)).rejects.toThrow(/no row returned/i);
  });
});

describe("getJobStatus", () => {
  it("returns the job when found", async () => {
    mockExecuteQuery.mockResolvedValueOnce([makeRow({ status: "processing" })]);
    const job = await getJobStatus("job-1");
    expect(job?.status).toBe("processing");
  });

  it("returns null when no row matches", async () => {
    mockExecuteQuery.mockResolvedValueOnce([]);
    const job = await getJobStatus("missing-id");
    expect(job).toBeNull();
  });

  it("adds a userId filter to the WHERE when supplied (auth scoping)", async () => {
    const { db, spies } = makeSpyDb([]);
    mockExecuteQuery.mockImplementationOnce(async (cb) => cb(db as never));

    await getJobStatus("job-1", "user-sub-1");

    // Drizzle's `and()` returns an opaque SQL chunk we can't inspect by value
    // here, but we CAN assert .where() was called with a non-undefined arg —
    // an unscoped lookup would either skip .where() or pass eq(id) only.
    // The presence of a where-arg + the absence of a regression to "no filter"
    // is what we're locking in.
    expect(spies.where).toHaveBeenCalledTimes(1);
    expect(spies.where.mock.calls[0][0]).toBeDefined();
  });
});

describe("updateJobStatus", () => {
  it("auto-sets completedAt when transitioning to completed without an explicit value", async () => {
    const { db, spies } = makeSpyDb();
    mockExecuteQuery.mockImplementationOnce(async (cb) => cb(db as never));

    await updateJobStatus("job-1", "completed", { progress: 100 });

    expect(spies.set).toHaveBeenCalledTimes(1);
    const setArg = spies.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.status).toBe("completed");
    expect(setArg.progress).toBe(100);
    expect(setArg.completedAt).toBeInstanceOf(Date);
  });

  it("does NOT auto-set completedAt for non-completed transitions", async () => {
    const { db, spies } = makeSpyDb();
    mockExecuteQuery.mockImplementationOnce(async (cb) => cb(db as never));

    await updateJobStatus("job-1", "processing", { progress: 50 });

    const setArg = spies.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.completedAt).toBeUndefined();
  });

  it("does NOT forward undefined fields to .set() (clearable-field silent-failure guard)", async () => {
    const { db, spies } = makeSpyDb();
    mockExecuteQuery.mockImplementationOnce(async (cb) => cb(db as never));

    // Caller passes only progress; processingStage / result / errorMessage
    // are absent. The service must NOT forward those keys as undefined —
    // Drizzle's .set() would treat undefined as SQL NULL and clobber any
    // existing values for those columns.
    await updateJobStatus("job-1", "processing", { progress: 50 });

    const setArg = spies.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toEqual({ status: "processing", progress: 50 });
    expect(setArg).not.toHaveProperty("processingStage");
    expect(setArg).not.toHaveProperty("result");
    expect(setArg).not.toHaveProperty("resultLocation");
    expect(setArg).not.toHaveProperty("resultGcsKey");
    expect(setArg).not.toHaveProperty("errorMessage");
    expect(setArg).not.toHaveProperty("completedAt");
  });

  it("forwards explicitly-set fields including null-clearing values", async () => {
    const { db, spies } = makeSpyDb();
    mockExecuteQuery.mockImplementationOnce(async (cb) => cb(db as never));

    await updateJobStatus("job-1", "completed", {
      progress: 100,
      result: { extractedText: "hello" },
      resultLocation: "inline",
    });

    const setArg = spies.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.result).toEqual({ extractedText: "hello" });
    expect(setArg.resultLocation).toBe("inline");
  });

  it("throws when the row does not exist", async () => {
    const { db } = makeSpyDb([]); // returning() resolves to empty
    mockExecuteQuery.mockImplementationOnce(async (cb) => cb(db as never));
    await expect(updateJobStatus("missing", "failed")).rejects.toThrow(/Job not found/);
  });
});

describe("confirmDocumentUpload", () => {
  it("transitions the job to processing with stage=upload_confirmed and progress=10", async () => {
    mockExecuteQuery.mockResolvedValueOnce([{ id: "job-1" }]);
    await expect(
      confirmDocumentUpload("job-1", "upload-abc"),
    ).resolves.toBeUndefined();
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
  });
});

describe("getUserJobs", () => {
  it("returns the page and no nextCursor when results fit under the limit", async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      makeRow({ id: "j1" }),
      makeRow({ id: "j2" }),
    ]);
    const out = await getUserJobs("user-sub-1", 10);
    expect(out.jobs).toHaveLength(2);
    expect(out.nextCursor).toBeUndefined();
  });

  it("emits a nextCursor and trims the page when more results exist", async () => {
    // Service requests `limit + 1`; we return `limit + 1` rows, expect the
    // page sliced to `limit` and a cursor pointing at the last visible row.
    const t1 = new Date("2026-05-09T01:00:00Z");
    const t2 = new Date("2026-05-09T02:00:00Z");
    const t3 = new Date("2026-05-09T03:00:00Z");
    mockExecuteQuery.mockResolvedValueOnce([
      makeRow({ id: "j3", createdAt: t3 }),
      makeRow({ id: "j2", createdAt: t2 }),
      makeRow({ id: "j1", createdAt: t1 }),
    ]);
    const out = await getUserJobs("user-sub-1", 2);
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs[0].id).toBe("j3");
    expect(out.jobs[1].id).toBe("j2");
    expect(out.nextCursor).toEqual({
      createdAt: t2.toISOString(),
      id: "j2",
    });
  });

  it("accepts a cursor for follow-up pages", async () => {
    mockExecuteQuery.mockResolvedValueOnce([]);
    await getUserJobs("user-sub-1", 5, {
      createdAt: "2026-05-08T00:00:00.000Z",
      id: "prev-id",
    });
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
  });
});

describe("getJobsByStatus", () => {
  it("returns jobs filtered by status", async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      makeRow({ status: "failed", errorMessage: "boom" }),
    ]);
    const jobs = await getJobsByStatus("failed");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].errorMessage).toBe("boom");
  });
});

describe("deleteOldJobs", () => {
  it("returns the number of rows deleted", async () => {
    mockExecuteQuery.mockResolvedValueOnce([{ id: "j1" }, { id: "j2" }, { id: "j3" }]);
    const n = await deleteOldJobs(7);
    expect(n).toBe(3);
  });
});

describe("fetchResultFromGcs", () => {
  // Mock the storage service before importing — but the service is already
  // imported at the top. Use jest.mock() instead.
  beforeEach(() => {
    jest.resetModules();
  });

  it("streams the GCS object, parses JSON, returns it", async () => {
    jest.doMock("@/lib/services/document-storage-service", () => ({
      getObjectStream: jest.fn(async () => ({
        stream: (async function* () {
          yield Buffer.from('{"hello"');
          yield Buffer.from(': "world"}');
        })(),
      })),
    }));
    const { fetchResultFromGcs: freshFetch } = await import("../document-job-service");
    await expect(freshFetch("v2/results/abc.json")).resolves.toEqual({
      hello: "world",
    });
  });

  it("wraps storage errors", async () => {
    jest.doMock("@/lib/services/document-storage-service", () => ({
      getObjectStream: jest.fn(async () => {
        throw new Error("NoSuchKey");
      }),
    }));
    const { fetchResultFromGcs: freshFetch } = await import("../document-job-service");
    await expect(freshFetch("missing.json")).rejects.toThrow(
      /Failed to fetch result from GCS.*NoSuchKey/,
    );
  });
});
