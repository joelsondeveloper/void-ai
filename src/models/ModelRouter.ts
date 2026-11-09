import type { ModelProvider, ModelRequest, ModelResponse } from "../types/model.js";
import { dispatchModel } from "./modelScope.js";

export class ModelRouter {
    private readonly providers: Map<string, ModelProvider> = new Map();

    constructor(providers: ModelProvider[]) {
        for (const modelProvider of providers) {
            this.providers.set(modelProvider.id, modelProvider);
        }
    }

    hasProvider(providerId: string): boolean {
        return this.providers.has(providerId);
    }

    async generate(providerId: string, request: ModelRequest): Promise<ModelResponse> {
        const provider = this.providers.get(providerId);
        if (!provider) {
            throw new Error(`Model provider ${providerId} not found`);
        }
        return dispatchModel(providerId, request, (guardedRequest) => provider.generate(guardedRequest));
    }
}
