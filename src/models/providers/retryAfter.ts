export function retryAfter(headers: Headers, now: number): number | null {
  const value = headers.get("retry-after")?.trim();
  if (!value) return null;
  const timestamp = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isSafeInteger(timestamp) && timestamp > now && timestamp <= 8.64e15 ? timestamp : null;
}
