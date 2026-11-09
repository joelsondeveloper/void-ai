import type { DatabaseSync } from "node:sqlite";
import { openLocalDatabase } from "../governance/CheckpointStore.js";
import type { OpenRouterDiagnostic } from "../models/providers/OpenRouterProvider.js";
import { quota, type LimitSignal, type ProviderId, type ProviderModel, type ProviderTotals } from "./provider-contracts.js";

const minute = 60_000, day = 86_400_000;
const retention = 7 * day;
const lease = 15_000;
export const voiceCaps = { perResponse: 2_000, daily: 6_000, minute: 6, concurrent: 1 };

const aggregate = `
  count(*) attempts, count(CASE WHEN outcome = 'failed' THEN 1 END) failed,
  count(CASE WHEN outcome = 'pending' THEN 1 END) pending,
  sum(input) inputTokens, sum(output) outputTokens, count(output) tokenReports,
  sum(characters) characters, sum(credits) credits, count(credits) creditReports,
  sum(usd) costUsd, count(usd) costReports
`;
const totals = (row: Record<string, unknown>) => row as unknown as ProviderTotals;

export interface VoiceOutcome {
  failed: boolean;
  httpStatus: number | null;
  credits: number | null;
  limit: LimitSignal | null;
  retryAt: number | null;
}

export class ProviderUsage {
  private readonly db: DatabaseSync;
  constructor(filename: string, private readonly now = Date.now) {
    this.db = openLocalDatabase(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_attempts (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        outcome TEXT NOT NULL, http INTEGER, api_code INTEGER, input INTEGER, output INTEGER, characters INTEGER,
        credits REAL, usd REAL, limit_kind TEXT, retry_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS provider_attempts_provider_at ON provider_attempts(provider, at);
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.db.prepare("PRAGMA table_info(provider_attempts)").all();
      if (!columns.some(({ name }) => name === "limit_evidence")) {
        this.db.exec("ALTER TABLE provider_attempts ADD COLUMN limit_evidence TEXT");
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; }
  }

  private prune(at: number) {
    this.db.prepare("DELETE FROM provider_attempts WHERE at < ? AND coalesce(retry_at, 0) <= ?").run(at - retention, at);
  }

  openRouter(event: Readonly<OpenRouterDiagnostic>) {
    if (event.elapsedMs === undefined) return;
    const at = this.now();
    this.db.prepare(`
      INSERT INTO provider_attempts (at, provider, model, outcome, http, api_code, input, output, usd, limit_kind, retry_at, limit_evidence)
      VALUES (?, 'openrouter', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(at, event.returnedModel ?? event.requestedModel ?? "desconhecido", event.failure ? "failed" : "ok",
      event.httpStatus ?? null, event.apiCode ?? null, event.usage?.inputTokens ?? null, event.usage?.outputTokens ?? null,
      event.costUsd ?? null, event.failure === "rate_limited" ? "rate" : null, event.retryAt ?? null,
      event.limitEvidence ? JSON.stringify(event.limitEvidence) : null);
    this.prune(at);
  }

  reserveVoice(model: string, characters: number) {
    const at = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE provider_attempts SET outcome = 'unknown' WHERE provider = 'elevenlabs' AND outcome = 'pending' AND at <= ?")
        .run(at - lease);
      const { daily, minute: calls, retryAt } = this.voiceLimits(at);
      const busy = this.db.prepare("SELECT 1 FROM provider_attempts WHERE provider = 'elevenlabs' AND outcome = 'pending' LIMIT 1").get();
      let reservation;
      if (retryAt !== null) reservation = { state: "cooldown" } as const;
      else if (busy || calls.remaining === 0 || characters > (daily.remaining ?? 0)) {
        reservation = { state: "local_limit" } as const;
      } else {
        const { lastInsertRowid } = this.db.prepare(`
          INSERT INTO provider_attempts (at, provider, model, outcome, characters)
          VALUES (?, 'elevenlabs', ?, 'pending', ?)
        `).run(at, model, characters);
        reservation = { state: "reserved", id: lastInsertRowid } as const;
      }
      this.prune(at);
      this.db.exec("COMMIT");
      return reservation;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  finishVoice(id: number | bigint, outcome: VoiceOutcome) {
    this.db.prepare(`
      UPDATE provider_attempts SET outcome = ?, http = ?, credits = ?, limit_kind = ?, retry_at = ? WHERE id = ?
    `).run(outcome.failed ? "failed" : "ok", outcome.httpStatus, outcome.credits, outcome.limit, outcome.retryAt, id);
  }

  voiceLimits(at = this.now()) {
    const dayStart = Math.floor(at / day) * day, minuteStart = Math.floor(at / minute) * minute;
    const usage = this.db.prepare(`
      SELECT coalesce(sum(characters), 0) characters, count(CASE WHEN at >= ? THEN 1 END) calls
      FROM provider_attempts WHERE provider = 'elevenlabs' AND at >= ?
    `).get(minuteStart, dayStart);
    const chars = Number(usage?.characters), calls = Number(usage?.calls);
    const latest = this.db.prepare(`
      SELECT max(retry_at) retryAt FROM provider_attempts WHERE provider = 'elevenlabs' AND retry_at > ?
    `).get(at);
    return {
      daily: quota(chars, voiceCaps.daily, Math.max(0, voiceCaps.daily - chars), "daily", dayStart + day),
      minute: quota(calls, voiceCaps.minute, Math.max(0, voiceCaps.minute - calls), "minute", minuteStart + minute),
      perResponse: voiceCaps.perResponse, concurrent: voiceCaps.concurrent,
      retryAt: (latest?.retryAt as number | null) ?? null,
    };
  }

  since() { return this.now() - retention; }

  report(provider: ProviderId, configured: readonly string[], since = this.since()) {
    const filter = "FROM provider_attempts WHERE provider = ? AND at >= ?";
    const aggregateRow = this.db.prepare("SELECT " + aggregate + filter).get(provider, since)!;
    const models = this.db.prepare("SELECT model, " + aggregate + filter + " GROUP BY model ORDER BY model")
      .all(provider, since);
    const latest = this.db.prepare(`
      SELECT limit_kind kind, at, retry_at retryAt, http httpStatus, api_code apiCode, limit_evidence evidenceJson
      FROM provider_attempts WHERE provider = ? AND model = ? AND at >= ? AND limit_kind IS NOT NULL
      ORDER BY at DESC, id DESC LIMIT 1
    `);
    const missing = { attempts: 0, failed: 0, pending: 0, inputTokens: null, outputTokens: null, tokenReports: 0,
      characters: null, credits: null, creditReports: 0, costUsd: null, costReports: 0 };
    const byModel = new Map(models.map((row) => [String(row.model), totals(row)]));
    return { totals: totals(aggregateRow), models: [...new Set([...configured, ...byModel.keys()])].map((model): ProviderModel => {
      const row = latest.get(provider, model, since) as
        (NonNullable<ProviderModel["limitEvent"]> & { evidenceJson: string | null }) | undefined;
      if (!row) return { ...(byModel.get(model) ?? missing), model, limitEvent: null };
      const { evidenceJson, ...event } = row;
      if (evidenceJson) event.evidence = JSON.parse(evidenceJson);
      return { ...(byModel.get(model) ?? missing), model, limitEvent: event };
    }) };
  }

  close() { this.db.close(); }
}
