import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { AppscreenClient, AppscreenHttpError, AppscreenTimeoutError } from "../src/client.js";

// We don't hit the network; we install a fake `fetch` and assert the
// request shape (headers, multipart, idempotency) and the
// response-parsing logic (quota headers → Quota object, error → throw).

type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

function fakeFetch(
  responses: Array<{ status: number; headers?: Record<string, string>; body: unknown }>,
): { calls: Captured[]; fn: typeof fetch } {
  const calls: Captured[] = [];
  let i = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    }
    calls.push({ url, method, headers, body: init?.body });
    const r = responses[Math.min(i++, responses.length - 1)];
    const resHeaders = new Headers(r.headers ?? {});
    if (!resHeaders.has("content-type")) resHeaders.set("content-type", "application/json");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: resHeaders });
  }) as unknown as typeof fetch;
  return { calls, fn };
}

function client(opts: {
  apiKey?: string | null;
  anonId?: string | null;
  fetchImpl: typeof fetch;
}): AppscreenClient {
  // The real client picks fetch off globalThis. We monkey-patch for the
  // duration of each test rather than passing it through, mirroring how
  // we'd swap it in production (Node ≥20 → global fetch).
  (globalThis as { fetch: typeof fetch }).fetch = opts.fetchImpl;
  return new AppscreenClient({
    apiKey: opts.apiKey ?? null,
    anonId: opts.anonId ?? null,
    baseUrl: "https://api.test.appscreen.co",
    mcpClient: "test/1.0",
  });
}

describe("AppscreenClient.render", () => {
  it("sends X-API-Key when an API key is configured", async () => {
    const { calls, fn } = fakeFetch([
      { status: 202, body: { jobId: "abc", status: "queued" } },
    ]);
    const c = client({ apiKey: "mcm_live_xxx", fetchImpl: fn });
    await c.render({
      sizes: ["ios-6.9"],
      langs: ["en"],
      screens: [],
      files: [{ name: "0.png", base64: Buffer.from("png").toString("base64") }],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.test.appscreen.co/v1/render");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["x-api-key"], "mcm_live_xxx");
    assert.equal(calls[0].headers["x-mcp-client"], "test/1.0");
    assert.equal(
      calls[0].headers["x-anon-id"],
      undefined,
      "must NOT send anon-id when authed",
    );
  });

  it("sends X-Anon-Id when only an anon-id is configured", async () => {
    const { calls, fn } = fakeFetch([
      { status: 200, body: { downloadUrl: "https://r2/x", screenCount: 1 } },
    ]);
    const c = client({ anonId: "11111111-2222-3333-4444-555555555555", fetchImpl: fn });
    await c.render({
      sizes: ["ios-6.9"],
      langs: ["en"],
      screens: [],
      files: [{ name: "0.png", base64: "aGk=" }],
    });
    assert.equal(
      calls[0].headers["x-anon-id"],
      "11111111-2222-3333-4444-555555555555",
    );
    assert.equal(calls[0].headers["x-api-key"], undefined);
  });

  it("forwards Idempotency-Key when provided", async () => {
    const { calls, fn } = fakeFetch([{ status: 202, body: { jobId: "x" } }]);
    const c = client({ apiKey: "mcm_live_x", fetchImpl: fn });
    await c.render({
      sizes: ["ios-6.9"],
      langs: ["en"],
      screens: [],
      files: [{ name: "0.png", base64: "aGk=" }],
      idempotencyKey: "test-key-123",
    });
    assert.equal(calls[0].headers["idempotency-key"], "test-key-123");
  });

  it("parses X-Quota-* response headers into Quota", async () => {
    const { fn } = fakeFetch([
      {
        status: 202,
        headers: {
          "x-quota-used": "7",
          "x-quota-cap": "30",
          "x-quota-tier": "free",
          "x-quota-reset": "2026-06-01T00:00:00.000Z",
        },
        body: { jobId: "x" },
      },
    ]);
    const c = client({ apiKey: "mcm_live_x", fetchImpl: fn });
    const r = await c.render({
      sizes: ["ios-6.9"],
      langs: ["en"],
      screens: [],
      files: [{ name: "0.png", base64: "aGk=" }],
    });
    assert.equal(r.quota.used, 7);
    assert.equal(r.quota.cap, 30);
    assert.equal(r.quota.tier, "free");
    assert.equal(r.quota.resetAt, "2026-06-01T00:00:00.000Z");
    // An API that predates credits sends no X-Credits-* headers.
    assert.equal(r.quota.balance, null);
    assert.equal(r.quota.cost, null);
  });

  it("parses X-Credits-* response headers alongside X-Quota-*", async () => {
    const { fn } = fakeFetch([
      {
        status: 202,
        headers: {
          // Used/Cap count credits now: cap − used = balance.
          "x-quota-used": "6",
          "x-quota-cap": "50",
          "x-quota-tier": "free",
          "x-quota-reset": "2026-10-01T00:00:00.000Z",
          "x-credits-balance": "44",
          "x-credits-cost": "6",
        },
        body: { jobId: "x", credits: 6, creditsLeft: 44 },
      },
    ]);
    const c = client({ apiKey: "mcm_live_x", fetchImpl: fn });
    const r = await c.render({
      sizes: ["ios-6.9"],
      langs: ["en"],
      screens: [],
      files: [{ name: "0.png", base64: "aGk=" }],
    });
    assert.equal(r.quota.used, 6);
    assert.equal(r.quota.cap, 50);
    assert.equal(r.quota.balance, 44);
    assert.equal(r.quota.cost, 6);
  });

  it("throws AppscreenHttpError with parsed body on 4xx", async () => {
    const { fn } = fakeFetch([
      {
        status: 402,
        headers: {
          "x-quota-used": "48",
          "x-quota-cap": "50",
          "x-quota-tier": "free",
          "x-credits-balance": "2",
        },
        body: {
          error: "not enough credits: this export needs 6, you have 2",
          code: "insufficient_credits",
          tier: "free",
          cost: 6,
          balance: 2,
          upgradeUrl: "https://appscreen.co/pricing",
        },
      },
    ]);
    const c = client({ apiKey: "mcm_live_x", fetchImpl: fn });
    await assert.rejects(
      () =>
        c.render({
          sizes: ["ios-6.9"],
          langs: ["en"],
          screens: [],
          files: [{ name: "0.png", base64: "aGk=" }],
        }),
      (err: unknown) => {
        if (!(err instanceof AppscreenHttpError)) return false;
        assert.equal(err.status, 402);
        assert.match(err.message, /not enough credits/);
        const body = err.body as { code: string; cost: number; quota: { used: number; balance: number } };
        assert.equal(body.code, "insufficient_credits");
        assert.equal(body.cost, 6);
        assert.equal(body.quota.used, 48);
        assert.equal(body.quota.balance, 2);
        return true;
      },
    );
  });

  it("rejects null when neither apiKey nor anonId is set (anonymous-but-no-id)", async () => {
    const { calls, fn } = fakeFetch([{ status: 200, body: {} }]);
    const c = client({ fetchImpl: fn });
    await c.render({
      sizes: ["ios-6.9"],
      langs: ["en"],
      screens: [],
      files: [{ name: "0.png", base64: "aGk=" }],
    });
    // Neither auth header should be set. The server will reject downstream
    // (anon path requires anon-id), but the client doesn't fabricate one.
    assert.equal(calls[0].headers["x-api-key"], undefined);
    assert.equal(calls[0].headers["x-anon-id"], undefined);
  });
});

describe("AppscreenClient timeout", () => {
  it("aborts a hung render and throws AppscreenTimeoutError (not an infinite wait)", async () => {
    // fetch that respects the abort signal but otherwise never resolves —
    // simulates a wedged inline render on the server.
    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }
      })) as unknown as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = hangingFetch;

    const c = new AppscreenClient({
      apiKey: "mcm_live_x",
      anonId: null,
      baseUrl: "https://api.test.appscreen.co",
      mcpClient: "test/1.0",
      renderTimeoutMs: 80, // tiny deadline so the test is fast
    });

    const start = Date.now();
    await assert.rejects(
      () =>
        c.render({
          sizes: ["ios-6.9"],
          langs: ["en"],
          screens: [],
          files: [{ name: "0.png", base64: "aGk=" }],
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppscreenTimeoutError, `got ${String(err)}`);
        assert.match((err as Error).message, /timed out/);
        assert.match((err as Error).message, /idempotencyKey/);
        return true;
      },
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `should abort near the 80ms deadline, took ${elapsed}ms`);
  });
});

describe("AppscreenClient.getJob", () => {
  it("GETs the job and forwards quota headers", async () => {
    const { calls, fn } = fakeFetch([
      {
        status: 200,
        headers: { "x-quota-used": "1", "x-quota-cap": "5", "x-quota-tier": "anon-mcp" },
        body: { jobId: "abc", status: "done", downloadUrl: "https://r2/x" },
      },
    ]);
    const c = client({ anonId: "11111111-2222-3333-4444-555555555555", fetchImpl: fn });
    const r = await c.getJob("abc-123-def-456");
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/v1\/render\/abc-123-def-456$/);
    assert.equal(r.body.downloadUrl, "https://r2/x");
    assert.equal(r.quota.cap, 5);
  });
});

describe("AppscreenClient.whoami", () => {
  it("returns tier metadata", async () => {
    const { fn } = fakeFetch([
      {
        status: 200,
        body: {
          tier: "pro",
          uid: "u1",
          workspace: { id: "ws1", name: "Personal", kind: "personal" },
          // monthlyUsed / monthlyCap count credits: cap − used = balance.
          monthlyUsed: 42,
          monthlyCap: 2542,
          credits: { balance: 2500, plan: 2500, pack: 0 },
          resetAt: "2026-10-01",
        },
      },
    ]);
    const c = client({ apiKey: "mcm_live_x", fetchImpl: fn });
    const r = await c.whoami();
    assert.equal(r.body.tier, "pro");
    assert.equal(r.body.monthlyUsed, 42);
    assert.equal(r.body.credits?.balance, 2500);
    assert.equal(r.body.workspace?.kind, "personal");
  });

  it("still reads a pre-credits whoami (no workspace / credits fields)", async () => {
    const { fn } = fakeFetch([
      { status: 200, body: { tier: "pro", monthlyUsed: 42, monthlyCap: 1000, resetAt: "2026-06-01" } },
    ]);
    const c = client({ apiKey: "mcm_live_x", fetchImpl: fn });
    const r = await c.whoami();
    assert.equal(r.body.monthlyCap, 1000);
    assert.equal(r.body.credits, undefined);
  });
});
