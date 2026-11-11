import assert from "node:assert/strict";
import test from "node:test";
import { detectSecret, secretRefusal } from "../src/conversation/secrets.js";

// Key-shaped fixtures are assembled at runtime so no literal in this file matches a secret scanner.
const glue = (separator: string, ...parts: string[]) => parts.join(separator);
const pem = (label: string) => glue(" ", "-----BEGIN", label, "PRIVATE", "KEY-----");
const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

const openRouterKey = glue("-", "sk", "or", "v1", "0123456789abcdef0123456789abcdef");
const openAiKey = glue("-", "sk", "proj", "AbCdEfGhIjKlMnOpQrSt");
const awsKey = glue("", "AKIA", "IOSFODNN7", "EXAMPLE");
const googleKey = glue("", "AIza", "SyA1234567890", "abcdefghijklmnopqrstuv");
const stripeKey = glue("_", "sk", "live", "abcdefghijklmnopqrstuvwx");
const githubToken = glue("_", "ghp", "1234567890abcdefghijklmnopqrstuvwxyz12");
const slackToken = glue("-", "xoxb", "123456789012", "abcdefghij");
const jwt = glue(".", base64url({ alg: "HS256" }), base64url({ sub: "1234567890" }), "dozjgNryP4J3jVmNHl0w5N");
const bearer = glue(" ", "Authorization:", "Bearer", glue("", "abcdef0123456789", "abcdef"));
const hexDigest = glue("", "3f2a9c8d7e6b5a4f", "3e2d1c0b9a8f7e6d");
const mixedRun = glue("", "Zx9QwErTyUiOp1", "AsDfGh2JkLz3XcVb");

const positives: [string, string][] = [
  [`${pem("OPENSSH")}
b3BlbnNzaC1rZXktdjEAAAAA`, "chave privada"],
  [pem("RSA"), "chave privada"],
  [`minha chave da openrouter é ${openRouterKey}`, "chave de API"],
  [`OPENAI_API_KEY=${openAiKey}`, "chave de API"],
  [`aws ${awsKey}`, "chave de API"],
  [`google ${googleKey}`, "chave de API"],
  [stripeKey, "chave de API"],
  [glue(": ", "api_key", "9f8e7d6c5b4a"), "chave de API"],
  [glue("=", "token", "abcd1234efgh"), "chave de API"],
  [githubToken, "token"],
  [slackToken, "token"],
  [jwt, "token"],
  [bearer, "token"],
  ["a senha do wifi é batata123", "senha"],
  ["Senha: hunter2", "senha"],
  ["password = 'correct horse'", "senha"],
  ["minha senha do banco do brasil é 4821", "senha"],
  ["cartão 4111 1111 1111 1111 validade 12/30", "número de cartão"],
  ["5500-0000-0000-0004", "número de cartão"],
  ["meu CPF é 529.982.247-25", "CPF"],
  ["cpf 52998224725", "CPF"],
  ["CPF 111.222.333-44 (formatado, mesmo com dígito errado)", "CPF"],
  ["CNPJ da loja: 11.222.333/0001-81", "CNPJ"],
  ["cnpj 11222333000181", "CNPJ"],
  [`segredo ${hexDigest}`, "chave de API"],
  [`chave ${mixedRun}`, "chave de API"],
];

const negatives = [
  "Uso um gerenciador de senhas e troco a senha todo mês",
  "Prefere autenticação por token JWT no backend",
  "Trabalha com a API da OpenRouter e modelos gratuitos",
  "Meu CEP é 54500-000 e moro no Cabo de Santo Agostinho",
  "Meu telefone é (81) 98765-4321",
  "Nasceu em 11/11/1998 e começou a programar em 2015",
  "Usa Node 22.23.4 e TypeScript 7.0.2",
  "Gosta do pacote scikit-learn e de sk8 aos domingos",
  "Pedido número 123456 chega na sexta",
  "Esqueceu a senha ontem e teve que redefinir",
  "Quer uma chave de API própria para o Void algum dia",
  "Projeto como-configurar-o-servidor-de-producao-2024",
  "Commit 3c5a183 ativou o modo tools",
  "Prefere senhas longas, com mais de 16 caracteres",
  "O token expira em 1 hora",
];

test("credentials, card numbers and Brazilian document numbers are detected", () => {
  for (const [text, kind] of positives)
    assert.equal(detectSecret(text), kind, text);
});

test("ordinary sentences about passwords, tokens, numbers and dates are not flagged", () => {
  for (const text of negatives)
    assert.equal(detectSecret(text), undefined, text);
});

test("checksums keep random digit runs from being taken for CPF, CNPJ or cards", () => {
  assert.equal(detectSecret("protocolo 52998224726"), undefined);
  assert.equal(detectSecret("lote 11222333000182"), undefined);
  assert.equal(detectSecret("série 4111 1111 1111 1112"), undefined);
  assert.equal(detectSecret("00000000000"), undefined);
});

test("the refusal explains the kind of data and never repeats it", () => {
  const message = secretRefusal("CPF");
  assert.match(message, /um CPF/);
  assert.match(message, /nunca entram na memória/);
  assert.match(secretRefusal("senha"), /uma senha/);
  assert.match(secretRefusal("token"), /um token/);
});
