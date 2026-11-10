import type { AgentIdentity, ExecutableAgent } from "../types/agent.js";
import type { AgentOperation, OperationHandler } from "./AgentOperation.js";

interface RegisteredOperation {
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
    this.operations.set(operation, { agentId: operation.agentId, capability: operation.capability,
      callers: new Set(callers), handler });
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
