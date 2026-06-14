import { describe, expect, test } from "vitest";
import { sha256Hash } from "./hash.js";

describe("hash helpers", () => {
  test("test_sha256_hash_uses_base64url_without_padding", () => {
    const result = sha256Hash("hello");

    expect(result).toBe("sha256:LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ");
  });

  test("test_sha256_hash_accepts_utf8_input", () => {
    const result = sha256Hash("同意");

    expect(result).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });
});
