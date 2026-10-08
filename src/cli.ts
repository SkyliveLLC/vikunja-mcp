#!/usr/bin/env node
/**
 * Entry point. With no command it serves MCP over stdio, which is how clients
 * launch it; the other commands are for people in a terminal.
 */
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { PACKAGE_NAME, VERSION } from "./meta.js";
import { createServer } from "./server.js";
import { createVikunja, errorMessage } from "./vikunja.js";

const HELP = `vikunja-mcp ${VERSION}: MCP server for Vikunja

Usage
  npx -y ${PACKAGE_NAME} setup       Connect to Vikunja and add the server to your MCP clients

Commands
  setup        Save the Vikunja URL and API token, then register with Claude Code, Codex and Claude Desktop
  doctor       Check the config, the connection, the token and client registrations
  uninstall    Remove the client registrations and the saved config
  serve        Run the MCP server over stdio (the default when an MCP client starts it)

Setup options
  --url <url>          Vikunja address, e.g. https://tasks.example.com
  --token-stdin        Read the API token from stdin and don't prompt
  --client <id>        claude-code, codex, claude-desktop, all or none (repeatable)
  -y, --yes            Replace existing registrations without asking

Environment
  VIKUNJA_URL, VIKUNJA_TOKEN   Override the saved config

Docs: https://github.com/SkyliveLLC/vikunja-mcp`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      "token-stdin": { type: "boolean" },
      client: { type: "string", multiple: true },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, ...extra] = positionals;
  if (values.version) return console.log(VERSION);
  if (values.help || command === "help") return console.log(HELP);
  if (extra.length > 0) throw new Error(`Unexpected argument: ${extra.join(" ")}`);

  switch (command) {
    case undefined:
      // A person ran it directly: explain instead of waiting silently for JSON-RPC.
      if (process.stdin.isTTY) return console.log(`${HELP}\n\nThis is an MCP server for MCP clients to start. To set it up, run: vikunja-mcp setup`);
      return serve();
    case "serve":
      return serve();
    case "setup": {
      const { setup } = await import("./setup.js");
      return setup(
        { url: values.url, tokenStdin: values["token-stdin"], clients: values.client, yes: values.yes },
        import.meta.filename,
      );
    }
    case "doctor": {
      const { doctor } = await import("./setup.js");
      if (!(await doctor())) process.exitCode = 1;
      return;
    }
    case "uninstall": {
      const { uninstall } = await import("./setup.js");
      return uninstall({ yes: values.yes });
    }
    default:
      throw new Error(`Unknown command "${command}". Run vikunja-mcp --help.`);
  }
}

function serve() {
  // stdout carries the protocol, so diagnostics go to stderr.
  serveStdio(() => createServer(async () => createVikunja(await loadConfig()), VERSION), {
    onerror: (error) => console.error(`vikunja-mcp: ${error.message}`),
  });
}

main().catch((error: unknown) => {
  console.error(`vikunja-mcp: ${errorMessage(error)}`);
  process.exitCode = 1;
});
