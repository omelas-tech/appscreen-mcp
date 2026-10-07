import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The anon module reads env-paths at import time, so we can't simply
// stash + restore HOME after the fact. Instead we point env-paths at a
// fresh temp dir BEFORE importing the module by clearing the require
// cache between scenarios.
//
// Contract under test:
//   1. First call → mints a uuid v4, persists it, returns it
//   2. Subsequent calls → return the SAME uuid (idempotent across restarts)
//   3. Corrupted file → mints a fresh uuid (does not crash)
//   4. The file is written with exactly the uuid string (no JSON wrapping)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function freshHomedir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "appscreen-mcp-test-"));
  return dir;
}

async function loadAnon(homedir: string): Promise<typeof import("../src/anon.js")> {
  process.env.HOME = homedir;
  process.env.XDG_DATA_HOME = join(homedir, ".local", "share");
  process.env.APPDATA = join(homedir, "AppData", "Roaming"); // windows env-paths key
  // bust the ESM cache so env-paths re-reads HOME
  const url = new URL("../src/anon.ts", import.meta.url).href + `?t=${Date.now()}`;
  return (await import(url)) as typeof import("../src/anon.js");
}

describe("anon-id persistence", () => {
  let tmp: string;
  const origHome = process.env.HOME;
  const origXdg = process.env.XDG_DATA_HOME;

  beforeEach(async () => {
    tmp = await freshHomedir();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    if (origHome) process.env.HOME = origHome;
    if (origXdg) process.env.XDG_DATA_HOME = origXdg;
  });

  it("mints a uuid v4 on first call and persists it", async () => {
    const mod = await loadAnon(tmp);
    const id1 = await mod.loadOrCreateAnonId();
    assert.match(id1, UUID_RE, "should be a uuid v4");
    // Second call returns the same id (does NOT mint a new one)
    const id2 = await mod.loadOrCreateAnonId();
    assert.equal(id2, id1, "must persist across calls");
  });

  it("survives across module reloads (simulates process restart)", async () => {
    const mod1 = await loadAnon(tmp);
    const id1 = await mod1.loadOrCreateAnonId();
    // Re-import as if the process restarted
    const mod2 = await loadAnon(tmp);
    const id2 = await mod2.loadOrCreateAnonId();
    assert.equal(id2, id1, "id must persist across imports");
  });

  it("recovers from corrupted file by minting a new id", async () => {
    const mod = await loadAnon(tmp);
    const id1 = await mod.loadOrCreateAnonId();
    // Corrupt the file
    const envPaths = (await import("env-paths")).default;
    const paths = envPaths("appscreen", { suffix: "" });
    const file = join(paths.data, "anon-id");
    await (await import("node:fs/promises")).writeFile(file, "not-a-uuid", "utf8");
    const mod2 = await loadAnon(tmp);
    const id2 = await mod2.loadOrCreateAnonId();
    assert.match(id2, UUID_RE);
    assert.notEqual(id2, id1, "corrupted file → fresh uuid");
  });

  it("writes the uuid verbatim with no JSON wrapping", async () => {
    const mod = await loadAnon(tmp);
    const id = await mod.loadOrCreateAnonId();
    const envPaths = (await import("env-paths")).default;
    const paths = envPaths("appscreen", { suffix: "" });
    const file = join(paths.data, "anon-id");
    const content = (await readFile(file, "utf8")).trim();
    assert.equal(content, id, "file content must equal the uuid exactly");
  });
});
