// Accept raw JSON or exactly one complete JSON Markdown fence. Extra prose is rejected.
export function parseModelJson(content: string): unknown {
  const text = content.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  return JSON.parse(fenced?.[1] ?? text);
}
