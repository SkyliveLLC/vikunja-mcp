import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { connect, connectApi, type Route, TOKEN, task } from "./helpers.js";

describe("tool catalog", () => {
  it("exposes read and write tools with matching hints, and no delete tools", async () => {
    const { client } = await connectApi();
    const { tools } = await client.listTools();
    const readOnly = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]));
    expect(readOnly).toEqual({
      list_projects: true,
      list_tasks: true,
      get_task: true,
      list_views: true,
      list_buckets: true,
      list_comments: true,
      create_task: false,
      update_task: false,
      move_task: false,
      add_comment: false,
    });
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });
});

describe("update_task", () => {
  it("sends the whole current task with only the requested change, then returns the saved task", async () => {
    const current = { ...task(), buckets: [{ id: 40, title: "Doing", project_view_id: 52 }] };
    let saved = current;
    const { call, api } = await connectApi({
      "GET /tasks/75": () => saved,
      "POST /tasks/75": ({ body }) => (saved = { ...current, ...(body as object) }),
    });

    const result = await call("update_task", { task_id: 75, done: true });

    expect(result.isError).toBe(false);
    const { buckets: _, ...rest } = current;
    expect(api.writes()).toEqual([expect.objectContaining({ method: "POST", path: "/tasks/75", body: { ...rest, done: true } })]);
    expect(result.json()).toMatchObject({ id: 75, done: true, description: current.description, labels: ["backend"] });
  });

  it("clears the due date when given null", async () => {
    const { call, api } = await connectApi({ "GET /tasks/75": () => task(), "POST /tasks/75": () => task() });
    await call("update_task", { task_id: 75, due_date: null });
    expect(api.writes()[0]?.body).toMatchObject({ due_date: "0001-01-01T00:00:00Z", title: "Existing" });
  });

  it("rejects bad arguments before calling Vikunja", async () => {
    const { call, api } = await connectApi();
    for (const args of [
      { task_id: 75 },
      { task_id: "../projects", done: true },
      { task_id: 75, done: "false" },
      { task_id: 75, project_id: 10, done: true },
      { task_id: 75, priority: 9 },
      { task_id: 75, due_date: "next friday" },
    ]) {
      expect((await call("update_task", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(api.calls).toEqual([]);
  });
});

describe("move_task", () => {
  const args = { task_id: 75, project_id: 11, view_id: 52, bucket_id: 40 };

  it("checks the project and bucket, moves, then returns the saved task", async () => {
    const { call, api } = await connectApi({
      "GET /tasks/75": () => task(),
      "GET /projects/11/views/52/buckets": () => [{ id: 39 }, { id: 40 }],
      "POST /projects/11/views/52/buckets/40/tasks": () => ({}),
    });
    expect((await call("move_task", args)).isError).toBe(false);
    expect(api.writes()).toEqual([
      expect.objectContaining({ body: { task_id: 75, bucket_id: 40, project_view_id: 52 } }),
    ]);
  });

  it("refuses to write when the task is in another project or the bucket is in another view", async () => {
    const cases: Record<string, Route>[] = [
      { "GET /tasks/75": () => task({ project_id: 10 }) },
      { "GET /tasks/75": () => task(), "GET /projects/11/views/52/buckets": () => [{ id: 39 }] },
    ];
    for (const routes of cases) {
      const { call, api } = await connectApi(routes);
      const result = await call("move_task", args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Nothing was moved");
      expect(api.writes()).toEqual([]);
    }
  });
});

describe("reads", () => {
  it("resolves a board number with project_id and index", async () => {
    const { call, api } = await connectApi({ "GET /projects/11/tasks/by-index/12": () => task() });
    const result = await call("get_task", { project_id: 11, index: 12 });
    expect(result.json()).toMatchObject({ id: 75, identifier: "APP-12", start_date: null, recurring: false });
    expect(api.calls[0]?.query.get("expand")).toBe("buckets");
    expect((await call("get_task", { index: 12 })).text).toContain("project_id together with index");
  });

  it("scopes list_tasks to the project and combines filters", async () => {
    const { call, api } = await connectApi({
      "GET /tasks": () => new Response(JSON.stringify([task()]), {
        headers: { "content-type": "application/json", "x-pagination-total-pages": "3" },
      }),
    });
    const result = await call("list_tasks", { project_id: 11, done: false, filter: "priority >= 3", page: 2 });
    expect(Object.fromEntries(api.calls[0]?.query ?? [])).toEqual({
      filter: "project = 11 && done = false && (priority >= 3)",
      page: "2",
      per_page: "50",
    });
    expect(result.json()).toEqual({
      page: 2,
      total_pages: 3,
      items: [
        {
          id: 75,
          index: 12,
          identifier: "APP-12",
          title: "Existing",
          done: false,
          priority: 3,
          due_date: "2026-10-01T12:00:00Z",
          labels: ["backend"],
          assignees: ["conan"],
          description_preview: "Keep this",
        },
      ],
    });
  });

  it("hides pseudo projects such as Favorites", async () => {
    const project = { title: "P", description: "", identifier: "", parent_project_id: 0, is_archived: false };
    const { call } = await connectApi({ "GET /projects": () => [{ ...project, id: -1 }, { ...project, id: 3 }] });
    expect((await call("list_projects")).json()).toMatchObject({ items: [{ id: 3 }] });
  });
});

describe("errors", () => {
  it("names the missing token permission on 401 without echoing the token", async () => {
    const { call } = await connectApi({
      "PUT /tasks/75/comments": () => Response.json({ code: 11, message: "invalid token" }, { status: 401 }),
    });
    const result = await call("add_comment", { task_id: 75, comment: "Done" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"tasks_comments: create"');
    expect(result.text).not.toContain(TOKEN);
  });

  it("tells the agent how to configure the server when it isn't", async () => {
    const { call } = await connect(async () => {
      throw new ConfigError("Vikunja is not configured. Run setup.");
    });
    expect(await call("list_projects")).toMatchObject({ isError: true, text: "Vikunja is not configured. Run setup." });
  });
});
