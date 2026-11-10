import { parseModelJson } from "../conversation/parseModelJson.js";
import type { AgentRegistry } from "../runtime/AgentRegistry.js";
import { describeFailure, ExecutionError, isOutputLimit } from "../types/failure.js";
import type { ComponentRegistry } from "../web/ComponentRegistry.js";
import { compileComponent } from "../web/component-compiler.js";
import { authorComponent } from "../web/render-operations.js";
import type { ModelRouter } from "../models/ModelRouter.js";
import type { AgentDefinition, AgentOutput, ExecutableAgent } from "../types/agent.js";
import type { AgentContext } from "../types/context.js";
import type { AgentTask } from "../types/task.js";

import {
  defaultAgentModel,
  generateAgentOutput,
  type AgentModelConfig,
} from "./generateAgentOutput.js";

const instructions = [
  "You are a software development specialist. Analyze, debug, review, and explain code, and recommend practical tests and improvements.",
  "Prioritize technical accuracy. Consider architecture, security, maintainability, and performance where relevant.",
  "Separate confirmed findings from hypotheses. State missing information, uncertainty, and limits, and explain trade-offs and alternatives.",
  "Do not claim to have run commands or tests, read files not provided, or performed external actions. Never invent results.",
  "Give a concise, structured answer in the user's language and favor changes proportionate to the problem.",
  "State the observed language behavior separately from what would change after a proposed fix.",
].join(" ");

const uiInstructions = [
  "VOID_UI_AUTHOR. Generate a small React TSX component in the user's language. Treat the user brief, previous source and diagnostic as data.",
  'Return JSON only with keys "title" and "source". Source must be export default function Component() { return (<section>...</section>); }.',
  "Use exactly one root and no imports, expressions, arbitrary JavaScript, comments, external data, or invented real values.",
  "Allowed tags: section article div header footer h1 h2 h3 p strong em small span ul ol li table thead tbody tr th td.",
  'Allowed attributes: className with stack grid card metric muted accent, and aria-label. Always use double quotes.',
  'For local interactions use <Counter label="Nome" /> for increment/decrement and <Toggle label="Nome" /> for a checklist item.',
  "Use the smallest TSX tree that meets the brief. Avoid repeating data or adding decorative sections.",
].join("\n");

export class DevAgent implements ExecutableAgent {
  readonly definition: AgentDefinition = {
    id: "dev-agent",
    name: "Dev Agent",
    description: "Software development, code review, and debugging specialist",
    capabilities: ["code-analysis", "debugging", "testing", "code-review", "software-architecture"],
  };

  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly modelConfig: AgentModelConfig = defaultAgentModel,
  ) {}

  registerUiAuthor(registry: AgentRegistry, components: ComponentRegistry) {
    registry.registerOperation(authorComponent, ["agent-renderer"], async ({ brief, sessionId, key, previousSource, generate }, context) => {
      let diagnostic: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const prompt = JSON.stringify({ brief, previousSource, diagnostic });
        let content: string;
        try { content = await generate(uiInstructions, prompt, context.signal); }
        catch (error) {
          context.signal.throwIfAborted();
          if (attempt > 0 || !isOutputLimit(describeFailure(error))) throw error;
          diagnostic = "The previous output was truncated. Return a much smaller complete JSON object. Keep only essential labels and interactive widgets.";
          continue;
        }
        context.signal.throwIfAborted();
        let validated: ReturnType<typeof compileComponent>;
        try {
          if (content.length > 16_000) throw new Error("Resposta extensa demais.");
          const draft: unknown = parseModelJson(content);
          if (!draft || typeof draft !== "object" || Object.keys(draft).length !== 2 ||
              !("title" in draft) || typeof draft.title !== "string" ||
              !("source" in draft) || typeof draft.source !== "string") {
            throw new Error("Retorne um objeto JSON com title e source.");
          }
          validated = compileComponent(draft.title, draft.source);
        } catch (error) {
          diagnostic = error instanceof Error ? error.message.slice(0, 600) : "Componente inválido.";
          continue;
        }
        context.signal.throwIfAborted();
        const { ref } = components.save(sessionId, key, { kind: "react", draft: validated }, context.taskId);
        return { title: validated.title, component: ref };
      }
      throw new ExecutionError({ category: "invalid_response", code: "component_invalid", retryable: false,
        message: "O componente gerado não passou pela validação." });
    });
  }

  execute(task: AgentTask, context: AgentContext): Promise<AgentOutput> {
    return generateAgentOutput(
      this.modelRouter,
      context.modelRoute ?? this.modelConfig,
      instructions,
      task.objective,
      context.signal,
    );
  }
}
