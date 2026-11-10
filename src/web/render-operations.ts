import { AgentOperation } from "../runtime/AgentOperation.js";
import type { UiAction, WindowToolCall } from "./ui-contracts.js";
import { authorCapability, renderCapability, type GeneratedWindow, type RenderRequest } from "./render-contracts.js";

export type GenerateComponent = (instructions: string, prompt: string, signal: AbortSignal) => Promise<string>;

export interface AuthorComponentRequest {
  brief: string;
  sessionId: string;
  key: string;
  previousSource?: string;
  generate: GenerateComponent;
}

export type RenderInvocation = (RenderRequest | { builtin: WindowToolCall }) & {
  sessionId: string;
  generate: GenerateComponent;
};

export type RenderedWindow = { response: string; action: UiAction };

export const renderWindow = new AgentOperation<RenderInvocation, RenderedWindow>("agent-renderer", renderCapability);

export const authorComponent = new AgentOperation<AuthorComponentRequest, GeneratedWindow>("dev-agent", authorCapability);
