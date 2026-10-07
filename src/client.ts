import { Buffer } from "node:buffer";

const DEFAULT_BASE_URL = "https://api.appscreen.co";

// Anonymous renders run inline (synchronous Chromium) on the server, so a
// busy/wedged render can take a while; keyed renders return a jobId fast.
// Without a client deadline a hung server pins the agent forever — exactly
// the "stuck 30 min" symptom. Bound it and surface a clear, retryable
// error instead. Override via APPSCREEN_TIMEOUT_MS.
const DEFAULT_RENDER_TIMEOUT_MS = 180_000;
const DEFAULT_STATUS_TIMEOUT_MS = 30_000;

export type ClientOptions = {
  apiKey: string | null;
  anonId: string | null;
  baseUrl?: string;
  mcpClient?: string;
  renderTimeoutMs?: number;
  statusTimeoutMs?: number;
};

export class AppscreenTimeoutError extends Error {
  constructor(public readonly url: string, public readonly ms: number) {
    super(
      `request to ${url} timed out after ${Math.round(ms / 1000)}s. The render may still be processing — for keyed renders poll get_render_status; for anonymous renders retry (with an idempotencyKey to avoid double-spend).`,
    );
    this.name = "AppscreenTimeoutError";
  }
}

export type RenderArgs = {
  sizes: string[];
  langs: string[];
  layout?: string;
  rounded?: boolean;
  cornerRadius?: string;
  autoBox?: boolean;
  screens: unknown[];
  screensMeta?: unknown[];
  files: { name: string; base64: string }[];
  idempotencyKey?: string;
};

export type RenderResponse = {
  jobId?: string;
  status?: string;
  totalSteps?: number;
  doneSteps?: number;
  downloadUrl?: string | null;
  pollUrl?: string;
  screenCount?: number;
  error?: string;
  tier?: string;
  monthlyUsed?: number;
  monthlyCap?: number;
};

// Signed-in usage is metered in credits (1 credit = 1 exported image).
// `used` / `cap` come from the X-Quota-* headers every API version sends:
// for a signed-in caller they count credits (cap − used = what is left), for
// an anonymous one (tier "anon-mcp") they count lifetime renders. `balance`
// and `cost` come from X-Credits-Balance / X-Credits-Cost, which only a
// credits-aware API sends — absent (null) on anonymous calls and older APIs.
export type Quota = {
  used: number | null;
  cap: number | null;
  resetAt: string | null;
  /** Plan id: free | starter | pro | team | admin — or "anon-mcp". */
  tier: string | null;
  /** Credits left in the key's workspace (plan + packs). */
  balance?: number | null;
  /** Credits the submitted export cost. Render submit only. */
  cost?: number | null;
};

export type WhoamiResponse = {
  /** Plan id (free | starter | pro | team | admin), "anon-mcp" or "anonymous". */
  tier: string;
  monthlyUsed: number;
  monthlyCap: number | null;
  resetAt: string | null;
  /** The workspace the key belongs to — its credits are what renders spend. */
  workspace?: { id: string; name: string; kind: "personal" | "team" };
  /** balance = plan + pack. Absent on anonymous calls and older APIs. */
  credits?: { balance: number; plan: number; pack: number };
};

export type ApiResult<T> = {
  status: number;
  body: T;
  quota: Quota;
};

export class AppscreenHttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    const msg = typeof body === "object" && body && "error" in body && typeof (body as { error: unknown }).error === "string"
      ? (body as { error: string }).error
      : `HTTP ${status}`;
    super(msg);
    this.name = "AppscreenHttpError";
    this.status = status;
    this.body = body;
  }
}

export class AppscreenClient {
  private readonly baseUrl: string;
  private readonly renderTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  constructor(private readonly opts: ClientOptions) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const envMs = Number(process.env.APPSCREEN_TIMEOUT_MS);
    const override = Number.isFinite(envMs) && envMs > 0 ? envMs : undefined;
    this.renderTimeoutMs = opts.renderTimeoutMs ?? override ?? DEFAULT_RENDER_TIMEOUT_MS;
    this.statusTimeoutMs = opts.statusTimeoutMs ?? override ?? DEFAULT_STATUS_TIMEOUT_MS;
  }

  // fetch with a hard deadline. Converts an abort into a typed timeout
  // error so callers (and the agent) get an actionable message rather
  // than a generic "aborted".
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AppscreenTimeoutError(url, timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "X-MCP-Client": this.opts.mcpClient ?? "unknown",
    };
    if (this.opts.apiKey) h["X-API-Key"] = this.opts.apiKey;
    else if (this.opts.anonId) h["X-Anon-Id"] = this.opts.anonId;
    return h;
  }

  private parseQuota(res: Response): Quota {
    const used = res.headers.get("x-quota-used");
    const cap = res.headers.get("x-quota-cap");
    const reset = res.headers.get("x-quota-reset");
    const tier = res.headers.get("x-quota-tier");
    const balance = res.headers.get("x-credits-balance");
    const cost = res.headers.get("x-credits-cost");
    return {
      used: used !== null ? Number(used) : null,
      cap: cap !== null ? Number(cap) : null,
      resetAt: reset,
      tier,
      balance: balance !== null ? Number(balance) : null,
      cost: cost !== null ? Number(cost) : null,
    };
  }

  async render(args: RenderArgs): Promise<ApiResult<RenderResponse>> {
    const form = new FormData();
    form.set("sizes", JSON.stringify(args.sizes));
    form.set("langs", JSON.stringify(args.langs));
    form.set("screens_v2", JSON.stringify(args.screens));
    if (args.screensMeta) form.set("screens_meta", JSON.stringify(args.screensMeta));
    if (args.layout) form.set("layout", args.layout);
    if (args.rounded !== undefined) form.set("rounded", String(args.rounded));
    if (args.autoBox !== undefined) form.set("autoBox", String(args.autoBox));
    if (args.cornerRadius) form.set("cornerRadius", args.cornerRadius);
    for (const f of args.files) {
      const buf = Buffer.from(f.base64, "base64");
      // Blob constructor expects Uint8Array, not Buffer subclass directly in some Node versions
      const blob = new Blob([new Uint8Array(buf)], { type: "image/png" });
      form.append("screens", blob, f.name);
    }
    const headers = this.authHeaders();
    if (args.idempotencyKey) headers["Idempotency-Key"] = args.idempotencyKey;
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/v1/render`,
      { method: "POST", headers, body: form },
      this.renderTimeoutMs,
    );
    const body = (await res.json().catch(() => ({}))) as RenderResponse;
    const quota = this.parseQuota(res);
    if (res.status >= 400) throw new AppscreenHttpError(res.status, { ...body, quota });
    return { status: res.status, body, quota };
  }

  async getJob(jobId: string): Promise<ApiResult<RenderResponse>> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/v1/render/${encodeURIComponent(jobId)}`,
      { method: "GET", headers: this.authHeaders() },
      this.statusTimeoutMs,
    );
    const body = (await res.json().catch(() => ({}))) as RenderResponse;
    const quota = this.parseQuota(res);
    if (res.status >= 400) throw new AppscreenHttpError(res.status, { ...body, quota });
    return { status: res.status, body, quota };
  }

  // monthlyUsed / monthlyCap keep their names from before credits; for a
  // signed-in caller they now count credits (cap − used = balance). A
  // credits-aware API also returns `workspace` and `credits`.
  async whoami(): Promise<ApiResult<WhoamiResponse>> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/v1/whoami`,
      { method: "GET", headers: this.authHeaders() },
      this.statusTimeoutMs,
    );
    const body = (await res.json().catch(() => ({}))) as WhoamiResponse;
    const quota = this.parseQuota(res);
    if (res.status >= 400) throw new AppscreenHttpError(res.status, body);
    return { status: res.status, body, quota };
  }
}
