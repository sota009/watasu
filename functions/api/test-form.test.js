import { describe, expect, test } from "vitest";
import { onRequestPost } from "./test-form.js";

describe("test form function", () => {
  test("echoes submitted JSON without storing it", async () => {
    const request = new Request("https://docs.watasu.ai/api/test-form", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        fullName: "Test User",
        email: "test@example.test"
      })
    });

    const response = await onRequestPost({ request });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      received: {
        fullName: "Test User",
        email: "test@example.test"
      }
    });
    expect(typeof body.received_at).toBe("string");
  });

  test("rejects invalid JSON", async () => {
    const request = new Request("https://docs.watasu.ai/api/test-form", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "not json"
    });

    const response = await onRequestPost({ request });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: "Request body must be valid JSON."
    });
  });
});

