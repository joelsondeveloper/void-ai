import { describeFailure, ExecutionError } from "../types/failure.js";
import type { ModelMessage, ModelResponse, ModelToolCall, ModelToolSpec, ModelUsage } from "../types/model.js";

/** A tool the model may call. `run` receives already-parsed JSON arguments and returns text for the model. */
export interface LoopTool {
  readonly spec: ModelToolSpec;
  /** Human label for status lines (for example the specialist's name). */
  readonly label: string;
  /** Status line shown while the tool runs. Defaults to "Usando <label>…". */
  readonly status?: string;
  /** Throw to report a failure to the model; it can recover or explain it to the user. */
  run(args: unknown, signal: AbortSignal): Promise<string>;
}

export interface ToolLoopTurn {
  readonly messages: ModelMessage[];
  readonly tools: readonly ModelToolSpec[];
  readonly toolChoice: "auto" | "none";
  readonly iteration: number;
}

export interface ToolLoopOptions {
  /** System, history and the new user message. Never mutated. */
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly LoopTool[];
  /** Upper bound on model calls. The last one is always made with tools disabled. */
  readonly maxIterations: number;
  /** Lets the caller force the final text answer earlier (for example when the call budget is nearly spent). */
  readonly forceFinal?: (iteration: number) => boolean;
  readonly maxToolCallsPerTurn?: number;
  readonly maxResultChars?: number;
  readonly signal: AbortSignal;
  generate(turn: ToolLoopTurn): Promise<ModelResponse>;
  onToolStart?(tool: LoopTool, call: ModelToolCall): void;
}

export interface ToolLoopResult {
  readonly content: string;
  readonly messages: ModelMessage[];
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: ModelUsage;
}

function failure(code: string, message: string): ExecutionError {
  return new ExecutionError({ category: "invalid_response", code, message, retryable: false });
}

function describeToolError(error: unknown, signal: AbortSignal): string {
  signal.throwIfAborted();
  // Specialist failures carry a safe, already-localized message. Anything else stays generic.
  return error instanceof ExecutionError || (error instanceof Error && error.name === "ToolInputError")
    ? error.message : describeFailure(error, signal).message;
}

export class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

/**
 * Runs the conversation as a loop: the model answers or asks for tools, the tools run (in parallel when it asks
 * for several at once) and their results go back to the model, until it produces its final text.
 * Tool failures and malformed arguments are returned to the model as results so it can recover.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const { signal, tools } = options;
  const maxCallsPerTurn = options.maxToolCallsPerTurn ?? 4;
  const maxChars = options.maxResultChars ?? 12_000;
  if (!Number.isSafeInteger(options.maxIterations) || options.maxIterations < 1) {
    throw new Error("Invalid tool loop configuration.");
  }
  const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));
  const specs = tools.map(({ spec }) => spec);
  const messages: ModelMessage[] = [...options.messages];
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  let reasoning = 0;
  let toolCalls = 0;

  const run = async (call: ModelToolCall): Promise<string> => {
    const tool = byName.get(call.name);
    if (!tool) return `Erro: a ferramenta ${call.name} não existe. Disponíveis: ${[...byName.keys()].join(", ") || "nenhuma"}.`;
    let args: unknown;
    try { args = call.arguments.trim() ? JSON.parse(call.arguments) : {}; }
    catch { return "Erro: os argumentos não são JSON válido. Envie um objeto JSON."; }
    try {
      options.onToolStart?.(tool, call);
      const output = await tool.run(args, signal);
      return output.length > maxChars ? output.slice(0, maxChars) + "\n[resultado truncado]" : output;
    } catch (error) {
      return "Erro: " + describeToolError(error, signal);
    }
  };

  for (let iteration = 0; iteration < options.maxIterations; iteration++) {
    signal.throwIfAborted();
    const last = iteration >= options.maxIterations - 1 || !!options.forceFinal?.(iteration);
    const response = await options.generate({
      messages: [...messages], tools: specs, toolChoice: last || specs.length === 0 ? "none" : "auto", iteration,
    });
    signal.throwIfAborted();
    if (response.usage) {
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      reasoning += response.usage.reasoningTokens ?? 0;
    }

    const requested = response.toolCalls;
    if (!requested?.length) {
      const content = response.content.trim();
      if (!content) throw failure("empty_reply", "O modelo terminou sem uma resposta em texto.");
      return { content, messages, iterations: iteration + 1, toolCalls,
        usage: reasoning ? { ...usage, reasoningTokens: reasoning } : usage };
    }
    if (last) throw failure("tool_loop_exhausted", "O modelo continuou pedindo ferramentas depois do limite.");

    messages.push({ role: "assistant", content: response.content, toolCalls: requested });
    // Every call id needs an answer, otherwise the provider rejects the next request. Only the first N run.
    const results = await Promise.all(requested.map((call, index) => index < maxCallsPerTurn
      ? run(call)
      : Promise.resolve(`Erro: limite de ${maxCallsPerTurn} chamadas por vez. Refaça esta chamada se ainda precisar dela.`)));
    toolCalls += Math.min(requested.length, maxCallsPerTurn);
    requested.forEach((call, index) => {
      messages.push({ role: "tool", toolCallId: call.id, content: results[index] ?? "" });
    });
  }
  throw failure("tool_loop_exhausted", "O limite de iterações terminou sem uma resposta.");
}
