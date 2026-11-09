import { failureText, type ActionName, type Execution, type Extension, type Notice, type Snapshot, type SystemInfo } from "../../src/web/contracts";
import { Icon } from "./singularity";

const statusLabels: Record<Execution["status"], string> = {
  pending: "Pendente", running: "Em execução", pausing: "Pausando", paused: "Pausada",
  awaiting_approval: "Aguardando aprovação", completed: "Concluída", failed: "Com falhas", cancelled: "Cancelada",
};
const reasons: Record<NonNullable<Execution["reason"]>, string> = {
  requested: "Pausa solicitada", time: "Limite de tempo", calls: "Limite de chamadas", steps: "Limite de etapas",
  tokens: "Limite de tokens", usage_unknown: "O provedor não informou o consumo de tokens", recovery: "Recuperação após interrupção do servidor",
};
const extensions: Record<keyof Extension, { label: string; amount: number }> = {
  calls: { label: "Chamadas adicionais", amount: 2 }, steps: { label: "Etapas adicionais", amount: 1 },
  timeMs: { label: "Tempo adicional (ms)", amount: 60_000 }, outputTokens: { label: "Tokens de saída adicionais", amount: 1_000 },
};

type Act = (action: ActionName, execution: Execution, extension?: Extension) => void;

export function ApprovalPanel({ execution, busy, act }: { execution: Execution; busy: boolean; act: Act }) {
  const { extension, actions, reason } = execution;
  if (execution.status !== "awaiting_approval" && execution.status !== "paused") return null;
  const resource = extension ? extensions[extension] : null;
  const limit = extension === "timeMs" ? execution.limits.pauseAfterMs : extension ? execution.limits[extension] : null;
  const completed = execution.steps.filter(({ status }) => status === "completed").length;
  return <section className="approval" aria-label="Decisão necessária">
    <p className="kicker"><span className="signal amber"/> Decisão necessária</p>
    <h3>{reason ? reasons[reason] : "Execução pausada"}</h3>
    <p>{completed} de {execution.steps.length} etapas concluídas{limit == null ? "." : " · Limite atual: " + limit + "."}</p>
    {resource && extension && actions.includes("approve") && <form onSubmit={(event) => {
      event.preventDefault();
      const value = Number(new FormData(event.currentTarget).get("additional"));
      act("approve", execution, { [extension]: value });
    }}>
      <label>{resource.label}<input name="additional" type="number" min="1" step="1" required defaultValue={resource.amount} disabled={busy}/></label>
      <button className="button primary" disabled={busy}>Autorizar e retomar</button>
    </form>}
    <div className="approval-actions">
      {actions.includes("resume") && <button className="button primary" disabled={busy} onClick={() => act("resume", execution)}>Retomar</button>}
      {actions.includes("cancel") && <button className="button" disabled={busy} onClick={() => act("cancel", execution)}>Encerrar execução</button>}
    </div>
  </section>;
}

function timeline(execution: Execution, notices: Notice[]) {
  const live = notices.filter(({ executionId, type }) => executionId === execution.id && type !== "initial");
  const restored = execution.steps.flatMap((step) => [
    ...(step.startedAt ? [{ id: step.id + ":start", at: step.startedAt, text: step.agentId + " iniciou " + step.id + "." }] : []),
    ...(step.finishedAt ? [{ id: step.id + ":end", at: step.finishedAt, text: step.agentId + " · " + statusLabels[step.status] + "." }] : []),
  ]);
  const end = ["completed", "failed", "cancelled", "paused", "awaiting_approval"].includes(execution.status)
    ? [{ id: execution.id + ":status", at: execution.updatedAt, text: statusLabels[execution.status] + "." }] : [];
  return [{ id: execution.id + ":start", at: execution.createdAt, text: "Execução iniciada." },
    ...(live.some((notice) => notice.stepId) ? [] : restored), ...live, ...end].sort((a, b) => a.at.localeCompare(b.at));
}

export function Workspace({ snapshot, execution, select, system, busy, act }: {
  snapshot: Snapshot | null; execution: Execution | undefined; select: (id: string) => void; system: SystemInfo | null; busy: boolean; act: Act;
}) {
  const history = snapshot?.executions ?? [];
  const entries = execution ? timeline(execution, snapshot?.notices ?? []) : [];
  return <section className="workspace" aria-label="Workspace">
    <header className="workspace-heading">
      <div><p className="kicker"><Icon name="workspace"/> Spatial workspace</p><h2>Operações</h2></div>
      {history.length > 0 && <label className="select-wrap"><span className="sr-only">Execução</span><select value={execution?.id ?? ""} onChange={(event) => select(event.target.value)}>
        {[...history].reverse().map((item) => <option value={item.id} key={item.id}>Execução {item.id.slice(0, 8)}</option>)}
      </select></label>}
    </header>
    {execution ? <>
      <div className="execution-head">
        <div><span className="run-label" data-status={execution.status}><span className="signal"/>{statusLabels[execution.status]}</span>
          <p className="technical">{execution.effort} · {execution.usage.calls}/{execution.limits.calls} chamadas · {execution.steps.filter(({ status }) => status === "completed").length}/{execution.steps.length} etapas concluídas</p></div>
        {execution.actions.includes("pause") && <button className="button" disabled={busy} onClick={() => act("pause", execution)}>Pausar</button>}
        {execution.actions.includes("cancel") && !["paused", "awaiting_approval"].includes(execution.status) &&
          <button className="button" disabled={busy} onClick={() => act("cancel", execution)}>Cancelar</button>}
      </div>
      <ApprovalPanel key={execution.revision} execution={execution} busy={busy} act={act}/>
      <section className="work-section">
        <h3><Icon name="activity"/> Atividade dos agentes</h3>
        <div className="steps">{execution.steps.map((step) => <article className="step" key={step.id}>
          <div className="step-heading"><span className="step-id">{step.id}</span><div><strong>{step.agentId}</strong>
            <span className="technical">{step.dependsOn.length ? "Após " + step.dependsOn.join(", ") : "Etapa independente"}</span></div>
            <span className="run-label" data-status={step.status}><span className="signal"/>{statusLabels[step.status]}</span></div>
          {step.failure && <p className="step-failure">{failureText(step.failure, step.failureDetail)}</p>}
          <details><summary>{step.output !== null ? "Inspecionar resultado" : "Ver objetivo"}</summary>
            <p className="step-objective">{step.objective}</p>
            {step.output !== null && <p className="prewrap">{step.output}</p>}
          </details>
        </article>)}</div>
      </section>
      <section className="work-section"><h3><Icon name="layers"/> Linha do tempo</h3>
        <ol className="timeline">{entries.map((entry) => <li key={entry.id}>
          <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString("pt-BR")}</time><span>{entry.text}</span></li>)}</ol>
      </section>
    </> : <div className="empty-work"><Icon name="activity" size={24}/><p>Nenhuma execução nesta sessão.</p><span>Quando a conversa envolver especialistas, as etapas e os resultados aparecem aqui.</span></div>}
    <section className="work-section"><h3>Modelos</h3>
      <dl className="model-list">{Object.entries(execution?.routes ?? system?.models ?? {}).map(([role, route]) =>
        <div key={role}><dt>{role}</dt><dd>{route.model}</dd></div>)}</dl>
      <p className="technical">Rotas selecionadas {execution ? "para esta execução" : "para o próximo envio"}</p>
      {execution?.served.length ? <ul className="served">{execution.served.map((model, index) =>
        <li key={model.role + index}><strong>{model.role}</strong> · {model.returned}</li>)}</ul> : <p className="technical">Nenhum modelo atendente registrado nesta execução.</p>}
      {!!execution?.served.length && <p className="technical">{system?.mode === "MOCK" ? "Atendentes simulados" : "Modelos efetivamente utilizados"}</p>}
    </section>
  </section>;
}
