import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { getJobForUser, fetchResultFromGcs } from '@/lib/services/document-job-service';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer('api.documents.v2.jobs.get');
  const log = createLogger({ requestId, route: 'api.documents.v2.jobs' });
  
  
  try {
    // Authentication
    const session = await getServerSession();
    if (!session?.sub) {
      log.warn('Unauthorized request');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    const resolvedParams = await params;
    const jobId = resolvedParams.jobId;
    
    // Get job with user ID for security
    const job = await getJobForUser(session.sub, jobId);
    
    if (!job) {
      log.warn('Job not found', { jobId, userId: session.sub });
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    
    // Large results live in GCS rather than inline JSONB. The file-processor
    // sets resultLocation = 'gcs' + resultGcsKey when the extracted output
    // exceeds the inline threshold; small results stay in `job.result`.
    let result = job.result;
    if (job.resultLocation === 'gcs' && job.resultGcsKey) {
      try {
        result = await fetchResultFromGcs(job.resultGcsKey);
      } catch (error) {
        log.error('Failed to fetch result from GCS', { error, jobId, gcsKey: job.resultGcsKey });
        // Continue with undefined result rather than failing the request
        result = undefined;
      }
    }
    
    timer({ status: 'success' });
    
    // Return job status with results if available
    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      progress: job.progress || 0,
      processingStage: job.processingStage,
      result: job.status === 'completed' ? result : null,
      error: job.errorMessage,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      fileName: job.fileName,
      fileSize: job.fileSize,
      fileType: job.fileType,
      purpose: job.purpose,
      processingOptions: job.processingOptions,
    });
    
  } catch (error) {
    log.error('Failed to get job status', error);
    timer({ status: 'error' });
    return NextResponse.json(
      { error: 'Failed to get job status' },
      { status: 500 }
    );
  }
}