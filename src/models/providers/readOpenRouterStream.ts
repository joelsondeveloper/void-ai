export async function readOpenRouterStream(
  response: Response, onText: (content: string) => void, onData: () => void,
): Promise<unknown> {
  if (!response.body) throw new SyntaxError("Missing OpenRouter stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", content = "";
  let model: unknown, provider: unknown, reason: unknown, usage: unknown, error: unknown;
  let hasReasoning = false;
  const completion = () => ({ model, provider, usage, error, choices: [{ finish_reason: reason,
    message: { content, ...(hasReasoning ? { reasoning: "present" } : {}) } }] });
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
