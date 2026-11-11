import { setTimeout } from "node:timers/promises";
import { isDisplaySchema } from "./ui-contracts.js";
import type { ModelProvider } from "../types/model.js";

// Scripted fixtures for the offline demo. LIVE never uses this provider.
const toolFixtures: Record<string, { name: string; arguments: object }> = {
  "abra configurações": { name: "ui.openWindow", arguments: { component: "settings" } },
  "abra uso": { name: "ui.openWindow", arguments: { component: "usage" } },
  "abra sessões": { name: "ui.openWindow", arguments: { component: "sessions" } },
  "mostre operações": { name: "ui.openWindow", arguments: { component: "operations" } },
  "modo workspace": { name: "ui.switchMode", arguments: { mode: "workspace" } },
  "voltar ao focus": { name: "ui.switchMode", arguments: { mode: "focus" } },
};

export const mockProviderId = "web-demo";

export function demoProvider(delay: number): ModelProvider {
  return {
    id: mockProviderId,
    async generate({ model, messages, signal }) {
      const input = messages.at(-1)?.content ?? "";
      const system = messages[0]?.content ?? "";
      if (delay) await setTimeout(delay, undefined, { signal });
      signal?.throwIfAborted();
      let content: string;
      const fixture = system.startsWith("VOID_DECISION") && system.includes("ui.openWindow")
        && Object.hasOwn(toolFixtures, input.toLowerCase()) ? toolFixtures[input.toLowerCase()] : undefined;
      if (fixture) {
        content = JSON.stringify({ mode: "tool", call: fixture });
      } else if (system.startsWith("VOID_DECISION") && input.startsWith("Exibir {")) {
        let schema: unknown;
        try { schema = JSON.parse(input.slice("Exibir ".length)); } catch { /* Fixture only. */ }
        content = JSON.stringify(isDisplaySchema(schema) ? { mode: "display", schema }
          : { mode: "direct", response: "Visualização inválida." });
      } else if (system.startsWith("VOID_DECISION") && system.includes("ui.render") && /\bcontador\b/i.test(input)) {
        const key = /expedições/i.test(input) ? "contador-de-expedicoes" : "contador";
        content = JSON.stringify(input.startsWith("Reabra ") ? { mode: "tool", call: { name: "ui.render",
          arguments: { brief: input, key } } } : { mode: "delegate", steps: [{ id: "visual",
          agentId: "agent-renderer", requiredCapability: "ui-render", objective: input, dependsOn: [] }] });
      } else if (system.startsWith("VOID_UI_DESIGN")) {
        const { objective, requestedKey } = JSON.parse(input);
        content = JSON.stringify({ kind: "author", key: requestedKey ?? (/expedições/i.test(objective) ? "contador-de-expedicoes" : "contador"), brief: objective, review: false });
      } else if (system.startsWith("VOID_UI_AUTHOR") && /expedições/i.test(input)) {
        content = JSON.stringify({ title: "Expedições da equipe",
          source: 'export default function Component() { return (<section className="stack"><header><h1>Expedições da equipe</h1><p className="muted">Registre as saídas de campo desta sessão.</p></header><article className="card"><h2>Diário de campo</h2><Counter label="Expedições" /><Toggle label="Equipamento conferido" /></article></section>); }' });
      } else if (system.startsWith("VOID_UI_AUTHOR") && /contador/i.test(input)) {
        content = JSON.stringify({ title: "Contador",
          source: 'export default function Component() { return (<section className="stack"><header><h1>Contador</h1><p className="muted">Use os controles para ajustar a contagem nesta sessão.</p></header><article className="card"><Counter label="Contador" /></article></section>); }' });
      } else if (system.startsWith("VOID_DECISION")) {
        content = JSON.stringify(/analis[ea]|compare|função|falha simulada/i.test(input) ? {
          mode: "delegate",
          steps: [
            { id: "A", agentId: "dev-agent", requiredCapability: "code-analysis", objective: input, dependsOn: [] },
            { id: "B", agentId: "research-agent", requiredCapability: "comparative-analysis", objective: input, dependsOn: ["A"] },
          ],
        } : {
          mode: "direct",
          response: /concorr[êe]ncia/i.test(input) && /paralelismo/i.test(input)
            ? "Concorrência é fazer várias tarefas progredirem no mesmo período, por exemplo, alternando entre elas em um único núcleo. Paralelismo é executá-las de fato ao mesmo tempo, por exemplo, usando dois núcleos."
            : "O modo simulado tem cenários fixos. Experimente perguntar sobre concorrência e paralelismo ou pedir uma análise com os especialistas.",
        });
      } else if (system.startsWith("VOID_SYNTHESIS")) {
        const { evidence }: { evidence: Record<string, string> } = JSON.parse(input);
        content = JSON.stringify({ answer: Object.values(evidence).join("\n\n"),
          sources: Object.fromEntries(Object.entries(evidence).map(([id, output]) => [id, output.slice(0, 120)])) });
      } else if (model === "research-local") {
        if (/falha simulada/i.test(input)) throw new Error("Simulated specialist failure");
        content = "Comparação simulada: validar a correção com casos-limite é mais rápido que refatorar a função inteira. A refatoração ganha valor se houver outros problemas recorrentes.";
      } else {
        content = "Análise simulada: defina o comportamento para entradas vazias e cubra esse caso com um teste. Verifique também se o retorno preserva o tipo esperado.";
      }
      return { model, content, usage: { inputTokens: 12, outputTokens: 20 } };
    },
  };
}
