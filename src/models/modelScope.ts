import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelRequest, ModelResponse } from "../types/model.js";

export type ModelGate = (
  providerId: string,
  request: ModelRequest,
  dispatch: (request: ModelRequest) => Promise<ModelResponse>,
) => Promise<ModelResponse>;

const scope = new AsyncLocalStorage<ModelGate>();

export function runWithModelGate<T>(gate: ModelGate, run: () => Promise<T>): Promise<T> {
  if (scope.getStore()) throw new Error("Cannot replace an active model governance scope.");
  return scope.run(gate, run);
}

export function dispatchModel(
  providerId: string, request: ModelRequest, dispatch: (request: ModelRequest) => Promise<ModelResponse>,
): Promise<ModelResponse> {
  const gate = scope.getStore();
  return gate ? gate(providerId, request, dispatch) : dispatch(request);
}
