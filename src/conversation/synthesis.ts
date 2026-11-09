import type { ExecutionCheckpoint } from "../governance/checkpoint.js";
import { isRecord } from "./mainDecision.js";
import { parseModelJson } from "./parseModelJson.js";

const outcome = {
  pending: "Ainda pendente",
  running: "Em andamento",
  completed: "Execução concluída",
  failed: "Execução com falhas",
  pausing: "Pausa em andamento",
  paused: "Execução pausada",
  awaiting_approval: "Execução aguardando aprovação",
  cancelled: "Execução cancelada",
} satisfies Record<ExecutionCheckpoint["status"], string>;

export function renderResults(checkpoint: ExecutionCheckpoint, answer?: string, synthesisNote?: string): string {
  const agents = new Map(checkpoint.plan.map(({ id, agentId }) => [id, agentId]));
  const groups: Record<"confirmed" | "failed" | "pending", string[]> = { confirmed: [], failed: [], pending: [] };
  for (const step of checkpoint.steps) {
    const label = `${step.stepId} (${agents.get(step.stepId) ?? "especialista"})`;
    if (step.status === "completed") {
      const output = step.output ?? "";
      groups.confirmed.push(`### ${label}\n\n${output}`);
    } else if (step.status === "failed") {
      groups.failed.push(`- ${label}`);
    } else {
      groups.pending.push(`- ${label} — ${outcome[step.status]}`);
    }
  }
  return [
    outcome[checkpoint.status] + ".",
    ...(synthesisNote ? [synthesisNote] : []),
    answer ?? (groups.confirmed.length ? "## Resultados dos especialistas\n\n" + groups.confirmed.join("\n\n") : "Nenhuma etapa concluída."),
    ...(groups.failed.length ? ["## Falhas\n\n" + groups.failed.join("\n")] : []),
    ...(groups.pending.length ? ["## Etapas sem resultado\n\n" + groups.pending.join("\n")] : []),
  ].join("\n\n");
}

export function parseSynthesis(content: string, evidence: ReadonlyMap<string, string>): string {
  if (content.length > 32_000) throw new Error("Invalid synthesis size.");
  const value = parseModelJson(content);
  if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.answer !== "string" ||
      !value.answer.trim() || !isRecord(value.sources) || Object.keys(value.sources).length !== evidence.size) {
    throw new Error("Invalid or incomplete synthesis.");
  }
  for (const [id, quote] of Object.entries(value.sources)) {
    if (typeof quote !== "string" || !quote.trim() || quote.length > 160 || !evidence.get(id)?.includes(quote)) {
      throw new Error("Invalid synthesis evidence.");
    }
  }
  return value.answer.trim();
}
