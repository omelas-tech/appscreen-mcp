import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { defaultBoxFor, findFrame, findSize } from "../src/geometry.js";
import type { Catalog } from "../src/catalog.js";

// The whole point of this module is to stop the "tall/skinny phone"
// distortion: given a frame's native aspect and the canvas dims, the box
// height must come out so the device renders at true proportions. These
// tests pin the formula and its branches.

const catalog: Catalog = {
  version: 2,
  sizes: [
    { id: "ios-6.9", width: 1320, height: 2868, store: "appstore" },
    { id: "play", width: 1080, height: 1920, store: "playstore" },
  ],
  langs: ["en"],
  layouts: ["default"],
  backgrounds: { kinds: ["color"], presets: ["mesh"], effects: ["blur", "blur+tint"] },
  frames: [
    { id: "iphone", kind: "device", aspectWOverH: 1520 / 3068 },
    { id: "pixel", kind: "device", aspectWOverH: 1620 / 3136 },
    { id: "generic-minimal", kind: "generic", aspectWOverH: null },
  ],
  tiers: {},
  pricing: { upgradeUrl: "https://appscreen.co/pricing" },
};

describe("defaultBoxFor", () => {
  it("computes the studio-matching box for iphone on ios-6.9", () => {
    const size = findSize(catalog, "ios-6.9")!;
    const frame = findFrame(catalog, "iphone");
    const box = defaultBoxFor(size, frame);
    // Studio: w=0.84, y=0.21, h = (0.84*1320)/(1520/3068)/2868
    assert.equal(box.w, 0.84);
    assert.equal(box.y, 0.21);
    assert.equal(box.x, 0.08); // (1-0.84)/2
    // h ≈ 0.7803 — the value the manual MCP run got WRONG (used a taller h)
    assert.ok(Math.abs(box.h - 0.7803) < 0.001, `h was ${box.h}, expected ≈0.7803`);
  });

  it("produces a box whose rendered device aspect equals the frame aspect", () => {
    const size = findSize(catalog, "ios-6.9")!;
    const frame = findFrame(catalog, "iphone")!;
    const box = defaultBoxFor(size, frame);
    // Rendered device pixel aspect = (box.w*canvasW) / (box.h*canvasH)
    const renderedAspect = (box.w * size.width) / (box.h * size.height);
    assert.ok(
      Math.abs(renderedAspect - frame.aspectWOverH!) < 0.002,
      `rendered aspect ${renderedAspect} != frame ${frame.aspectWOverH}`,
    );
  });

  it("uses play defaults (narrower w, higher y) for the play size", () => {
    const size = findSize(catalog, "play")!;
    const frame = findFrame(catalog, "pixel");
    const box = defaultBoxFor(size, frame);
    assert.equal(box.w, 0.74);
    assert.equal(box.y, 0.18);
  });

  it("pixel frame yields a different (correct) aspect than iphone", () => {
    const size = findSize(catalog, "ios-6.9")!;
    const iph = defaultBoxFor(size, findFrame(catalog, "iphone"));
    const pix = defaultBoxFor(size, findFrame(catalog, "pixel"));
    assert.notEqual(iph.h, pix.h, "different frame aspects must yield different heights");
  });

  it("falls back to the iPhone aspect for a generic frame (no aspectWOverH)", () => {
    const size = findSize(catalog, "ios-6.9")!;
    const generic = defaultBoxFor(size, findFrame(catalog, "generic-minimal"));
    const iph = defaultBoxFor(size, findFrame(catalog, "iphone"));
    // generic has aspectWOverH:null → falls back to DEFAULT_DEVICE_ASPECT
    // (also 1520/3068) so it matches iphone here.
    assert.equal(generic.h, iph.h);
  });

  it("honors a source image aspect for generic frames when provided", () => {
    const size = findSize(catalog, "ios-6.9")!;
    const square = defaultBoxFor(size, findFrame(catalog, "generic-minimal"), 1.0);
    const tall = defaultBoxFor(size, findFrame(catalog, "generic-minimal"), 0.46);
    assert.ok(square.h < tall.h, "a wider (square) source → shorter box height");
  });

  it("falls back to default aspect when frame is undefined", () => {
    const size = findSize(catalog, "ios-6.9")!;
    const box = defaultBoxFor(size, undefined);
    assert.ok(box.h > 0 && box.h < 1);
    assert.equal(box.w, 0.84);
  });

  it("keeps the box centered horizontally", () => {
    const size = findSize(catalog, "ios-6.9")!;
    const box = defaultBoxFor(size, findFrame(catalog, "iphone"));
    assert.ok(Math.abs(box.x - (1 - box.w) / 2) < 1e-6);
  });
});

describe("findSize / findFrame", () => {
  it("finds by id", () => {
    assert.equal(findSize(catalog, "play")!.width, 1080);
    assert.equal(findFrame(catalog, "pixel")!.kind, "device");
  });
  it("returns undefined for unknown ids", () => {
    assert.equal(findSize(catalog, "nope"), undefined);
    assert.equal(findFrame(catalog, "nope"), undefined);
    assert.equal(findFrame(catalog, undefined), undefined);
  });
});
