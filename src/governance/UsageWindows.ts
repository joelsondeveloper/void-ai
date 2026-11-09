import { DatabaseSync } from "node:sqlite";
import type { ModelUsage } from "../types/model.js";
import type { UsageWindow } from "../web/contracts.js";

const windows = [5, 7 * 24] as const;
const hour = 3_600_000;

export class UsageWindows {
  private readonly db: DatabaseSync;

  constructor(filename: string, private readonly now = Date.now) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS provider_usage (
        at INTEGER NOT NULL, failed INTEGER NOT NULL, input INTEGER, output INTEGER, reasoning INTEGER
      );
      CREATE INDEX IF NOT EXISTS provider_usage_at ON provider_usage(at);
    `);
  }

  record(usage: ModelUsage | undefined, failed: boolean): void {
    const at = this.now();
    this.db.prepare("INSERT INTO provider_usage VALUES (?, ?, ?, ?, ?)").run(
      at, Number(failed), usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.reasoningTokens ?? null,
    );
    this.db.prepare("DELETE FROM provider_usage WHERE at <= ?").run(at - windows[1] * hour);
  }

  snapshot(): UsageWindow[] {
    const at = this.now();
    const totals = this.db.prepare(`
      SELECT count(*) attempts, coalesce(sum(failed), 0) failed, count(*) - count(output) unknownUsage,
        coalesce(sum(input), 0) inputTokens, coalesce(sum(output), 0) outputTokens,
        coalesce(sum(reasoning), 0) reasoningTokens
      FROM provider_usage WHERE at > ? AND at <= ?
    `);
    return windows.map((hours) => {
      const since = at - hours * hour;
      const row = totals.get(since, at);
      return { hours, since: new Date(since).toISOString(), attempts: Number(row?.attempts),
        failed: Number(row?.failed), unknownUsage: Number(row?.unknownUsage),
        inputTokens: Number(row?.inputTokens), outputTokens: Number(row?.outputTokens),
        reasoningTokens: Number(row?.reasoningTokens) };
    });
  }

  close(): void { this.db.close(); }
}
