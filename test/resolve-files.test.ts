import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testing__ } from "../src/server.js";

const { resolveFiles, expandPath, MAX_FILE_BYTES } = __testing__;

// The whole point of path-input: bytes are read off disk by the server,
// never emitted by the model. These tests pin that the server reads
// files faithfully, enforces limits, and still accepts inline base64 for
// the tiny-test escape hatch.

describe("resolveFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appscreen-files-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a path file and returns faithful base64 (matches Buffer encoding)", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const p = join(dir, "shot.png");
    await writeFile(p, bytes);
    const out = await resolveFiles([{ name: "0.png", path: p }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "0.png");
    assert.equal(out[0].base64, bytes.toString("base64"));
    // round-trips back to the exact bytes — no corruption
    assert.ok(Buffer.from(out[0].base64, "base64").equals(bytes));
  });

  it("passes inline base64 through unchanged (tiny-test escape hatch)", async () => {
    const out = await resolveFiles([{ name: "x.png", base64: "aGVsbG8=" }]);
    assert.equal(out[0].base64, "aGVsbG8=");
  });

  it("prefers path when both are given", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const p = join(dir, "a.png");
    await writeFile(p, bytes);
    const out = await resolveFiles([{ name: "a", path: p, base64: "WRONG" }]);
    assert.equal(out[0].base64, bytes.toString("base64"));
  });

  it("throws a clear error when the path does not exist", async () => {
    await assert.rejects(
      () => resolveFiles([{ name: "missing", path: join(dir, "nope.png") }]),
      /cannot read file for "missing"/,
    );
  });

  it("rejects an empty file", async () => {
    const p = join(dir, "empty.png");
    await writeFile(p, Buffer.alloc(0));
    await assert.rejects(() => resolveFiles([{ name: "empty", path: p }]), /is empty/);
  });

  it("rejects a file over the 10MB cap", async () => {
    const p = join(dir, "big.png");
    await writeFile(p, Buffer.alloc(MAX_FILE_BYTES + 1));
    await assert.rejects(() => resolveFiles([{ name: "big", path: p }]), /exceeds the 10MB/);
  });

  it("resolves multiple files in order", async () => {
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    await writeFile(a, Buffer.from([10]));
    await writeFile(b, Buffer.from([20]));
    const out = await resolveFiles([
      { name: "a", path: a },
      { name: "b", path: b },
    ]);
    assert.deepEqual(out.map((f) => f.name), ["a", "b"]);
    assert.equal(Buffer.from(out[0].base64, "base64")[0], 10);
    assert.equal(Buffer.from(out[1].base64, "base64")[0], 20);
  });
});

describe("expandPath", () => {
  it("expands ~ to home", () => {
    assert.equal(expandPath("~"), process.env.HOME ?? expandPath("~"));
  });
  it("expands ~/sub to home/sub", () => {
    assert.match(expandPath("~/x/y.png"), /\/x\/y\.png$/);
    assert.ok(!expandPath("~/x/y.png").startsWith("~"));
  });
  it("resolves a relative path to absolute", () => {
    assert.ok(expandPath("foo/bar.png").startsWith("/"));
  });
  it("leaves an absolute path absolute", () => {
    assert.equal(expandPath("/abs/x.png"), "/abs/x.png");
  });
});
