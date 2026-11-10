import type { DisplaySchema } from "./ui-contracts.js";

export const renderCapability = "ui-render";
export const authorCapability = "ui-author";
export const previewPermission = "isolated-preview";

export interface RenderRequest {
  brief: string;
  key?: string;
  display?: DisplaySchema;
  revise?: boolean;
}

export interface ComponentRef {
  id: string;
  version: number;
}

export interface GeneratedWindow {
  title: string;
  component: ComponentRef;
}

export interface ComponentDraft {
  title: string;
  source: string;
  compiled: string;
}

export function isGeneratedWindow(value: unknown): value is GeneratedWindow {
  if (!value || typeof value !== "object" || !("title" in value) || !("component" in value) ||
      Object.keys(value).length !== 2 || typeof value.title !== "string" || !value.title.trim() ||
      value.title.length > 120) return false;
  const ref = value.component;
  return !!ref && typeof ref === "object" && Object.keys(ref).length === 2 &&
    "id" in ref && typeof ref.id === "string" && /^[a-f0-9]{64}$/.test(ref.id) &&
    "version" in ref && typeof ref.version === "number" && Number.isSafeInteger(ref.version) && ref.version > 0;
}
