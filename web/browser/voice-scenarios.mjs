// Voice scenarios share the Singularity OS mock server in singularity.test.mjs.
export function voiceTests(test, open, assert) {
  test("voice · final-only playback, reconnect deduplication and immediate cancellation", { timeout: 30_000 }, async (t) => {
    const page = await open(t, { width: 1280, height: 820 }, async (page) => {
      await page.route("**/api/sessions", (route) => route.fulfill({
        json: [{ id: "one", title: "Sessão um" }, { id: "two", title: "Sessão dois" }],
      }));
      await page.addInitScript(() => {
        localStorage.setItem("void:session", "one");
        const fetch = window.fetch.bind(window);
        window.remoteVoiceCalls = [];
        window.fetch = (input, init) => {
          if (!String(input).endsWith("/voice")) return fetch(input, init);
          window.remoteVoiceCalls.push(String(input));
          return Promise.resolve(Response.json({ error: { code: "voice_quota" } }, { status: 429 }));
        };
        const sources = [];
        let sequence = 0;
        window.EventSource = class extends EventTarget {
          constructor(url) { super(); this.url = url; sources.push(this); }
          close() { this.closed = true; }
        };
        window.streamCount = () => sources.length;
        window.breakStream = () => sources.findLast((item) => !item.closed)?.onerror?.();
        window.pushSnapshot = (snapshot) => {
          const source = sources.findLast((item) => !item.closed && item.url.includes("/" + snapshot.sessionId + "/"));
          if (!source) return false;
          source.dispatchEvent(new MessageEvent("snapshot", {
            data: JSON.stringify(snapshot), lastEventId: String(++sequence),
          }));
          return true;
        };
        const spoken = [];
        window.speechMock = { spoken, cancelled: 0 };
        const engine = new EventTarget();
        engine.getVoices = () => [{ name: "Daniel", lang: "pt-BR", voiceURI: "daniel", localService: true }];
        engine.speak = (utterance) => { spoken.push(utterance); utterance.onstart?.(); };
        engine.cancel = () => { window.speechMock.cancelled++; };
        Object.defineProperty(window, "speechSynthesis", { configurable: true, value: engine });
        window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      });
    });
    page.setDefaultTimeout(8_000);

    const history = { id: "old", request: "Histórico", response: "Uma resposta anterior.", failure: null, executionId: null, model: null };
    const newTurn = { ...history, id: "new", request: "Pergunta nova", response: null };
    const final = { ...newTurn, response: "**Resposta final.** https://exemplo.com" };
    const push = async (turns, active = null, sessionId = "one") => {
      const data = { sessionId, turns, active, notices: [], executions: [] };
      await page.waitForFunction((snapshot) => window.pushSnapshot(snapshot), data);
    };
    await push([history]);
    await page.getByText(history.response, { exact: true }).waitFor();
    const toggle = page.getByRole("checkbox", { name: "Ativar voz" });
    assert.equal(await toggle.isChecked(), false);
    await toggle.check();
    const provider = page.getByLabel("Provedor de voz");
    assert.equal(await provider.inputValue(), "elevenlabs");
    await page.getByLabel(/^Voz do sistema/).selectOption("daniel");
    await page.getByRole("slider", { name: "Volume" }).press("ArrowLeft");
    await page.getByRole("slider", { name: "Velocidade" }).press("ArrowRight");
    await push([history, newTurn], { turnId: "new", executionId: null, draft: "Rascunho SSE" });
    await page.getByText("Rascunho SSE", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.speechMock.spoken.length), 0);

    await push([history, final]);
    await page.getByText(final.response, { exact: true }).waitFor();
    const ring = page.locator('.singularity[data-voice="speaking"]');
    await ring.waitFor();
    assert.deepEqual(await page.evaluate(() => window.remoteVoiceCalls), ["/api/sessions/one/messages/new/voice"]);
    assert.deepEqual(await page.evaluate(() => {
      const { voice, volume, rate } = window.speechMock.spoken[0];
      return [voice.voiceURI, volume, rate];
    }), ["daniel", 0.9, 1.05]);
    assert.equal(await ring.locator(".ring-glow").evaluate((node) => getComputedStyle(node).animationName), "none");
    await page.evaluate(() => window.breakStream());
    const streamCount = await page.evaluate(() => window.streamCount());
    await page.getByRole("button", { name: "Reconectar" }).click();
    await page.waitForFunction((previous) => window.streamCount() > previous, streamCount);
    await push([history, final]);
    assert.deepEqual(await page.evaluate(() => window.speechMock.spoken.map(({ text }) => text)), ["Resposta final."]);
    assert.equal(await page.evaluate(() => window.remoteVoiceCalls.length), 1);

    await page.getByRole("button", { name: "Parar", exact: true }).click();
    await page.locator('.singularity[data-voice="idle"]').waitFor();
    assert.equal(await page.evaluate(() => window.speechMock.cancelled), 1);
    await provider.selectOption("local");
    const replay = page.locator(".turn").filter({ hasText: "Pergunta nova" }).getByRole("button", { name: "Reproduzir resposta" });
    await replay.click();
    await ring.waitFor();
    await toggle.uncheck();
    await page.locator('.singularity[data-voice="idle"]').waitFor();
    assert.equal(await page.evaluate(() => window.speechMock.cancelled), 2);

    await toggle.check();
    await replay.click();
    await page.getByRole("button", { name: "Sessão dois", exact: true }).click();
    await push([history], null, "two");
    await page.locator('.singularity[data-voice="idle"]').waitFor();
    assert.equal(await page.evaluate(() => window.speechMock.cancelled), 3);
    assert.equal(await page.evaluate(() => window.speechMock.spoken.length), 3);
    assert.equal(await page.evaluate(() => window.remoteVoiceCalls.length), 1);
  });

  test("voice · ElevenLabs works without speech synthesis and releases audio on stop", { timeout: 30_000 }, async (t) => {
    const page = await open(t, { width: 390, height: 844 }, (page) =>
      page.addInitScript(() => {
        window.SpeechSynthesisUtterance = undefined;
        const fetch = window.fetch.bind(window);
        window.fetch = (input, init) => String(input).endsWith("/voice")
          ? Promise.resolve(new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "audio/mpeg" } }))
          : fetch(input, init);
        window.audioStops = 0;
        window.Audio = class {
          async play() { this.onplaying?.(); }
          pause() { window.audioStops++; }
          removeAttribute() {}
          load() {}
        };
      }));
    const composer = page.getByRole("textbox", { name: "Mensagem para o VOID" });
    await page.getByRole("checkbox", { name: "Ativar voz" }).check();
    const provider = page.getByLabel("Provedor de voz");
    assert.equal(await provider.inputValue(), "elevenlabs");
    assert.equal(await provider.locator('option[value="local"]').isDisabled(), true);
    await composer.fill("Explique concorrência e paralelismo.");
    await composer.press("Enter");
    await page.getByText("Falando · ElevenLabs", { exact: true }).waitFor();
    await page.locator('.singularity[data-voice="speaking"]').waitFor();
    await page.getByRole("button", { name: "Parar", exact: true }).click();
    await page.locator('.singularity[data-voice="idle"]').waitFor();
    assert.equal(await page.evaluate(() => window.audioStops), 1);
  });
}
