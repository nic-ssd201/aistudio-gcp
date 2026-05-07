import { NextRequest } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { getConversationById } from '@/lib/db/drizzle';
import { getActiveStorageBucketName, getDocumentSignedUrl } from '@/lib/services/document-storage-service';

/**
 * Secure Image Proxy API
 * GET /api/images/[...key] - Serve images from storage with authentication
 * 
 * This endpoint provides secure access to AI-generated images stored in the configured storage provider
 * by generating short-lived presigned URLs after authentication checks.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer('api.images.get');
  const log = createLogger({ requestId, route: 'api.images.get' });
  
  const { key: keyParts } = await params;
  const gcsKey = keyParts.join('/');
  
  log.info('Image request received', { gcsKey });
  
  try {
    // 1. Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request - no session', { gcsKey });
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response('Unauthorized', { status: 401 });
    }
    
    // 2. Get current user
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user', { gcsKey });
      return new Response('Unauthorized', { status: 401 });
    }
    
    // 3. Validate that this is an AI-generated image path
    if (!gcsKey.startsWith('v2/generated-images/')) {
      log.warn('Invalid image path - not AI generated', { gcsKey, userId: currentUser.data.user.id });
      return new Response('Not Found', { status: 404 });
    }

    // 4. Extract conversation ID from path for ownership validation
    // Path format: v2/generated-images/{conversationId}/{filename}
    const pathParts = gcsKey.split('/');
    if (pathParts.length < 4) {
      log.warn('Invalid image path format', { gcsKey, pathParts });
      return new Response('Not Found', { status: 404 });
    }

    const conversationId = pathParts[2];

    // Validate UUID format before database query
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(conversationId)) {
      log.warn('Invalid conversation ID format in path', { conversationId, gcsKey });
      return new Response('Not Found', { status: 404 });
    }

    const userId = currentUser.data.user.id;

    // 5. Verify conversation ownership (user can only access their own generated images)
    const conversation = await getConversationById(conversationId, userId);

    if (!conversation) {
      log.warn('Conversation not found for image access', { conversationId, gcsKey, userId });
      return new Response('Not Found', { status: 404 });
    }
    
    // 6. Generate provider-aware signed URL for the image (valid for 1 hour)
    const bucketName = getActiveStorageBucketName();
    if (!bucketName) {
      log.error('Storage bucket name not configured');
      return new Response('Internal Server Error', { status: 500 });
    }
    
    log.info('Image access granted, redirecting to presigned URL', {
      conversationId,
      gcsKey,
      userId
    });
    
    timer({ status: 'success' });
    
    // 7. Generate and redirect to the presigned URL
    const presignedUrl = await getDocumentSignedUrl({ key: gcsKey, expiresIn: 3600 });
    return Response.redirect(presignedUrl, 302);
    
  } catch (error) {
    log.error('Image proxy error', { 
      gcsKey,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
    
    timer({ status: 'error' });
    
    return new Response('Internal Server Error', { status: 500 });
  }
}