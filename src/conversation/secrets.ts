/**
 * Conservative detection of credentials and identity numbers that must never reach the memory store.
 * "Conservative" here means precision first: each pattern targets a well-known shape (key prefixes, PEM headers,
 * checksummed document numbers) instead of guessing from vocabulary, so ordinary sentences about passwords or
 * tokens still pass. The one deliberate exception is "senha ... é X": any value given for a password is blocked.
 */
export type SecretKind = "chave privada" | "chave de API" | "token" | "senha" | "número de cartão" | "CPF" | "CNPJ";

const patterns: readonly (readonly [SecretKind, RegExp])[] = [
  ["chave privada", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ["chave de API", /\bsk-(?:or-v1-|proj-|ant-)?[A-Za-z0-9_-]{16,}/],
  ["chave de API", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["chave de API", /\bAIza[0-9A-Za-z_-]{35}/],
  ["chave de API", /\b[rsp]k_(?:live|test)_[0-9A-Za-z]{16,}/],
  ["token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["token", /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["chave de API", /\b(?:api[_ -]?key|apikey|secret[_ -]?key|client[_ -]?secret|access[_ -]?key|chave d[ae] api|token)\s*[:=]\s*["']?[^\s"']{8,}/i],
  // "senha: x", "password = x", "minha senha do banco do brasil é x" (up to four words between).
  ["senha", /\b(?:senha|password|passwd|pwd)\b(?:\s+[\p{L}\d.-]+){0,4}?(?:\s*[:=]\s*|\s+(?:é|eh|era|is)\s+)["']?\S{3,}/iu],
];

const digits = (value: string) => value.replace(/\D/g, "");
const repeated = (value: string) => /^(\d)\1*$/.test(value);

function luhn(value: string): boolean {
  let sum = 0;
  for (let index = 0; index < value.length; index++) {
    let digit = Number(value[value.length - 1 - index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

function validCpf(value: string): boolean {
  if (value.length !== 11 || repeated(value)) return false;
  for (const length of [9, 10]) {
    let sum = 0;
    for (let index = 0; index < length; index++) sum += Number(value[index]) * (length + 1 - index);
    if ((sum * 10) % 11 % 10 !== Number(value[length])) return false;
  }
  return true;
}

function validCnpj(value: string): boolean {
  if (value.length !== 14 || repeated(value)) return false;
  for (const length of [12, 13]) {
    let sum = 0;
    for (let index = 0; index < length; index++) sum += Number(value[index]) * ((length - index - 1) % 8 + 2);
    const check = sum % 11 < 2 ? 0 : 11 - (sum % 11);
    if (check !== Number(value[length])) return false;
  }
  return true;
}

/** Long runs of random-looking characters: hex digests of 32+ or mixed-case alphanumerics of 24+. */
function highEntropy(text: string): boolean {
  for (const run of text.match(/[A-Za-z0-9]{24,}/g) ?? []) {
    if (run.length >= 32 && /^[a-f0-9]+$/i.test(run) && /\d/.test(run) && /[a-f]/i.test(run)) return true;
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && (run.match(/\d/g)?.length ?? 0) >= 3) return true;
  }
  return false;
}

/** Returns what the text appears to contain, or undefined when it looks safe to store. */
export function detectSecret(text: string): SecretKind | undefined {
  for (const [kind, pattern] of patterns) if (pattern.test(text)) return kind;
  if (highEntropy(text)) return "chave de API";
  for (const match of text.matchAll(/(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g)) {
    const formatted = /\./.test(match[0]) && /\//.test(match[0]) && /-/.test(match[0]);
    if (formatted || validCnpj(digits(match[0]))) return "CNPJ";
  }
  for (const match of text.matchAll(/(?<![\d.])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\d-])/g)) {
    const formatted = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(match[0]);
    if (formatted || validCpf(digits(match[0]))) return "CPF";
  }
  for (const match of text.matchAll(/(?<!\d)(?:\d[ .-]?){12,18}\d(?!\d)/g)) {
    const number = digits(match[0]);
    if (number.length >= 13 && number.length <= 19 && !repeated(number) && luhn(number)) return "número de cartão";
  }
  return undefined;
}

/** Message for the model. It names the kind of data, never the value. */
export function secretRefusal(kind: SecretKind): string {
  return `Não gravei: o texto parece conter ${kind === "senha" || kind === "chave privada" ? "uma " + kind : kind === "token" ? "um token" : kind === "chave de API" ? "uma chave de API" : "um " + kind}. ` +
    "Segredos e números de documento nunca entram na memória. Não repita o valor na resposta; diga ao usuário que esse tipo de dado deve ficar num gerenciador de senhas.";
}
