import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeDesktop, resolveLauncher, stableNodePath } from "../src/clients.js";

const temp = async () => realpath(await mkdtemp(join(tmpdir(), "vikunja-mcp-")));

describe("claudeDesktop", () => {
  it("adds and removes its entry without touching other settings", async () => {
    const path = join(await temp(), "claude_desktop_config.json");
    const other = { command: "other-server", env: { KEY: "kept" } };
    await writeFile(path, JSON.stringify({ globalShortcut: "Ctrl+Space", mcpServers: { other } }));
    const client = claudeDesktop(path);

    expect(await client.isRegistered()).toBe(false);
    await client.register({ command: "/usr/bin/node", args: ["/opt/vikunja-mcp/dist/cli.js"] });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      globalShortcut: "Ctrl+Space",
      mcpServers: { other, vikunja: { command: "/usr/bin/node", args: ["/opt/vikunja-mcp/dist/cli.js"] } },
    });

    await client.unregister();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ globalShortcut: "Ctrl+Space", mcpServers: { other } });
  });

  it("creates the file when Claude Desktop has none yet", async () => {
    const path = join(await temp(), "Claude", "claude_desktop_config.json");
    await claudeDesktop(path).register({ command: "node", args: [] });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { vikunja: { command: "node", args: [] } } });
  });

  it("leaves an unreadable config untouched", async () => {
    const path = join(await temp(), "claude_desktop_config.json");
    await writeFile(path, "{ not json");
    await expect(claudeDesktop(path).register({ command: "node", args: [] })).rejects.toThrow(/not valid JSON/);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });
});

describe("resolveLauncher", () => {
  const script = (...segments: string[]) => join("/home/me", ...segments, "dist", "cli.js");

  it("starts an installed copy directly with absolute paths", () => {
    const file = script("lib", "node_modules", "@skylivellc", "vikunja-mcp");
    expect(resolveLauncher(file, "/opt/node/bin/node")).toEqual({ command: "/opt/node/bin/node", args: [file] });
  });

  it.each([
    ["npx", script(".npm", "_npx", "abc123", "node_modules", "@skylivellc", "vikunja-mcp")],
    ["pnpm dlx", script("Library", "Caches", "pnpm", "dlx", "abc", "node_modules", "@skylivellc", "vikunja-mcp")],
    ["yarn dlx", script("tmp", "xfs-1", "dlx-4242", "node_modules", "@skylivellc", "vikunja-mcp")],
  ])("uses npx when running from the %s cache, with node on PATH for GUI apps", (_, file) => {
    expect(resolveLauncher(file, "/opt/node/bin/node")).toEqual({
      command: "/opt/node/bin/npx",
      args: ["-y", "@skylivellc/vikunja-mcp"],
      env: { PATH: "/opt/node/bin:/usr/bin:/bin" },
    });
  });
});

describe("stableNodePath", () => {
  it("prefers the PATH entry that links to the running node over its versioned real path", async () => {
    const root = await temp();
    const cellar = join(root, "Cellar", "node", "24.1.0", "bin");
    const bin = join(root, "bin");
    await mkdir(cellar, { recursive: true });
    await mkdir(bin);
    await writeFile(join(cellar, "node"), "");
    await symlink(join(cellar, "node"), join(bin, "node"));

    expect(stableNodePath(join(cellar, "node"), ["/nonexistent", bin].join(":"))).toBe(join(bin, "node"));
    expect(stableNodePath(join(cellar, "node"), "/nonexistent")).toBe(join(cellar, "node"));
  });
});
