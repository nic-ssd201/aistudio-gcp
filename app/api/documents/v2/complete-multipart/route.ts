import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { completeMultipartUpload } from '@/lib/aws/document-upload';
import { confirmDocumentUpload, getJobForUser } from '@/lib/services/document-job-service';
import { sendToProcessingQueue } from '@/lib/gcp/processing-queue';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { z } from 'zod';
import { getActiveStorageBucketName, getStorageProvider } from '@/lib/services/document-storage-service';

const CompleteMultipartSchema = z.object({
  uploadId: z.string().min(1),
  jobId: z.string().uuid(),
  parts: z.array(z.object({
    ETag: z.string().min(1),
    PartNumber: z.number().positive(),
  })).min(1),
});

export async function POST(req: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer('api.documents.v2.complete-multipart');
  const log = createLogger({ requestId, route: 'api.documents.v2.complete-multipart' });
  
  try {
    const session = await getServerSession();
    if (!session?.sub) {
      log.warn('Unauthorized request');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    const body = await req.json();
    const { uploadId, jobId, parts } = CompleteMultipartSchema.parse(body);
    
    log.info('Completing multipart upload', { 
      uploadId, 
      jobId, 
      partCount: parts.length,
      userId: session.sub 
    });
    
    // Get job details to verify ownership
    const job = await getJobForUser(session.sub, jobId);
    if (!job) {
      log.warn('Job not found for multipart completion', { jobId, userId: session.sub });
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    
    // Sanitize filename for S3 key
    const sanitizedFileName = job.fileName.replace(/[^\d.A-Za-z-]/g, '_');
    
           // Complete multipart upload (provider-aware)
    const provider = getStorageProvider();
    if (provider === 'gcs') {
         // GCS uses resumable uploads, not multipart — the upload is already complete
         // at this point; just confirm in job tracking.
      log.info('GCS resumable upload confirmed', { jobId });
       } else {
      await completeMultipartUpload(jobId, sanitizedFileName, uploadId, parts);
       }

       // Confirm upload in job tracking
    await confirmDocumentUpload(jobId, uploadId);

       // Generate storage key (provider-agnostic)
    const storageKey = `uploads/${jobId}/${sanitizedFileName}`;
    const bucketName = getActiveStorageBucketName();

       // Send processing job to queue
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
    
    log.info('Multipart upload completed and processing queued', { 
      jobId, 
      uploadId, 
      partCount: parts.length 
    });
    timer({ status: 'success' });
    
    return NextResponse.json({ 
      success: true,
      jobId,
      status: 'processing',
      message: 'Multipart upload completed and processing started',
      partCount: parts.length,
    });
    
  } catch (error) {
    log.error('Failed to complete multipart upload', error);
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
      { error: 'Failed to complete multipart upload' },
      { status: 500 }
    );
  }
}