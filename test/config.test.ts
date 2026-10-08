import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, configPath, isInsecure, loadConfig, normalizeUrl, saveConfig } from "../src/config.js";

describe("normalizeUrl", () => {
  it.each([
    ["tasks.example.com", "https://tasks.example.com"],
    ["https://tasks.example.com/", "https://tasks.example.com"],
    ["https://tasks.example.com/api/v1/", "https://tasks.example.com"],
    ["  http://localhost:3456  ", "http://localhost:3456"],
    ["https://example.com/vikunja/api/v1?x=1#top", "https://example.com/vikunja"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it("rejects non-http URLs", () => {
    expect(() => normalizeUrl("ftp://tasks.example.com")).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  const configFile = async () => configPath(await mkdtemp(join(tmpdir(), "vikunja-mcp-")));

  it("lets environment variables override the config file", async () => {
    const path = await configFile();
    await saveConfig({ url: "https://file.example.com", token: "tk_file" }, path);
    expect(await loadConfig({}, path)).toEqual({ url: "https://file.example.com", token: "tk_file" });
    expect(await loadConfig({ VIKUNJA_TOKEN: "tk_env" }, path)).toEqual({ url: "https://file.example.com", token: "tk_env" });
    expect(await loadConfig({ VIKUNJA_URL: "file.example.com/" }, path)).toEqual({
      url: "https://file.example.com",
      token: "tk_file",
    });
  });

  it("never sends the saved token to a different VIKUNJA_URL", async () => {
    const path = await configFile();
    await saveConfig({ url: "https://prod.example.com", token: "tk_prod" }, path);
    await expect(loadConfig({ VIKUNJA_URL: "https://staging.example.com" }, path)).rejects.toThrow(
      /saved token isn't sent there\. Set VIKUNJA_TOKEN/,
    );
    expect(await loadConfig({ VIKUNJA_URL: "https://staging.example.com", VIKUNJA_TOKEN: "tk_staging" }, path)).toEqual({
      url: "https://staging.example.com",
      token: "tk_staging",
    });
  });

  it("points to setup when nothing is configured", async () => {
    await expect(loadConfig({ VIKUNJA_URL: "tasks.example.com" }, await configFile())).rejects.toThrow(
      /missing API token\). Run `npx -y @skylive\/vikunja-mcp setup`/,
    );
  });

  it("stores the token readable only by the owner, even over an existing file", async () => {
    const path = await configFile();
    await saveConfig({ url: "https://a.example.com", token: "tk_1" }, path);
    await writeFile(path, "{}", { mode: 0o644 });
    await saveConfig({ url: "https://a.example.com", token: "tk_2" }, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadConfig({}, path)).toEqual({ url: "https://a.example.com", token: "tk_2" });
  });
});

it("flags plain HTTP except on loopback", () => {
  expect(isInsecure("http://tasks.lan")).toBe(true);
  expect(isInsecure("http://localhost:3456")).toBe(false);
  expect(isInsecure("https://tasks.example.com")).toBe(false);
});
