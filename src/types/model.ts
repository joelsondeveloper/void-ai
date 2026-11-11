export interface ModelMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface ModelRequest {
    model: string;
    messages: ModelMessage[];
    maxOutputTokens?: number;
    temperature?: number;
    responseFormat?: "json_object";
    reasoning?: ModelReasoning;
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
