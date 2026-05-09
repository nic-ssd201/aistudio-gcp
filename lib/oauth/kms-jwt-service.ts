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
import { createLogger } from "@/lib/logger"

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

    try {
      const [response] = await this.client.asymmetricSign({
        name: this.keyName,
        digest: { sha256: digest },
      })

      if (!response.signature) {
        throw new Error("KMS asymmetricSign returned no signature")
      }

      const signatureBytes =
        typeof response.signature === "string"
          ? Buffer.from(response.signature, "base64")
          : Buffer.from(response.signature)

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
   */
  async getPublicKeyJwk(): Promise<JwksKey> {
    const now = Date.now()

    if (this.publicKeyCache && now - this.publicKeyCache.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
      return this.publicKeyCache.jwk
    }

    const log = createLogger({ action: "KmsJwtService.getPublicKeyJwk" })

    const [response] = await this.client.getPublicKey({ name: this.keyName })
    if (!response.pem) {
      throw new Error("KMS getPublicKey returned no PEM")
    }

    const exported = createPublicKey(response.pem).export({ format: "jwk" }) as {
      kty: string
      n: string
      e: string
    }

    const jwk: JwksKey = {
      kty: exported.kty,
      use: "sig",
      kid: this.kid,
      alg: "RS256",
      n: exported.n,
      e: exported.e,
    }

    this.publicKeyCache = { jwk, fetchedAt: now }
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

function bufferToBase64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}
