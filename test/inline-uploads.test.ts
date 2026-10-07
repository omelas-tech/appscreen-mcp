import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { __testing__ } from "../src/server.js";

const { collectInlineUploads, stripInlinePaths } = __testing__;

// Inline paths on screen elements → flat files[] + screensMeta binding.
// This is the ergonomic fix that unlocks bg images, logo objects, and
// per-locale screenshots without the agent hand-building screensMeta.

describe("collectInlineUploads", () => {
  it("returns null when no inline image paths are present", () => {
    assert.equal(
      collectInlineUploads([{ screenshot: { box: { x: 0, y: 0, w: 1, h: 1 } } }]),
      null,
    );
  });

  it("binds a single screenshot path to a null-lang screen meta", () => {
    const out = collectInlineUploads([{ screenshot: { path: "~/a.png" } }]);
    assert.ok(out);
    assert.deepEqual(out!.files, [{ name: "r0-ss.png", path: "~/a.png" }]);
    assert.deepEqual(out!.screensMeta, [{ rowIdx: 0, lang: null, kind: "screen" }]);
  });

  it("binds per-lang screenshots to one meta per locale", () => {
    const out = collectInlineUploads([
      { screenshot: { pathsByLang: { en: "/en.png", es: "/es.png" } } },
    ])!;
    assert.equal(out.files.length, 2);
    const langs = out.screensMeta.map((m) => m.lang).sort();
    assert.deepEqual(langs, ["en", "es"]);
    assert.ok(out.screensMeta.every((m) => m.kind === "screen" && m.rowIdx === 0));
  });

  it("binds a background image with kind:bg", () => {
    const out = collectInlineUploads([
      { bg: { kind: "image", path: "/bg.png" }, screenshot: { path: "/s.png" } },
    ])!;
    const bg = out.screensMeta.find((m) => m.kind === "bg");
    assert.ok(bg);
    assert.equal(bg!.rowIdx, 0);
    assert.ok(out.files.some((f) => f.path === "/bg.png"));
  });

  it("binds an image object with objectId + mime", () => {
    const out = collectInlineUploads([
      {
        screenshot: { path: "/s.png" },
        objects: [{ kind: "image", id: "logo", path: "/logo.png", mime: "image/png" }],
      },
    ])!;
    const obj = out.screensMeta.find((m) => m.kind === "object");
    assert.ok(obj);
    assert.equal(obj!.objectId, "logo");
    assert.equal(obj!.objectMime, "image/png");
  });

  it("maps svg object mime + extension", () => {
    const out = collectInlineUploads([
      {
        screenshot: { path: "/s.png" },
        objects: [{ kind: "image", id: "ic", path: "/ic.svg", mime: "image/svg+xml" }],
      },
    ])!;
    const obj = out.screensMeta.find((m) => m.kind === "object")!;
    assert.equal(obj.objectMime, "image/svg+xml");
    assert.ok(out.files.some((f) => f.name.endsWith(".svg")));
  });

  it("uses correct rowIdx across multiple screens", () => {
    const out = collectInlineUploads([
      { screenshot: { path: "/0.png" } },
      { screenshot: { path: "/1.png" } },
    ])!;
    assert.deepEqual(out.screensMeta.map((m) => m.rowIdx), [0, 1]);
  });

  it("ignores image objects missing a path or id", () => {
    const out = collectInlineUploads([
      {
        screenshot: { path: "/s.png" },
        objects: [
          { kind: "image", id: "noPath", mime: "image/png" },
          { kind: "text", id: "t" },
        ],
      },
    ])!;
    assert.equal(out.screensMeta.filter((m) => m.kind === "object").length, 0);
  });
});

describe("stripInlinePaths", () => {
  it("removes path fields the API doesn't expect", () => {
    const [s] = stripInlinePaths([
      {
        bg: { kind: "image", box: { x: 0, y: 0, w: 1, h: 1 }, path: "/bg.png" },
        screenshot: { path: "/s.png", pathsByLang: { en: "/e.png" }, box: { x: 0, y: 0, w: 1, h: 1 } },
        objects: [{ kind: "image", id: "l", path: "/l.png", mime: "image/png" }],
      },
    ]);
    assert.equal((s.screenshot as Record<string, unknown>).path, undefined);
    assert.equal((s.screenshot as Record<string, unknown>).pathsByLang, undefined);
    assert.equal((s.bg as Record<string, unknown>).path, undefined);
    assert.equal((s.objects![0] as Record<string, unknown>).path, undefined);
    // non-path fields survive
    assert.ok((s.screenshot as Record<string, unknown>).box);
    assert.equal((s.objects![0] as Record<string, unknown>).id, "l");
  });

  it("leaves text objects untouched", () => {
    const [s] = stripInlinePaths([
      { objects: [{ kind: "text", id: "t", content: {} }] },
    ]);
    assert.equal(s.objects![0].kind, "text");
    assert.equal(s.objects![0].id, "t");
  });
});
