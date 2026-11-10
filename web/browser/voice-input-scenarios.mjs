export function mockInput() {
  const mock = { level: 0, pending: "", live: 0, spoken: [], recognition: null, requests: 0, starts: 0,
    permission: sessionStorage.getItem("mic-test-permission") ?? "prompt",
    pack: sessionStorage.getItem("mic-test-pack") ?? "available", deferred: false, audioError: sessionStorage.getItem("mic-test-audio-error") === "on",
    captureError: "", localFailure: "" };
  window.inputMock = mock;
  navigator.permissions.query = async () => ({ state: mock.permission });
  navigator.mediaDevices.getUserMedia = async () => {
    mock.requests++;
    if (mock.deferred) await new Promise((resolve, reject) => { mock.grant = resolve; mock.reject = reject; });
    if (mock.captureError) throw new DOMException("", mock.captureError);
    mock.permission = "granted";
    sessionStorage.setItem("mic-test-permission", "granted");
    mock.live++;
    const track = Object.assign(new EventTarget(), { readyState: "live", stop() { this.readyState = "ended"; mock.live--; } });
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  };
  window.AudioContext = class {
    state = "running";
    resume() { return mock.audioError ? Promise.reject(new DOMException("", "NotAllowedError")) : Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { getFloatTimeDomainData: (samples) => samples.fill(mock.level) }; }
  };
  window.SpeechRecognition = class {
    processLocally = false;
    static available() { return Promise.resolve(mock.pack); }
    start(track) {
      if (this.lang !== "pt-BR" || (this.processLocally ? track?.readyState !== "live" : track !== undefined)) throw new Error("unexpected STT input");
      mock.recognition = this;
      mock.starts++;
      if (this.processLocally && mock.localFailure) this.onerror?.({ error: mock.localFailure });
      else this.onstart?.();
    }
    stop() {
      const transcript = mock.pending;
      mock.pending = "";
      const event = { resultIndex: 0, results: [{ isFinal: true, 0: { transcript } }] };
      this.onresult?.(event);
      this.onresult?.(event);
      this.onend?.();
    }
    abort() { if (mock.recognition === this) mock.recognition = null; }
  };
}

// Replace browser audio APIs only. Messages and snapshots use the real MOCK server.
export function voiceInputTests(test, open, assert, command) {
  test("microphone · manual and local wake, VAD, playback guard, idle expiry and privacy", { timeout: 30_000 }, async (t) => {
    const sent = [];
    const page = await open(t, { width: 390, height: 844 }, async (page) => {
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/messages") && request.postDataJSON().source === "voice") sent.push(request.postDataJSON());
      });
      await page.addInitScript(mockInput);
      await page.addInitScript(() => {
        localStorage.setItem("void:voice-pause", "0.5");
        localStorage.setItem("void:voice-idle", "1");
        const engine = new EventTarget();
        engine.getVoices = () => [{ name: "Daniel", lang: "pt-BR", voiceURI: "daniel", localService: true }];
        engine.speak = (utterance) => { window.inputMock.spoken.push(utterance); utterance.onstart?.(); };
        engine.cancel = () => {};
        Object.defineProperty(window, "speechSynthesis", { configurable: true, value: engine });
        window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      });
    });

    const mic = page.getByRole("region", { name: "Conversa" });
    const live = () => page.evaluate(() => window.inputMock.live);
    const talk = async (text) => {
      await page.evaluate((text) => Object.assign(window.inputMock, { pending: text, level: 0.1 }), text);
      await page.clock.runFor(160);
      await page.evaluate(() => { window.inputMock.level = 0; });
      await page.clock.runFor(600);
    };
    const finishAudio = async () => {
      await page.locator('.singularity[data-voice="speaking"]').waitFor();
      assert.equal(await live(), 0);
      await page.evaluate(() => window.inputMock.spoken.at(-1).onend());
      await page.locator('.singularity[data-voice="idle"]').waitFor();
    };

    await page.clock.install();
    assert.equal(await live(), 0);
    await mic.getByRole("button", { name: "Clique para falar" }).click();
    await mic.getByText("Escutando · fale agora").waitFor();
    await talk("Olá pelo microfone");
    await mic.getByText("Olá pelo microfone", { exact: true }).waitFor();
    await finishAudio();
    assert.deepEqual(sent.map(({ message, source }) => [message, source]), [["Olá pelo microfone", "voice"]]);

    await mic.getByRole("button", { name: "Permitir microfone" }).click();
    await mic.getByText(/diga “VOID”/).waitFor();
    await talk("isso é conversa de fundo");
    assert.equal(sent.length, 1);
    await talk("VOID");
    await mic.getByText("Escutando · fale agora").waitFor();
    assert.equal(sent.length, 1);
    await talk("Pode continuar");
    await mic.getByText("Pode continuar", { exact: true }).waitFor();
    await page.locator('.singularity[data-voice="speaking"]').waitFor();
    await talk("áudio do próprio VOID");
    assert.equal(await live(), 0);
    assert.equal(sent.length, 2);
    await page.evaluate(() => { window.inputMock.pending = ""; });
    await finishAudio();
    await page.clock.runFor(500);
    await mic.getByText("Escutando · fale agora").waitFor();
    await page.clock.fastForward(61_000);
    await mic.getByText(/diga “VOID”/).waitFor();
    await talk("VOID, diga olá");
    await mic.getByText("diga olá", { exact: true }).waitFor();
    const requestsBeforeResume = await page.evaluate(() => window.inputMock.requests);
    await page.evaluate(() => { window.inputMock.permission = "prompt"; });
    await finishAudio();
    await page.clock.runFor(500);
    await mic.getByText(/Clique para retomar a escuta/).waitFor();
    assert.equal(await page.evaluate(() => window.inputMock.requests), requestsBeforeResume);
    await mic.getByRole("button", { name: "Detalhes de áudio" }).click();
    await page.getByRole("dialog", { name: "Configurações" }).getByText(/Clique para retomar a escuta/).waitFor();
    await page.getByRole("dialog", { name: "Configurações" }).getByRole("button", { name: "Fechar", exact: true }).click();
    await mic.getByRole("button", { name: "Retomar escuta" }).click();
    await mic.getByText(/diga “VOID”/).waitFor();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await mic.getByText("Microfone desligado", { exact: true }).waitFor();
    assert.equal(await live(), 0);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await mic.getByText(/Escuta local · diga/).waitFor();
    assert.equal(await live(), 1);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await mic.getByText("Microfone desligado", { exact: true }).waitFor();
    assert.equal(await live(), 0);
    assert.deepEqual(sent.map(({ message }) => message), ["Olá pelo microfone", "Pode continuar", "diga olá"]);
  });

  test("microphone · checks and installs the local pack before asking for microphone access", { timeout: 15_000 }, async (t) => {
    const page = await open(t, { width: 390, height: 844 }, (page) => page.addInitScript(() => {
      window.pack = "downloadable";
      window.micRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        window.micRequests++;
        throw new DOMException("", "NotAllowedError");
      };
      window.SpeechRecognition = class {
        processLocally = false;
        static available() { return Promise.resolve(window.pack); }
        static install() { window.pack = "downloading"; return Promise.resolve(false); }
      };
    }));
    const manual = page.getByRole("button", { name: "Clique para falar" });
    const settings = page.getByRole("dialog", { name: "Configurações" });
    assert.equal(await manual.isDisabled(), true);
    await page.getByRole("button", { name: "Configurar microfone" }).click();
    const install = settings.getByRole("button", { name: "Instalar reconhecimento pt-BR" });
    await install.waitFor();
    assert.equal(await page.evaluate(() => window.micRequests), 0);
    await install.click();
    const verify = settings.getByRole("button", { name: "Verificar reconhecimento pt-BR" });
    await verify.waitFor();
    await page.evaluate(() => { window.pack = "available"; });
    await verify.click();
    await verify.waitFor({ state: "hidden" });
    await page.getByRole("dialog", { name: "Configurações" }).getByRole("button", { name: "Fechar", exact: true }).click();
    await page.getByRole("button", { name: "Permitir microfone" }).click();
    await page.getByRole("button", { name: "Detalhes de áudio" }).click();
    await settings.getByText(/acesso ao microfone foi recusado/).waitFor();
    await page.getByRole("dialog", { name: "Configurações" }).getByRole("button", { name: "Fechar", exact: true }).click();
    assert.equal(await page.evaluate(() => window.micRequests), 1);
    assert.equal(await page.getByRole("textbox", { name: "Mensagem para o VOID" }).isEnabled(), true);
  });

  test("microphone · explicit first run, granted reload, gesture retry and persistent opt-out", { timeout: 30_000 }, async (t) => {
    const page = await open(t, { width: 320, height: 740 }, (page) => page.addInitScript(mockInput));
    const setup = page.getByRole("button", { name: "Permitir microfone" });
    const resume = page.getByRole("button", { name: "Retomar escuta" });
    const focus = page.getByRole("dialog", { name: "Configurações" }).getByRole("button", { name: "Fechar", exact: true });
    const settings = page.getByRole("dialog", { name: "Configurações" });
    const openSettings = () => command(page, "abra configurações");
    const voice = page.locator(".voice-indicator");
    const wake = voice.getByText(/Escuta local · diga/);
    const live = () => page.evaluate(() => window.inputMock.live);
    const requests = () => page.evaluate(() => window.inputMock.requests);

    await setup.waitFor();
    assert.equal(await requests(), 0);
    assert.equal(await page.getByRole("button", { name: /Iniciar escuta mãos livres|Encerrar escuta/ }).count(), 0);
    assert.equal(await page.getByRole("slider").count(), 0);
    await openSettings();
    await settings.waitFor();
    const preference = settings.getByRole("checkbox", { name: "Modo mãos livres" });
    assert.equal(await preference.isChecked(), true);
    assert.equal(await settings.getByRole("checkbox", { name: "Ativar voz" }).isChecked(), true);
    assert.equal(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await settings.getByRole("slider", { name: /Pausa entre falas/ }).press("ArrowRight");
    await settings.getByRole("slider", { name: /Inatividade/ }).press("ArrowRight");
    await focus.click();

    await page.evaluate(() => { window.inputMock.captureError = "NotAllowedError"; });
    await setup.click();
    await voice.getByText(/acesso ao microfone foi recusado/).waitFor();
    assert.equal(await live(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("void:voice-hands-free-mic")), null);
    await page.evaluate(() => { window.inputMock.captureError = ""; });
    await resume.click();
    await wake.waitFor();
    assert.equal(await live(), 1);
    assert.equal(await page.evaluate(() => localStorage.getItem("void:voice-hands-free-mic")), "granted");
    assert.equal(await setup.count() + await resume.count(), 0);

    await page.reload();
    await page.getByRole("button", { name: "Abrir comando de texto e voz" }).click();
    await wake.waitFor();
    assert.equal(await requests(), 1);
    await openSettings();
    await settings.waitFor();
    assert.equal(await live(), 0);
    await focus.click();
    await page.getByRole("button", { name: "Abrir comando de texto e voz" }).click();
    await wake.waitFor();
    await page.evaluate(() => sessionStorage.setItem("mic-test-audio-error", "on"));
    await page.reload();
    await page.getByRole("button", { name: "Abrir comando de texto e voz" }).click();
    await voice.getByText(/não conseguiu preparar o áudio/).waitFor();
    assert.equal(await requests(), 1);
    assert.equal(await live(), 0);
    await page.evaluate(() => { sessionStorage.removeItem("mic-test-audio-error"); window.inputMock.audioError = false; });
    await resume.click();
    await wake.waitFor();
    await page.evaluate(() => sessionStorage.setItem("mic-test-permission", "prompt"));
    await page.reload();
    await page.getByRole("button", { name: "Abrir comando de texto e voz" }).click();
    await resume.waitFor();
    assert.equal(await requests(), 0);
    await resume.click();
    await wake.waitFor();
    await page.evaluate(() => sessionStorage.setItem("mic-test-permission", "denied"));
    await page.reload();
    await page.getByRole("button", { name: "Abrir comando de texto e voz" }).click();
    await voice.getByText(/acesso ao microfone foi recusado/).waitFor();
    assert.equal(await requests(), 0);
    await openSettings();
    await settings.waitFor();
    await preference.uncheck();
    await page.reload();
    await page.getByRole("button", { name: "Abrir comando de texto e voz" }).click();
    await openSettings();
    await settings.waitFor();
    assert.equal(await preference.isChecked(), false);
    assert.equal(await requests(), 0);
    assert.equal(await settings.getByRole("slider", { name: /Pausa entre falas/ }).inputValue(), "1.5");
    assert.equal(await settings.getByRole("slider", { name: /Inatividade/ }).inputValue(), "6");
  });

  test("microphone · stale grants and errors, recognition abort and failure diagnostics", { timeout: 30_000 }, async (t) => {
    const page = await open(t, { width: 390, height: 844 }, (page) => page.addInitScript(mockInput));
    const setup = page.getByRole("button", { name: "Permitir microfone" });
    const wake = page.getByText(/Escuta local · diga/);
    const settings = page.getByRole("button", { name: "Configurações", exact: true });
    const focus = page.getByRole("dialog", { name: "Configurações" }).getByRole("button", { name: "Fechar", exact: true });
    await page.evaluate(() => { window.inputMock.deferred = true; });
    await setup.click();
    await settings.click();
    await focus.click();
    await page.evaluate(() => {
      window.inputMock.lateReject = window.inputMock.reject;
      window.inputMock.deferred = false;
    });
    await setup.click();
    await wake.waitFor();
    await page.evaluate(async () => {
      window.inputMock.lateReject(new DOMException("", "NotAllowedError"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(await wake.isVisible(), true);
    assert.equal(await page.evaluate(() => window.inputMock.live), 1);
    await page.evaluate(() => window.inputMock.recognition.onerror({ error: "aborted" }));
    await page.waitForFunction(() => window.inputMock.starts === 2);
    await page.evaluate(() => window.inputMock.recognition.onend());
    await page.waitForFunction(() => window.inputMock.starts === 3);
    await page.evaluate(() => window.inputMock.recognition.onerror({ error: "not-allowed" }));
    await page.getByText(/bloqueou o reconhecimento de fala local após abrir o microfone/).waitFor();
    assert.equal(await page.evaluate(() => window.inputMock.live), 0);
    await page.getByRole("button", { name: "Detalhes de áudio" }).click();
    await page.getByText(/permitido.*reconhecimento local · not-allowed/).waitFor();
    await focus.click();
    const resume = page.getByRole("button", { name: "Retomar escuta" });
    await page.evaluate(() => { window.inputMock.audioError = true; });
    await resume.click();
    await page.getByText(/não conseguiu preparar o áudio/).waitFor();
    await page.evaluate(() => Object.assign(window.inputMock, { audioError: false, deferred: true }));
    await resume.click();
    await settings.click();
    await page.evaluate(async () => {
      window.inputMock.grant();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(await page.evaluate(() => window.inputMock.live), 0);
  });

  test("microphone · policy diagnosis and opt-in browser fallback", { timeout: 25_000 }, async (t) => {
    const page = await open(t, { width: 390, height: 844 }, async (page) => {
      await page.addInitScript(mockInput);
      await page.addInitScript(() => {
        Object.defineProperty(document, "permissionsPolicy", { configurable: true, value: {
          features: () => ["on-device-speech-recognition"], allowsFeature: () => false,
        } });
      });
    });
    const setup = page.getByRole("button", { name: "Permitir microfone" });
    await setup.click();
    await page.waitForFunction(() => localStorage.getItem("void:voice-hands-free-mic") === "granted");
    await setup.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => {
      const { requests, live, starts } = window.inputMock;
      return [requests, live, starts, localStorage.getItem("void:voice-hands-free-mic")];
    }), [1, 0, 0, "granted"]);
    await page.getByRole("button", { name: "Configurar microfone" }).click();
    await page.getByText(/política desta página bloqueia o reconhecimento local/).waitFor();
    const fallback = page.getByRole("checkbox", { name: /Usar o serviço do navegador/ });
    assert.equal(await fallback.isChecked(), false);
    assert.equal(await page.evaluate(() => window.inputMock.requests), 1);
    await fallback.check();
    await page.getByRole("dialog", { name: "Configurações" }).getByRole("button", { name: "Fechar", exact: true }).click();
    await page.getByText(/Serviço do navegador · diga/).waitFor();
    await page.evaluate(() => window.inputMock.recognition.onerror({ error: "network" }));
    await page.getByText(/serviço de reconhecimento do navegador não respondeu/).waitFor();
    assert.equal(await page.evaluate(() => window.inputMock.live), 0);
  });

  test("microphone · local runtime failure falls back only after consent", { timeout: 25_000 }, async (t) => {
    const page = await open(t, { width: 390, height: 844 }, (page) => page.addInitScript(mockInput));
    await page.evaluate(() => { window.inputMock.localFailure = "service-not-allowed"; });
    await page.getByRole("button", { name: "Permitir microfone" }).click();
    await page.getByText(/bloqueou o reconhecimento de fala local/).waitFor();
    assert.equal(await page.evaluate(() => window.inputMock.starts), 1);
    await page.getByRole("button", { name: "Detalhes de áudio" }).click();
    await page.getByRole("checkbox", { name: /Usar o serviço do navegador/ }).check();
    await page.getByRole("dialog", { name: "Configurações" }).getByRole("button", { name: "Fechar", exact: true }).click();
    await page.getByRole("button", { name: "Retomar escuta" }).click();
    await page.getByText(/Serviço do navegador · diga/).waitFor();
    assert.equal(await page.evaluate(() => window.inputMock.starts), 3);
  });
}
