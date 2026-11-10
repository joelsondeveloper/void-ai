import type { AgentRegistry } from "../runtime/AgentRegistry.js";
import type { AgentIdentity } from "../types/agent.js";
import { ExecutionError } from "../types/failure.js";
import type { ComponentRegistry } from "../web/ComponentRegistry.js";
import { previewPermission } from "../web/render-contracts.js";
import { authorComponent, renderWindow, type RenderedWindow } from "../web/render-operations.js";
import type { UiRuntimeService } from "../web/ui-runtime.js";

export class AgentRenderer implements AgentIdentity {
  readonly definition = {
    id: renderWindow.agentId,
    name: "AgentRenderer",
    description: "Abre janelas do VOID, monta visualizações e reutiliza componentes. Solicita ao DevAgent componentes React novos para a prévia isolada.",
    capabilities: [],
  };

  constructor(private readonly components: ComponentRegistry, private readonly ui: UiRuntimeService) {}

  register(registry: AgentRegistry) {
    registry.registerOperation(renderWindow, ["main-agent"], async (input, context): Promise<RenderedWindow> => {
      if ("builtin" in input) {
        const command = this.ui.call(input.builtin);
        if (!command?.action) throw new Error("Invalid built-in window.");
        return { response: command.response, action: command.action };
      }
      const { sessionId, brief, display, revise, generate } = input;
      const key = input.key ?? brief;
      if (display) {
        const version = this.components.save(sessionId, key, { kind: "display", schema: display }, context.taskId);
        const schema = version.artifact.kind === "display" ? version.artifact.schema : display;
        return { response: "Visualização aberta.", action: { type: "update_panel", panel: "display", schema } };
      }
      const existing = this.components.latest(sessionId, key);
      if (existing?.artifact.kind === "display" && !revise) {
        return { response: "Visualização aberta.", action: { type: "update_panel", panel: "display", schema: existing.artifact.schema } };
      }
      if (!context.permissions.has(previewPermission)) {
        throw new ExecutionError({ category: "permission_denied", retryable: false,
          message: "A prévia isolada não está autorizada." });
      }
      if (existing?.artifact.kind === "react" && !revise) {
        return { response: "Interface aberta.", action: { type: "open_component",
          window: { title: existing.artifact.draft.title, component: existing.ref } } };
      }
      const window = await context.invoke(authorComponent, { brief, sessionId, key, generate,
        ...(existing?.artifact.kind === "react" ? { previousSource: existing.artifact.draft.source } : {}) });
      context.signal.throwIfAborted();
      return { response: "Interface aberta.", action: { type: "open_component", window } };
    });
  }
}
