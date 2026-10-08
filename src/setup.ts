/** The interactive CLI commands: setup, doctor and uninstall. */
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { allClients, type ClientId, type Launcher, type McpClient, resolveLauncher } from "./clients.js";
import { type Config, configPath, isInsecure, loadConfig, normalizeUrl, readConfigFile, saveConfig } from "./config.js";
import { SERVER_NAME } from "./meta.js";
import { createVikunja, errorMessage, TOKEN_PERMISSIONS } from "./vikunja.js";

export interface SetupOptions {
  url?: string | undefined;
  /** Read the token from stdin instead of prompting. Implies no prompts. */
  tokenStdin?: boolean | undefined;
  /** Client IDs, or "all" / "none". Defaults to every detected client. */
  clients?: string[] | undefined;
  /** Replace existing registrations without asking. */
  yes?: boolean | undefined;
}

/** A usage error: reported as-is and never retried. */
export class CliError extends Error {}

/** Unwraps a clack answer, exiting cleanly on Ctrl-C. */
async function ask<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await prompt;
  if (p.isCancel(value)) {
    p.cancel("Cancelled. Nothing else was changed.");
    process.exit(1);
  }
  // isCancel narrows the value but not the generic, so restate the narrowing.
  return value as Exclude<T, symbol>;
}

const tilde = (path: string) => path.replace(homedir(), "~");

/** Picks the useful part of a failed child process: its stderr. */
const commandError = (error: unknown) =>
  (error && typeof error === "object" && "stderr" in error && String(error.stderr).trim()) || errorMessage(error);

const permissionList = () =>
  Object.entries(TOKEN_PERMISSIONS)
    .map(([group, permissions]) => `  ${group}: ${permissions.join(", ")}`)
    .join("\n");

/** Runs `attempt` until it succeeds, re-prompting only when a person is there to answer. */
async function untilValid<T>(interactive: boolean, attempt: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!interactive || error instanceof CliError) throw error;
      p.log.error(errorMessage(error));
    }
  }
}

export async function setup(options: SetupOptions, script: string): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY) && !options.tokenStdin;
  checkClientIds(options.clients);
  const path = configPath();
  const saved = await readConfigFile(path).catch(() => undefined);
  p.intro("Vikunja MCP setup");

  const { url, version } = await untilValid(interactive && !options.url, async () => {
    const input =
      options.url ??
      (interactive
        ? await ask(
            p.text({
              message: "Vikunja URL",
              placeholder: "https://tasks.example.com",
              initialValue: saved?.url ?? "",
              validate: (value) => (value?.trim() ? undefined : "Enter the address you open Vikunja at."),
            }),
          )
        : process.env.VIKUNJA_URL?.trim() || saved?.url);
    if (!input) throw new CliError("Pass --url or VIKUNJA_URL when running without a terminal.");
    const url = normalizeUrl(input);
    const { version } = await createVikunja({ url, token: "" }).info();
    return { url, version };
  });
  p.log.success(`Found Vikunja ${version} at ${url}`);
  if (isInsecure(url)) p.log.warn("This URL is not HTTPS, so the token will travel unencrypted.");

  const keep = saved?.url === url ? saved.token : undefined;
  if (interactive) {
    p.note(`Create one at ${url}/user/settings/api-tokens\nwith these permissions:\n${permissionList()}`, "API token");
  }
  const { token, projects } = await untilValid(interactive, async () => {
    let token: string | undefined;
    if (options.tokenStdin) token = await readStdin();
    else if (interactive) {
      const answer = await ask(
        p.password({
          message: keep ? "API token (press Enter to keep the saved one)" : "API token",
          validate: (value) => (value?.trim() || keep ? undefined : "Paste the token you created."),
        }),
      );
      token = answer.trim() || keep;
    } else token = process.env.VIKUNJA_TOKEN?.trim() || keep;
    if (!token) throw new CliError("Pass the token with --token-stdin or VIKUNJA_TOKEN when running without a terminal.");
    return { token, projects: await countProjects({ url, token }) };
  });
  p.log.success(`Token works: ${projects} visible`);

  await saveConfig({ url, token }, path);
  p.log.success(`Saved to ${tilde(path)}, readable only by you`);

  const launcher = resolveLauncher(script);
  const chosen = await chooseClients(options.clients, interactive);
  const added: string[] = [];
  for (const client of chosen) {
    if (await registerWith(client, launcher, { interactive, yes: Boolean(options.yes) })) added.push(client.name);
  }

  if (added.length === 0) {
    p.note(
      JSON.stringify({ mcpServers: { [SERVER_NAME]: launcher } }, null, 2),
      "No client was configured. For other MCP clients, add",
    );
    p.outro("Setup finished.");
  } else {
    p.outro(`Restart ${new Intl.ListFormat("en").format(added)} to load the Vikunja tools.`);
  }
}

/** Rejects unknown --client values before setup changes anything. */
function checkClientIds(requested: string[] | undefined) {
  const valid = [...allClients().map((client) => client.id), "all", "none"];
  const unknown = requested?.filter((id) => !valid.includes(id)) ?? [];
  if (unknown.length > 0) throw new CliError(`Unknown client ${unknown.join(", ")}. Use ${valid.join(", ")}.`);
}

async function chooseClients(requested: string[] | undefined, interactive: boolean): Promise<McpClient[]> {
  const clients = allClients();
  const detected = await Promise.all(clients.map((client) => client.detect()));
  const installed = clients.filter((_, i) => detected[i]);

  if (requested) {
    if (requested.includes("none")) return [];
    if (requested.includes("all")) return installed;
    return clients.filter((client) => requested.includes(client.id));
  }
  if (installed.length === 0) {
    p.log.warn(`Didn't find ${clients.map((client) => client.name).join(", ")} on this machine.`);
    return [];
  }
  if (!interactive) return installed;
  const ids = await ask(
    p.multiselect<ClientId>({
      message: "Add the server to",
      options: installed.map((client) => ({ value: client.id, label: client.name })),
      initialValues: installed.map((client) => client.id),
      required: false,
    }),
  );
  return installed.filter((client) => ids.includes(client.id));
}

async function registerWith(
  client: McpClient,
  launcher: Launcher,
  { interactive, yes }: { interactive: boolean; yes: boolean },
): Promise<boolean> {
  try {
    if (await client.isRegistered()) {
      const replace =
        yes ||
        (interactive &&
          (await ask(p.confirm({ message: `${client.name} already has a "${SERVER_NAME}" server. Replace it?` }))));
      if (!replace) {
        p.log.warn(`Left ${client.name}'s existing "${SERVER_NAME}" server as it was${interactive ? "" : " (pass --yes to replace it)"}.`);
        return false;
      }
      await client.unregister();
    }
    await client.register(launcher);
    p.log.success(`Added to ${client.name}`);
    return true;
  } catch (error) {
    p.log.error(`Couldn't configure ${client.name}: ${commandError(error)}`);
    return false;
  }
}

/** Confirms the token can list projects and describes how many it sees. */
async function countProjects(config: Config): Promise<string> {
  const page = await createVikunja(config).listProjects({ per_page: 50 });
  const count = page.items.filter((project) => project.id > 0).length;
  const more = (page.total_pages ?? 1) > 1 ? "+" : "";
  return `${count}${more} project${count === 1 && !more ? "" : "s"}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Checks config, connectivity, the token and client registrations. Resolves to false if a check failed. */
export async function doctor(): Promise<boolean> {
  p.intro("Vikunja MCP doctor");
  let ok = true;
  const fail = (message: string) => {
    p.log.error(message);
    ok = false;
  };

  const config = await loadConfig().catch((error: unknown) => fail(errorMessage(error)));
  if (config) {
    const source = (variable: string) => (process.env[variable]?.trim() ? `$${variable}` : tilde(configPath()));
    p.log.success(`Config: URL from ${source("VIKUNJA_URL")}, token from ${source("VIKUNJA_TOKEN")}`);
    await createVikunja(config)
      .info()
      .then(({ version }) => p.log.success(`Vikunja ${version} at ${config.url}`))
      .catch((error: unknown) => fail(errorMessage(error)));
    await countProjects(config)
      .then((projects) => p.log.success(`Token works: ${projects} visible`))
      .catch((error: unknown) => fail(errorMessage(error)));
    if (isInsecure(config.url)) p.log.warn("The URL is not HTTPS, so the token travels unencrypted.");
  }

  for (const client of allClients()) {
    try {
      if (!(await client.detect())) p.log.info(`${client.name}: not installed`);
      else if (await client.isRegistered()) p.log.success(`${client.name}: "${SERVER_NAME}" server registered`);
      else p.log.warn(`${client.name}: not registered. Run \`vikunja-mcp setup\` to add it.`);
    } catch (error) {
      fail(`${client.name}: ${commandError(error)}`);
    }
  }

  p.outro(ok ? "Everything looks good." : "Some checks failed.");
  return ok;
}

/** Removes client registrations and the saved config, asking first unless --yes. */
export async function uninstall({ yes }: { yes?: boolean | undefined }): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY);
  const confirm = async (message: string) => Boolean(yes) || (interactive && (await ask(p.confirm({ message }))));
  p.intro("Vikunja MCP uninstall");

  for (const client of allClients()) {
    try {
      if (!(await client.detect()) || !(await client.isRegistered())) continue;
      if (!(await confirm(`Remove the "${SERVER_NAME}" server from ${client.name}?`))) continue;
      await client.unregister();
      p.log.success(`Removed from ${client.name}`);
    } catch (error) {
      p.log.error(`Couldn't update ${client.name}: ${commandError(error)}`);
    }
  }

  const path = configPath();
  if ((await readConfigFile(path).catch(() => ({}))) && (await confirm(`Delete ${tilde(path)}?`))) {
    await rm(path, { force: true });
    p.log.success(`Deleted ${tilde(path)}`);
  }

  if (!interactive && !yes) p.log.warn("Nothing was removed. Pass --yes to remove without prompts.");
  p.outro("Your API token stays valid until it expires. Revoke it in Vikunja under Settings > API Tokens if you're done with it.");
}

