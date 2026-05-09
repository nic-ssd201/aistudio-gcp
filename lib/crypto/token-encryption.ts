/**
 * Token Encryption Module (AES-256-GCM)
 *
 * Provides field-level encryption for per-user OAuth tokens and other sensitive
 * connector credentials before database storage. AlloyDB at-rest encryption alone
 * is insufficient for token-level data protection.
 *
 * - Data Encryption Key (DEK) fetched from Google Cloud Secret Manager
 * - Key derived via HKDF-SHA-256 (NIST SP 800-56C) with domain separation
 * - In-process DEK cache with 5-minute TTL, concurrency-safe (single in-flight fetch)
 * - Store format: base64 JSON string containing { ver, iv, tag, data }
 * - Provider-agnostic — works for any connector
 *
 * KEY ROTATION: The encrypted payload includes a `ver` field for forward
 * compatibility with future key versioning. Currently all payloads use ver=1.
 * Rotating the Secret Manager secret without a re-encryption migration will
 * make existing ciphertext unreadable. A future version can add a `kid` field
 * to support multi-key decryption during rotation windows. Do NOT enable
 * automatic rotation on the Secret Manager secret until key versioning is
 * implemented.
 *
 * @see Issue #777 — Part of Epic #774 (Nexus MCP Connectors)
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import { SecretManagerServiceClient } from "@google-cloud/secret-manager"
import { createLogger } from "@/lib/logger"
import { getRequiredEnv } from "@/lib/env-validation"

const log = createLogger({ action: "token-encryption" })

// ─── Constants ───────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12 // 96 bits — recommended for GCM
const AUTH_TAG_LENGTH = 16 // 128 bits
const DEK_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/** Current payload format version. Bump when changing algorithm or envelope. */
const CURRENT_PAYLOAD_VERSION = 1

// HKDF domain separation labels — changing these invalidates all existing ciphertext
const HKDF_SALT = Buffer.from("aistudio-mcp-token-encryption")
const HKDF_INFO = Buffer.from("aes-256-gcm-dek-v1")

// ─── DEK Cache ───────────────────────────────────────────────────────────────

interface CachedDEK {
  key: Buffer
  fetchedAt: number
}

let dekCache: CachedDEK | null = null
let dekFetchPromise: Promise<Buffer> | null = null
let cacheGeneration = 0
let smClient: SecretManagerServiceClient | null = null

function getSecretManagerServiceClient(): SecretManagerServiceClient {
  if (!smClient) {
    // GCP Secret Manager SDK resolves project + endpoint from Application Default
    // Credentials (ADC) on Cloud Run automatically. `projectId` can be supplied
    // explicitly for local dev where ADC may not embed a project. The previous
    // `region` and `maxAttempts` options were AWS SDK artefacts — GCP does not
    // accept them and silently ignored both.
    smClient = new SecretManagerServiceClient({
      ...(process.env.GCP_PROJECT_ID
        ? { projectId: process.env.GCP_PROJECT_ID }
        : {}),
    })
  }
  return smClient
}

/** GCP Secret Manager secret holding the token-encryption DEK. Provisioned by
 *  Terraform (per-env GCP project, so the secret name is not env-prefixed). */
const TOKEN_ENCRYPTION_SECRET_NAME = "aistudio-mcp-token-encryption-key"

/**
 * Fetches and caches the DEK. Uses a generation counter to discard results from
 * a superseded fetch (i.e. if invalidateDEKCache() was called while a fetch was
 * in-flight, the resolved result is discarded rather than re-populating with stale data).
 */
async function fetchAndCacheDEK(fetchGeneration: number): Promise<Buffer> {
  log.info("Fetching token encryption DEK from Secret Manager")

  // Fail-loud on missing GCP_PROJECT_ID. The previous code defaulted to a
  // literal "your-project" which silently misrouted lookups to a non-existent
  // project and surfaced as a confusing 404 at request time.
  const projectId = getRequiredEnv("GCP_PROJECT_ID")
  const client = getSecretManagerServiceClient()
  const [version] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/${TOKEN_ENCRYPTION_SECRET_NAME}/versions/latest`,
       })

  if (!version?.payload?.data) {
    log.warn("Token encryption DEK secret is empty", { secretName: TOKEN_ENCRYPTION_SECRET_NAME })
    throw new Error("Token encryption DEK is unavailable: secret is empty")
     }

   // Derive a 32-byte key via HKDF-SHA-256 (NIST SP 800-56C Rev 2).
   // HKDF provides:
   // - Domain separation via salt and info labels
   // - Proper key stretching beyond a raw hash
   // - Compatibility with any secret string format from Secret Manager
  const key = Buffer.from(
    hkdfSync(
       "sha256",
      version.payload.data.toString("utf8"),
      HKDF_SALT,
      HKDF_INFO,
       32
     )
   )

   // Only populate cache if the generation hasn't been bumped since we started.
   // If invalidateDEKCache() was called during the fetch, cacheGeneration will
   // have incremented and we discard this stale result.
  if (fetchGeneration === cacheGeneration) {
    dekCache = { key, fetchedAt: Date.now() }
    log.info("Token encryption DEK cached successfully")
     } else {
    log.info("Discarding stale DEK fetch (cache was invalidated during fetch)")
     }

  return key
}


/**
 * Derives a DEK from a local env var (MCP_TOKEN_ENCRYPTION_KEY) using the same
 * HKDF flow as the Secret Manager path. For local dev only — avoids requiring
 * GCP credentials just to encrypt/decrypt MCP tokens.
 */
function deriveLocalDEK(envKey: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(envKey, "utf8"),
      HKDF_SALT,
      HKDF_INFO,
      32
    )
  )
}

/**
 * Fetches the Data Encryption Key with in-process caching and concurrency safety.
 *
 * Cache TTL: 5 minutes. Concurrent callers on a cold cache share a single Secrets
 * Manager fetch (thundering-herd protection via the shared in-flight promise).
 * A generation counter prevents a stale in-flight fetch from re-populating the
 * cache after an explicit invalidation.
 *
 * @throws Error if the secret cannot be retrieved
 */
async function getDEK(): Promise<Buffer> {
  // Return cached DEK if still valid
  if (dekCache && Date.now() - dekCache.fetchedAt < DEK_CACHE_TTL) {
    return dekCache.key
  }

  // Local dev fallback: derive from env var instead of Secret Manager.
  // ENVIRONMENT is set by Terraform on the Cloud Run service ("dev" / "staging" /
  // "prod") and is absent in local dev (`bun run dev:local`). When ENVIRONMENT
  // is absent, we're in local dev and MCP_TOKEN_ENCRYPTION_KEY is safe to use.
  // When present, only "dev" is allowed — staging/prod block the env var to
  // force Secret Manager use.
  const localKey = process.env.MCP_TOKEN_ENCRYPTION_KEY
  if (localKey) {
    const environment = process.env.ENVIRONMENT
    if (environment && environment !== "dev") {
      throw new Error(
        `MCP_TOKEN_ENCRYPTION_KEY is not allowed in environment '${environment}'. ` +
          "Use Google Cloud Secret Manager for token encryption in non-dev environments."
      )
    }
    log.warn("Using MCP_TOKEN_ENCRYPTION_KEY env var for DEK — local dev only")
    const key = deriveLocalDEK(localKey)
    dekCache = { key, fetchedAt: Date.now() }
    return key
  }

  // Concurrency guard: if a fetch is already in progress, join it
  if (dekFetchPromise) {
    return dekFetchPromise
  }

  // Capture generation before starting fetch
  const gen = cacheGeneration

  // Start a new fetch and share the promise with concurrent callers.
  // The .finally only clears dekFetchPromise if it still points to THIS promise,
  // preventing a stale .finally callback from clobbering a newer in-flight fetch
  // (e.g. when invalidateDEKCache() is called between two fetches).
  const currentPromise: Promise<Buffer> = fetchAndCacheDEK(gen).finally(() => {
    if (dekFetchPromise === currentPromise) {
      dekFetchPromise = null
    }
  })
  dekFetchPromise = currentPromise

  return dekFetchPromise
}

// ─── Encrypted Token Format ──────────────────────────────────────────────────

interface EncryptedPayload {
  /** Format version — enables future algorithm or envelope changes */
  ver: number
  /** Base64-encoded initialization vector (12 bytes) */
  iv: string
  /** Base64-encoded GCM auth tag (16 bytes) */
  tag: string
  /** Base64-encoded ciphertext */
  data: string
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Encrypts a plaintext token using AES-256-GCM.
 *
 * @param plaintext - The token value to encrypt
 * @returns A base64-encoded JSON string containing { ver, iv, tag, data }
 * @throws Error if the DEK cannot be fetched
 */
export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getDEK()
  const iv = randomBytes(IV_LENGTH)

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])

  const tag = cipher.getAuthTag()

  const payload: EncryptedPayload = {
    ver: CURRENT_PAYLOAD_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  }

  return Buffer.from(JSON.stringify(payload)).toString("base64")
}

/**
 * Decrypts a token that was encrypted with `encryptToken`.
 *
 * @param ciphertext - The base64-encoded JSON string from `encryptToken`
 * @returns The original plaintext token
 * @throws Error if decryption fails (wrong key, tampered data, or invalid format)
 */
export async function decryptToken(ciphertext: string): Promise<string> {
  const key = await getDEK()

  let payload: EncryptedPayload
  try {
    const json = Buffer.from(ciphertext, "base64").toString("utf8")
    payload = JSON.parse(json) as EncryptedPayload
  } catch (err) {
    log.warn("Failed to parse encrypted token payload", { error: String(err) })
    throw new Error("Invalid encrypted token format: failed to parse payload")
  }

  if (payload.iv == null || payload.tag == null || payload.data == null) {
    log.warn("Encrypted token payload missing required fields")
    throw new Error("Invalid encrypted token format: missing iv, tag, or data")
  }

  // Version check — currently only version 1 is supported
  if (payload.ver != null && payload.ver !== CURRENT_PAYLOAD_VERSION) {
    log.warn("Unsupported encrypted token version", { ver: payload.ver })
    throw new Error(`Unsupported encrypted token version: ${payload.ver}`)
  }

  const iv = Buffer.from(payload.iv, "base64")
  const tag = Buffer.from(payload.tag, "base64")
  const data = Buffer.from(payload.data, "base64")

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    })
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([decipher.update(data), decipher.final()])

    return decrypted.toString("utf8")
  } catch (err) {
    log.warn("Token decryption failed — possible key mismatch or tampered data")
    throw err
  }
}

/**
 * Invalidates the cached DEK, forcing a fresh fetch on the next encrypt/decrypt call.
 * Useful after secret rotation.
 *
 * The generation counter ensures that any in-flight fetch from a prior generation
 * does not re-populate the cache with stale key material.
 */
export function invalidateDEKCache(): void {
  dekCache = null
  dekFetchPromise = null
  cacheGeneration++
  log.info("Token encryption DEK cache invalidated")
}

// ─── Testing Utilities ───────────────────────────────────────────────────────

/**
 * Resets internal module state. Only for use in tests.
 * Throws in non-test environments to prevent accidental production use.
 */
export function _resetForTesting(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("_resetForTesting is only available in test environments")
  }
  dekCache = null
  dekFetchPromise = null
  cacheGeneration = 0
  smClient = null
}
