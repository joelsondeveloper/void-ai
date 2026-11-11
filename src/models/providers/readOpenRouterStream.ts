export async function readOpenRouterStream(
  response: Response, onText: (content: string) => void, onData: () => void,
): Promise<unknown> {
  if (!response.body) throw new SyntaxError("Missing OpenRouter stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", content = "";
  let model: unknown, provider: unknown, reason: unknown, usage: unknown, error: unknown;
  let hasReasoning = false;
  // Tool calls arrive as fragments keyed by index; ids and names come first, arguments stream in pieces.
  const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  const completion = () => ({ model, provider, usage, error, choices: [{ finish_reason: reason,
    message: { content, ...(hasReasoning ? { reasoning: "present" } : {}),
      ...(calls.length ? { tool_calls: calls.filter(Boolean) } : {}) } }] });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new SyntaxError("OpenRouter stream ended before [DONE]");
      onData();
      buffer += chunk.value;
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const data = buffer.slice(0, boundary.index).split(/\r?\n/)
          .filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (!data) continue;
        if (data === "[DONE]") return completion();
        const event = JSON.parse(data);
        if (!event || typeof event !== "object") throw new SyntaxError("Invalid OpenRouter event");
        const choice = event.choices?.[0];
        model = event.model ?? model;
        provider = event.provider ?? provider;
        usage = event.usage ?? usage;
        error = event.error ?? choice?.error ?? error;
        reason = choice?.finish_reason ?? reason;
        if (error) return completion();
        const delta = choice?.delta;
        hasReasoning ||= !!delta?.reasoning || !!delta?.reasoning_details?.length;
        if (Array.isArray(delta?.tool_calls)) {
          for (const fragment of delta.tool_calls) {
            const index = fragment?.index;
            if (!Number.isSafeInteger(index) || index < 0 || index > 16) throw new SyntaxError("Invalid OpenRouter tool call");
            const call = calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
            if (typeof fragment.id === "string") call.id = fragment.id;
            if (typeof fragment.function?.name === "string") call.function.name += fragment.function.name;
            if (typeof fragment.function?.arguments === "string") {
              call.function.arguments += fragment.function.arguments;
              if (call.function.arguments.length > 64_000) throw new SyntaxError("OpenRouter tool call too large");
            }
          }
        }
        if (typeof delta?.content === "string" && delta.content && reason !== "content_filter") {
          content += delta.content;
          onText(content);
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
