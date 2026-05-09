/**
 * Document Jobs Table Schema
 *
 * Async document-processing pipeline tracking. Replaces the prior DynamoDB-backed
 * tracker (which was broken behind @ts-nocheck on this fork). One row per upload;
 * status/progress mutate in place via UPDATE rather than the DynamoDB append-only
 * pattern. Provisioned by migration 067.
 */

import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export interface DocumentJobProcessingOptions {
  extractText: boolean
  convertToMarkdown: boolean
  extractImages: boolean
  generateEmbeddings: boolean
  ocrEnabled: boolean
}

/** Inline result blob for small extraction outputs that fit in JSONB. */
export type DocumentJobResult = Record<string, unknown>

export const documentJobs = pgTable(
  "document_jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // OIDC subject (session.sub) — stored as varchar, NOT a FK to users.id.
    // Document jobs are short-lived; RI to users isn't worth the lookup churn.
    userId: varchar("user_id", { length: 255 }).notNull(),
    fileName: text("file_name").notNull(),
    // BIGINT in the DB so files larger than 2 GiB are representable; the JS
    // postgres driver returns BIGINT as string by default — read sites should
    // Number() the value if they need arithmetic.
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    fileType: varchar("file_type", { length: 255 }).notNull(),
    purpose: varchar("purpose", { length: 50 })
      .notNull()
      .$type<"chat" | "repository" | "assistant">(),
    // No default — the type promises 5 required booleans, and `'{}'::jsonb`
    // would silently violate that. Callers (createDocumentJob) always supply
    // the object; the migration matches by not setting a column DEFAULT either.
    processingOptions: jsonb("processing_options")
      .$type<DocumentJobProcessingOptions>()
      .notNull(),
    status: varchar("status", { length: 50 })
      .notNull()
      .default("pending")
      .$type<"pending" | "processing" | "completed" | "failed">(),
    progress: integer("progress"),
    processingStage: varchar("processing_stage", { length: 255 }),
    result: jsonb("result").$type<DocumentJobResult>(),
    resultLocation: varchar("result_location", { length: 50 }).$type<"inline" | "gcs">(),
    resultGcsKey: varchar("result_gcs_key", { length: 500 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userCreatedAt: index("document_jobs_user_id_created_at_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
    statusCreatedAt: index("document_jobs_status_created_at_idx").on(
      table.status,
      table.createdAt.desc(),
    ),
  }),
)

export type DocumentJobRow = typeof documentJobs.$inferSelect
export type NewDocumentJobRow = typeof documentJobs.$inferInsert
