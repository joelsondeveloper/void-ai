"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderDashboard, ProviderModel, ProviderReport, ProviderTotals, Quota, QuotaStatus } from "../../src/web/provider-contracts";

const labels = { normal: "Normal", near: "Perto do limite", exhausted: "Esgotado", unknown: "Desconhecido" };
const windows: Record<string, string> = { daily: "Diária (UTC)", weekly: "Semanal (UTC)", monthly: "Mensal (UTC)",
  monthly_period: "Mensal", annual_period: "Anual", weekly_period: "Semanal", minute: "Por minuto" };
const accountIssue = {
  not_checked: "Consulta externa pendente", not_configured: "Chave ausente", permission: "Acesso à cota recusado",
  rate: "Consulta de cota limitada", network: "Falha de conexão", timeout: "Tempo de consulta esgotado",
  invalid_response: "Resposta de cota inválida", unavailable: "Consulta indisponível",
};
const origins = { account: "Cota da conta OpenRouter", model: "Limite específico do modelo",
  upstream: "Provedor upstream", platform: "Plataforma OpenRouter (escopo desconhecido)", unknown: "Origem desconhecida" };
const numbers = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 6 });
const date = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const count = (value: number | null) => value === null ? "—" : numbers.format(value);
const time = (value: number | null) => value === null ? "—" : date.format(value);
const money = (amount: number, currency: string) => currency + " " + numbers.format(amount);

function Status({ value }: { value: QuotaStatus }) {
  return <span className="quota-status" data-quota={value}>{labels[value]}</span>;
}

function QuotaLine({ title, quota }: { title: string; quota: Quota | null }) {
  return <div className="quota-line">
    <div><strong>{title}</strong><Status value={quota?.status ?? "unknown"}/></div>
    {quota?.limit != null && quota.limit > 0 && quota.used !== null && <progress aria-label={title}
      max={quota.limit} value={Math.min(quota.used, quota.limit)} data-quota={quota.status}/>}
    <dl><div><dt>Consumido</dt><dd>{count(quota?.used ?? null)}</dd></div>
      <div><dt>Limite</dt><dd>{count(quota?.limit ?? null)}</dd></div>
      <div><dt>Restante</dt><dd>{count(quota?.remaining ?? null)}</dd></div>
      <div><dt>Renovação</dt><dd>{quota?.window && (windows[quota.window] ?? quota.window)} {time(quota?.resetsAt ?? null)}</dd></div>
    </dl>
  </div>;
}

function Usage({ usage, voice }: { usage: ProviderTotals; voice: boolean }) {
  return <dl className="provider-stats">
    <div><dt>Requisições</dt><dd>{count(usage.attempts)}</dd></div>
    <div><dt>Falhas</dt><dd>{count(usage.failed)}</dd></div>
    {usage.pending > 0 && <div><dt>Pendentes</dt><dd>{count(usage.pending)}</dd></div>}
    {voice ? <>
      <div><dt>Caracteres enviados (estimativa local)</dt><dd>{count(usage.characters)}</dd></div>
      <div><dt>Créditos informados</dt><dd>{count(usage.credits)} <small>({usage.creditReports}/{usage.attempts})</small></dd></div>
    </> : <>
      <div><dt>Tokens de entrada / saída</dt><dd>{count(usage.inputTokens)} / {count(usage.outputTokens)} <small>({usage.tokenReports}/{usage.attempts})</small></dd></div>
      <div><dt>Custo informado</dt><dd>{usage.costUsd === null ? "—" : money(usage.costUsd, "USD")} <small>({usage.costReports}/{usage.attempts})</small></dd></div>
    </>}
  </dl>;
}

async function readDashboard(method: "GET" | "POST", signal: AbortSignal) {
  const response = await fetch("/api/provider-usage", { method, signal,
    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}) });
  if (!response.ok) return { error: "HTTP " + response.status + (response.status === 404
    ? " · endpoint indisponível. Reinicie o servidor local do VOID e recarregue a página." : ".") };
  const snapshot = await response.json().catch(() => null) as ProviderDashboard | null;
  if (!snapshot || !Array.isArray(snapshot.providers) || !snapshot.voiceLimits) return { error: "Resposta inválida da API local." };
  return { snapshot };
}

function Model({ model, voice, now }: { model: ProviderModel; voice: boolean; now: number }) {
  const event = model.limitEvent;
  const active = event?.retryAt != null && event.retryAt > now;
  return <li className="provider-model">
    <div className="provider-model-title"><strong>{model.model}</strong>
      <Status value={active && event.kind === "quota" ? "exhausted" : "unknown"}/></div>
    <Usage usage={model} voice={voice}/>
    <p className="technical">{voice ? "Cota individual, saldo e renovação desconhecidos." : "Cota própria do modelo · desconhecida."}</p>
    {event && <p className="provider-event">{event.kind === "quota" ? "Cota reportada pelo provedor" : "Limite de requisições detectado"}
      {event.httpStatus === null ? "" : " · HTTP " + event.httpStatus}
      {event.apiCode === null || event.apiCode === event.httpStatus ? "" : " · código da API " + event.apiCode} · {time(event.at)}
      {!voice && " · " + origins[event.evidence?.origin ?? "unknown"]}
      {event.evidence?.upstream && " · " + event.evidence.upstream}
      {event.evidence?.requestedModel && " · rota solicitada " + event.evidence.requestedModel}
      {event.evidence?.returnedModel && " · modelo retornado " + event.evidence.returnedModel}
      {event.evidence?.limit != null && " · limite " + count(event.evidence.limit)}
      {event.evidence?.remaining != null && " · restante " + count(event.evidence.remaining)}
      {event.evidence?.resetsAt != null && " · renovação " + time(event.evidence.resetsAt)}
      {event.evidence?.retryAfterAt != null && " · Retry-After até " + time(event.evidence.retryAfterAt)}
      {active ? " · pausa local até " + time(event.retryAt) : ""}</p>}
  </li>;
}

function Provider({ report }: { report: ProviderReport }) {
  const voice = report.provider === "elevenlabs";
  const { account } = report;
  const latest = report.models.reduce<ProviderModel["limitEvent"]>((newest, { limitEvent }) =>
    limitEvent && (!newest || limitEvent.at > newest.at) ? limitEvent : newest, null);
  return <article className="provider-card" aria-label={voice ? "ElevenLabs" : "OpenRouter"}>
    <div className="provider-title"><h3>{voice ? "ElevenLabs" : "OpenRouter"}</h3>
      <span className="kicker">{report.enabled ? voice ? "Síntese habilitada" : "Rotas gratuitas" : "Geração desativada"}</span></div>
    <QuotaLine title={voice ? "Cota da assinatura (unidades do provedor)" : "Teto monetário da chave (USD)"} quota={account.quota}/>
    <p className="muted">{account.issue ? accountIssue[account.issue] + (account.httpStatus ? " · HTTP " + account.httpStatus : "")
      + (account.errorCode ? " · " + account.errorCode : "")
      : "Consulta do provedor · " + time(account.checkedAt)}</p>
    {!voice && account.quota?.limit === null && <p className="muted">Chave sem teto monetário informado.</p>}
    {!voice && <QuotaLine title="Cota diária da conta OpenRouter (rotas gratuitas)" quota={account.freeRequests}/>}
    {latest && <p className="provider-event">{latest.kind === "quota" ? "Último registro de cota esgotada" : "Último registro de limitação de requisições"} · {time(latest.at)}
      {!voice && " · " + origins[latest.evidence?.origin ?? "unknown"]}</p>}
    <p className="muted">{voice ? "Excedente atual" : "Gasto reportado pela chave"} · {account.spend ? money(account.spend.amount, account.spend.currency) : "—"}
      {!voice && account.dailySpend !== null && " · Hoje " + money(account.dailySpend, "USD")}</p>
    {voice && <p className="muted">O valor da assinatura e o custo monetário por modelo estão indisponíveis.</p>}
    <h4>Uso registrado nesta instalação · 7 dias</h4>
    <Usage usage={report.totals} voice={voice}/>
    <details className="provider-models"><summary>Modelos · {report.models.length}</summary>
      <ul>{report.models.map((model) => <Model key={model.model} model={model} voice={voice} now={Date.now()}/>)}</ul>
    </details>
  </article>;
}

export function ProviderPanel({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [data, setData] = useState<ProviderDashboard>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setLoading(true);
    setError(undefined);
    let stage = "Uso local";
    try {
      const local = await readDashboard("GET", pending.signal);
      if (pending.signal.aborted) return;
      if (!local.snapshot) { setError(stage + " · " + local.error); return; }
      setData(local.snapshot);
      if (local.snapshot.providers.every(({ account }) => account.issue === "not_configured")) return;
      stage = "Consulta de cotas";
      const remote = await readDashboard("POST", pending.signal);
      if (pending.signal.aborted) return;
      if (remote.snapshot) setData(remote.snapshot);
      else setError(stage + " · " + remote.error);
    } catch {
      if (!pending.signal.aborted) setError(stage + " · falha de conexão com o servidor local.");
    } finally {
      if (!pending.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    void refresh();
    return () => {
      controller.current?.abort();
      element?.close();
    };
  }, [refresh]);

  return <dialog ref={dialog} className="provider-dialog" aria-labelledby="provider-heading"
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className="provider-header">
      <div><p className="kicker">Singularity OS / Telemetria</p><h2 id="provider-heading">Uso e limites</h2></div>
      <button type="button" className="button" onClick={close}>Fechar</button>
    </header>
    <div className="provider-body">
      <div className="provider-intro"><p className="muted">Acompanhe cotas dos provedores e o consumo desta instalação.</p>
        <button className="button" type="button" disabled={loading} onClick={() => void refresh()}>Atualizar</button></div>
      {loading && <p className="muted" role="status">{data ? "Consultando provedores…" : "Carregando uso local…"}</p>}
      {error && <p className="provider-event" role="alert">{error}</p>}
      {data && <>
        <div className="provider-grid">{data.providers.map((report) => <Provider key={report.provider} report={report}/>)}</div>
        <article className="provider-card" aria-label="Limites internos de voz">
          <h3>Limites internos de voz</h3>
          <div className="provider-grid">
            <QuotaLine title="Caracteres por dia UTC" quota={data.voiceLimits.daily}/>
            <QuotaLine title="Chamadas por minuto" quota={data.voiceLimits.minute}/>
          </div>
          <p className="muted">{count(data.voiceLimits.perResponse)} caracteres por resposta · {data.voiceLimits.concurrent} chamada simultânea.</p>
          {data.voiceLimits.retryAt !== null && <p className="provider-event">Pausa de síntese após limite do provedor até {time(data.voiceLimits.retryAt)}.</p>}
          <p className="muted">A voz local pt-BR pode reproduzir a resposta quando a síntese externa falha ou está desativada.</p>
        </article>
        {data.legacy && data.legacy.attempts > 0 && <p className="muted">Histórico anterior do OpenRouter · {data.legacy.attempts} requisições, {data.legacy.failed} falhas. Modelo e motivo indisponíveis nesse contador. Origem desconhecida.</p>}
        <p className="technical">Desde {time(data.since)}. Frações indicam requisições com métrica informada. Um traço indica dado indisponível.</p>
      </>}
    </div>
  </dialog>;
}
