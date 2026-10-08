# Security

vikunja-mcp holds a Vikunja API token and acts on your tasks for an AI agent. The
safeguards are listed in the [README](README.md#security).

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/SkyliveLLC/vikunja-mcp/security/advisories/new)
rather than in a public issue. Include steps to reproduce and the impact you see.

We'll acknowledge reports within 3 working days and keep you updated until a fix ships.
We're happy to credit you in the release notes.

## Scope

In scope: the MCP server, the setup CLI, and how they store and send the token. Especially interesting:

- the token reaching anywhere other than the configured Vikunja host, or being written to a client config or log;
- a tool changing or deleting data beyond what its description says;
- task or comment text that makes the server, rather than the agent, do something unintended.

Out of scope: vulnerabilities in Vikunja itself (see [Vikunja's security policy](https://vikunja.io/security)) and an
agent choosing to misuse the tools it was given.
