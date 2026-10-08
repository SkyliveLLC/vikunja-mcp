import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { createVikunja, type Vikunja } from "../src/vikunja.js";

export interface ApiCall {
  method: string;
  /** Path below /api/v1, without the query string. */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export type Route = (call: ApiCall) => unknown;

/**
 * A fake Vikunja API keyed by "METHOD /path". Handlers return a JSON body or a
 * Response; unknown routes answer 404. Every request is recorded in `calls`.
 */
export function fakeApi(routes: Record<string, Route> = {}) {
  const calls: ApiCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const call: ApiCall = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/api\/v1/, ""),
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) return Response.json({ code: 0, message: "Not found" }, { status: 404 });
    const result = route(call);
    return result instanceof Response ? result : Response.json(result);
  };
  return { fetch, calls, writes: () => calls.filter((call) => call.method !== "GET") };
}

export const TOKEN = "tk_secret_test_token";

/** Connects an MCP client to a server backed by `api`, over an in-memory transport. */
export async function connect(connectVikunja: () => Promise<Vikunja>) {
  const server = createServer(connectVikunja, "0.0.0-test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content;
    const text = first?.type === "text" ? first.text : "";
    return { isError: Boolean(result.isError), text, json: (): unknown => JSON.parse(text) };
  }
  return { client, call };
}

export function connectApi(routes: Record<string, Route> = {}) {
  const api = fakeApi(routes);
  const vikunja = createVikunja({ url: "https://tasks.test", token: TOKEN, fetch: api.fetch });
  return connect(async () => vikunja).then((mcp) => ({ ...mcp, api }));
}

/** A task as Vikunja returns it, with the fields round-tripped by updates. */
export function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 75,
    project_id: 11,
    index: 12,
    identifier: "APP-12",
    title: "Existing",
    description: "<p>Keep <b>this</b></p>",
    done: false,
    done_at: "0001-01-01T00:00:00Z",
    due_date: "2026-10-01T12:00:00Z",
    start_date: "0001-01-01T00:00:00Z",
    end_date: "0001-01-01T00:00:00Z",
    priority: 3,
    percent_done: 0,
    repeat_after: 0,
    repeat_mode: 0,
    hex_color: "e8e8e8",
    reminders: [{ relative_period: -3600, relative_to: "due_date" }],
    assignees: [{ id: 1, username: "conan", name: "Conan" }],
    labels: [{ id: 4, title: "backend" }],
    related_tasks: {},
    bucket_id: 0,
    created: "2026-09-01T10:00:00Z",
    updated: "2026-09-02T10:00:00Z",
    created_by: { id: 1, username: "conan", name: "Conan" },
    ...overrides,
  };
}
