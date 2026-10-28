import { db, newId, nowIso } from '../db/client.ts';
import type { EventType, TimelineEvent } from '../types.ts';

type Listener = (event: TimelineEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitEvent(
  projectId: string,
  type: EventType,
  message: string,
  taskId: string | null = null,
  payload: unknown = {}
): TimelineEvent {
  const event: TimelineEvent = {
    id: newId('event'),
    project_id: projectId,
    task_id: taskId,
    type,
    message,
    payload: JSON.stringify(payload ?? {}),
    created_at: nowIso()
  };
  db.prepare(
    `INSERT INTO events (id, project_id, task_id, type, message, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    event.project_id,
    event.task_id,
    event.type,
    event.message,
    event.payload,
    event.created_at
  );
  for (const listener of listeners) listener(event);
  return event;
}

export function listEvents(projectId: string, limit = 200): TimelineEvent[] {
  return db
    .prepare(
      `SELECT * FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(projectId, limit) as unknown as TimelineEvent[];
}
