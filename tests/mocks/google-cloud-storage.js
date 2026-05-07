// Mock for @google-cloud/storage — provides a no-op Storage class so that
// modules importing it (but not directly jest.mock'ing the package) don't crash.
// Individual tests that need controlled behaviour should still use their own
// jest.mock('@google-cloud/storage', …) calls which take precedence.

class MockBucket {
  constructor() {
    this.exists = jest.fn().mockResolvedValue([true]);
    this.getFiles = jest.fn().mockResolvedValue([[]]);
    this.getMetadata = jest.fn().mockResolvedValue([{}]);
    this.createReadStream = jest.fn().mockReturnValue(null);
    this.createResumableUpload = jest.fn().mockResolvedValue('https://mock/resumable');
  }

  file(_key) {
    return {
      save: jest.fn().mockResolvedValue(undefined),
      getSignedUrl: jest.fn().mockResolvedValue(['https://mock/signed']),
      getMetadata: this.getMetadata,
      createReadStream: this.createReadStream,
      createResumableUpload: this.createResumableUpload,
      exists: this.exists,
      delete: jest.fn().mockResolvedValue(undefined),
    };
  }
}

class Storage {
  constructor() {}
  bucket(_name) {
    return new MockBucket();
  }
}

module.exports = {
  Storage,
  ApiError: class ApiError extends Error {},
  IdempotencyStrategy: {},
};
