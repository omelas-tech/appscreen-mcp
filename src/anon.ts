import envPaths from "env-paths";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const paths = envPaths("appscreen", { suffix: "" });
const ANON_FILE = join(paths.data, "anon-id");

export async function loadOrCreateAnonId(): Promise<string> {
  try {
    const buf = await readFile(ANON_FILE, "utf8");
    const id = buf.trim();
    if (/^[0-9a-f-]{36}$/i.test(id)) return id;
  } catch {
    // fall through to create
  }
  const id = randomUUID();
  await mkdir(paths.data, { recursive: true });
  await writeFile(ANON_FILE, id, "utf8");
  return id;
}
