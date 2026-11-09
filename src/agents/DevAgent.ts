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
