import envPaths from "env-paths";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Catalog is fetched live from /v1/catalog with a 24h disk cache.
// Falls back to a small inline list if the network is down at startup
// so the server can still hand out *something* to the agent. The
// inline list will inevitably drift; treat it as a safety net, not the
// source of truth — the catalog endpoint is authoritative.

const paths = envPaths("appscreen", { suffix: "" });
const DEFAULT_CACHE_FILE = join(paths.cache, "catalog.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type Option = { id: string; label?: string; description?: string; exampleUrl?: string };
export type SizeOption = Option & { width: number; height: number; store: string };
export type FrameOption = Option & { kind: string; aspectWOverH?: number | null; variant?: string };

export type Catalog = {
  version: number;
  galleryUrl?: string;
  sizes: SizeOption[];
  langs: readonly string[];
  layouts: ReadonlyArray<string | Option>;
  backgrounds: {
    kinds: ReadonlyArray<string | Option>;
    presets: ReadonlyArray<string | Option>;
    effects: ReadonlyArray<string | Option>;
  };
  frames: FrameOption[];
  text?: {
    defaultFont?: string;
    fonts?: Array<{ id: string; label?: string; category?: string }>;
    marks?: readonly string[];
    [k: string]: unknown;
  };
  tiers: Record<string, unknown>;
  pricing: { upgradeUrl: string; [k: string]: unknown };
};

const FALLBACK: Catalog = {
  version: 0,
  galleryUrl: "https://appscreen.co/mcp/options",
  sizes: [
    { id: "ios-6.9", label: "iPhone 6.9\"", width: 1320, height: 2868, store: "appstore" },
    { id: "ios-6.7", label: "iPhone 6.7\"", width: 1290, height: 2796, store: "appstore" },
    { id: "ios-6.5", label: "iPhone 6.5\"", width: 1284, height: 2778, store: "appstore" },
    { id: "ios-6.3", label: "iPhone 6.3\"", width: 1206, height: 2622, store: "appstore" },
    { id: "play", label: "Play phone", width: 1080, height: 1920, store: "playstore" },
  ],
  langs: ["en", "es", "fr", "de", "it", "pt", "nl", "sv", "pl", "tr", "ru", "ar", "ja", "ko", "zh"],
  layouts: ["default", "fastlane", "flutter", "react-native", "capacitor", "kmm"],
  backgrounds: {
    kinds: ["color", "preset", "image", "effect"],
    presets: ["paper", "frame", "card", "mesh"],
    effects: ["blur", "blur+tint"],
  },
  frames: [
    { id: "iphone", label: "iPhone", kind: "device", aspectWOverH: 1520 / 3068 },
    { id: "pixel", label: "Pixel", kind: "device", aspectWOverH: 1620 / 3136 },
    { id: "generic-minimal", label: "Generic — minimal", kind: "generic", aspectWOverH: null },
    { id: "generic-outline", label: "Generic — outline", kind: "generic", aspectWOverH: null },
    { id: "generic-glow", label: "Generic — glow", kind: "generic", aspectWOverH: null },
  ],
  tiers: {},
  pricing: { upgradeUrl: "https://appscreen.co/pricing" },
};

async function readCached(file: string, maxAgeMs: number): Promise<Catalog | null> {
  try {
    const st = await stat(file);
    if (Date.now() - st.mtimeMs > maxAgeMs) return null;
    const buf = await readFile(file, "utf8");
    return JSON.parse(buf) as Catalog;
  } catch {
    return null;
  }
}

async function writeCached(file: string, c: Catalog): Promise<void> {
  try {
    const { dirname } = await import("node:path");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(c), "utf8");
  } catch {
    // cache write is best-effort
  }
}

export type CatalogOptions = {
  baseUrl?: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  // Override cache file path. Defaults to ~/Library/Caches/appscreen/catalog.json
  // (or the XDG equivalent). Tests pass a tmpdir path to isolate state.
  cacheFile?: string;
};

export async function loadCatalog(opts: CatalogOptions = {}): Promise<Catalog> {
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const file = opts.cacheFile ?? DEFAULT_CACHE_FILE;
  const cached = await readCached(file, ttl);
  if (cached) return cached;
  const base = opts.baseUrl ?? process.env.APPSCREEN_BASE_URL ?? "https://api.appscreen.co";
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${base}/v1/catalog`);
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const body = (await res.json()) as Catalog;
    await writeCached(file, body);
    return body;
  } catch {
    // Network down or endpoint missing (pre-P2 API) → use the inline
    // fallback. Stale, but the renderer schema is forgiving and the
    // agent will get a sensible error from the API if it picks
    // something invalid.
    return FALLBACK;
  }
}

export const __testing__ = {
  DEFAULT_CACHE_FILE,
  CACHE_TTL_MS,
  FALLBACK,
};
