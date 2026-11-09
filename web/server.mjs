import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import next from "next";
import { createWebApi } from "../src/web/api.ts";
import { createWebRuntime } from "../src/web/runtime.ts";


const dev = process.argv.includes("--dev");
const live = process.argv.includes("--live");
const port = Number(process.env.VOID_WEB_PORT ?? 3030);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("VOID_WEB_PORT inválida.");
const hostname = "127.0.0.1";
const app = next({ dev, dir: resolve("web"), hostname, port, webpack: dev });
await app.prepare();
const nextRequest = app.getRequestHandler();
const key = process.env.OPENROUTER_API_KEY?.trim();
const data = resolve("web", ".data");
if (!process.env.VOID_WEB_DB) mkdirSync(data, { recursive: true });
const runtime = createWebRuntime({
  live, voiceEnv: process.env, filename: process.env.VOID_WEB_DB ?? resolve(data, live ? "void-live.sqlite" : "void-mock.sqlite"),
  ...(key ? { key } : {}),
  ...(process.env.VOID_WEB_MAX_CALLS === undefined ? {} : { maxCalls: Number(process.env.VOID_WEB_MAX_CALLS) }),
});
const api = createWebApi(runtime, () => port);
const server = createServer((request, response) => {
  const host = request.headers.host;
  if (host !== hostname + ":" + port && host !== "localhost:" + port) {
    response.writeHead(403).end("Acesso local apenas.");
    return;
  }
  if (request.url?.startsWith("/api/")) void api(request, response);
  else void nextRequest(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
server.requestTimeout = 30_000;
server.listen(port, hostname, () => console.log("VOID " + (live ? "LIVE" : "MOCK") + " — http://" + hostname + ":" + port));
