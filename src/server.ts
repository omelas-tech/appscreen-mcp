import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { AppscreenClient, AppscreenHttpError, type Quota } from "./client.js";
import { loadOrCreateAnonId } from "./anon.js";
import { loadCatalog, type Catalog, type Option } from "./catalog.js";
import { defaultBoxFor, findFrame, findSize } from "./geometry.js";
import { nudge } from "./quota.js";

const apiKey = process.env.APPSCREEN_API_KEY?.trim() || null;
const baseUrl = process.env.APPSCREEN_BASE_URL?.trim() || undefined;
const UPGRADE_URL = "https://appscreen.co/pricing";

let cachedClient: AppscreenClient | null = null;
let cachedAnonId: string | null = null;
let cachedCatalog: Catalog | null = null;

async function getClient(mcpClient: string): Promise<AppscreenClient> {
  if (cachedClient) return cachedClient;
  if (!apiKey) cachedAnonId = await loadOrCreateAnonId();
  cachedClient = new AppscreenClient({
    apiKey,
    anonId: cachedAnonId,
    baseUrl,
    mcpClient,
  });
  return cachedClient;
}

async function getCatalog(): Promise<Catalog> {
  if (cachedCatalog) return cachedCatalog;
  cachedCatalog = await loadCatalog({ baseUrl });
  return cachedCatalog;
}

// Per-file cap mirrors the API's multer limit (10MB). Files are read off
// disk here so the bytes never transit the model.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function expandPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

// Normalize each input file to base64 the SERVER produced. For path
// inputs we read the file ourselves (no model in the byte path → no
// corruption); base64 inputs pass through for tiny test cases. The
// base64 created here by Buffer.toString is faithful — the corruption
// only ever came from the model emitting the string.
async function resolveFiles(
  files: Array<{ name: string; path?: string; base64?: string }>,
): Promise<{ name: string; base64: string }[]> {
  return Promise.all(
    files.map(async (f) => {
      if (f.path) {
        const abs = expandPath(f.path);
        let buf: Buffer;
        try {
          buf = await readFile(abs);
        } catch {
          throw new Error(`cannot read file for "${f.name}": ${f.path} (resolved ${abs})`);
        }
        if (buf.length === 0) throw new Error(`"${f.name}" is empty: ${f.path}`);
        if (buf.length > MAX_FILE_BYTES) {
          throw new Error(
            `"${f.name}" is ${(buf.length / 1048576).toFixed(1)}MB — exceeds the 10MB per-file limit (${f.path})`,
          );
        }
        return { name: f.name, base64: buf.toString("base64") };
      }
      return { name: f.name, base64: f.base64! };
    }),
  );
}

// ─── Inline upload assembly ───────────────────────────────────────────
// Turn inline image paths (screenshot.path / pathsByLang, bg.path on an
// image background, path on image objects) into the API's flat
// files[] + screensMeta binding, so callers never hand-build screensMeta.
// Returns null when no inline images are present (caller falls back to
// explicit top-level files + screensMeta).

type InlineScreen = {
  bg?: { kind?: string; path?: string; [k: string]: unknown };
  screenshot?: { path?: string; pathsByLang?: Record<string, string>; visible?: boolean; [k: string]: unknown };
  objects?: Array<{ kind?: string; id?: string; path?: string; mime?: string; [k: string]: unknown }>;
  [k: string]: unknown;
};

type Assembled = {
  files: { name: string; path: string }[];
  screensMeta: Array<{ rowIdx: number; lang: string | null; kind: "screen" | "bg" | "object"; objectId?: string; objectMime?: "image/png" | "image/svg+xml" }>;
};

function collectInlineUploads(screens: InlineScreen[]): Assembled | null {
  const files: { name: string; path: string }[] = [];
  const screensMeta: Assembled["screensMeta"] = [];
  let found = false;
  screens.forEach((s, i) => {
    const ss = s.screenshot;
    if (ss?.pathsByLang && Object.keys(ss.pathsByLang).length > 0) {
      found = true;
      for (const [lang, p] of Object.entries(ss.pathsByLang)) {
        files.push({ name: `r${i}-ss-${lang}.png`, path: p });
        screensMeta.push({ rowIdx: i, lang, kind: "screen" });
      }
    } else if (ss?.path) {
      found = true;
      files.push({ name: `r${i}-ss.png`, path: ss.path });
      screensMeta.push({ rowIdx: i, lang: null, kind: "screen" });
    }
    if (s.bg?.kind === "image" && s.bg.path) {
      found = true;
      files.push({ name: `r${i}-bg.png`, path: s.bg.path });
      screensMeta.push({ rowIdx: i, lang: null, kind: "bg" });
    }
    for (const o of s.objects ?? []) {
      if (o.kind === "image" && o.path && o.id) {
        found = true;
        const ext = o.mime === "image/svg+xml" ? "svg" : "png";
        files.push({ name: `r${i}-obj-${o.id}.${ext}`, path: o.path });
        screensMeta.push({
          rowIdx: i,
          lang: null,
          kind: "object",
          objectId: o.id,
          objectMime: o.mime === "image/svg+xml" ? "image/svg+xml" : "image/png",
        });
      }
    }
  });
  return found ? { files, screensMeta } : null;
}

// Remove inline path fields before sending screens to the API — the API
// expects bytes via files+screensMeta, not inline paths (it would strip
// them anyway; this keeps the payload clean).
function stripInlinePaths<T extends InlineScreen>(screens: T[]): T[] {
  return screens.map((s) => {
    const out: InlineScreen = { ...s };
    if (out.screenshot) {
      const ss = { ...out.screenshot };
      delete ss.path;
      delete ss.pathsByLang;
      out.screenshot = ss;
    }
    if (out.bg && out.bg.kind === "image") {
      const bg = { ...out.bg };
      delete bg.path;
      out.bg = bg;
    }
    if (out.objects) {
      out.objects = out.objects.map((o) => {
        if (o.kind === "image") {
          const x = { ...o };
          delete x.path;
          return x;
        }
        return o;
      });
    }
    return out as T;
  });
}

// ─── Tool schemas ─────────────────────────────────────────────────────
// Enums are *not* pulled from /v1/catalog at registration time because
// MCP `tools/list` needs a synchronous JSON Schema. We use forgiving
// `z.string()` here and let the server validate authoritatively. The
// description points the agent at the `appscreen://catalog/*` resources
// for the live list.

const layerBox = z.object({
  x: z.number().min(-2).max(3),
  y: z.number().min(-2).max(3),
  w: z.number().min(0.01).max(5),
  h: z.number().min(0.01).max(5),
  rotation: z.number().min(-360).max(360).optional(),
});

const richTextDoc = z.object({
  type: z.literal("doc"),
  content: z.array(z.unknown()).optional(),
});

const bgSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("color"), color: z.string().max(32) }),
  z.object({
    kind: z.literal("preset"),
    preset: z.string().describe("One of catalog.backgrounds.presets"),
    color: z.string().max(32),
  }),
  z.object({
    kind: z.literal("image"),
    box: layerBox,
    path: z.string().min(1).max(1024).optional().describe("Local path to a full-bleed background image — the server reads it (like screenshots). No base64."),
  }),
  z.object({
    kind: z.literal("effect"),
    effect: z.string().describe("One of catalog.backgrounds.effects"),
    color: z.string().max(32),
  }),
]);

const textObject = z.object({
  id: z.string().min(1).max(64),
  kind: z.literal("text"),
  box: layerBox,
  belowScreenshot: z.boolean().optional(),
  content: z.record(z.string().max(16), richTextDoc),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
});

const imageObject = z.object({
  id: z.string().min(1).max(64),
  kind: z.literal("image"),
  box: layerBox,
  belowScreenshot: z.boolean().optional(),
  mime: z.enum(["image/png", "image/svg+xml"]),
  aspectRatio: z.number().min(0.05).max(20).optional(),
  path: z.string().min(1).max(1024).optional().describe("Local path to this object's image (logo, decoration) — the server reads it. No base64."),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
});

const screenSchema = z.object({
  bg: bgSchema,
  screenshot: z.object({
    // box is OPTIONAL. Omit it and the server computes an aspect-correct,
    // centered box from the frame + size so the device never stretches.
    // Only supply box if you need custom placement; if you do, size it at
    // the frame's native aspect (see catalog.frames[].aspectWOverH) or the
    // phone will look distorted.
    box: layerBox.optional(),
    visible: z.boolean().optional(),
    frameId: z.string().optional().describe("One of catalog.frames[].id. Read appscreen://catalog/frames for previews."),
    frameColor: z.string().max(32).optional(),
    frameGlow: z.string().max(32).optional(),
    // Inline screenshot source (preferred). Provide either one path for
    // all locales, or pathsByLang for per-locale screenshots (e.g. RTL).
    // The server reads the file(s) — no base64, no manual screensMeta.
    path: z.string().min(1).max(1024).optional().describe("Local path to this screen's screenshot."),
    pathsByLang: z.record(z.string().max(16), z.string().min(1).max(1024)).optional().describe("Per-locale screenshots: { en: '/path/en.png', es: '/path/es.png' }."),
  }),
  objects: z.array(z.discriminatedUnion("kind", [textObject, imageObject])).max(50),
});

const renderInput = {
  sizes: z.array(z.string()).min(1).max(5).describe("Target canvas sizes (catalog.sizes[].id)."),
  langs: z.array(z.string()).min(1).max(15).describe("Locales (catalog.langs)."),
  screens: z.array(screenSchema).min(1).max(200),
  files: z
    .array(
      z
        .object({
          name: z.string().min(1).max(200),
          path: z
            .string()
            .min(1)
            .max(1024)
            .optional()
            .describe(
              "Local filesystem path to the image (absolute, or ~ for home). STRONGLY PREFERRED: the MCP server reads the bytes off disk, so they never pass through the model. Always use this for real screenshots.",
            ),
          base64: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Base64-encoded image. ONLY for tiny synthetic test images — a large base64 string corrupts when an LLM emits it token-by-token (PNG decodes to black below the first bad char). Use `path` for anything real.",
            ),
        })
        .refine((f) => Boolean(f.path) || Boolean(f.base64), {
          message: "each file needs `path` (preferred) or `base64`",
        }),
    )
    .max(200)
    .optional()
    .describe(
      "Low-level uploads + manual screensMeta binding. PREFER inline paths instead: put screenshot.path / screenshot.pathsByLang on each screen, bg.path on an image background, and path on image objects — the server assembles the upload + binding for you. Use this top-level files[] only if you're hand-managing screensMeta.",
    ),
  screensMeta: z
    .array(
      z.object({
        rowIdx: z.number().int().min(0).max(199),
        lang: z.union([z.string(), z.null()]),
        kind: z.enum(["screen", "bg", "object"]),
        objectId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
        objectMime: z.enum(["image/png", "image/svg+xml"]).optional(),
      }),
    )
    .optional(),
  layout: z.string().optional().describe("One of catalog.layouts (default = `default`)."),
  rounded: z.boolean().optional(),
  cornerRadius: z.string().max(16).optional(),
  idempotencyKey: z.string().max(200).optional(),
};

const statusInput = {
  jobId: z.string().regex(/^[0-9a-f-]{36}$/i),
};

// Documents the tiptap doc shape that text objects use. Returned verbatim
// by the appscreen://schema/text resource. Discovered-by-trial previously
// (notes F5); now first-class.
const TEXT_DOC_SCHEMA = {
  description:
    "Text objects (screens[].objects with kind:'text') carry a tiptap/ProseMirror doc per language, keyed by lang code in `content`. Marks attach PER TEXT RUN, so styling is partial — split a line into multiple text nodes to color/size/font individual words differently.",
  supportedMarks: ["bold", "italic", "underline", "textStyle"],
  textStyleAttrs: {
    color: "hex, e.g. #FFFFFF",
    fontSize: "px or cqw, e.g. 72px or 6.5cqw (cqw scales with canvas)",
    fontWeight: "100–900, e.g. 800",
    fontFamily: "a font id from catalog.text.fonts, e.g. 'playfair' (default: nunito)",
  },
  paragraphAttrs: { textAlign: "center | left | right" },
  fontsResource: "read appscreen://catalog/fonts for the full list of ~37 font ids",
  partialStylingExample: {
    note: "Two runs in one line: 'Your' bold-white, 'Macs' accent in a display font.",
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { textAlign: "center" },
        content: [
          {
            type: "text",
            marks: [{ type: "bold" }, { type: "textStyle", attrs: { color: "#FFFFFF", fontSize: "72px" } }],
            text: "Your ",
          },
          {
            type: "text",
            marks: [
              { type: "bold" },
              { type: "textStyle", attrs: { color: "#7DF9FF", fontSize: "72px", fontFamily: "playfair" } },
            ],
            text: "Macs",
          },
          {
            type: "text",
            marks: [{ type: "bold" }, { type: "textStyle", attrs: { color: "#FFFFFF", fontSize: "72px" } }],
            text: ", one tap away",
          },
        ],
      },
    ],
  },
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; mimeType: string; description?: string };

function quotaMeta(q: Quota): Record<string, unknown> {
  const n = nudge(q);
  return {
    quota: {
      used: q.used,
      cap: q.cap,
      tier: q.tier,
      resetAt: q.resetAt,
      // Credits-aware APIs only: what is left, and what this export cost.
      ...(q.balance !== null && q.balance !== undefined ? { balance: q.balance } : {}),
      ...(q.cost !== null && q.cost !== undefined ? { cost: q.cost } : {}),
    },
    ...(n?.upgradeUrl ? { upgradeUrl: n.upgradeUrl } : {}),
  };
}

function clientNameFrom(server: McpServer): string {
  const info = server.server.getClientVersion?.();
  if (info?.name) return info.version ? `${info.name}/${info.version}` : info.name;
  return process.env.APPSCREEN_MCP_CLIENT?.trim() || "unknown";
}

// Fill any screen whose screenshot.box was omitted with an aspect-correct,
// centered box derived from its frame + the primary requested size. This is
// the single fix for the "tall/skinny phone" distortion: callers should NOT
// hand-roll box geometry. Computed against sizes[0]; all iOS sizes share a
// near-identical aspect so one fraction box is correct across them.
type LooseScreen = {
  screenshot?: { box?: unknown; frameId?: string; visible?: boolean };
  [k: string]: unknown;
};

async function fillBoxes<T extends LooseScreen>(screens: T[], sizes: string[]): Promise<T[]> {
  const needsFill = screens.some((s) => !s.screenshot || s.screenshot.box === undefined);
  if (!needsFill) return screens;

  const catalog = await getCatalog();
  const primarySize = findSize(catalog, sizes[0]) ?? catalog.sizes[0];
  return screens.map((s) => {
    const shot = s.screenshot ?? {};
    if (shot.box !== undefined) return s;
    const frame = findFrame(catalog, shot.frameId);
    const box = defaultBoxFor(primarySize, frame);
    return { ...s, screenshot: { ...shot, box, visible: shot.visible ?? true } };
  });
}

// ─── Registration ────────────────────────────────────────────────────

export function registerTools(server: McpServer): void {
  registerToolHandlers(server);
  registerResources(server);
  registerPrompts(server);
}

function registerToolHandlers(server: McpServer): void {
  server.registerTool(
    "render_screenshots",
    {
      title: "Render App Store / Play Store screenshots",
      description:
        "Queue a screenshot render; returns jobId, poll get_render_status until done, then fetch the bundle from the resource_link.\n\n" +
        "BEFORE CALLING THIS: read the appscreen://options resource and present the user the FULL menu of background effects, frames, and presets — each has a preview URL they can open. Let the user pick; never choose a background or frame silently. blur+tint, mesh, and every frame are all valid choices they should see.\n\n" +
        "IMAGES — put a local file path right on the element; the server reads the bytes off disk and wires up the binding for you. Never base64 real screenshots (a large base64 corrupts token-by-token → renders black):\n" +
        "• screenshot: screens[i].screenshot.path = \"~/shot.png\" (or pathsByLang: { en, es } for per-locale shots)\n" +
        "• background image: screens[i].bg = { kind:\"image\", box, path:\"~/bg.png\" }\n" +
        "• logo/decoration: screens[i].objects[] = { kind:\"image\", id:\"logo\", box, mime:\"image/png\", path:\"~/logo.png\" }\n\n" +
        "Geometry is automatic: omit screenshot.box and the server centers the device at the correct aspect ratio. screensMeta is auto-derived when you upload exactly one file per screen. Text overlays use the tiptap doc format and support rich, PARTIAL styling — per-run color, fontSize, fontWeight, fontFamily (~37 fonts), plus bold/italic/underline and per-paragraph align. See appscreen://schema/text + appscreen://catalog/fonts. Free anonymous tier: 5 lifetime renders.",
      inputSchema: renderInput,
    },
    async (args) => {
      const client = await getClient(clientNameFrom(server));
      try {
        // Inline mode: screenshot/bg/object paths on the screens → assemble
        // files + screensMeta here. Else fall back to explicit top-level
        // files + screensMeta (legacy/manual binding).
        const inline = collectInlineUploads(args.screens as InlineScreen[]);
        const screensIn = inline ? stripInlinePaths(args.screens as InlineScreen[]) : args.screens;
        const filesIn = inline ? inline.files : args.files ?? [];
        const metaIn = inline ? inline.screensMeta : args.screensMeta;
        if (filesIn.length === 0) {
          return errorResult(
            new Error(
              "no images provided — put screenshot.path (or screenshot.pathsByLang) on each screen, or pass top-level files[].",
            ),
          );
        }
        const screens = await fillBoxes(screensIn as typeof args.screens, args.sizes);
        // Read files off disk locally — bytes never pass through the model.
        const files = await resolveFiles(filesIn);
        const result = await client.render({
          sizes: args.sizes,
          langs: args.langs,
          screens,
          screensMeta: metaIn,
          files,
          layout: args.layout,
          rounded: args.rounded,
          cornerRadius: args.cornerRadius,
          // Let the server own per-size device geometry: aspect-correct,
          // centered, no top/bottom crop, correct width on every canvas.
          autoBox: true,
          idempotencyKey: args.idempotencyKey,
        });
        return renderResult(result.body, result.quota, files.length);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_render_status",
    {
      title: "Poll a render job",
      description:
        "Returns status (queued|running|done|failed), progress, and downloadUrl when ready. Only needed when render_screenshots returned a jobId with status=queued (the keyed/async path). Anonymous and small renders often complete inline — if render_screenshots already returned a downloadUrl, you do NOT need to poll.",
      inputSchema: statusInput,
    },
    async ({ jobId }) => {
      const client = await getClient(clientNameFrom(server));
      try {
        const { body, quota } = await client.getJob(jobId);
        const content: ContentBlock[] = [];
        const lines = [
          `jobId=${jobId} status=${body.status ?? "unknown"} progress=${body.doneSteps ?? "?"}/${body.totalSteps ?? "?"}`,
        ];
        if (body.error) lines.push(`error: ${body.error}`);
        const n = nudge(quota);
        if (n) lines.push(n.text);
        content.push({ type: "text", text: lines.join("\n") });
        if (body.downloadUrl) {
          content.push({
            type: "resource_link",
            uri: body.downloadUrl,
            name: "bundle.zip",
            mimeType: "application/zip",
            description: "Rendered bundle (signed URL, ~1h TTL).",
          });
        }
        return {
          content,
          structuredContent: {
            jobId,
            status: body.status ?? null,
            doneSteps: body.doneSteps ?? null,
            totalSteps: body.totalSteps ?? null,
            downloadUrl: body.downloadUrl ?? null,
            error: body.error ?? null,
          },
          _meta: quotaMeta(quota),
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

function renderResult(
  body: { jobId?: string; status?: string; downloadUrl?: string | null; doneSteps?: number; totalSteps?: number; screenCount?: number },
  quota: Quota,
  fileCount: number,
) {
  const content: ContentBlock[] = [];
  const lines: string[] = [];
  if (body.jobId) {
    lines.push(`Render queued. jobId=${body.jobId} (poll with get_render_status).`);
  } else if (body.downloadUrl) {
    lines.push(`Render complete (${body.screenCount ?? fileCount} screens).`);
  } else {
    lines.push("Render accepted.");
  }
  const n = nudge(quota);
  if (n) lines.push(n.text);
  content.push({ type: "text", text: lines.join("\n") });
  if (body.downloadUrl) {
    content.push({
      type: "resource_link",
      uri: body.downloadUrl,
      name: "bundle.zip",
      mimeType: "application/zip",
      description: "Rendered bundle (signed URL, ~1h TTL).",
    });
  }
  return {
    content,
    structuredContent: {
      jobId: body.jobId ?? null,
      status: body.status ?? (body.downloadUrl ? "done" : "queued"),
      doneSteps: body.doneSteps ?? null,
      totalSteps: body.totalSteps ?? null,
      downloadUrl: body.downloadUrl ?? null,
    },
    _meta: quotaMeta(quota),
  };
}

function errorResult(err: unknown): {
  content: ContentBlock[];
  isError: true;
  _meta?: Record<string, unknown>;
} {
  if (err instanceof AppscreenHttpError) {
    const body = err.body as {
      quota?: Quota;
      error?: string;
      code?: string;
      tier?: string;
      cost?: number;
      balance?: number;
      upgradeUrl?: string;
    } | null;
    const quota = body?.quota;
    const lines = [`AppScreen API error (HTTP ${err.status}): ${err.message}`];
    if (body?.tier) lines.push(`tier: ${body.tier}`);
    if (body?.code === "insufficient_credits") {
      lines.push(
        "1 credit = 1 exported image (screens × sizes × languages). Render fewer screens, sizes or languages, buy a credit pack (works on every plan), or upgrade.",
      );
    } else if (body?.code === "funding_changed") {
      lines.push("Nothing was charged. Submit the same render again.");
    }
    if (body?.upgradeUrl) lines.push(`upgrade: ${body.upgradeUrl}`);
    if (quota) {
      const n = nudge(quota);
      if (n) lines.push(n.text);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      isError: true,
      _meta: quota ? quotaMeta(quota) : undefined,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `appscreen-mcp error: ${msg}` }],
    isError: true,
  };
}

// ─── Resources ───────────────────────────────────────────────────────

function registerResources(server: McpServer): void {
  const slice = async (
    pick: (c: Catalog) => unknown,
    uri: string,
  ): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> => {
    const c = await getCatalog();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(pick(c), null, 2),
        },
      ],
    };
  };

  // The headline resource: a single, human-presentable menu of every
  // choice the user makes, each with a preview URL. The agent should read
  // this and lay the options out for the user BEFORE rendering — this is
  // what surfaces blur+tint, every frame, every preset.
  server.registerResource(
    "options",
    "appscreen://options",
    {
      title: "All options (present these to the user)",
      description:
        "The complete, self-describing menu of backgrounds, effects, frames, presets, sizes and layouts — each with a clickable preview URL. Show this to the user and let them choose; do not pick silently.",
      mimeType: "application/json",
    },
    async () => {
      const c = await getCatalog();
      const optionList = (arr: ReadonlyArray<string | Option>): Option[] =>
        arr.map((o) => (typeof o === "string" ? { id: o } : o));
      const menu = {
        galleryUrl: c.galleryUrl ?? "https://appscreen.co/mcp/options",
        instructions:
          "Present every option below to the user with its label, description, and exampleUrl (a clickable preview). Ask which they want. Only after they choose should you call render_screenshots.",
        backgroundEffects: optionList(c.backgrounds.effects),
        backgroundPresets: optionList(c.backgrounds.presets),
        backgroundKinds: optionList(c.backgrounds.kinds),
        frames: c.frames,
        sizes: c.sizes,
        layouts: optionList(c.layouts),
      };
      return {
        contents: [
          { uri: "appscreen://options", mimeType: "application/json", text: JSON.stringify(menu, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    "schema-text",
    "appscreen://schema/text",
    {
      title: "Text overlay schema (tiptap doc)",
      description: "The exact JSON shape + supported marks for text objects in screens[].objects.",
      mimeType: "application/json",
    },
    () => ({
      contents: [
        {
          uri: "appscreen://schema/text",
          mimeType: "application/json",
          text: JSON.stringify(TEXT_DOC_SCHEMA, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "catalog-sizes",
    "appscreen://catalog/sizes",
    {
      title: "Catalog: sizes",
      description: "Valid canvas sizes (App Store + Play Store).",
      mimeType: "application/json",
    },
    () => slice((c) => c.sizes, "appscreen://catalog/sizes"),
  );

  server.registerResource(
    "catalog-langs",
    "appscreen://catalog/langs",
    {
      title: "Catalog: languages",
      description: "Supported locales.",
      mimeType: "application/json",
    },
    () => slice((c) => c.langs, "appscreen://catalog/langs"),
  );

  server.registerResource(
    "catalog-frames",
    "appscreen://catalog/frames",
    {
      title: "Catalog: device frames",
      description: "Valid frameId values for screen.screenshot.frameId.",
      mimeType: "application/json",
    },
    () => slice((c) => c.frames, "appscreen://catalog/frames"),
  );

  server.registerResource(
    "catalog-backgrounds",
    "appscreen://catalog/backgrounds",
    {
      title: "Catalog: backgrounds",
      description: "Valid background kinds, presets, and effects.",
      mimeType: "application/json",
    },
    () => slice((c) => c.backgrounds, "appscreen://catalog/backgrounds"),
  );

  server.registerResource(
    "catalog-layouts",
    "appscreen://catalog/layouts",
    {
      title: "Catalog: layouts",
      description: "Output bundle layouts (fastlane, flutter, etc.).",
      mimeType: "application/json",
    },
    () => slice((c) => c.layouts, "appscreen://catalog/layouts"),
  );

  server.registerResource(
    "catalog-fonts",
    "appscreen://catalog/fonts",
    {
      title: "Catalog: fonts + text styling",
      description: "Font ids for textStyle.fontFamily + the full text mark vocabulary (color, size, weight, family, align, partial per-run styling).",
      mimeType: "application/json",
    },
    () => slice((c) => c.text ?? { note: "text styling info unavailable" }, "appscreen://catalog/fonts"),
  );

  server.registerResource(
    "account",
    "appscreen://account",
    {
      title: "Account: plan + credits",
      description: "Current plan, workspace, credit balance (1 credit = 1 exported image), and reset time.",
      mimeType: "application/json",
    },
    async () => {
      const client = await getClient(clientNameFrom(server));
      try {
        const { body } = await client.whoami();
        return {
          contents: [
            {
              uri: "appscreen://account",
              mimeType: "application/json",
              text: JSON.stringify(body, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: "appscreen://account",
              mimeType: "application/json",
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
        };
      }
    },
  );

  server.registerResource(
    "upgrade",
    "appscreen://upgrade",
    {
      title: "Plans + credit packs",
      description: "Plans, one-time credit packs and the pricing URL, for when credits run out.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "appscreen://upgrade",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              checkoutUrl: UPGRADE_URL,
              note: "Usage is metered in credits: 1 credit = 1 exported image (screens × sizes × languages). Failed exports are refunded; auto-translate is free. No watermark on any plan. Unused plan credits roll over one billing period.",
              plans: [
                "Free — $0: 50 credits/month, iOS 6.9 only, English only, 10 screens/export, 1 project.",
                "Starter — $4/mo or $36/yr: 400 credits/month, all 5 sizes, any 3 languages per export, auto-translate, 50 screens/export, 3 projects.",
                "Pro — $8/mo or $60/yr: 2,500 credits/month, all 15 languages, 200 screens/export, 20 projects, programmatic API keys, full-rate MCP.",
                "Team — $29/mo or $288/yr: 8,000 pooled credits/month, 3 seats included (+$6/seat/mo), unlimited projects, roles, shared projects.",
              ],
              packs: "One-time credit packs on every plan, including Free: 100 for $5, 400 for $15, 1,500 for $39, valid 12 months. On Free, a pack-funded export unlocks every size and language.",
              mcp: "MCP keys work on every plan and spend the credits of the workspace they were created in. Below Pro, a 3 renders/hour limit applies.",
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}

// ─── Prompts ─────────────────────────────────────────────────────────

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "choose-style",
    {
      title: "Pick a style (shows every option with previews)",
      description:
        "Walk the user through the full option menu — backgrounds, effects, frames — with preview links, before any render. Use this when the user hasn't specified a look yet.",
      argsSchema: {
        appName: z.string().describe("App name, for context."),
      },
    },
    ({ appName }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `I want App Store screenshots for "${appName}" but haven't decided on a look.\n\n` +
              `Read the appscreen://options resource. Then present me the COMPLETE menu — every background effect (including blur and blur+tint), every preset, and every device frame — as a list where each item shows its name, a one-line description, and its preview URL that I can open in a browser.\n\n` +
              `Group them: (1) Background style — solid color / preset / blurred screenshot effect; (2) Device frame. For the blurred-screenshot options specifically, make sure I see both "blur" and "blur+tint" with their preview links. Wait for me to pick from each group before you build or render anything.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "quick-start",
    {
      title: "Quick start: render one screenshot",
      description: "Minimal one-screen render to verify the integration end-to-end.",
      argsSchema: {
        appName: z.string().describe("App name to use as caption."),
      },
    },
    ({ appName }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Use the appscreen-mcp tool to render one ios-6.9 / en screenshot for the app "${appName}".\n\n` +
              `Pick a default layout: solid background (#fafafa), one screen with the screenshot framed in iphone, and a single text overlay above with the app name. Pass the screenshot as files[0] = { name, path: "<local path to the PNG>" } — use the path, never base64 (large base64 corrupts).\n\n` +
              `After calling render_screenshots, immediately poll get_render_status every 5 seconds until status=done, then summarize the result and share the bundle URL.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "localize",
    {
      title: "Re-render existing screenshots in more languages",
      description: "Reuse a previous job's screens against a fresh set of target locales.",
      argsSchema: {
        previousJobId: z.string().describe("Job id returned from a prior render_screenshots call."),
        targetLangs: z
          .string()
          .describe("Comma-separated locale codes (e.g. `es,fr,de,ja`). See appscreen://catalog/langs."),
      },
    },
    ({ previousJobId, targetLangs }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Re-render the screens from jobId=${previousJobId} but with langs=${targetLangs.split(",").map((s) => s.trim()).join(",")}.\n\n` +
              `First fetch the screens metadata from the previous job's bundle if available, otherwise ask me for the screens JSON + raw PNGs again. Reuse the same layout, sizes, and bg/object overlays — only swap the per-lang text content.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "from-app-icon",
    {
      title: "Generate a bg palette from the app icon",
      description: "Sample colors from an app icon PNG and apply them to the screenshot background.",
      argsSchema: {
        iconHint: z.string().describe("Brief description of the icon (e.g. `bright orange flame on dark navy`)."),
      },
    },
    ({ iconHint }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Build a screenshot whose background palette is derived from the app icon: ${iconHint}.\n\n` +
              `Pick one accent color from the icon for the bg, then propose a layout with a contrasting text overlay above the screenshot. Use the iphone frame. Call render_screenshots when the design is ready; do not poll for status until I confirm.`,
          },
        },
      ],
    }),
  );
}

// Exposed for unit tests — pure-ish helpers with no MCP wiring.
export const __testing__ = {
  resolveFiles,
  expandPath,
  MAX_FILE_BYTES,
  collectInlineUploads,
  stripInlinePaths,
};
