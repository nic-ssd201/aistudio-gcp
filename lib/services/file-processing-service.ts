import { v4 as uuidv4 } from 'uuid';
import { PubSub } from '@google-cloud/pubsub';

const pubsub = new PubSub();

interface FileProcessingJob {
  jobId: string;
  itemId: number;
  fileKey: string;
  fileName: string;
  fileType: string;
  bucketName: string;
}

interface URLProcessingJob {
  jobId: string;
  itemId: number;
  url: string;
  itemName: string;
}

/**
 * Queue a file for processing via Cloud Pub/Sub
 */
export async function queueFileForProcessing(
  itemId: number,
  fileKey: string,
  fileName: string,
  fileType: string
): Promise<string> {
  const topicName = process.env.FILE_PROCESSING_TOPIC || 'file-processing';

  const jobId = uuidv4();
  const job: FileProcessingJob = {
    jobId,
    itemId,
    fileKey,
    fileName,
    fileType,
    bucketName: process.env.DOCUMENTS_BUCKET_NAME || process.env.GCS_BUCKET || '',
    };

  const topic = pubsub.topic(topicName);
  const message = Buffer.from(JSON.stringify(job)).toString('base64');

  await topic.publishMessage({
    data: message,
    attributes: {
      itemId: itemId.toString(),
      jobType: 'file',
      },
    });

  return jobId;
}

/**
 * Process a URL directly (invoke Cloud Run Job)
 */
export async function processUrl(
  itemId: number,
  url: string,
  itemName: string
): Promise<string> {
  const jobId = uuidv4();
  const job: URLProcessingJob = {
    jobId,
    itemId,
    url,
    itemName,
    };

    // TODO: Wire up to Cloud Run Job invocation via gcloud or REST API
    // For now, publish to a URL processing topic as a placeholder
  const topicName = process.env.URL_PROCESSING_TOPIC || 'url-processing';
  const topic = pubsub.topic(topicName);

  await topic.publishMessage({
    data: Buffer.from(JSON.stringify(job)).toString('base64'),
    attributes: {
      itemId: itemId.toString(),
      },
    });

  return jobId;
}
