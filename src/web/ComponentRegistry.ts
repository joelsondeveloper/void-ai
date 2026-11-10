import { createHash } from "node:crypto";
import { openLocalDatabase } from "../governance/CheckpointStore.js";
import type { AgentTaskEvent } from "../runtime/AgentOperation.js";
import { previewPermission, type ComponentDraft, type ComponentRef } from "./render-contracts.js";
import type { DisplaySchema } from "./ui-contracts.js";

type Artifact = { kind: "react"; draft: ComponentDraft } | { kind: "display"; schema: DisplaySchema };
type Version = { ref: ComponentRef; artifact: Artifact };

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function componentId(sessionId: string, key: string) {
  return hash(JSON.stringify([sessionId, key.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ")]));
}

export class ComponentRegistry {
  private readonly db: ReturnType<typeof openLocalDatabase>;

  constructor(filename: string) {
    this.db = openLocalDatabase(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ui_components (
        id TEXT NOT NULL, version INTEGER NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL, lookup_key TEXT,
        artifact TEXT NOT NULL, digest TEXT NOT NULL, permission TEXT NOT NULL,
        task_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ui_components_session ON ui_components (session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS ui_agent_tasks (
        task_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, parent_task_id TEXT, caller TEXT NOT NULL,
        agent_id TEXT NOT NULL, capability TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT
      ) STRICT;
    `);
  }

  catalog(sessionId: string): { key: string; title: string; version: number }[] {
    return this.db.prepare(`SELECT lookup_key, title, version FROM ui_components c
      WHERE session_id = ? AND lookup_key IS NOT NULL AND
        version = (SELECT MAX(version) FROM ui_components WHERE id = c.id)
      ORDER BY created_at DESC LIMIT 12`).all(sessionId).flatMap(({ lookup_key, title, version }) =>
      typeof lookup_key === "string" && typeof title === "string" && typeof version === "number"
        ? [{ key: lookup_key, title, version }] : []);
  }

  latest(sessionId: string, key: string): Version | undefined {
    const id = componentId(sessionId, key);
    const row = this.db.prepare(`SELECT version, artifact, digest FROM ui_components
      WHERE session_id = ? AND id = ? ORDER BY version DESC LIMIT 1`).get(sessionId, id);
    return this.read(id, row);
  }

  save(sessionId: string, key: string, artifact: Artifact, taskId: string): Version {
    const id = componentId(sessionId, key);
    const json = JSON.stringify(artifact);
    const digest = hash(json);
    const title = artifact.kind === "react" ? artifact.draft.title : artifact.schema.title;
    const permission = artifact.kind === "react" ? previewPermission : "declarative-display";
    const lookupKey = /^[a-z0-9-]{1,64}$/.test(key) ? key : null;
    const row = this.db.prepare(`INSERT INTO ui_components
      (id, version, session_id, title, lookup_key, artifact, digest, permission, task_id, created_at)
      SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ? FROM ui_components WHERE id = ?
      HAVING COALESCE((SELECT digest FROM ui_components WHERE id = ? ORDER BY version DESC LIMIT 1), '') <> ?
      RETURNING version`).get(id, sessionId, title, lookupKey, json, digest, permission, taskId, new Date().toISOString(), id, id, digest);
    if (typeof row?.version === "number") return { ref: { id, version: row.version }, artifact };
    const duplicate = this.db.prepare(`SELECT version, artifact, digest FROM ui_components
      WHERE session_id = ? AND id = ? AND digest = ? ORDER BY version DESC LIMIT 1`).get(sessionId, id, digest);
    const version = this.read(id, duplicate);
    if (!version) throw new Error("Component version was not persisted.");
    return version;
  }

  preview(sessionId: string, ref: ComponentRef): ComponentDraft | undefined {
    const row = this.db.prepare(`SELECT version, artifact, digest FROM ui_components
      WHERE session_id = ? AND id = ? AND version = ? AND permission = ?`)
      .get(sessionId, ref.id, ref.version, previewPermission);
    const artifact = this.read(ref.id, row)?.artifact;
    return artifact?.kind === "react" ? artifact.draft : undefined;
  }

  trace(event: AgentTaskEvent) {
    if (event.status === "running") {
      this.db.prepare(`INSERT INTO ui_agent_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        event.taskId, event.executionId, event.parentTaskId, event.caller, event.agentId, event.capability, event.status, event.at);
    } else {
      this.db.prepare("UPDATE ui_agent_tasks SET status = ?, finished_at = ? WHERE task_id = ?")
        .run(event.status, event.at, event.taskId);
    }
  }

  close() { this.db.close(); }

  private read(id: string, row: Record<string, unknown> | undefined): Version | undefined {
    if (!row) return;
    if (typeof row.version !== "number" || typeof row.artifact !== "string" || hash(row.artifact) !== row.digest) {
      throw new Error("Component artifact is corrupt.");
    }
    return { ref: { id, version: row.version }, artifact: JSON.parse(row.artifact) as Artifact };
  }
}
