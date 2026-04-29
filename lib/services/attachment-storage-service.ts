import { createLogger } from '@/lib/logger';
import type { UIMessage } from 'ai';
import { generateUUID } from '@/lib/utils/uuid';
import {
  uploadDocument as uploadDocumentToGcs,
  getObjectStream as getGcsObjectStream,
} from '@/lib/gcp/gcs-client';

const log = createLogger({ service: 'attachment-storage' });

type StorageProvider = 'gcs';

function getStorageProvider(): StorageProvider {
  return 'gcs';
}

async function uploadAttachmentObject(params: {
  keyPrefix: string;
  body: string;
  metadata: Record<string, string>;
}): Promise<string> {
  const result = await uploadDocumentToGcs({
    userId: 'conversations',
    fileName: params.keyPrefix.replace(/^conversations\//, ''),
    fileContent: params.body,
    contentType: 'application/json',
    metadata: params.metadata,
  });

  return result.key;
}

async function readAttachmentObject(key: string): Promise<string> {
  const response = await getGcsObjectStream(key);

  const chunks: Buffer[] = [];
  for await (const chunk of response.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf-8');
}

export interface AttachmentMetadata {
  gcsKey: string;
  originalName: string;
  contentType: string;
  size: number;
  attachmentId: string;
}

export interface AttachmentContent {
  id?: string;
  name?: string;
  type: 'image' | 'document' | 'file';
  contentType?: string;
  image?: string; // base64 data for images
  data?: string; // data for documents/files
  content?: string; // alternative data field
}

export interface StoredAttachment {
  type: 'image' | 'document' | 'file';
  gcsKey: string;
  originalContent: AttachmentContent;
  metadata: AttachmentMetadata;
}

/**
 * Store attachment content in GCS with conversation-scoped keys.
 */
export async function storeAttachmentInGCS(
  conversationId: string,
  messageId: string,
  attachment: AttachmentContent,
  attachmentIndex: number
): Promise<AttachmentMetadata> {
  try {
    const attachmentId = attachment.id || generateUUID();
    const sanitizedName = sanitizeFileName(attachment.name || 'attachment');

    const objectKeyPrefix = `conversations/${conversationId}/attachments/${messageId}-${attachmentIndex}-${sanitizedName}`;

    let contentToStore: Record<string, unknown>;

    if (attachment.type === 'image' && attachment.image) {
      contentToStore = {
        type: 'image',
        image: attachment.image,
        name: attachment.name,
        contentType: attachment.contentType
      };
    } else if (attachment.type === 'document' || attachment.type === 'file') {
      contentToStore = {
        type: attachment.type,
        data: attachment.data || attachment.content,
        name: attachment.name,
        contentType: attachment.contentType
      };
     } else {
      throw new Error(`Unsupported attachment type: ${attachment.type}`);
    }

    const serializedContent = JSON.stringify(contentToStore);

    const objectKey = await uploadAttachmentObject({
      keyPrefix: objectKeyPrefix,
      body: serializedContent,
      metadata: {
        conversationId,
        messageId,
        attachmentId,
        originalName: sanitizedName,
        attachmentType: attachment.type,
      },
     });

    log.info('Attachment stored in GCS', {
      provider: 'gcs',
      conversationId,
      messageId,
      attachmentId,
      gcsKey: objectKey,
      size: serializedContent.length
     });

    return {
      gcsKey: objectKey,
      originalName: attachment.name || 'attachment',
      contentType: attachment.contentType || 'application/octet-stream',
      size: serializedContent.length,
      attachmentId
     };

  } catch (error) {
    log.error('Failed to store attachment in GCS', {
      provider: 'gcs',
      conversationId,
      messageId,
      error: error instanceof Error ? error.message : String(error)
     });
    throw new Error(`Failed to store attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Retrieve attachment content from GCS.
 */
export async function getAttachmentFromGCS(gcsKey: string): Promise<AttachmentContent> {
  try {
    const bodyText = await readAttachmentObject(gcsKey);
    const attachmentData = JSON.parse(bodyText) as AttachmentContent;

    log.info('Attachment retrieved from GCS', {
      provider: 'gcs',
      gcsKey,
      type: attachmentData.type,
      size: bodyText.length
     });

    return attachmentData;

  } catch (error) {
    log.error('Failed to retrieve attachment from GCS', {
      provider: 'gcs',
      gcsKey,
      error: error instanceof Error ? error.message : String(error)
     });
    throw new Error(`Failed to retrieve attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Process messages to extract and store attachments in GCS.
 * Returns lightweight messages with object-key references.
 */
export async function processMessagesWithAttachments(
  conversationId: string,
  messages: UIMessage[]
): Promise<{ lightweightMessages: UIMessage[], attachmentReferences: AttachmentMetadata[] }> {
  const lightweightMessages: UIMessage[] = [];
  const attachmentReferences: AttachmentMetadata[] = [];

  for (const message of messages) {
    const messageId = generateUUID();

    if (Array.isArray(message.parts)) {
      const lightweightParts = [];
      let attachmentIndex = 0;

      for (const part of message.parts) {
        const partData = part as { type: string; image?: string; data?: string; content?: string; name?: string; mediaType?: string; [key: string]: unknown };
        if (partData.type === 'image' && partData.image) {
          const metadata = await storeAttachmentInGCS(
            conversationId,
            messageId,
            partData as AttachmentContent,
            attachmentIndex++
           );

          attachmentReferences.push(metadata);

          lightweightParts.push({
            type: 'image' as const,
            image: `gs://${metadata.gcsKey}`,
            gcsKey: metadata.gcsKey,
            attachmentId: metadata.attachmentId
           } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
         } else if ((partData.type === 'document' || partData.type === 'file') && (partData.data || partData.content)) {
          const metadata = await storeAttachmentInGCS(
            conversationId,
            messageId,
            partData as AttachmentContent,
            attachmentIndex++
           );

          attachmentReferences.push(metadata);

          lightweightParts.push({
            type: 'file' as const,
            url: `gs://${metadata.gcsKey}`,
            mediaType: partData.mediaType || 'application/octet-stream',
            filename: partData.name,
            gcsKey: metadata.gcsKey,
            attachmentId: metadata.attachmentId
           } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
         } else {
          lightweightParts.push(part);
         }
       }

      lightweightMessages.push({
         ...message,
        parts: lightweightParts
       });
     } else {
      lightweightMessages.push(message);
     }
   }

  return { lightweightMessages, attachmentReferences };
}

/**
 * Reconstruct full messages with attachment data from GCS.
 */
export async function reconstructMessagesWithAttachments(
  lightweightMessages: UIMessage[],
  attachmentReferences: AttachmentMetadata[]
): Promise<UIMessage[]> {
  const fullMessages: UIMessage[] = [];

  for (const message of lightweightMessages) {
    if (Array.isArray(message.parts)) {
      const fullParts = [];

      for (const part of message.parts) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.startsWith('[Image:') && part.text.includes('conversation context')) {
          const matchingAttachment = attachmentReferences.find(ref =>
            part.text && part.text.includes(ref.originalName)
           );

          if (matchingAttachment) {
            const attachmentData = await getAttachmentFromGCS(matchingAttachment.gcsKey);
            fullParts.push(attachmentData);
           } else {
            fullParts.push(part);
           }
         } else {
          fullParts.push(part);
         }
       }

      fullMessages.push({
         ...message,
        parts: fullParts as UIMessage['parts']
       });
     } else {
      fullMessages.push(message);
     }
   }

  return fullMessages;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^\d.A-Za-z-]/g, '_').substring(0, 255);
}
