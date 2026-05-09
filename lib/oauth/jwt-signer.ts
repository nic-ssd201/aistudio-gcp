/**
 * JWT Signer Factory
 *
 * Returns a Cloud KMS-backed signer when KMS_SIGNING_KEY_NAME is set
 * (production / staging), or an in-process RSA keypair signer for local dev.
 *
 * KMS_SIGNING_KEY_NAME must be a fully-qualified KMS cryptoKeyVersion path:
 *   projects/<P>/locations/<L>/keyRings/<R>/cryptoKeys/<K>/cryptoKeyVersions/<V>
 *
 * Part of Issue #686 — MCP Server + OAuth2/OIDC Provider (Phase 3).
 */

import { createLogger } from "@/lib/logger"
import type { JwksKey } from "./kms-jwt-service"

// ============================================
// Interface
// ============================================

export interface JwtSigner {
  signJwt(payload: Record<string, unknown>): Promise<string>
  getPublicKeyJwk(): Promise<JwksKey>
  getKid(): string
}

// ============================================
// Local Dev Signer (RSA keypair via jose library)
// ============================================

class LocalJwtSigner implements JwtSigner {
  private kid: string
  // jose v6 uses CryptoKey | KeyObject union; store as unknown for simplicity
  private privateKey: unknown = null
  private publicKeyJwk: JwksKey | null = null
  private initPromise: Promise<void> | null = null

  constructor() {
    this.kid = `local-${Date.now()}`
  }

  private async init(): Promise<void> {
    if (this.privateKey) return
    if (this.initPromise) {
      await this.initPromise
      return
    }

    this.initPromise = this._generateKeyPair()
    await this.initPromise
  }

  private async _generateKeyPair(): Promise<void> {
    const { generateKeyPair, exportJWK } = await import("jose")

    const { privateKey, publicKey } = await generateKeyPair("RS256")
    this.privateKey = privateKey

    const jwk = await exportJWK(publicKey)

    this.publicKeyJwk = {
      kty: jwk.kty!,
      use: "sig",
      kid: this.kid,
      alg: "RS256",
      n: jwk.n!,
      e: jwk.e!,
    }
  }

  async signJwt(payload: Record<string, unknown>): Promise<string> {
    await this.init()

    const { SignJWT } = await import("jose")

    const jwt = await new SignJWT(payload as Record<string, unknown>)
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: this.kid })
      .sign(this.privateKey as CryptoKey)

    return jwt
  }

  async getPublicKeyJwk(): Promise<JwksKey> {
    await this.init()
    return this.publicKeyJwk!
  }

  getKid(): string {
    return this.kid
  }
}

// ============================================
// Factory
// ============================================

let signerInstance: JwtSigner | null = null

export async function getJwtSigner(): Promise<JwtSigner> {
  if (signerInstance) return signerInstance

  const log = createLogger({ action: "getJwtSigner" })
  // KMS_SIGNING_KEY_NAME is the canonical name (fully-qualified KMS cryptoKeyVersion path).
  // KMS_SIGNING_KEY_ARN is accepted as an alias for back-compat with any pre-rename
  // configs, but new deployments should use KMS_SIGNING_KEY_NAME.
  const kmsKeyName =
    process.env.KMS_SIGNING_KEY_NAME ?? process.env.KMS_SIGNING_KEY_ARN

  if (kmsKeyName) {
    if (!process.env.KMS_SIGNING_KEY_NAME && process.env.KMS_SIGNING_KEY_ARN) {
      // Surface stale configs in logs so they can be migrated. The fallback works,
      // but ARN naming is misleading on GCP (no ARNs, just resource paths).
      log.warn(
        "Using deprecated KMS_SIGNING_KEY_ARN env var; rename to KMS_SIGNING_KEY_NAME — back-compat may be removed in a future release",
      )
    }
    log.info("Using KMS JWT signer", {
      keyName: kmsKeyName.substring(0, 80) + (kmsKeyName.length > 80 ? "..." : ""),
    })
    const { KmsJwtService } = await import("./kms-jwt-service")
    // kid is derived inside KmsJwtService from the key path; KMS_SIGNING_KEY_KID is
    // honored as an explicit override only.
    const kid = process.env.KMS_SIGNING_KEY_KID
    signerInstance = new KmsJwtService(kmsKeyName, kid)
  } else {
    log.info("Using local RSA JWT signer (dev mode)")
    signerInstance = new LocalJwtSigner()
  }

  return signerInstance
}

/**
 * Reset the signer instance (for testing).
 */
export function resetJwtSigner(): void {
  signerInstance = null
}
