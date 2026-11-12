"use client";

import { useEffect, useState } from "react";

interface MemoryItem {
  id: string;
  kind: "profile" | "fact" | "summary";
  origin: "explicit" | "extracted" | "summary";
  text: string;
  updatedAt: string;
}

const kinds = { profile: "Perfil", fact: "Fato", summary: "Resumo de sessão" } as const;
const origins = { explicit: "você pediu", extracted: "captado da conversa", summary: "gerado pelo VOID" } as const;

/** What VOID keeps about the user, with a way to delete one record or all of them. Reads and writes /api/memory. */
export function MemoryPanel() {
  const [records, setRecords] = useState<MemoryItem[] | null>(null);
  const [limit, setLimit] = useState(500);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const response = await fetch("/api/memory", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json() as { records: MemoryItem[]; limits: { records: number } };
      setRecords(data.records); setLimit(data.limits.records); setError("");
    } catch { setError("Não foi possível carregar a memória."); }
  }

  useEffect(() => { void load(); }, []);

  async function remove(path: string, body?: object) {
    setBusy(true);
    try {
      const response = await fetch(path, { method: "DELETE",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error();
      await load();
    } catch { setError("Não foi possível apagar. Tente de novo."); }
    finally { setBusy(false); }
  }

  return <div className="memory-pane">
    <p className="muted">O que o VOID guarda sobre você, em texto puro, só neste computador. Vale em todas as sessões.</p>
    <div className="memory-tools">
      <span className="technical">{records ? `${records.length} de ${limit} registros` : "Carregando…"}</span>
      <button type="button" className="button" disabled={busy} onClick={() => void load()}>Atualizar</button>
      <button type="button" className="button" disabled={busy || !records?.length} onClick={() => {
        if (window.confirm("Apagar toda a memória? Isso não pode ser desfeito.")) void remove("/api/memory", { confirm: "apagar-tudo" });
      }}>Apagar tudo</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {records && !records.length && <p className="muted">A memória está vazia.</p>}
    <ul className="memory-list">{records?.map((record) => <li key={record.id}>
      <div>
        <span className="kicker">{kinds[record.kind]} · {origins[record.origin] ?? record.origin} · {new Date(record.updatedAt).toLocaleDateString("pt-BR")}</span>
        <p className="prewrap">{record.text}</p>
      </div>
      <button type="button" className="button" disabled={busy} aria-label={"Apagar: " + record.text.slice(0, 60)}
        onClick={() => void remove("/api/memory/" + record.id)}>Apagar</button>
    </li>)}</ul>
  </div>;
}
