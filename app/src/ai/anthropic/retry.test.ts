import { describe, it, expect } from "vitest";
import { classifyTransientError, sleepInterruptible, MAX_RETRIES } from "./session.js";

/**
 * Tests for transient-error classification and the interruptible sleep
 * used by the API call retry loop.
 */

describe("classifyTransientError", () => {
  it("retries 529 overloaded_error by status", () => {
    const err = { status: 529, message: "Overloaded" };
    expect(classifyTransientError(err)).toBe("overloaded_error (529)");
  });

  it("retries 503 service_unavailable", () => {
    expect(classifyTransientError({ status: 503 })).toBe("service_unavailable (503)");
  });

  it("retries 502 bad_gateway", () => {
    expect(classifyTransientError({ status: 502 })).toBe("bad_gateway (502)");
  });

  it("retries 500 api_error", () => {
    expect(classifyTransientError({ status: 500 })).toBe("api_error (500)");
  });

  it("retries 429 rate_limit_error", () => {
    expect(classifyTransientError({ status: 429 })).toBe("rate_limit_error (429)");
  });

  it("retries SDK-typed APIConnectionError", () => {
    const err = { name: "APIConnectionError", message: "fetch failed" };
    expect(classifyTransientError(err)).toBe("APIConnectionError");
  });

  it("retries SDK-typed APIConnectionTimeoutError", () => {
    const err = { name: "APIConnectionTimeoutError", message: "timeout" };
    expect(classifyTransientError(err)).toBe("APIConnectionTimeoutError");
  });

  it("retries network code ECONNRESET", () => {
    expect(classifyTransientError({ code: "ECONNRESET" })).toBe("ECONNRESET");
  });

  it("retries network code ETIMEDOUT", () => {
    expect(classifyTransientError({ code: "ETIMEDOUT" })).toBe("ETIMEDOUT");
  });

  it("retries on cause.code (Node fetch wraps errors)", () => {
    const err = { message: "fetch failed", cause: { code: "EAI_AGAIN" } };
    expect(classifyTransientError(err)).toBe("EAI_AGAIN");
  });

  it("retries on overloaded_error stringified in message (the field repro)", () => {
    // Real shape from the screenshot: serialized JSON in error.message
    const err = {
      message: 'Error: {"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CaUcxx9cX6Y4zs8sxPp9i"}',
    };
    expect(classifyTransientError(err)).toBe("overloaded_error");
  });

  it("retries when error.error.type is overloaded_error", () => {
    const err = { error: { type: "overloaded_error" } };
    expect(classifyTransientError(err)).toBe("overloaded_error");
  });

  it("retries when error.error.error.type is rate_limit_error (nested SDK shape)", () => {
    const err = { error: { error: { type: "rate_limit_error" } } };
    expect(classifyTransientError(err)).toBe("rate_limit_error");
  });

  it("does NOT retry 400 invalid_request_error (our payload is broken)", () => {
    expect(classifyTransientError({ status: 400, message: "Bad request" })).toBeNull();
  });

  it("does NOT retry 401 authentication_error", () => {
    expect(classifyTransientError({ status: 401 })).toBeNull();
  });

  it("does NOT retry 403 permission_error", () => {
    expect(classifyTransientError({ status: 403 })).toBeNull();
  });

  it("does NOT retry 404 not_found_error", () => {
    expect(classifyTransientError({ status: 404 })).toBeNull();
  });

  it("does NOT retry generic JS errors with no recognizable signal", () => {
    expect(classifyTransientError(new Error("boom"))).toBeNull();
    expect(classifyTransientError({ message: "random failure" })).toBeNull();
    expect(classifyTransientError(null)).toBeNull();
    expect(classifyTransientError(undefined)).toBeNull();
  });
});

describe("MAX_RETRIES constant", () => {
  it("is 10 — locks the contract", () => {
    expect(MAX_RETRIES).toBe(10);
  });
});

describe("sleepInterruptible", () => {
  it("resolves false (not aborted) after the timeout elapses", async () => {
    const t0 = Date.now();
    const aborted = await sleepInterruptible(15);
    const dt = Date.now() - t0;
    expect(aborted).toBe(false);
    expect(dt).toBeGreaterThanOrEqual(10); // some slack for timer precision
  });

  it("resolves true immediately if signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const aborted = await sleepInterruptible(10000, ac.signal);
    const dt = Date.now() - t0;
    expect(aborted).toBe(true);
    expect(dt).toBeLessThan(50);
  });

  it("resolves true if abort fires during sleep", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const t0 = Date.now();
    const aborted = await sleepInterruptible(10000, ac.signal);
    const dt = Date.now() - t0;
    expect(aborted).toBe(true);
    expect(dt).toBeLessThan(200); // should be ~10ms, not 10000
  });

  it("works without a signal (signal optional)", async () => {
    const aborted = await sleepInterruptible(5);
    expect(aborted).toBe(false);
  });
});
