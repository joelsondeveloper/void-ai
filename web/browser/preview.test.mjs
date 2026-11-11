import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { compileComponent } from "../../src/web/component-compiler.ts";
import { previewDocument } from "../../src/web/component-preview.ts";

const example = `
  import React, { useState } from "react";
  function Bars({ points }) {
    return <svg aria-label="Gráfico" viewBox="0 0 100 100">
      {points.map((point, i) => <rect key={i} x={i * 12} width={10} height={point} fill="coral" />)}
    </svg>;
  }
  export default function Dashboard() {
    const [points, setPoints] = useState([10, 20]);
    const [value, setValue] = useState("30");
    return <main style={{ display: "grid", gap: 14 }}>
      <style>{".plot{max-width:24rem}@media(max-width:480px){.plot{max-width:100%}}"}</style>
      <label>Valor<input value={value} onChange={event => setValue(event.target.value)} /></label>
      <button onClick={() => setPoints([...points, Number(value)])}>Adicionar despesa</button>
      <output>{points.reduce((a, b) => a + b, 0)}</output>
      <section className="plot"><Bars points={points} /></section>
    </main>;
  }
`;

const restricted = `
  export default function Dashboard() {
    const [status, setStatus] = React.useState("pronto");
    async function check() {
      try { await fetch(globalThis.testUrl); setStatus("rede disponível"); }
      catch { setStatus(typeof document + ":" + typeof Worker); }
    }
    return <><button onClick={check}>Verificar fronteira</button>
      <button onClick={() => { for (;;) {} }}>Interromper</button>
      <output>{status}</output>
      <a href="https://example.invalid/">Navegar</a>
      <img src="https://example.invalid/x" />
      <div dangerouslySetInnerHTML={{ __html: "<b>HTML externo</b>" }} /></>;
  }
`;

test("isolated worker supports React state, events, SVG and CSS and can be terminated", { timeout: 30_000 }, async (t) => {
  let requests = 0;
  let origin;
  const server = createServer((req, res) => {
    if (req.url === "/preview" || req.url === "/restricted") {
      const source = req.url === "/preview" ? example
        : "globalThis.testUrl = " + JSON.stringify(origin + "/sensitive") + ";\n" + restricted;
      const { policy, html } = previewDocument(compileComponent("Test", source).compiled);
      res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": policy });
      res.end(html);
    } else if (req.url === "/sensitive") {
      requests++;
      res.end("should never reach the worker");
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<iframe title="preview" sandbox="allow-scripts" src="/preview"></iframe>');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  origin = "http://127.0.0.1:" + server.address().port;
  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const executablePath = process.env.VOID_BROWSER_EXECUTABLE || (process.platform === "win32" && existsSync(edge) ? edge : undefined);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin);
  const frame = page.frameLocator("iframe");
  await frame.getByText("30", { exact: true }).waitFor();
  await frame.getByRole("textbox", { name: "Valor" }).fill("45");
  await frame.getByRole("button", { name: "Adicionar despesa" }).click();
  await frame.getByText("75", { exact: true }).waitFor();
  assert.equal(await frame.locator("rect").count(), 3);
  assert.equal(await frame.locator("main main").evaluate(node => getComputedStyle(node).gap), "14px");
  assert.equal(await frame.locator("body").evaluate(() => self.origin), "null");

  await page.locator("iframe").evaluate(node => { node.src = "/restricted"; });
  await frame.getByRole("button", { name: "Verificar fronteira" }).click();
  await frame.getByText("undefined:undefined", { exact: true }).waitFor();
  assert.equal(requests, 0);
  assert.equal(await frame.locator("img,a,b").count(), 0);
  await frame.getByRole("button", { name: "Interromper" }).click();
  await frame.getByRole("alert").waitFor();
  assert.equal(await page.locator("iframe").count(), 1);
});
