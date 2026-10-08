/**
 * Compact shapes for tool results. Raw Vikunja objects carry nested users,
 * colors and zero-value dates that cost an agent context without helping it,
 * so results keep what matters for planning and editing work.
 */
import type { VikunjaBucket, VikunjaComment, VikunjaProject, VikunjaTask, VikunjaView } from "./vikunja.js";

/** Turns Vikunja's zero time ("no date") into null. */
const date = (value: string | undefined) => (value && !value.startsWith("0001-01-01") ? value : null);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** Plain-text excerpt of an HTML description, for lists. */
export function preview(html: string, max = 200): string {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, entity: string) => ENTITIES[entity] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function projectSummary(project: VikunjaProject) {
  return {
    id: project.id,
    title: project.title,
    identifier: project.identifier,
    parent_project_id: project.parent_project_id || null,
    archived: project.is_archived,
    description_preview: preview(project.description),
  };
}

export function taskSummary(task: VikunjaTask) {
  return {
    id: task.id,
    index: task.index,
    identifier: task.identifier,
    title: task.title,
    done: task.done,
    priority: task.priority,
    due_date: date(task.due_date),
    labels: (task.labels ?? []).map((label) => label.title),
    assignees: (task.assignees ?? []).map((user) => user.username),
    description_preview: preview(task.description),
  };
}

export function taskDetail(task: VikunjaTask) {
  return {
    id: task.id,
    project_id: task.project_id,
    index: task.index,
    identifier: task.identifier,
    title: task.title,
    description: task.description,
    done: task.done,
    done_at: date(task.done_at),
    priority: task.priority,
    percent_done: task.percent_done,
    due_date: date(task.due_date),
    start_date: date(task.start_date),
    end_date: date(task.end_date),
    // Recurring tasks reopen themselves when marked done.
    recurring: task.repeat_after > 0 || task.repeat_mode === 1,
    labels: (task.labels ?? []).map((label) => label.title),
    assignees: (task.assignees ?? []).map((user) => user.username),
    buckets: (task.buckets ?? []).map(bucketRef),
    related_tasks: Object.fromEntries(
      Object.entries(task.related_tasks ?? {}).map(([kind, related]) => [
        kind,
        (related ?? []).map(({ id, title, done }) => ({ id, title, done })),
      ]),
    ),
    created_by: task.created_by?.username ?? null,
    created: task.created,
    updated: task.updated,
  };
}

const bucketRef = (bucket: VikunjaBucket) => ({ id: bucket.id, title: bucket.title, view_id: bucket.project_view_id });

export function viewSummary(view: VikunjaView) {
  return {
    id: view.id,
    title: view.title,
    view_kind: view.view_kind,
    bucket_configuration_mode: view.bucket_configuration_mode,
    default_bucket_id: view.default_bucket_id || null,
    done_bucket_id: view.done_bucket_id || null,
  };
}

export function bucketSummary(bucket: VikunjaBucket) {
  return { id: bucket.id, title: bucket.title, position: bucket.position, limit: bucket.limit || null };
}

export function commentSummary(comment: VikunjaComment) {
  return {
    id: comment.id,
    author: comment.author?.username ?? null,
    created: comment.created,
    updated: comment.updated,
    comment: comment.comment,
  };
}
