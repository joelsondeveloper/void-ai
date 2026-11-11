export interface ModelToolSpec {
    readonly name: string;
    readonly description: string;
    /** JSON Schema for the arguments object. */
    readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelToolCall {
    readonly id: string;
    readonly name: string;
    /** Raw JSON text exactly as the model produced it. Validate before use. */
    readonly arguments: string;
}

export interface ModelMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    /** Only on assistant messages that requested tools. */
    toolCalls?: readonly ModelToolCall[];
    /** Only on tool messages: the id of the call this result answers. */
    toolCallId?: string;
}

export interface ModelRequest {
    model: string;
    messages: ModelMessage[];
    maxOutputTokens?: number;
    temperature?: number;
    responseFormat?: "json_object";
    reasoning?: ModelReasoning;
    tools?: readonly ModelToolSpec[];
    toolChoice?: "auto" | "none";
    signal?: AbortSignal;
    onText?: (content: string) => void;
    validateContent?: (content: string) => void;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelReasoning {
    readonly enabled?: false;
    readonly effort?: ReasoningEffort;
    readonly maxTokens?: number;
    readonly exclude?: boolean;
}

export interface ModelUsage {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
}

export interface ModelResponse {
    content: string;
    model: string;
    usage?: ModelUsage;
    /** Present only when the request offered tools and the model chose to call some. */
    toolCalls?: readonly ModelToolCall[];
}

export interface ModelProvider {
    readonly id: string;

    generate(request: ModelRequest): Promise<ModelResponse>;
}

export interface ModelRoute {
    readonly providerId: string;
    readonly model: string;
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
    readonly reasoning?: ModelReasoning;
}

export type ModelRoutes = Readonly<Record<string, ModelRoute>> & {
    readonly decision: ModelRoute;
    readonly synthesis: ModelRoute;
};

export interface ServedModel {
    providerId: string;
    requested: string;
    returned: string;
    role: string;
    stepId?: string;
}
