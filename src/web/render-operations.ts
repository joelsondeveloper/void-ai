import { uiTools } from "./ui-runtime.js";
import { AgentOperation, type AgentGeneration } from "../runtime/AgentOperation.js";
import { isLocalUiToolCall, isRenderToolCall, type UiAction, type LocalUiToolCall } from "./ui-contracts.js";
import { authorCapability, renderCapability, type ComponentDraft, type RenderRequest } from "./render-contracts.js";

export type GenerateComponent = AgentGeneration;

export interface AuthorComponentRequest {
  brief: string;
  previousSource?: string;
  generate?: GenerateComponent;
}

export type RenderInvocation = (RenderRequest | { builtin: LocalUiToolCall }) & {
  sessionId: string;
  generate?: GenerateComponent;
};

export type RenderedWindow = { response: string; action?: UiAction };

export const renderWindow = new AgentOperation<RenderInvocation, RenderedWindow>("agent-renderer", renderCapability, uiTools.map(tool => ({ ...tool,
  prepare: (value, resources): RenderInvocation => {
    if (isRenderToolCall(value)) return { ...value.arguments, ...resources };
    if (isLocalUiToolCall(value)) return { builtin: value, ...resources };
    throw new Error("Invalid renderer tool.");
  },
})));

export const authorComponent = new AgentOperation<AuthorComponentRequest, ComponentDraft>("dev-agent", authorCapability);
