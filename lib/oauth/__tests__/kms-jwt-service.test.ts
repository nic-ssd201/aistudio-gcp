/**
 * Unit tests for KmsJwtService.
 *
 * Strategy: generate a real RSA keypair in-test and use a fake KMS client that
 * signs with that private key. This proves end-to-end JWT validity (signed-by-KMS
 * → fetched-from-JWKS public key verifies the signature) without hitting Cloud KMS.
 */

import {
  createPublicKey,
  generateKeyPairSync,
  createVerify,
  privateEncrypt,
  constants,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";
import { KmsJwtService } from "../kms-jwt-service";

// PKCS#1 v1.5 DigestInfo prefix for SHA-256 (RFC 8017 §9.2 step 2).
// Cloud KMS's RSA_SIGN_PKCS1_2048_SHA256 algorithm signs this prefix concatenated
// with the 32-byte digest, padded to keysize-1 bytes with type-1 padding, then
// raw-RSA'd with the private key. We replicate that here so the resulting
// signature is byte-identical to what KMS would produce, allowing the production
// code path (createVerify("RSA-SHA256")) to verify it.
const SHA256_DIGEST_INFO_PREFIX = Buffer.from([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86,
  0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
  0x00, 0x04, 0x20,
]);

const TEST_KEY_PATH =
  "projects/test-proj/locations/us-west1/keyRings/test-ring/cryptoKeys/jwt-signing/cryptoKeyVersions/3";

interface FakeKmsClient {
  asymmetricSign(req: { name: string; digest: { sha256: Buffer } }): Promise<[{ signature: Buffer }]>;
  getPublicKey(req: { name: string }): Promise<[{ pem: string }]>;
}

function makeFakeKmsClient() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  let signCallCount = 0;
  let getPublicKeyCallCount = 0;

  const client: FakeKmsClient = {
    async asymmetricSign(req) {
      signCallCount++;
      // Cloud KMS signs the precomputed digest by wrapping it in the DigestInfo
      // ASN.1 structure for SHA-256, then RSA-encrypting with PKCS#1 v1.5
      // type-1 padding. Replicate exactly so the resulting signature verifies
      // byte-for-byte the same way the production code's createVerify does.
      const digestInfo = Buffer.concat([SHA256_DIGEST_INFO_PREFIX, req.digest.sha256]);
      const signature = privateEncrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
        digestInfo,
      );
      return [{ signature }];
    },
    async getPublicKey(req) {
      getPublicKeyCallCount++;
      if (req.name !== TEST_KEY_PATH) {
        throw new Error(`unexpected key path: ${req.name}`);
      }
      return [{ pem: publicKey }];
    },
  };

  return {
    client,
    publicKey,
    counts: () => ({ signCallCount, getPublicKeyCallCount }),
  };
}

describe("KmsJwtService", () => {
  describe("constructor validation", () => {
    it.each([
      "",
      "arn:aws:kms:us-east-1:123:key/abc",
      "projects/p/locations/l/keyRings/r/cryptoKeys/k", // no version
      "projects/p/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1", // no location
      "not-a-path",
    ])("rejects malformed key path %j", (badPath) => {
      expect(() => new KmsJwtService(badPath)).toThrow(
        /must be a KMS cryptoKeyVersion/i,
      );
    });

    it("derives kid from the cryptoKey name + version", () => {
      const { client } = makeFakeKmsClient();
      const svc = new KmsJwtService(
        TEST_KEY_PATH,
        undefined,
        // @ts-expect-error fake client only implements the methods we use
        client,
      );
      expect(svc.getKid()).toBe("jwt-signing-v3");
    });

    it("honors explicit kid override", () => {
      const { client } = makeFakeKmsClient();
      const svc = new KmsJwtService(
        TEST_KEY_PATH,
        "custom-kid",
        // @ts-expect-error
        client,
      );
      expect(svc.getKid()).toBe("custom-kid");
    });
  });

  describe("signJwt", () => {
    it("produces a JWT whose signature verifies against the public key fetched from JWKS", async () => {
      const { client, publicKey } = makeFakeKmsClient();
      const svc = new KmsJwtService(
        TEST_KEY_PATH,
        undefined,
        // @ts-expect-error
        client,
      );

      const jwt = await svc.signJwt({ sub: "user-1", iss: "https://aistudio" });
      const [headerB64, payloadB64, sigB64] = jwt.split(".");
      expect(headerB64).toBeTruthy();
      expect(payloadB64).toBeTruthy();
      expect(sigB64).toBeTruthy();

      // Decode header and confirm kid + alg
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
      expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "jwt-signing-v3" });

      // Verify the signature using the same public key the JWKS endpoint would publish
      const signingInput = `${headerB64}.${payloadB64}`;
      const verifier = createVerify("RSA-SHA256");
      verifier.update(signingInput);
      verifier.end();
      const sigBytes = Buffer.from(sigB64, "base64url");
      expect(verifier.verify(publicKey, sigBytes)).toBe(true);
    });

    it("propagates errors from KMS asymmetricSign", async () => {
      const failingClient = {
        async asymmetricSign() {
          throw new Error("KMS denied: PERMISSION_DENIED");
        },
        async getPublicKey() {
          return [{ pem: "" }];
        },
      };
      const svc = new KmsJwtService(
        TEST_KEY_PATH,
        undefined,
        // @ts-expect-error
        failingClient,
      );
      await expect(svc.signJwt({ sub: "u" })).rejects.toThrow(/PERMISSION_DENIED/);
    });

    it("throws when KMS returns no signature", async () => {
      const emptyClient = {
        async asymmetricSign() {
          return [{ signature: undefined }];
        },
        async getPublicKey() {
          return [{ pem: "" }];
        },
      };
      const svc = new KmsJwtService(
        TEST_KEY_PATH,
        undefined,
        // @ts-expect-error
        emptyClient,
      );
      await expect(svc.signJwt({ sub: "u" })).rejects.toThrow(/no signature/i);
    });
  });

  describe("getPublicKeyJwk", () => {
    it("returns a JWK with the configured kid and RSA params", async () => {
      const { client, publicKey } = makeFakeKmsClient();
      const svc = new KmsJwtService(
        TEST_KEY_PATH,
        undefined,
        // @ts-expect-error
        client,
      );

      const jwk = await svc.getPublicKeyJwk();
      expect(jwk.kty).toBe("RSA");
      expect(jwk.use).toBe("sig");
      expect(jwk.alg).toBe("RS256");
      expect(jwk.kid).toBe("jwt-signing-v3");
      expect(jwk.n).toBeTruthy();
      expect(jwk.e).toBeTruthy();

      // Sanity: round-trip should produce a key that re-imports to the same SPKI
      const reExported = createPublicKey({
        key: jwk as unknown as NodeJsonWebKey,
        format: "jwk",
      }).export({
        type: "spki",
        format: "pem",
      }) as string;
      expect(reExported.replace(/\s/g, "")).toBe(publicKey.replace(/\s/g, ""));
    });

    it("caches the public key within the TTL window", async () => {
      const fake = makeFakeKmsClient();
      const svc = new KmsJwtService(
        TEST_KEY_PATH,
        undefined,
        // @ts-expect-error
        fake.client,
      );

      await svc.getPublicKeyJwk();
      await svc.getPublicKeyJwk();
      await svc.getPublicKeyJwk();
      expect(fake.counts().getPublicKeyCallCount).toBe(1);
    });

    it("refetches after the cache TTL expires", async () => {
      jest.useFakeTimers();
      try {
        const fake = makeFakeKmsClient();
        const svc = new KmsJwtService(
          TEST_KEY_PATH,
          undefined,
          // @ts-expect-error
          fake.client,
        );

        await svc.getPublicKeyJwk();
        expect(fake.counts().getPublicKeyCallCount).toBe(1);

        // Advance just past the 5-minute TTL.
        jest.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);

        await svc.getPublicKeyJwk();
        expect(fake.counts().getPublicKeyCallCount).toBe(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it("dedupes concurrent cache misses into a single KMS RPC", async () => {
      const fake = makeFakeKmsClient();
      const svc = new KmsJwtService(
        TEST_KEY_PATH,
        undefined,
        // @ts-expect-error
        fake.client,
      );

      // Five callers race during the cold-start window. Without dedup each would
      // issue its own getPublicKey RPC — with dedup they share the in-flight one.
      const results = await Promise.all([
        svc.getPublicKeyJwk(),
        svc.getPublicKeyJwk(),
        svc.getPublicKeyJwk(),
        svc.getPublicKeyJwk(),
        svc.getPublicKeyJwk(),
      ]);
      expect(fake.counts().getPublicKeyCallCount).toBe(1);
      // All callers got the same JWK object.
      results.forEach((r) => expect(r.kid).toBe("jwt-signing-v3"));
    });

    it("rejects non-RSA public keys (defense-in-depth for algorithm misconfig)", async () => {
      const ecClient = {
        async asymmetricSign() {
          return [{ signature: Buffer.alloc(0) }];
        },
        async getPublicKey() {
          // EC keypair PEM (would only happen if the KMS key was provisioned
          // with an EC algorithm but KmsJwtService is built only for RS256).
          const { generateKeyPairSync: g } = require("node:crypto") as typeof import("node:crypto");
          const { publicKey } = g("ec", {
            namedCurve: "P-256",
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
          });
          return [{ pem: publicKey }];
        },
      };
      const svc = new KmsJwtService(
        TEST_KEY_PATH,
        undefined,
        // @ts-expect-error
        ecClient,
      );
      await expect(svc.getPublicKeyJwk()).rejects.toThrow(/non-RSA/i);
    });

    it("throws when KMS returns no PEM", async () => {
      const emptyClient = {
        async asymmetricSign() {
          return [{ signature: Buffer.alloc(0) }];
        },
        async getPublicKey() {
          return [{ pem: undefined }];
        },
      };
      const svc = new KmsJwtService(
        TEST_KEY_PATH,
        undefined,
        // @ts-expect-error
        emptyClient,
      );
      await expect(svc.getPublicKeyJwk()).rejects.toThrow(/no PEM/i);
    });
  });
});
