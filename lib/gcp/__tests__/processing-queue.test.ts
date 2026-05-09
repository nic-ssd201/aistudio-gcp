/**
 * Unit tests for the Cloud Tasks dispatcher.
 *
 * The @google-cloud/tasks SDK is mocked at the module boundary; tests inspect
 * the args we passed to createTask to verify the queue path, payload shape,
 * and OIDC token config without making real RPCs.
 */

import {
  sendToProcessingQueue,
  triggerLambdaProcessing,
  retryFailedJob,
  _resetForTesting,
  type ProcessingJobMessage,
} from "../processing-queue";

const createTaskMock = jest.fn();
const queuePathMock = jest.fn(
  (project: string, location: string, queue: string) =>
    `projects/${project}/locations/${location}/queues/${queue}`,
);

jest.mock("@google-cloud/tasks", () => ({
  CloudTasksClient: jest.fn().mockImplementation(() => ({
    createTask: createTaskMock,
    queuePath: queuePathMock,
  })),
}));

const QUEUE = "projects/aistudio-staging/locations/us-west1/queues/aistudio-doc-processing";
const TARGET = "https://aistudio-doc-processor-abc123-uw.a.run.app/process-job";
const INVOKER = "doc-proc@aistudio-staging.iam.gserviceaccount.com";

const baseMessage: ProcessingJobMessage = {
  jobId: "11111111-1111-4111-8111-111111111111",
  bucket: "aistudio-staging-attachments",
  key: "v2/uploads/job-1/file.pdf",
  fileName: "file.pdf",
  fileSize: 1024,
  fileType: "application/pdf",
  userId: "user-sub-1",
  processingOptions: {
    extractText: true,
    convertToMarkdown: false,
    extractImages: false,
    generateEmbeddings: false,
    ocrEnabled: false,
  },
};

const originalEnv = process.env;

beforeEach(() => {
  process.env = {
    ...originalEnv,
    NODE_ENV: "test",
    PROCESSING_QUEUE_NAME: QUEUE,
    PROCESSING_TARGET_URL: TARGET,
    PROCESSING_INVOKER_SA: INVOKER,
  };
  createTaskMock.mockReset();
  createTaskMock.mockResolvedValue([{}]);
  queuePathMock.mockClear();
  // Force a fresh client for each test.
  _resetForTesting();
});

afterAll(() => {
  process.env = originalEnv;
});

describe("sendToProcessingQueue", () => {
  it("creates a task with the queue path, payload, and OIDC config", async () => {
    await sendToProcessingQueue(baseMessage);

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    const arg = createTaskMock.mock.calls[0][0];
    expect(arg.parent).toBe(QUEUE);
    expect(arg.task.name).toBe(`${QUEUE}/tasks/${baseMessage.jobId}-v1`);

    const http = arg.task.httpRequest;
    expect(http.url).toBe(TARGET);
    expect(http.httpMethod).toBe("POST");
    expect(http.headers["Content-Type"]).toBe("application/json");
    expect(http.oidcToken).toEqual({
      serviceAccountEmail: INVOKER,
      audience: TARGET,
    });

    const body = JSON.parse(Buffer.from(http.body).toString("utf8"));
    expect(body).toEqual({ message: baseMessage });
  });

  it("treats Cloud Tasks ALREADY_EXISTS as success (dedup)", async () => {
    createTaskMock.mockRejectedValueOnce(
      new Error("6 ALREADY_EXISTS: Requested entity already exists"),
    );

    await expect(sendToProcessingQueue(baseMessage)).resolves.toBeUndefined();
  });

  it("wraps unexpected errors with a clear message", async () => {
    createTaskMock.mockRejectedValueOnce(new Error("PERMISSION_DENIED"));

    await expect(sendToProcessingQueue(baseMessage)).rejects.toThrow(
      /Failed to queue processing for job 11111111.*PERMISSION_DENIED/,
    );
  });

  it("rejects malformed PROCESSING_QUEUE_NAME at the parse step", async () => {
    process.env.PROCESSING_QUEUE_NAME = "not-a-queue-path";
    _resetForTesting();
    await expect(sendToProcessingQueue(baseMessage)).rejects.toThrow(
      /must be a fully-qualified queue resource path/,
    );
  });
});

describe("retryFailedJob", () => {
  it("computes exponential backoff capped at 5 minutes and tags the task name with the attempt", async () => {
    await retryFailedJob("job-1", 3);
    const arg = createTaskMock.mock.calls[0][0];
    expect(arg.task.name).toMatch(/job-1-retry-3$/);
    // 2^3 = 8 seconds — well under the 300s cap.
    const nowSec = Math.floor(Date.now() / 1000);
    expect(arg.task.scheduleTime.seconds).toBeGreaterThanOrEqual(nowSec + 7);
    expect(arg.task.scheduleTime.seconds).toBeLessThanOrEqual(nowSec + 10);
  });

  it("caps backoff at 5 minutes for high attempt numbers", async () => {
    await retryFailedJob("job-1", 20);
    const arg = createTaskMock.mock.calls[0][0];
    const nowSec = Math.floor(Date.now() / 1000);
    expect(arg.task.scheduleTime.seconds).toBeGreaterThanOrEqual(nowSec + 295);
    expect(arg.task.scheduleTime.seconds).toBeLessThanOrEqual(nowSec + 305);
  });
});

describe("triggerLambdaProcessing", () => {
  it("dispatches without delay when priority=true", async () => {
    await triggerLambdaProcessing("job-1", { priority: true });
    const arg = createTaskMock.mock.calls[0][0];
    expect(arg.task.scheduleTime).toBeUndefined();
  });
});
