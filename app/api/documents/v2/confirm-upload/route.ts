import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { confirmDocumentUpload, getJobForUser } from '@/lib/services/document-job-service';
import { sendToProcessingQueue } from '@/lib/gcp/processing-queue';
import { getDocumentUploadBucketName, resolveUploadedDocumentKey } from '@/lib/services/document-upload-service';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { z } from 'zod';

const ConfirmUploadSchema = z.object({
  uploadId: z.string().min(1),
  jobId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer('api.documents.v2.confirm-upload');
  const log = createLogger({ requestId, route: 'api.documents.v2.confirm-upload' });
  
  try {
    const session = await getServerSession();
    if (!session?.sub) {
      log.warn('Unauthorized request');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    const body = await req.json();
    const { uploadId, jobId } = ConfirmUploadSchema.parse(body);
    
    log.info('Confirming upload', { uploadId, jobId, userId: session.sub });
    
    // Get job details to verify ownership and get processing info
    const job = await getJobForUser(session.sub, jobId);
    if (!job) {
      log.warn('Job not found for confirmation', { jobId, userId: session.sub });
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    
    // Confirm upload in job tracking
    await confirmDocumentUpload(session.sub, jobId, uploadId);
    
    const storageKey = resolveUploadedDocumentKey({ uploadId, jobId, fileName: job.fileName });
    const bucketName = getDocumentUploadBucketName();

    if (process.env.NODE_ENV !== 'test' && !bucketName) {
      log.error('Storage bucket environment variable not configured');
      return NextResponse.json({ error: 'Service configuration error' }, { status: 500 });
    }

    // Send processing job to NEW DocumentProcessingStack queue
    await sendToProcessingQueue({
      jobId,
      bucket: bucketName,
      key: storageKey,
      fileName: job.fileName,
      fileSize: job.fileSize,
      fileType: job.fileType,
      userId: session.sub,
      processingOptions: job.processingOptions,
    });
    
    log.info('Upload confirmed and processing queued', { jobId, uploadId });
    timer({ status: 'success' });
    
    return NextResponse.json({ 
      success: true,
      jobId,
      status: 'processing',
      message: 'Upload confirmed and processing started'
    });
    
  } catch (error) {
    // Safe error logging to avoid circular reference issues
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'Unknown';
    log.error(`Failed to confirm upload ${errorMessage}`, { name: errorName });
    timer({ status: 'error' });

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: 'Invalid request data',
          details: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`)
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to confirm upload' },
      { status: 500 }
    );
  }
}