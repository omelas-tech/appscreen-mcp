#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { registerTools } from "./server.js";

// Read version from package.json at runtime so it never drifts from
// the published version (release.mjs bumps package.json, not source).
// dist/index.js → ../package.json; src/index.ts → ../package.json. Both
// resolve correctly relative to this module.
const require = createRequire(import.meta.url);
const PKG_VERSION = (require("../package.json") as { version: string }).version;

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "appscreen-mcp", version: PKG_VERSION },
    {
      instructions:
        "Generate App Store / Play Store screenshots. Call `render_screenshots` with screen layouts and raw app PNGs (base64). Returns a jobId; poll with `get_render_status` until status=done, then download the bundle from the resource_link.",
    },
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr only — stdout is reserved for JSON-RPC frames.
  process.stderr.write(`[appscreen-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
