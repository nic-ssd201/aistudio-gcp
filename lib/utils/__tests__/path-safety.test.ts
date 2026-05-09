import {
  isSafeStorageSegment,
  areSafeStorageSegments,
  isSafeStorageKey,
} from "../path-safety";

describe("isSafeStorageSegment", () => {
  it.each([
    ["normal-name", true],
    ["with.dot.in.middle", true],
    ["with-uuid-1234-5678", true],
    ["a", true],
    ["", false],
    [".", false],
    ["..", false],
    ["a/b", false],
    ["a\\b", false],
    ["a\0b", false],
  ])("isSafeStorageSegment(%j) === %s", (input, expected) => {
    expect(isSafeStorageSegment(input)).toBe(expected);
  });
});

describe("areSafeStorageSegments", () => {
  it("accepts a normal storage path", () => {
    expect(
      areSafeStorageSegments([
        "v2",
        "generated-images",
        "11111111-1111-4111-8111-111111111111",
        "image.png",
      ])
    ).toBe(true);
  });

  it("rejects when any segment is `..`", () => {
    expect(
      areSafeStorageSegments([
        "v2",
        "generated-images",
        "11111111-1111-4111-8111-111111111111",
        "..",
        "victim",
        "image.png",
      ])
    ).toBe(false);
  });

  it("rejects when any segment is `.`", () => {
    expect(areSafeStorageSegments(["a", ".", "b"])).toBe(false);
  });

  it("rejects when any segment is empty", () => {
    expect(areSafeStorageSegments(["a", "", "b"])).toBe(false);
  });

  it("rejects empty array (fail-closed for forgotten length checks)", () => {
    expect(areSafeStorageSegments([])).toBe(false);
  });
});

describe("isSafeStorageKey", () => {
  it("accepts a normal key", () => {
    expect(isSafeStorageKey("user-1/2026-01-01-doc.pdf")).toBe(true);
  });

  it("accepts a key with valid segments", () => {
    expect(isSafeStorageKey("v2/generated-images/abc-uuid/image.png")).toBe(true);
  });

  it("rejects a traversal key (the original CVE-shape)", () => {
    expect(isSafeStorageKey("user-1/../user-2/secret.pdf")).toBe(false);
  });

  it("rejects a key with `.` segment", () => {
    expect(isSafeStorageKey("user-1/./doc.pdf")).toBe(false);
  });

  it("rejects keys producing empty segments (leading slash)", () => {
    expect(isSafeStorageKey("/user-1/doc.pdf")).toBe(false);
  });

  it("rejects keys producing empty segments (trailing slash)", () => {
    expect(isSafeStorageKey("user-1/doc.pdf/")).toBe(false);
  });

  it("rejects keys producing empty segments (double slash)", () => {
    expect(isSafeStorageKey("user-1//doc.pdf")).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(isSafeStorageKey("")).toBe(false);
  });

  it("rejects keys with NUL bytes", () => {
    expect(isSafeStorageKey("user-1/foo\0.pdf")).toBe(false);
  });
});
