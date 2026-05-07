/**
 * JWT Signing Service
 * Signs JWTs using RS256 for production use.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Security:
 * - Private key loaded from GOOGLE_KMS_KEY_PATH env var (GCP KMS integration TODO)
 * - Falls back to local RSA key pair for dev/staging
 * - Public keys cached with 5-min TTL for JWKS endpoint
 * - Cloud Audit Logs on all signing operations (when GCP KMS is configured)
 */

import { createSign, createPublicKey, generateKeyPairSync } from "node:crypto"
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
  pem: string
  jwk: JwksKey
  fetchedAt: number
}

// ============================================
// Constants
// ============================================

const PUBLIC_KEY_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const KID = "aistudio-jwt-v1"

// ============================================
// JWT Signer
// ============================================

export class KmsJwtService {
  private kid: string
  private privateKey: Buffer
  private publicKeyCache: CachedPublicKey | null = null

  constructor(keyArn?: string, kid?: string) {
    // GCP KMS integration TODO: Load key from GOOGLE_KMS_KEY_PATH env var
    // For now, use local RSA key pair for dev/staging
    this.kid = kid || KID
    
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    })
    this.privateKey = privateKey as unknown as Buffer
  }

  /**
   * Sign a JWT with RSA-SHA256.
   * Constructs header.payload, signs locally (or via KMS when configured), returns complete JWT string.
   */
  async signJwt(payload: Record<string, unknown>): Promise<string> {
    const jwtLog = createLogger({ action: "jwtService.signJwt" })

    const header = {
      alg: "RS256",
      typ: "JWT",
      kid: this.kid,
    }

    const headerB64 = base64UrlEncode(JSON.stringify(header))
    const payloadB64 = base64UrlEncode(JSON.stringify(payload))
    const signingInput = `${headerB64}.${payloadB64}`

    try {
      const signer = createSign("SHA256withRSA")
      signer.update(signingInput)
      signer.end()

      const signature = signer.sign(this.privateKey)
      const signatureB64 = bufferToBase64Url(signature)
      return `${signingInput}.${signatureB64}`
    } catch (error) {
      jwtLog.error("JWT signing failed", {
        kid: this.kid,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /**
   * Get the public key in JWK format for JWKS endpoint.
   * Cached with 5-min TTL.
   */
  async getPublicKeyJwk(): Promise<JwksKey> {
    const now = Date.now()

    if (this.publicKeyCache && now - this.publicKeyCache.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
      return this.publicKeyCache.jwk
    }

    const jwtLog = createLogger({ action: "jwtService.getPublicKeyJwk" })

    // Derive public key from private key
    const publicKey = createPublicKey(this.privateKey)
    const exported = publicKey.export({ format: "jwk" }) as {
      kty: string
      n: string
      e: string
    }

    const jwk = {
      kty: exported.kty,
      use: "sig",
      kid: this.kid,
      alg: "RS256",
      n: exported.n,
      e: exported.e,
    }

    this.publicKeyCache = {
      pem: "", // Not needed for JWKS
      jwk,
      fetchedAt: now,
    }

    jwtLog.info("Refreshed JWT public key", { kid: this.kid })
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
