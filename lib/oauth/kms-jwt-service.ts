/**
 * KMS-backed JWT signing service.
 *
 * Signs JWTs by delegating the RSA-SHA256 signature operation to Google Cloud KMS,
 * so the private key never leaves KMS and every Cloud Run instance signs against the
 * same key (the previous in-process keypair generation produced a different keypair
 * per instance — tokens signed by instance A failed verification at instance B).
 *
 * Key resource paths look like:
 *   projects/<P>/locations/<L>/keyRings/<R>/cryptoKeys/<K>/cryptoKeyVersions/<V>
 *
 * The constructor expects a fully-qualified key version path. The trailing
 * "<key-name>-v<version>" pair is used as the JWK `kid` so verifiers see a stable,
 * version-aware identifier across the fleet.
 *
 * Required IAM on the key:
 *   roles/cloudkms.signer         — for asymmetricSign
 *   roles/cloudkms.viewer         — for getPublicKey
 * (Or roles/cloudkms.signerVerifier which covers both.)
 *
 * Required key configuration:
 *   purpose                = ASYMMETRIC_SIGN
 *   version_template.algorithm
 *     = RSA_SIGN_PKCS1_2048_SHA256  (RS256 — what this service produces)
 *
 * Part of Issue #686 — MCP Server + OAuth2/OIDC Provider (Phase 3).
 * Replaces the deploy-blocker keypair-per-instance behavior flagged on PR #8.
 */

import { createHash, createPublicKey } from "node:crypto"
import { KeyManagementServiceClient } from "@google-cloud/kms"
import { Crc32c } from "@aws-crypto/crc32c"
import { createLogger } from "@/lib/logger"

// Compute CRC32C of a byte sequence. The @aws-crypto/crc32c package exposes a
// streaming hasher; for our small payloads (digest is 32 bytes, signature is
// 256 bytes for RSA-2048) a one-shot wrapper is clearer at call sites.
function crc32c(bytes: Uint8Array): number {
  const c = new Crc32c()
  c.update(bytes)
  return c.digest()
}

// ============================================
// Types
// ============================================

export interface JwksKey {
  kty: string
  use: string
  kid: string
  alg: string
  n: string
  e: string
}

interface CachedPublicKey {
  jwk: JwksKey
  fetchedAt: number
}

// ============================================
// Constants
// ============================================

const PUBLIC_KEY_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// Match a fully-qualified KMS key version path (the only form we accept).
// projects/<P>/locations/<L>/keyRings/<R>/cryptoKeys/<K>/cryptoKeyVersions/<V>
const KEY_VERSION_PATH_RE =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/([^/]+)\/cryptoKeyVersions\/([^/]+)$/

// ============================================
// JWT Signer
// ============================================

export class KmsJwtService {
  private readonly keyName: string
  private readonly kid: string
  private readonly client: KeyManagementServiceClient
  private publicKeyCache: CachedPublicKey | null = null
  private pendingFetch: Promise<JwksKey> | null = null

  /**
   * @param keyName    Fully-qualified KMS cryptoKeyVersion resource name.
   * @param kid        Optional override for the JWK `kid`. Defaults to
   *                   "<crypto-key-name>-v<version>" parsed from `keyName`.
   * @param client     Optional injected client (for tests). A real
   *                   KeyManagementServiceClient is constructed otherwise.
   */
  constructor(
    keyName: string,
    kid?: string,
    client?: KeyManagementServiceClient,
  ) {
    const match = KEY_VERSION_PATH_RE.exec(keyName)
    if (!match) {
      throw new Error(
        `KmsJwtService: keyName must be a KMS cryptoKeyVersion resource path ` +
          `(projects/.../keyRings/.../cryptoKeys/.../cryptoKeyVersions/N). ` +
          `Got: "${keyName}"`,
      )
    }

    this.keyName = keyName
    this.kid = kid ?? `${match[1]}-v${match[2]}`
    this.client = client ?? new KeyManagementServiceClient()
  }

  /**
   * Sign a JWT with RS256 using the configured KMS key.
   *
   * KMS's asymmetricSign expects a pre-computed digest of the signing input
   * (header.payload), not the raw bytes — the digest is hashed locally and the
   * resulting bytes are sent to KMS along with the algorithm hint.
   */
  async signJwt(payload: Record<string, unknown>): Promise<string> {
    const log = createLogger({ action: "KmsJwtService.signJwt" })

    const header = {
      alg: "RS256",
      typ: "JWT",
      kid: this.kid,
    }

    const headerB64 = base64UrlEncode(JSON.stringify(header))
    const payloadB64 = base64UrlEncode(JSON.stringify(payload))
    const signingInput = `${headerB64}.${payloadB64}`

    const digest = createHash("sha256").update(signingInput).digest()
    // CRC32C round-trip per https://cloud.google.com/kms/docs/data-integrity-guidelines:
    // we send digestCrc32c so KMS can detect transit corruption of the digest, and
    // we verify verifiedDigestCrc32c (KMS confirms the digest it processed) and
    // signatureCrc32c (we confirm the signature reached us intact).
    const digestCrc = crc32c(digest)

    try {
      const [response] = await this.client.asymmetricSign({
        name: this.keyName,
        digest: { sha256: digest },
        digestCrc32c: { value: digestCrc },
      })

      if (!response.signature) {
        throw new Error("KMS asymmetricSign returned no signature")
      }

      // proto codec returns string (base64) when JSON, Uint8Array when gRPC.
      // Buffer.from on a Uint8Array views the same memory; on a string it decodes.
      const signatureBytes: Buffer =
        typeof response.signature === "string"
          ? Buffer.from(response.signature, "base64")
          : Buffer.from(response.signature)

      // KMS echoes back the digest CRC it computed on its side; mismatch means
      // the digest got corrupted in flight from us to KMS.
      if (response.verifiedDigestCrc32c !== true) {
        throw new Error(
          "KMS asymmetricSign did not verify digestCrc32c — request may have been corrupted in transit",
        )
      }
      // The signature CRC must match what we computed on the bytes we received;
      // mismatch means corruption from KMS back to us. Real KMS always populates
      // signatureCrc32c — a missing wrapper signals either a downgraded response
      // shape or a misbehaving mock; log it so the drift is observable.
      const expectedSigCrc = readCrc32cValue(response.signatureCrc32c)
      if (expectedSigCrc === null) {
        log.warn("KMS asymmetricSign omitted signatureCrc32c; integrity check skipped", {
          kid: this.kid,
        })
      } else if (expectedSigCrc !== crc32c(signatureBytes)) {
        throw new Error(
          "KMS asymmetricSign signatureCrc32c mismatch — response may have been corrupted in transit",
        )
      }

      return `${signingInput}.${bufferToBase64Url(signatureBytes)}`
    } catch (error) {
      log.error("JWT signing failed", {
        kid: this.kid,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /**
   * Get the public key in JWK format for the JWKS endpoint.
   * KMS returns a PEM-encoded public key; we parse it locally and re-export as a JWK.
   * Cached with `PUBLIC_KEY_CACHE_TTL_MS` TTL (KMS getPublicKey is cheap but rate-limited).
   *
   * Concurrent cache misses share a single in-flight fetch via `pendingFetch` so
   * N simultaneous JWKS requests during a cold start make exactly one KMS RPC.
   */
  async getPublicKeyJwk(): Promise<JwksKey> {
    const now = Date.now()

    if (this.publicKeyCache && now - this.publicKeyCache.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
      return this.publicKeyCache.jwk
    }

    if (this.pendingFetch) {
      return this.pendingFetch
    }

    this.pendingFetch = this.fetchPublicKey()
    try {
      return await this.pendingFetch
    } finally {
      this.pendingFetch = null
    }
  }

  private async fetchPublicKey(): Promise<JwksKey> {
    const log = createLogger({ action: "KmsJwtService.getPublicKeyJwk" })

    const [response] = await this.client.getPublicKey({ name: this.keyName })
    if (!response.pem) {
      throw new Error("KMS getPublicKey returned no PEM")
    }

    // CRC32C integrity check on the PEM bytes — same data-integrity guideline
    // as asymmetricSign. Real KMS always populates pemCrc32c; a missing wrapper
    // signals either a downgraded response shape or a misbehaving mock, log it.
    const expectedPemCrc = readCrc32cValue(response.pemCrc32c)
    if (expectedPemCrc === null) {
      log.warn("KMS getPublicKey omitted pemCrc32c; integrity check skipped", {
        kid: this.kid,
      })
    } else if (expectedPemCrc !== crc32c(Buffer.from(response.pem, "utf8"))) {
      throw new Error(
        "KMS getPublicKey pemCrc32c mismatch — response may have been corrupted in transit",
      )
    }

    const exported = createPublicKey(response.pem).export({ format: "jwk" }) as {
      kty: string
      n?: string
      e?: string
    }

    // Defensive: this service is RS256-only. If a future config swaps the key
    // algorithm to EC, the JWK shape changes (x/y instead of n/e) and the
    // downstream JWKS consumer would silently get a malformed key. Fail loud here.
    if (exported.kty !== "RSA" || !exported.n || !exported.e) {
      throw new Error(
        `KMS returned a non-RSA public key (kty="${exported.kty}"); ` +
          `KmsJwtService only supports RS256 (RSA_SIGN_PKCS1_2048_SHA256).`,
      )
    }

    const jwk: JwksKey = {
      kty: exported.kty,
      use: "sig",
      kid: this.kid,
      alg: "RS256",
      n: exported.n,
      e: exported.e,
    }

    this.publicKeyCache = { jwk, fetchedAt: Date.now() }
    log.info("Refreshed JWT public key from KMS", { kid: this.kid })
    return jwk
  }

  getKid(): string {
    return this.kid
  }
}

// ============================================
// Encoding Helpers
// ============================================

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function bufferToBase64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/**
 * Pull a CRC32C scalar out of the proto-shaped `Int64Value` wrapper KMS uses
 * for digestCrc32c / signatureCrc32c / pemCrc32c. The proto codec returns
 * `{ value: number | string | Long }`; we normalize to a plain number.
 *
 * Returns `null` when the wrapper is missing, signaling "no CRC available, skip
 * the check rather than fail closed" — this preserves compatibility with KMS
 * responses that legitimately omit the field (e.g. some test/mock paths).
 */
function readCrc32cValue(
  wrapper: { value?: number | string | { toNumber: () => number } | null } | null | undefined,
): number | null {
  if (!wrapper || wrapper.value === null || wrapper.value === undefined) return null
  const v = wrapper.value
  if (typeof v === "number") return v
  if (typeof v === "string") return Number.parseInt(v, 10)
  if (typeof v === "object" && typeof v.toNumber === "function") return v.toNumber()
  return null
}
