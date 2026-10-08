import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PACKAGE_NAME } from "./meta.js";
import { errorMessage } from "./vikunja.js";

export interface Config {
  /** Instance root, as returned by normalizeUrl. */
  url: string;
  token: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const ConfigFile = z.object({ url: z.string(), token: z.string() }).partial();

/**
 * Where setup stores the URL and token. It's under the home directory on every
 * platform, because MCP clients start the server with a filtered environment
 * (Codex passes an allowlist), so variables like XDG_CONFIG_HOME can't be relied on.
 * Keeping the token here, not in client configs, keeps it out of dotfiles that get synced or shared.
 */
export function configPath(home: string = homedir()): string {
  return join(home, ".config", "vikunja-mcp", "config.json");
}

/** Reads the config file, or returns undefined if there isn't one. */
export async function readConfigFile(path: string): Promise<Partial<Config> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new ConfigError(`Could not read ${path}: ${errorMessage(error)}`);
  }
  try {
    return ConfigFile.parse(JSON.parse(text));
  } catch {
    throw new ConfigError(`${path} is not valid. Run \`vikunja-mcp setup\` to rewrite it.`);
  }
}

export const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Resolves the server's config. VIKUNJA_URL and VIKUNJA_TOKEN override the config
 * file, but the saved token is only ever sent to the saved URL: pointing
 * VIKUNJA_URL somewhere else requires VIKUNJA_TOKEN too.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env, path: string = configPath()): Promise<Config> {
  const file = await readConfigFile(path);
  const savedUrl = file?.url && normalizeUrl(file.url);
  const envUrl = env.VIKUNJA_URL?.trim();
  const url = envUrl ? normalizeUrl(envUrl) : savedUrl;
  const token = env.VIKUNJA_TOKEN?.trim() || (url === savedUrl ? file?.token : undefined);
  if (url && token) return { url, token };

  if (url && file?.token) {
    throw new ConfigError(
      `VIKUNJA_URL (${url}) differs from the saved URL (${savedUrl}), so the saved token isn't sent there. Set VIKUNJA_TOKEN as well, or unset VIKUNJA_URL.`,
    );
  }
  const missing = [!url && "URL", !token && "API token"].filter(Boolean).join(" and ");
  throw new ConfigError(
    `Vikunja is not configured (missing ${missing}). Run \`npx -y ${PACKAGE_NAME} setup\` in a terminal, or set VIKUNJA_URL and VIKUNJA_TOKEN for the server.`,
  );
}

/** Writes the config file readable by the current user only. */
export async function saveConfig(config: Config, path: string = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Write a fresh 0600 file and swap it in, so the token never sits in a wider-mode
  // file and a crash can't leave a half-written config.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/**
 * Accepts what people paste ("tasks.example.com", "https://tasks.example.com/",
 * ".../api/v1") and returns the instance root without a trailing slash.
 */
export function normalizeUrl(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ConfigError(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`Use an http(s) URL, not ${url.protocol}`);
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${url.origin}${path}`;
}

/** True when a URL would send the token unencrypted over a network. */
export function isInsecure(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
