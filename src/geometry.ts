import type { Catalog, FrameOption, SizeOption } from "./catalog.js";

export type Box = { x: number; y: number; w: number; h: number; rotation?: number };

// Port of web/src/lib/screen-model.ts defaultScreenshotBox. The renderer
// places the device frame at the literal box w×h, so the caller MUST size
// the box at the frame's native aspect or the phone stretches. Studio does
// this; programmatic callers historically did not (the "tall phone" bug).
// We compute it here so MCP callers never have to.
//
//   box.h = (box.w * canvasWidth) / aspectWOverH / canvasHeight
//
// For generic frames (no bezel, aspectWOverH=null) the screenshot fills the
// box directly, so we fall back to the source image's own aspect when known,
// else a sensible iPhone-ish default.

const DEFAULT_DEVICE_ASPECT = 1520 / 3068; // iPhone bezel, used as fallback

export function defaultBoxFor(
  size: SizeOption,
  frame: FrameOption | undefined,
  sourceAspectWOverH?: number,
): Box {
  const isPlay = size.store === "playstore" || size.id === "play";
  const w = isPlay ? 0.74 : 0.84;
  const y = isPlay ? 0.18 : 0.21;

  let aspect: number;
  if (frame && frame.kind === "device" && typeof frame.aspectWOverH === "number") {
    aspect = frame.aspectWOverH;
  } else if (typeof sourceAspectWOverH === "number" && sourceAspectWOverH > 0) {
    // Generic frame: box matches the screenshot's own aspect.
    aspect = sourceAspectWOverH;
  } else {
    aspect = DEFAULT_DEVICE_ASPECT;
  }

  const h = (w * size.width) / aspect / size.height;
  const x = (1 - w) / 2;
  return {
    x: round4(x),
    y: round4(y),
    w: round4(w),
    h: round4(h),
  };
}

export function findSize(catalog: Catalog, sizeId: string): SizeOption | undefined {
  return catalog.sizes.find((s) => s.id === sizeId);
}

export function findFrame(catalog: Catalog, frameId: string | undefined): FrameOption | undefined {
  if (!frameId) return undefined;
  return catalog.frames.find((f) => f.id === frameId);
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
