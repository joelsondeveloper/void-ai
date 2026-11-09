import { quota, type Account, type AccountIssue, type ProviderId } from "./provider-contracts.js";

const endpoint = {
  openrouter: "https://openrouter.ai/api/v1/key",
  elevenlabs: "https://api.elevenlabs.io/v1/user/subscription",
};
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const periods = ["daily", "weekly", "monthly", "monthly_period", "annual_period", "weekly_period"];

function period(value: unknown) {
  return typeof value === "string" && periods.includes(value) ? value : null;
}

function resetUtc(window: string | null, now: number) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  if (window === "daily") date.setUTCDate(date.getUTCDate() + 1);
  else if (window === "weekly") date.setUTCDate(date.getUTCDate() + ((8 - date.getUTCDay()) % 7 || 7));
  else if (window === "monthly") { date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 1); }
  else return null;
  return date.getTime();
}

export function emptyAccount(issue: AccountIssue | null, checkedAt: number, httpStatus: number | null = null): Account {
  return { checkedAt, httpStatus, issue, quota: null, freeRequests: null, errorCode: null,
    spend: null, dailySpend: null, freeTier: null };
}

export function createAccountReader(keys: Partial<Record<ProviderId, string>>, send: typeof fetch = fetch, now = Date.now) {
  const cached = new Map<ProviderId, { until: number; read: Promise<Account> }>();
  async function read(provider: ProviderId): Promise<Account> {
    let status: number | null = null;
    const empty = (issue: AccountIssue | null) => emptyAccount(issue, now(), status);
    const key = keys[provider]?.trim();
    if (!key) return empty("not_configured");
    try {
      const headers = provider === "openrouter" ? new Headers({ Authorization: "Bearer " + key })
        : new Headers({ "xi-api-key": key });
      const response = await send(endpoint[provider], { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(5_000) });
      status = response.status;
      if (!response.ok) {
        const issue = response.status === 401 || response.status === 403 ? "permission"
          : response.status === 429 ? "rate" : "unavailable";
        const result = empty(issue);
        if (provider === "elevenlabs" && issue === "permission") {
          const detail = object(object(await response.json().catch(() => null)).detail);
          if (detail.status === "missing_permissions") result.errorCode = detail.status;
        } else void response.body?.cancel().catch(() => {});
        return result;
      }
      const data = object(await response.json());
      const result = empty(null);
      if (provider === "openrouter") {
        const keyData = object(data.data);
        const limit = numeric(keyData.limit);
        const rawRemaining = keyData.limit_remaining;
        const remaining = typeof rawRemaining === "number" && Number.isFinite(rawRemaining) ? Math.max(0, rawRemaining) : null;
        const window = period(keyData.limit_reset);
        const spend = numeric(keyData.usage);
        const free = object(keyData.free_model_daily_requests);
        const usedRequests = numeric(free.used), maxRequests = numeric(free.limit), leftRequests = numeric(free.remaining);
        if (usedRequests !== null && maxRequests !== null && leftRequests !== null &&
            [usedRequests, maxRequests, leftRequests].every(Number.isSafeInteger) && leftRequests <= maxRequests) {
          result.freeRequests = quota(usedRequests, maxRequests, leftRequests, "daily", resetUtc("daily", result.checkedAt));
        }
        if (spend === null && limit === null && remaining === null && !result.freeRequests) return empty("invalid_response");
        result.quota = quota(limit === null || remaining === null ? null : Math.max(0, limit - remaining),
          limit, remaining, window, resetUtc(window, result.checkedAt));
        result.spend = spend === null ? null : { amount: spend, currency: "USD", scope: "key" };
        result.dailySpend = numeric(keyData.usage_daily);
        result.freeTier = typeof keyData.is_free_tier === "boolean" ? keyData.is_free_tier : null;
      } else {
        const used = numeric(data.character_count), limit = numeric(data.character_limit);
        if (used === null && limit === null) return empty("invalid_response");
        const reset = numeric(data.next_character_count_reset_unix);
        result.quota = quota(used, limit, used === null || limit === null ? null : Math.max(0, limit - used),
          period(data.character_refresh_period), reset !== null && reset <= 8.64e12 ? reset * 1000 : null);
        const overage = object(data.current_overage);
        const amount = typeof overage.amount === "string" && /^\d+(?:\.\d+)?$/.test(overage.amount)
          ? numeric(Number(overage.amount)) : numeric(overage.amount);
        if (amount !== null && typeof overage.currency === "string" && /^[a-z]{3}$/i.test(overage.currency)) {
          result.spend = { amount, currency: overage.currency.toUpperCase(), scope: "overage" };
        }
      }
      return result;
    } catch (error) {
      return empty(error instanceof Error && error.name === "TimeoutError" ? "timeout"
        : status === null ? "network" : "invalid_response");
    }
  }
  return (provider: ProviderId) => {
    const previous = cached.get(provider);
    if (previous && previous.until > now()) return previous.read;
    const pending = read(provider);
    cached.set(provider, { until: now() + 60_000, read: pending });
    return pending;
  };
}
