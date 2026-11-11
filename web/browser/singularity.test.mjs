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
import { voiceInputTests } from "./voice-input-scenarios.mjs";

let server, generatedServer, generatedBase, liveServer, browser, directory, base;
const captures = process.env.VOID_WEB_SCREENSHOTS;
async function startServer(database, mode = "MOCK", maxCalls = 2) {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const base = "http://127.0.0.1:" + port;
  const args = ["--import", "tsx", "web/server.mjs"];
  if (mode === "LIVE") args.push("--live");
  const server = spawn(process.execPath, args, {
    env: { ...process.env, VOID_WEB_PORT: String(port), VOID_WEB_DB: database,
      VOID_WEB_MAX_CALLS: String(maxCalls), NEXT_TELEMETRY_DISABLED: "1",
      OPENROUTER_API_KEY: "", ELEVENLABS_API_KEY: "", VOID_ELEVENLABS_TTS: "0" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Servidor web indisponível: " + output)), 25_000);
    const append = (chunk) => {
      output += chunk.toString();
      if (output.includes("VOID " + mode + " —")) { clearTimeout(timer); resolve(); }
    };
    server.stdout.on("data", append);
    server.stderr.on("data", append);
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
  });
  return { server, base };
}

async function stopServer(server) {
  if (server?.exitCode === null && !server.signalCode) {
    const closed = once(server, "exit");
    server.kill();
    await closed;
  }
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "void-browser-"));
  if (captures) mkdirSync(captures, { recursive: true });
  ({ server, base } = await startServer(join(directory, "history.sqlite")));
  ({ server: generatedServer, base: generatedBase } = await startServer(join(directory, "generated.sqlite"), "MOCK", 5));
  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const executablePath = process.env.VOID_BROWSER_EXECUTABLE || (process.platform === "win32" && existsSync(edge) ? edge : undefined);
  browser = await chromium.launch({ executablePath });
});

after(async () => {
  await browser?.close();
  await Promise.all([stopServer(server), stopServer(generatedServer), stopServer(liveServer)]);
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function open(t, viewport, setup, url = base, mode = "MOCK") {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  t.after(() => context.close());
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (mode === "LIVE" && message.location().url.endsWith("/messages") && message.text().includes("503")) return;
    failures.push(message.text());
  });
  t.after(() => assert.deepEqual(failures, [], "browser errors"));
  await setup?.(page);
  await page.goto(url);
  await page.locator('[aria-label="Estado do sistema"]').filter({ hasText: mode }).waitFor();
  return page;
}


async function command(page, text) {
  if (await page.locator(".focus-shell").count() && !(await page.locator(".command-overlay").count())) {
    await page.keyboard.press("Control+k");
  }
  const field = page.getByRole("textbox", { name: "Mensagem para o VOID" });
  await field.fill(text);
  await page.getByRole("button", { name: "Enviar mensagem" }).and(page.locator(":enabled")).waitFor();
  await field.press("Enter");
}

test("Focus opens a generated React component, runs local interactions and reuses its version", async (t) => {
  const page = await open(t, { width: 1280, height: 800 }, undefined, generatedBase);
  const waitForPreview = () => page.waitForResponse((response) => /\/components\/[a-f0-9]{64}\/1$/.test(response.url()));
  const initialPreview = waitForPreview();
  await command(page, "Crie uma interface com um contador de expedições e um checklist de equipamentos");
  const response = await initialPreview;
  assert.equal(response.status(), 200);
  assert.match(response.headers()["content-security-policy"], /sandbox allow-scripts; default-src 'none'/);
  const dialog = page.getByRole("dialog", { name: "Expedições da equipe" });
  await dialog.waitFor();
  assert.equal(await page.locator(".focus-shell").count(), 1);
  assert.equal(await page.locator(".command-overlay").count(), 0);
  const iframe = dialog.locator("iframe");
  assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts");
  const frame = iframe.contentFrame();
  await frame.getByRole("heading", { name: "Diário de campo" }).waitFor();
  await frame.getByRole("button", { name: "Expedições: aumentar" }).click();
  await frame.getByText("1", { exact: true }).waitFor();
  const check = frame.getByRole("checkbox", { name: "Equipamento conferido" });
  await check.click();
  await frame.locator("input[type=checkbox]:checked").waitFor();
  assert.equal(await frame.locator("body").evaluate(() => self.origin), "null");
  if (captures) await page.screenshot({ path: join(captures, "void-generated-focus.png") });
  await check.press("Escape");
  await dialog.waitFor({ state: "detached" });
  const reusedPreview = waitForPreview();
  await command(page, "Reabra a janela do contador de expedições");
  assert.equal((await reusedPreview).url(), response.url());
  await frame.getByRole("heading", { name: "Diário de campo" }).waitFor();
});

test("Focus · cria uma janela com contador e reabre o componente salvo", async (t) => {
  const page = await open(t, { width: 1200, height: 800 }, undefined, generatedBase);
  await command(page, "Crie uma janela com contador");
  const dialog = page.getByRole("dialog", { name: "Contador", exact: true });
  const iframe = dialog.locator("iframe");
  const frame = iframe.contentFrame();
  await frame.getByRole("button", { name: "Contador: aumentar" }).click();
  await frame.getByText("1", { exact: true }).waitFor();
  const version = await iframe.getAttribute("src");
  assert.match(version ?? "", /\/components\/[a-f0-9]{64}\/1$/);
  if (captures) await page.screenshot({ path: join(captures, "void-contador-focus.png") });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await command(page, "Reabra a janela do contador");
  await frame.getByRole("button", { name: "Contador: aumentar" }).waitFor();
  assert.equal(await iframe.getAttribute("src"), version);
});

async function enterWorkspace(page) {
  await command(page, "modo workspace");
  await page.locator(".shell.wide").waitFor();
}

async function openWorkspace(t, viewport, setup) {
  const page = await open(t, viewport, setup);
  await enterWorkspace(page);
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
      assert.equal(route.request().method(), "GET");
      reads++;
      await route.continue();
    }));
  await command(page, "abra uso");
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

test("usage panel renders local telemetry before quota refresh and keeps it on an invalid response", { timeout: 30_000 }, async (t) => {
  const remote = Promise.withResolvers();
  const page = await open(t, { width: 1200, height: 800 }, (page) =>
    page.route("**/api/provider-usage", async (route) => {
      if (route.request().method() === "POST") {
        await remote.promise;
        await route.fulfill({ json: { error: "private provider payload" } });
        return;
      }
      const response = await route.fetch();
      const dashboard = await response.json();
      const openRouter = dashboard.providers[0];
      openRouter.account.issue = "not_checked";
      openRouter.models[0].limitEvent = { kind: "rate", at: Date.now(), retryAt: null, httpStatus: 429, apiCode: 429 };
      await route.fulfill({ response, json: dashboard });
    }));
  t.after(() => remote.resolve());
  await command(page, "abra uso");
  const panel = page.getByRole("dialog", { name: "Uso e limites" });
  const local = panel.getByRole("article", { name: "Limites internos de voz" });
  await local.waitFor();
  await panel.getByText(/Último registro.*Origem desconhecida/).waitFor();
  remote.resolve();
  await panel.getByRole("alert").getByText("Consulta de cotas · Resposta inválida da API local.").waitFor();
  assert.equal(await local.isVisible(), true);
  assert.equal(await panel.getByText(/private provider payload/).count(), 0);
});

test("desktop · stop an active turn before a plan exists", { timeout: 30_000 }, async (t) => {
  const page = await openWorkspace(t, { width: 1440, height: 900 });
  const field = page.getByRole("textbox", { name: "Mensagem para o VOID" });
  await field.fill("Explique concorrência e paralelismo.");
  await field.press("Enter");
  await page.getByRole("button", { name: "Parar", exact: true }).click();
  await page.getByText("A solicitação foi cancelada.", { exact: true }).waitFor();
  assert.equal(await page.locator(".assistant-message").count(), 0);
  await page.reload();
  await enterWorkspace(page);
  await page.getByText("A solicitação foi cancelada.", { exact: true }).waitFor();
});

test("desktop · direct answer, staged progress, approval after reload, and original results", { timeout: 60_000 }, async (t) => {
  const page = await openWorkspace(t, { width: 1440, height: 900 });
  const conversation = page.getByRole("region", { name: "Conversa" });
  const field = page.getByRole("textbox", { name: "Mensagem para o VOID" });
  await field.fill("Explique concorrência e paralelismo em programação.");
  await field.press("Shift+Enter");
  assert.ok((await field.inputValue()).endsWith("\n"));
  await field.press("Enter");
  await conversation.getByText(/Paralelismo é executá-las/).waitFor();
  await page.locator('.singularity[data-state="completed"]').waitFor();
  assert.equal(await page.getByRole("region", { name: "Workspace" }).count(), 1);

  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await page.getByLabel("Esforço").selectOption("medium");
  await page.getByRole("dialog", { name: "Configurações" }).getByRole("button", { name: "Fechar", exact: true }).click();
  await field.fill("Analise a função TypeScript e compare alternativas.");
  await field.press("Enter");
  await page.locator('.singularity[data-state="processing"]').waitFor();
  await conversation.getByText(/Vou encaminhar a análise para Dev Agent, Research Agent/).waitFor();
  await conversation.getByText("Já recebi um resultado da análise.").waitFor();
  assert.equal(await conversation.getByText(/dev-agent iniciou a etapa/).count(), 0);
  assert.equal(await conversation.locator(".assistant-message").count(), 2);
  await page.getByText("Limite de chamadas", { exact: true }).waitFor();
  const workspace = page.getByRole("region", { name: "Workspace" });
  await workspace.getByText(/medium · 2\/2 chamadas/).waitFor();
  await workspace.getByText(/dev-agent iniciou a etapa/).waitFor();
  await workspace.getByText("Inspecionar resultado", { exact: true }).click();
  await workspace.getByText(/Análise simulada/).waitFor();
  if (captures) await page.screenshot({ path: join(captures, "void-approval.png") });

  await page.reload();
  await enterWorkspace(page);
  await conversation.getByText(/Vou encaminhar a análise para Dev Agent, Research Agent/).waitFor();
  await workspace.getByRole("button", { name: "Autorizar e retomar" }).click();
  await conversation.getByText(/Comparação simulada/).waitFor();
  await page.locator('.singularity[data-state="completed"]').waitFor();
  assert.equal(await workspace.getByText("Inspecionar resultado", { exact: true }).count(), 2);
  assert.equal(await conversation.getByText("Analise a função TypeScript e compare alternativas.", { exact: true }).count(), 1);
  assert.ok(await noOverflow(page));
  if (captures) await page.screenshot({ path: join(captures, "void-workspace.png") });
});

test("tablet and mobile · switch views, navigate sessions, and preserve a partial failure", { timeout: 60_000 }, async (t) => {
  const page = await open(t, { width: 820, height: 1000 });
  await enterWorkspace(page);
  await page.getByText("Nenhuma execução nesta sessão.").waitFor();
  assert.ok(await noOverflow(page));
  await page.setViewportSize({ width: 390, height: 844 });
  const field = page.getByRole("textbox", { name: "Mensagem para o VOID" });
  await command(page, "Analise esta função com falha simulada.");
  await page.getByRole("button", { name: "Operações", exact: true }).click();
  await page.getByRole("button", { name: "Autorizar e retomar" }).click();
  await page.getByText("Com falhas", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("Inspecionar resultado", { exact: true }).count(), 1);
  assert.ok(await noOverflow(page));
  await page.getByRole("button", { name: "Conversa", exact: true }).click();
  await field.waitFor();
  await page.getByRole("button", { name: "Abrir sessões" }).click();
  await page.getByRole("complementary", { name: "Sessões" }).locator(".new-session").click();
  await page.getByRole("heading", { name: "O que vamos explorar?" }).waitFor();
  await page.getByRole("button", { name: "Abrir sessões" }).click();
  await page.getByRole("button", { name: "Analise esta função com falha simulada." }).click();
  await page.locator('.singularity[data-state="failed"]').waitFor();
  assert.ok(await noOverflow(page));
});

voiceTests(test, openWorkspace, assert, enterWorkspace);
voiceInputTests(test, openWorkspace, assert, command);

test("Focus · ring only, real windows, drag, resize, maximize, minimize, and Workspace by command", { timeout: 50_000 }, async (t) => {
  const page = await open(t, { width: 1440, height: 900 });
  const focus = page.locator(".focus-orbit .singularity");
  const field = page.getByRole("textbox", { name: "Mensagem para o VOID" });
  const dialog = page.getByRole("dialog");
  const settings = page.getByRole("dialog", { name: "Configurações" });
  await focus.waitFor();
  assert.equal(await page.locator(".topbar, .sidebar, .messages, .composer, .menu").count(), 0);
  const ring = await focus.boundingBox();
  assert.ok(ring.width >= 500);
  assert.equal(ring.x + ring.width / 2, 720);
  assert.equal(ring.y + ring.height / 2, 450);
  if (captures) await page.screenshot({ path: join(captures, "void-focus.png") });

  await page.getByRole("button", { name: "Abrir comando de texto e voz" }).click();
  await field.waitFor();
  assert.ok(await page.getByRole("button", { name: "Clique para falar" }).isVisible());
  await command(page, "abra configurações");
  await settings.getByRole("checkbox", { name: "Modo mãos livres" }).waitFor();
  assert.equal(await field.count(), 0);
  assert.equal(await settings.evaluate((node) => document.activeElement === node), true);
  const original = await settings.boundingBox();
  const heading = await settings.getByRole("heading", { name: "Configurações" }).boundingBox();
  await page.mouse.move(heading.x + 110, heading.y + 18);
  await page.mouse.down();
  await page.mouse.move(heading.x + 200, heading.y + 63, { steps: 5 });
  await page.mouse.up();
  const moved = await settings.boundingBox();
  assert.equal(moved.x, original.x + 90);
  assert.equal(moved.y, original.y + 45);
  await page.mouse.move(moved.x + moved.width - 4, moved.y + moved.height - 4);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width + 76, moved.y + moved.height + 36, { steps: 5 });
  await page.mouse.up();
  const resized = await settings.boundingBox();
  assert.equal(resized.width, moved.width + 80);
  assert.equal(resized.height, moved.height + 40);
  if (captures) await page.screenshot({ path: join(captures, "void-settings-window.png") });

  await settings.getByRole("button", { name: "Maximizar", exact: true }).click();
  assert.deepEqual(await settings.boundingBox(), { x: 0, y: 0, width: 1440, height: 900 });
  await settings.getByRole("button", { name: "Restaurar tamanho" }).click();
  assert.deepEqual(await settings.boundingBox(), resized);
  await settings.getByRole("button", { name: "Minimizar" }).click();
  await settings.waitFor({ state: "hidden" });
  assert.ok(await focus.isVisible());
  await page.getByRole("button", { name: "Restaurar Configurações" }).click();
  await settings.waitFor();
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });

  await command(page, "abra sessões");
  await page.getByRole("dialog", { name: "Sessões" }).locator(".new-session").waitFor();
  await command(page, "mostre operações");
  await dialog.getByText("Nenhuma execução nesta sessão.").waitFor();
  assert.equal(await dialog.count(), 1);
  await dialog.getByRole("button", { name: "Fechar", exact: true }).click();

  await enterWorkspace(page);
  assert.ok(await page.locator(".topbar").isVisible());
  assert.equal(await page.locator(".assistant-message, .user-message").count(), 0);
  await command(page, "voltar ao focus");
  await focus.waitFor();
  assert.equal(await page.locator(".topbar, .sidebar, .messages, .composer").count(), 0);
});

test("Focus · narrow viewport clamps the window and renders the validated display", { timeout: 30_000 }, async (t) => {
  const page = await open(t, { width: 390, height: 844 });
  if (captures) await page.screenshot({ path: join(captures, "void-mobile.png") });
  await command(page, "Exibir " + JSON.stringify({ title: "Saldo", blocks: [
    { kind: "card", title: "Total", value: 8 },
    { kind: "table", title: "Movimentos", columns: ["Mês", "Valor"], rows: [["Março", 8]] },
    { kind: "bar_chart", title: "Variação", points: [{ label: "Março", value: -2 }] },
  ] }));
  const display = page.getByRole("dialog", { name: "Visualização" });
  await display.getByRole("table", { name: "Movimentos" }).waitFor();
  await display.getByText("Variação").waitFor();
  await display.getByText("Total").waitFor();
  await page.setViewportSize({ width: 320, height: 580 });
  await page.waitForFunction(() => {
    const rect = document.querySelector(".floating-window").getBoundingClientRect();
    return rect.right <= innerWidth && rect.bottom <= innerHeight;
  });
  assert.ok(await noOverflow(page));
  if (captures) await page.screenshot({ path: join(captures, "void-mobile-window.png") });
  await page.reload();
  await page.locator(".focus-orbit .singularity").waitFor();
  assert.equal(await display.count(), 0);
});

test("LIVE without a provider rejects semantic chat dispatch", { timeout: 45_000 }, async (t) => {
  const live = await startServer(join(directory, "live.sqlite"), "LIVE");
  liveServer = live.server;
  const page = await open(t, { width: 1200, height: 800 }, undefined, live.base, "LIVE");
  const unavailable = page.waitForResponse(response => response.request().method() === "POST" &&
    response.url().endsWith("/messages"));
  await command(page, "Abra as configurações.");
  assert.equal((await unavailable).status(), 503);
  assert.equal(await page.getByRole("dialog", { name: "Configurações" }).count(), 0);
});
