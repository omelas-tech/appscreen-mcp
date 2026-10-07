import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, mkdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, __testing__ as t } from "../src/catalog.js";

// loadCatalog has three branches: fresh fetch, disk cache hit, fallback.
// We isolate each by passing a per-test cacheFile path so suites can't
// cross-pollute through the real user cache directory.

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

describe("loadCatalog", () => {
  let dir: string;
  let cacheFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appscreen-catalog-test-"));
    cacheFile = join(dir, "catalog.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns FALLBACK when the API is unreachable AND no cache exists", async () => {
    const c = await loadCatalog({ fetchImpl: failingFetch(), ttlMs: 60_000, cacheFile });
    assert.equal(c.version, t.FALLBACK.version, "expected fallback (version=0)");
    assert.ok(c.sizes.length > 0);
    assert.ok(c.langs.includes("en"));
  });

  it("caches a successful fetch to disk and survives a subsequent network outage", async () => {
    const live = {
      version: 99,
      sizes: [{ id: "ios-6.9", width: 1320, height: 2868, store: "appstore" }],
      langs: ["en"],
      layouts: ["default"],
      backgrounds: { kinds: ["color"], presets: [], effects: [] },
      frames: [{ id: "iphone", kind: "device" }],
      tiers: {},
      pricing: { upgradeUrl: "https://appscreen.co/pricing" },
    };
    const first = await loadCatalog({ fetchImpl: fakeFetch(200, live), ttlMs: 60_000, cacheFile });
    assert.equal(first.version, 99);
    // Network goes down → still served from disk cache
    const second = await loadCatalog({ fetchImpl: failingFetch(), ttlMs: 60_000, cacheFile });
    assert.equal(second.version, 99);
    await assert.doesNotReject(() => stat(cacheFile));
  });

  it("re-fetches when the cache is older than ttlMs", async () => {
    await mkdir(dir, { recursive: true });
    const stale = { ...t.FALLBACK, version: 1 };
    await writeFile(cacheFile, JSON.stringify(stale), "utf8");
    const oldS = Math.floor((Date.now() - 1000 * 60 * 60 * 24 * 365) / 1000);
    await utimes(cacheFile, oldS, oldS);

    const live = { ...t.FALLBACK, version: 2 };
    const c = await loadCatalog({ fetchImpl: fakeFetch(200, live), ttlMs: 1_000, cacheFile });
    assert.equal(c.version, 2, "stale cache should be bypassed");
  });

  it("falls back when the fetch returns a non-2xx status", async () => {
    const c = await loadCatalog({ fetchImpl: fakeFetch(500, {}), ttlMs: 60_000, cacheFile });
    assert.equal(c.version, t.FALLBACK.version);
  });

  it("does NOT cache a failed fetch (no stale fallback gets persisted)", async () => {
    await loadCatalog({ fetchImpl: fakeFetch(503, {}), ttlMs: 60_000, cacheFile });
    await assert.rejects(() => stat(cacheFile), "cache file must not be written on failure");
  });
});
