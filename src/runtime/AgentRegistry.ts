import type { AgentIdentity, ExecutableAgent } from "../types/agent.js";
import type { AgentOperation, OperationHandler, ModelTool } from "./AgentOperation.js";

interface RegisteredOperation {
  operation: AgentOperation<unknown, unknown>;
  tools: readonly ModelTool[];
  agentId: string;
  capability: string;
  callers: ReadonlySet<string>;
  handler: OperationHandler<never, unknown>;
}

export class AgentRegistry {
  private readonly agents: Map<string, AgentIdentity | ExecutableAgent> = new Map();

  private readonly operations = new Map<object, RegisteredOperation>();

  registerOperation<Input, Output>(
    operation: AgentOperation<Input, Output>,
    callers: readonly string[],
    handler: OperationHandler<Input, Output>,
  ): void {
    if (this.operations.has(operation)) throw new Error("Agent operation is already registered.");
    if (!this.agents.has(operation.agentId)) throw new Error("Register the operation owner first.");
    const names = new Set(Array.from(this.operations.values()).flatMap(entry => entry.tools.map(tool => tool.name)));
    for (const tool of operation.tools) {
      if (names.has(tool.name)) throw new Error("Model tool is already registered.");
      names.add(tool.name);
    }
    this.operations.set(operation, { agentId: operation.agentId, capability: operation.capability,
      callers: new Set(callers), operation: operation as unknown as AgentOperation<unknown, unknown>, tools: operation.tools, handler });
  }

  operationFor<Input, Output>(operation: AgentOperation<Input, Output>, caller: string): OperationHandler<Input, Output> | undefined {
    const registration = this.operations.get(operation);
    // Only registerOperation can associate a handler with this exact typed token.
    return registration?.callers.has(caller) ? registration.handler as OperationHandler<Input, Output> : undefined;
  }

  register(agent: AgentIdentity | ExecutableAgent) {
    if (this.agents.has(agent.definition.id)) {
      throw new Error(`Agent with ID ${agent.definition.id} already exists`);
    }
    this.agents.set(agent.definition.id, agent);
  }

  get(id: string): ExecutableAgent | undefined {
    const agent = this.agents.get(id);
    return agent && "execute" in agent ? agent : undefined;
  }

  list(): AgentIdentity[] {
    return Array.from(this.agents.values());
  }

  capabilities(): Set<string> {
    return new Set([
      ...this.list().flatMap(({ definition }) => this.get(definition.id) ? definition.capabilities : []),
      ...Array.from(this.operations.values(), ({ capability }) => capability),
    ]);
  }

  modelToolFor(name: string, caller: string, permissions: ReadonlySet<string>) {
    for (const entry of this.operations.values()) {
      const tool = entry.tools.find(tool => tool.name === name);
      if (tool && entry.callers.has(caller) && permissions.has(entry.capability)) return { tool, operation: entry.operation };
    }
    return undefined;
  }

  toolCatalog(caller: string, permissions: ReadonlySet<string>): readonly ModelTool[] {
    return Array.from(this.operations.values()).filter((entry) =>
      entry.callers.has(caller) && permissions.has(entry.capability)).flatMap((entry) => entry.tools);
  }

  catalog(caller: string, permissions: ReadonlySet<string>) {
    return this.list().flatMap(({ definition: { id, name, description, capabilities } }) => {
      const planCapabilities = this.get(id) ? capabilities.filter((capability) => permissions.has(capability)) : [];
      const operations = [...new Set(Array.from(this.operations.values()).filter((entry) =>
        entry.agentId === id && entry.callers.has(caller) && permissions.has(entry.capability))
        .map(({ capability }) => capability))];
      return planCapabilities.length || operations.length ? [{ id, name, description, planCapabilities, operations }] : [];
    });
  }
}
