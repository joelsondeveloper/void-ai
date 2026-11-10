import { uiTools } from "./ui-runtime.js";
import { AgentOperation } from "../runtime/AgentOperation.js";
import { isLocalUiToolCall, isRenderToolCall, type UiAction, type LocalUiToolCall } from "./ui-contracts.js";
import { authorCapability, renderCapability, type GeneratedWindow, type RenderRequest } from "./render-contracts.js";

export type GenerateComponent = (instructions: string, prompt: string, signal: AbortSignal) => Promise<string>;

export interface AuthorComponentRequest {
  brief: string;
  sessionId: string;
  key: string;
  previousSource?: string;
  generate: GenerateComponent;
}

export type RenderInvocation = (RenderRequest | { builtin: LocalUiToolCall }) & {
  sessionId: string;
  generate: GenerateComponent;
};

export type RenderedWindow = { response: string; action: UiAction };

export const renderWindow = new AgentOperation<RenderInvocation, RenderedWindow>("agent-renderer", renderCapability, uiTools.map(tool => ({ ...tool,
  prepare: (value, resources): RenderInvocation => {
    if (isRenderToolCall(value)) return { ...value.arguments, ...resources };
    if (isLocalUiToolCall(value)) return { builtin: value, ...resources };
    throw new Error("Invalid renderer tool.");
  },
})));

export const authorComponent = new AgentOperation<AuthorComponentRequest, GeneratedWindow>("dev-agent", authorCapability);
