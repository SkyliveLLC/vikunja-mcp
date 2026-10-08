/**
 * MCP clients the setup CLI can register the server with. Claude Code and Codex
 * are configured through their own `mcp` commands, so their config formats stay
 * theirs to own; Claude Desktop only has a JSON file.
 */
import { exec as execShell, execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { isMissing } from "./config.js";
import { PACKAGE_NAME, SERVER_NAME } from "./meta.js";

const runFile = promisify(execFile);
const runShell = promisify(execShell);

/** The stdio command a client runs to start the server. Never carries the token. */
export interface Launcher {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpClient {
  id: "claude-code" | "codex" | "claude-desktop";
  name: string;
  /** Whether the client is installed on this machine. */
  detect(): Promise<boolean>;
  isRegistered(): Promise<boolean>;
  register(launcher: Launcher): Promise<void>;
  unregister(): Promise<void>;
}

export type ClientId = McpClient["id"];

const isWindows = process.platform === "win32";

/**
 * Runs a client CLI from the home directory, so project-scoped entries in the
 * current directory don't affect it. On Windows, npm-installed CLIs are .cmd
 * shims that need a shell, which takes one quoted command line.
 */
function exec(file: string, args: string[]) {
  const options = { cwd: homedir() };
  if (!isWindows) return runFile(file, args, options);
  const quote = (arg: string) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg);
  return runShell([file, ...args].map(quote).join(" "), options);
}

const succeeds = (file: string, args: string[]) =>
  exec(file, args).then(
    () => true,
    () => false,
  );

const envFlags = (flag: string, env: Record<string, string> = {}) =>
  Object.entries(env).flatMap(([key, value]) => [flag, `${key}=${value}`]);

export const claudeCode: McpClient = {
  id: "claude-code",
  name: "Claude Code",
  detect: () => succeeds("claude", ["--version"]),
  // `get` also finds local and project entries, but setup only manages the user-scope one.
  isRegistered: () =>
    exec("claude", ["mcp", "get", SERVER_NAME]).then(
      ({ stdout }) => /Scope: User/.test(stdout),
      () => false,
    ),
  async register({ command, args, env }) {
    // -e takes several values, so it goes after the name and before `--`.
    await exec("claude", ["mcp", "add", "--scope", "user", SERVER_NAME, ...envFlags("-e", env), "--", command, ...args]);
  },
  async unregister() {
    await exec("claude", ["mcp", "remove", "--scope", "user", SERVER_NAME]);
  },
};

export const codex: McpClient = {
  id: "codex",
  name: "Codex",
  detect: () => succeeds("codex", ["--version"]),
  isRegistered: () => succeeds("codex", ["mcp", "get", SERVER_NAME]),
  async register({ command, args, env }) {
    await exec("codex", ["mcp", "add", SERVER_NAME, ...envFlags("--env", env), "--", command, ...args]);
  },
  async unregister() {
    await exec("codex", ["mcp", "remove", SERVER_NAME]);
  },
};

export function claudeDesktopConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (isWindows) return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
}

// Loose so every other setting in the file survives a rewrite.
const DesktopConfig = z.looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() });
type DesktopConfig = z.infer<typeof DesktopConfig>;

export function claudeDesktop(path = claudeDesktopConfigPath()): McpClient {
  async function read(): Promise<DesktopConfig> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }
    try {
      return DesktopConfig.parse(JSON.parse(text || "{}"));
    } catch {
      throw new Error(`${path} is not valid JSON, so it was left untouched. Fix it, then run setup again.`);
    }
  }
  async function write(config: DesktopConfig) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  }

  return {
    id: "claude-desktop",
    name: "Claude Desktop",
    detect: () =>
      access(dirname(path)).then(
        () => true,
        () => false,
      ),
    isRegistered: async () => SERVER_NAME in ((await read()).mcpServers ?? {}),
    async register(launcher) {
      const config = await read();
      await write({ ...config, mcpServers: { ...config.mcpServers, [SERVER_NAME]: launcher } });
    },
    async unregister() {
      const config = await read();
      const { [SERVER_NAME]: _, ...rest } = config.mcpServers ?? {};
      await write({ ...config, mcpServers: rest });
    },
  };
}

export const allClients = (): McpClient[] => [claudeCode, codex, claudeDesktop()];

/**
 * The `node` on PATH that is this same binary. `process.execPath` is fully
 * resolved, e.g. Homebrew's versioned Cellar path that `brew upgrade` deletes,
 * while the PATH entry (/opt/homebrew/bin/node) keeps working across upgrades.
 */
export function stableNodePath(execPath: string = process.execPath, path: string = process.env.PATH ?? ""): string {
  const real = realpathSync(execPath);
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, isWindows ? "node.exe" : "node");
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      // No node in this directory.
    }
  }
  return execPath;
}

/**
 * How clients should start the server, given this script's real path. A global or
 * local install is started directly with node. Under npx, pnpm dlx, yarn dlx or
 * bunx the package sits in a cache that can be cleared, so clients get npx instead,
 * by absolute path and with node's directory on PATH, because GUI apps (Claude
 * Desktop, Codex, IDEs) don't inherit a shell PATH. On Windows, npx goes through
 * `cmd /c` as Claude Code's docs require for .cmd shims.
 */
export function resolveLauncher(script: string, node: string = stableNodePath()): Launcher {
  if (!/[\\/](_npx|dlx(-\d+)?|bunx-[^\\/]*)[\\/]/.test(script)) return { command: node, args: [script] };
  if (isWindows) return { command: "cmd", args: ["/c", "npx", "-y", PACKAGE_NAME] };
  const bin = dirname(node);
  return { command: join(bin, "npx"), args: ["-y", PACKAGE_NAME], env: { PATH: [bin, "/usr/bin", "/bin"].join(delimiter) } };
}
