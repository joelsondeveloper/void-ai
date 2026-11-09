import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { voiceTests } from "./voice-scenarios.mjs";

let server, browser, directory, base;
const captures = process.env.VOID_WEB_SCREENSHOTS;
before(async () => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  base = "http://127.0.0.1:" + port;
  directory = mkdtempSync(join(tmpdir(), "void-browser-"));
  if (captures) mkdirSync(captures, { recursive: true });
  server = spawn(process.execPath, ["--import", "tsx", "web/server.mjs"], {
    env: { ...process.env, VOID_WEB_PORT: String(port), VOID_WEB_DB: join(directory, "history.sqlite"),
      VOID_WEB_MAX_CALLS: "2", NEXT_TELEMETRY_DISABLED: "1",
      OPENROUTER_API_KEY: "", ELEVENLABS_API_KEY: "", VOID_ELEVENLABS_TTS: "0" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Servidor web indisponível: " + output)), 25_000);
    const append = (chunk) => {
      output += chunk.toString();
      if (output.includes("VOID MOCK —")) { clearTimeout(timer); resolve(); }
    };
    server.stdout.on("data", append);
    server.stderr.on("data", append);
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
  });
  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const executablePath = process.env.VOID_BROWSER_EXECUTABLE || (process.platform === "win32" && existsSync(edge) ? edge : undefined);
  browser = await chromium.launch({ executablePath });
});

after(async () => {
  await browser?.close();
  if (server?.exitCode === null && !server.signalCode) {
    const closed = once(server, "exit");
    server.kill();
    await closed;
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function open(t, viewport, setup) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  t.after(() => context.close());
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });
  t.after(() => assert.deepEqual(failures, [], "browser errors"));
  await setup?.(page);
  await page.goto(base);
  await page.getByLabel("Estado do sistema").getByText("MOCK").waitFor();
  return page;
}

function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth &&
    [...document.querySelectorAll(".deck, .focus-pane, .workspace")].every((node) => node.scrollWidth <= node.clientWidth + 1));
}

test("usage panel separates remote quotas and local voice caps, including on mobile", { timeout: 30_000 }, async (t) => {
  let reads = 0;
  const page = await open(t, { width: 320, height: 740 }, (page) =>
    page.route("**/api/provider-usage", async (route) => {
      assert.equal(route.request().method(), "POST");
      reads++;
      await route.continue();
    }));
  const openUsage = page.getByRole("button", { name: "Uso", exact: true });
  await openUsage.click();
  const panel = page.getByRole("dialog", { name: "Uso e limites" });
  await panel.getByRole("article", { name: "OpenRouter" }).getByText("Desconhecido", { exact: true }).first().waitFor();
  const voice = panel.getByRole("article", { name: "ElevenLabs" });
  await voice.getByText("Chave ausente").waitFor();
  await voice.getByText(/Modelos/).click();
  await voice.getByText("eleven_flash_v2_5", { exact: true }).waitFor();
  const caps = panel.getByRole("article", { name: "Limites internos de voz" });
  await caps.getByText("6.000", { exact: true }).first().waitFor();
  await caps.getByText(/2\.000 caracteres por resposta/).waitFor();
  assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
  assert.equal(await noOverflow(page), true);
  await panel.getByRole("button", { name: "Atualizar" }).click();
  await panel.getByRole("button", { name: "Atualizar" }).and(page.locator(":enabled")).waitFor();
  assert.equal(reads, 2);
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
});

test("desktop · stop an active turn before a plan exists", { timeout: 30_000 }, async (t) => {
  const page = await open(t, { width: 1440, height: 900 });
  const field = page.getByRole("textbox", { name: "Mensagem para o VOID" });
  await field.fill("Explique concorrência e paralelismo.");
  await field.press("Enter");
  await page.getByRole("button", { name: "Parar", exact: true }).click();
  await page.getByText("A solicitação foi cancelada.", { exact: true }).waitFor();
  assert.equal(await page.locator(".assistant-message").count(), 0);
  await page.reload();
  await page.getByText("A solicitação foi cancelada.", { exact: true }).waitFor();
});

test("desktop · direct answer, staged progress, approval after reload, and original results", { timeout: 60_000 }, async (t) => {
  const page = await open(t, { width: 1440, height: 900 });
  const conversation = page.getByRole("region", { name: "Conversa" });
  const field = page.getByRole("textbox", { name: "Mensagem para o VOID" });
  await page.locator('.singularity[data-state="idle"]').waitFor();
  if (captures) await page.screenshot({ path: join(captures, "void-focus.png") });
  await page.getByRole("button", { name: /Resposta direta/ }).click();
  await field.press("Shift+Enter");
  assert.ok((await field.inputValue()).endsWith("\n"));
  await field.press("Enter");
  await conversation.getByText(/Paralelismo é executá-las/).waitFor();
  await page.locator('.singularity[data-state="completed"]').waitFor();
  assert.equal(await page.getByRole("region", { name: "Workspace" }).count(), 0);

  await page.getByLabel("Esforço").selectOption("medium");
  await field.fill("Analise a função TypeScript e compare alternativas.");
  await field.press("Enter");
  await page.locator('.singularity[data-state="processing"]').waitFor();
  await conversation.getByText(/Vou examinar a parte técnica/).waitFor();
  await conversation.getByText("Já recebi um resultado da análise.").waitFor();
  assert.equal(await conversation.getByText(/dev-agent iniciou a etapa/).count(), 0);
  assert.equal(await conversation.locator(".assistant-message").count(), 2);
  await page.getByRole("button", { name: "Ver execução" }).click();
  await page.getByText("Limite de chamadas", { exact: true }).waitFor();
  const workspace = page.getByRole("region", { name: "Workspace" });
  await workspace.getByText(/medium · 2\/2 chamadas/).waitFor();
  await workspace.getByText(/dev-agent iniciou a etapa/).waitFor();
  await workspace.getByText("Inspecionar resultado", { exact: true }).click();
  await workspace.getByText(/Análise simulada/).waitFor();
  if (captures) await page.screenshot({ path: join(captures, "void-approval.png") });

  await page.reload();
  await conversation.getByText(/Vou examinar a parte técnica/).waitFor();
  await conversation.getByRole("button", { name: "Autorizar e retomar" }).click();
  await conversation.getByText(/Comparação simulada/).waitFor();
  await page.locator('.singularity[data-state="completed"]').waitFor();
  await page.getByRole("button", { name: "Ver execução" }).click();
  assert.equal(await workspace.getByText("Inspecionar resultado", { exact: true }).count(), 2);
  assert.equal(await conversation.getByText("Analise a função TypeScript e compare alternativas.", { exact: true }).count(), 1);
  assert.ok(await noOverflow(page));
  if (captures) await page.screenshot({ path: join(captures, "void-workspace.png") });
});

test("tablet and mobile · switch views, navigate sessions, and preserve a partial failure", { timeout: 60_000 }, async (t) => {
  const page = await open(t, { width: 820, height: 1000 });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByText("Nenhuma execução nesta sessão.").waitFor();
  assert.ok(await noOverflow(page));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Focus", exact: true }).click();
  if (captures) await page.screenshot({ path: join(captures, "void-mobile.png") });
  const field = page.getByRole("textbox", { name: "Mensagem para o VOID" });
  await field.fill("Analise esta função com falha simulada.");
  await field.press("Enter");
  await page.getByRole("button", { name: "Autorizar e retomar" }).click();
  await page.locator('.singularity[data-state="failed"]').waitFor();
  await page.getByRole("button", { name: "Ver execução" }).click();
  await page.getByText("Com falhas", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("Inspecionar resultado", { exact: true }).count(), 1);
  assert.ok(await noOverflow(page));
  await page.getByRole("button", { name: "Conversa", exact: true }).click();
  await field.waitFor();
  await page.getByRole("button", { name: "Abrir sessões" }).click();
  await page.getByRole("button", { name: "Nova sessão" }).click();
  await page.getByRole("heading", { name: "O que vamos explorar?" }).waitFor();
  await page.getByRole("button", { name: "Abrir sessões" }).click();
  await page.getByRole("button", { name: "Analise esta função com falha simulada." }).click();
  await page.locator('.singularity[data-state="failed"]').waitFor();
  assert.ok(await noOverflow(page));
});

voiceTests(test, open, assert);
