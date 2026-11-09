import type { ExecutableAgent } from "../types/agent.js";

export class AgentRegistry {
  private readonly agents: Map<string, ExecutableAgent> = new Map();

  register(agent: ExecutableAgent) {
    if (this.agents.has(agent.definition.id)) {
      throw new Error(`Agent with ID ${agent.definition.id} already exists`);
    }
    this.agents.set(agent.definition.id, agent);
  }

  get(id: string): ExecutableAgent | undefined {
    return this.agents.get(id);
  }

  list(): ExecutableAgent[] {
    return Array.from(this.agents.values());
  }
}
