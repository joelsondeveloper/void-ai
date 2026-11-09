export interface CostAuthorizationPolicy {
  permits(providerId: string, model: string): boolean;
}

export function isFreeOpenRouterRoute(model: string): boolean {
  return model === "openrouter/free" || /^[a-z0-9_.-]+\/[a-z0-9_.-]+:free$/.test(model);
}

export function freeOnlyAuthorization(trustedLocalProviders: readonly string[] = []): CostAuthorizationPolicy {
  const local = new Set(trustedLocalProviders);
  return {
    permits(providerId, model) {
      return providerId === "openrouter" ? isFreeOpenRouterRoute(model) : local.has(providerId);
    },
  };
}
