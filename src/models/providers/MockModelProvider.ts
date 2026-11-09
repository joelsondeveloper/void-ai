import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../../types/model.js";

export class MockModelProvider implements ModelProvider {
  readonly id = "mock";

  async generate(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();

    const response: ModelResponse = {
      content: "Hello, world!",
      model: request.model,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
      },
    };

    return response;
  }
}
