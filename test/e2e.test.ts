/**
 * End-to-end: the built CLI over stdio against a real Vikunja. Point
 * VIKUNJA_E2E_URL at a disposable instance with registration enabled; the test
 * registers its own user and an API token limited to TOKEN_PERMISSIONS, which
 * also proves the documented permission set is enough. Run with `pnpm test:e2e`.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOKEN_PERMISSIONS } from "../src/vikunja.js";

const url = process.env.VIKUNJA_E2E_URL?.replace(/\/+$/, "");

async function api<T>(method: string, path: string, body: unknown, jwt?: string): Promise<T> {
  const response = await fetch(`${url}/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(jwt && { Authorization: `Bearer ${jwt}` }) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

interface Task {
  id: number;
  index: number;
  done: boolean;
  description: string;
  priority: number;
  due_date: string | null;
  buckets: { id: number; view_id: number }[];
}

describe.skipIf(!url)("against a real Vikunja", () => {
  const client = new Client({ name: "e2e", version: "0" });
  let projectId: number;
  let otherTaskId: number;

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content;
    const text = first?.type === "text" ? first.text : "";
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  }

  beforeAll(async () => {
    const username = `mcp${Date.now()}`;
    const password = "e2e-password-not-secret";
    await api("POST", "/register", { username, email: `${username}@example.com`, password });
    const { token: jwt } = await api<{ token: string }>("POST", "/login", { username, password });
    const { token } = await api<{ token: string }>(
      "PUT",
      "/tokens",
      { title: "vikunja-mcp e2e", expires_at: "2099-01-01T00:00:00Z", permissions: TOKEN_PERMISSIONS },
      jwt,
    );
    // Identifiers are unique per instance, so make one per run (max 10 characters).
    const identifier = `E${Date.now().toString(36).slice(-6).toUpperCase()}`;
    ({ id: projectId } = await api<{ id: number }>("PUT", "/projects", { title: "MCP e2e", identifier }, jwt));
    // A task in another project, which list_tasks for projectId must not return.
    const other = await api<{ id: number }>("PUT", "/projects", { title: "Elsewhere" }, jwt);
    ({ id: otherTaskId } = await api<{ id: number }>("PUT", `/projects/${other.id}/tasks`, { title: "Not here" }, jwt));

    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dirname, "..", "dist", "cli.js")],
        // An empty home directory proves the environment variables alone configure the server.
        env: { VIKUNJA_URL: url ?? "", VIKUNJA_TOKEN: token, HOME: await mkdtemp(join(tmpdir(), "vk-e2e-")) },
      }),
    );
  }, 30_000);

  afterAll(() => client.close());

  it("runs a full board workflow", async () => {
    const projects = await call<{ items: { id: number }[] }>("list_projects", { search: "MCP e2e" });
    expect(projects.items.map((project) => project.id)).toContain(projectId);

    const created = await call<Task>("create_task", {
      project_id: projectId,
      title: "Write the release notes",
      description: "<p>Cover <b>setup</b></p>",
      priority: 2,
    });
    const byIndex = await call<Task>("get_task", { project_id: projectId, index: created.index });
    expect(byIndex.id).toBe(created.id);

    const views = await call<{ id: number; view_kind: string; done_bucket_id: number }[]>("list_views", { project_id: projectId });
    const kanban = views.find((view) => view.view_kind === "kanban");
    if (!kanban) throw new Error("no kanban view");
    const buckets = await call<{ id: number }[]>("list_buckets", { project_id: projectId, view_id: kanban.id });
    const kanbanBucket = (task: Task) => task.buckets.find((bucket) => bucket.view_id === kanban.id)?.id;

    // Partial updates keep untouched fields.
    const dated = await call<Task>("update_task", { task_id: created.id, priority: 4, due_date: "2030-01-02T15:00:00Z" });
    expect(dated).toMatchObject({ priority: 4, due_date: "2030-01-02T15:00:00Z", description: created.description });
    expect((await call<Task>("update_task", { task_id: created.id, due_date: null })).due_date).toBeNull();

    // Completing moves the card to the done bucket; reopening moves it back.
    const done = await call<Task>("update_task", { task_id: created.id, done: true });
    expect([done.done, kanbanBucket(done)]).toEqual([true, kanban.done_bucket_id]);
    const reopened = await call<Task>("update_task", { task_id: created.id, done: false });
    expect(reopened.done).toBe(false);

    const moved = await call<Task>("move_task", {
      task_id: created.id,
      project_id: projectId,
      view_id: kanban.id,
      bucket_id: kanban.done_bucket_id,
    });
    expect(moved.done).toBe(true);
    const doing = buckets.find((bucket) => bucket.id !== kanban.done_bucket_id)?.id;
    const back = await call<Task>("move_task", { task_id: created.id, project_id: projectId, view_id: kanban.id, bucket_id: doing });
    expect([back.done, kanbanBucket(back)]).toEqual([false, doing]);

    await expect(
      call("move_task", { task_id: created.id, project_id: projectId + 1000, view_id: kanban.id, bucket_id: doing }),
    ).rejects.toThrow("Nothing was moved");

    await call("add_comment", { task_id: created.id, comment: "Drafted the outline." });
    const comments = await call<{ items: { comment: string }[] }>("list_comments", { task_id: created.id });
    expect(comments.items.map((comment) => comment.comment)).toEqual(["Drafted the outline."]);

    const open = await call<{ items: { id: number }[] }>("list_tasks", { project_id: projectId, done: false });
    expect(open.items.map((task) => task.id)).toEqual([created.id]);
    expect(open.items.map((task) => task.id)).not.toContain(otherTaskId);
    const urgent = await call<{ items: unknown[] }>("list_tasks", { project_id: projectId, filter: "priority >= 5" });
    expect(urgent.items).toEqual([]);
  }, 30_000);
});
