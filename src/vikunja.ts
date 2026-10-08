/**
 * Thin typed client for the Vikunja REST API (v1). Each method is one HTTP call;
 * tool behaviour such as merging updates and ownership checks lives in server.ts.
 *
 * The interfaces below declare only the fields this package reads. Responses are
 * not validated at runtime, and objects keep every field Vikunja sent, which
 * update_task relies on to round-trip a full task.
 */

export interface VikunjaUser {
  id: number;
  username: string;
  name: string;
}

export interface VikunjaLabel {
  id: number;
  title: string;
}

export interface VikunjaBucket {
  id: number;
  title: string;
  project_view_id: number;
  limit: number;
  position: number;
}

export interface VikunjaTask {
  id: number;
  project_id: number;
  /** Per-project number shown on the board, like 12 for #12. */
  index: number;
  identifier: string;
  title: string;
  /** HTML from Vikunja's editor. */
  description: string;
  done: boolean;
  done_at: string;
  due_date: string;
  start_date: string;
  end_date: string;
  priority: number;
  percent_done: number;
  repeat_after: number;
  repeat_mode: number;
  assignees: VikunjaUser[] | null;
  labels: VikunjaLabel[] | null;
  related_tasks: Record<string, VikunjaTask[] | null> | null;
  /** Only present when requested with `expand=buckets`. */
  buckets?: VikunjaBucket[] | null;
  created: string;
  updated: string;
  created_by?: VikunjaUser | null;
}

export interface VikunjaProject {
  id: number;
  title: string;
  description: string;
  identifier: string;
  parent_project_id: number;
  is_archived: boolean;
}

export interface VikunjaView {
  id: number;
  title: string;
  view_kind: "list" | "gantt" | "table" | "kanban";
  bucket_configuration_mode: "none" | "manual" | "filter";
  default_bucket_id: number;
  done_bucket_id: number;
}

export interface VikunjaComment {
  id: number;
  comment: string;
  author: VikunjaUser | null;
  created: string;
  updated: string;
}

export interface VikunjaInfo {
  version: string;
}

/** Fields callers may set when creating or updating a task. */
export interface TaskFields {
  title?: string;
  description?: string;
  priority?: number;
  due_date?: string;
}

// A type alias, not an interface, so it fits RequestOptions' query record.
export type Pagination = {
  page?: number | undefined;
  per_page?: number | undefined;
};

export interface Page<T> {
  items: T[];
  page: number;
  /** From Vikunja's `x-pagination-total-pages` header, when sent. */
  total_pages?: number;
}

/** API token permissions the tools need, grouped as on Vikunja's API token page. */
export const TOKEN_PERMISSIONS = {
  projects: ["read_all", "tasks_by_index", "views_buckets", "views_buckets_tasks"],
  projects_views: ["read_all"],
  tasks: ["read_all", "read_one", "create", "update"],
  tasks_comments: ["read_all", "create"],
} as const;

type Permissions = typeof TOKEN_PERMISSIONS;
export type Permission = { [G in keyof Permissions]: `${G}: ${Permissions[G][number]}` }[keyof Permissions];

type Method = "GET" | "PUT" | "POST";

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Permission an API token needs for this endpoint; quoted in 401 errors. Omit for public endpoints. */
  permission?: Permission;
}

export class VikunjaError extends Error {
  override name = "VikunjaError";
}

export interface VikunjaOptions {
  /** Instance root, e.g. `https://tasks.example.com`. See normalizeUrl in config.ts. */
  url: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Vikunja encodes "no date" as Go's zero time. */
export const NO_DATE = "0001-01-01T00:00:00Z";

export type Vikunja = ReturnType<typeof createVikunja>;

export function createVikunja({ url, token, fetch = globalThis.fetch, timeoutMs = 25_000 }: VikunjaOptions) {
  async function send(method: Method, path: string, { query = {}, body, permission }: RequestOptions) {
    const target = new URL(`${url}/api/v1${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) target.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (permission) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // Following a redirect would forward the bearer token to another URL.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? `timed out after ${timeoutMs / 1000}s`
          : errorMessage(error);
      throw new VikunjaError(`Could not reach Vikunja at ${url} (${reason}).${writeWarning(method)}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "another URL";
      throw new VikunjaError(
        `Vikunja at ${url} redirected to ${location}. Redirects are not followed, so the token is never sent anywhere else. Run \`vikunja-mcp setup\` with the final URL.`,
      );
    }
    if (!response.ok) throw await httpError(response, method, path, permission);
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new VikunjaError(`Expected JSON from ${target.origin}${target.pathname}. Is ${url} a Vikunja instance?`);
    }
    return response;
  }

  async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await send(method, path, options);
    return (await response.json()) as T;
  }

  async function requestPage<T>(path: string, options: RequestOptions & { query: Pagination }): Promise<Page<T>> {
    const response = await send("GET", path, options);
    const items = ((await response.json()) as T[] | null) ?? [];
    const totalPages = Number(response.headers.get("x-pagination-total-pages"));
    return { items, page: options.query.page ?? 1, ...(totalPages > 0 && { total_pages: totalPages }) };
  }

  return {
    info: () => request<VikunjaInfo>("GET", "/info"),

    listProjects: (query: Pagination & { s?: string | undefined }) =>
      requestPage<VikunjaProject>("/projects", { query, permission: "projects: read_all" }),

    /** `filter` uses Vikunja's filter syntax: https://vikunja.io/docs/filters */
    listTasks: (query: Pagination & { filter: string; s?: string | undefined }) =>
      requestPage<VikunjaTask>("/tasks", { query, permission: "tasks: read_all" }),

    getTask: (taskId: number) =>
      request<VikunjaTask>("GET", `/tasks/${taskId}`, {
        query: { expand: "buckets" },
        permission: "tasks: read_one",
      }),

    getTaskByIndex: (projectId: number, index: number) =>
      request<VikunjaTask>("GET", `/projects/${projectId}/tasks/by-index/${index}`, {
        query: { expand: "buckets" },
        permission: "projects: tasks_by_index",
      }),

    createTask: (projectId: number, fields: TaskFields & { title: string }) =>
      request<VikunjaTask>("PUT", `/projects/${projectId}/tasks`, { body: fields, permission: "tasks: create" }),

    /** Overwrites every editable column, so pass a complete task (see update_task). */
    updateTask: (task: VikunjaTask) =>
      request<VikunjaTask>("POST", `/tasks/${task.id}`, { body: task, permission: "tasks: update" }),

    listViews: (projectId: number) =>
      request<VikunjaView[]>("GET", `/projects/${projectId}/views`, { permission: "projects_views: read_all" }),

    listBuckets: (projectId: number, viewId: number) =>
      request<VikunjaBucket[] | null>("GET", `/projects/${projectId}/views/${viewId}/buckets`, {
        permission: "projects: views_buckets",
      }),

    moveTask: ({ taskId, projectId, viewId, bucketId }: Record<"taskId" | "projectId" | "viewId" | "bucketId", number>) =>
      request<unknown>("POST", `/projects/${projectId}/views/${viewId}/buckets/${bucketId}/tasks`, {
        body: { task_id: taskId, bucket_id: bucketId, project_view_id: viewId },
        permission: "projects: views_buckets_tasks",
      }),

    listComments: (taskId: number, query: Pagination) =>
      requestPage<VikunjaComment>(`/tasks/${taskId}/comments`, { query, permission: "tasks_comments: read_all" }),

    addComment: (taskId: number, comment: string) =>
      request<VikunjaComment>("PUT", `/tasks/${taskId}/comments`, {
        body: { comment },
        permission: "tasks_comments: create",
      }),
  };
}

async function httpError(response: Response, method: Method, path: string, permission: Permission | undefined) {
  const { status } = response;
  const endpoint = `${method} ${path}`;
  const detail = parseErrorMessage(await response.text().catch(() => ""));
  const said = detail ? `: ${detail}` : "";
  switch (status) {
    case 401:
      return new VikunjaError(
        `Vikunja rejected the API token for ${endpoint} (HTTP 401${said}). The token is invalid or expired, or it lacks the "${permission}" permission. Don't retry with the same token: create one with that permission in Vikunja under Settings > API Tokens, then run \`vikunja-mcp setup\`.`,
      );
    case 403:
      return new VikunjaError(`Vikunja denied ${endpoint} (HTTP 403${said}). The token's user can't access it.`);
    case 404:
      return new VikunjaError(`Vikunja found nothing at ${endpoint} (HTTP 404${said}). Check the IDs.`);
    default:
      return new VikunjaError(
        `Vikunja returned HTTP ${status} for ${endpoint}${said}.${status >= 500 ? writeWarning(method) : ""}`,
      );
  }
}

/** Vikunja errors look like `{"code": 4002, "message": "This task does not exist"}`. */
function parseErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return body.trim().slice(0, 200);
}

function writeWarning(method: Method) {
  return method === "GET"
    ? ""
    : " The change may have been applied anyway: read the task before retrying so you don't create a duplicate.";
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // fetch wraps network failures as "fetch failed" with the useful part in `cause`.
  const cause = error.cause instanceof Error ? error.cause : error;
  const code = "code" in cause ? String(cause.code) : undefined;
  if (code === "ERR_SSL_WRONG_VERSION_NUMBER") {
    return "the server didn't answer over HTTPS; if it only serves plain HTTP, start the URL with http://";
  }
  // A refused connection to localhost is an AggregateError with an empty message.
  return cause.message.trim() || code || error.message;
}
