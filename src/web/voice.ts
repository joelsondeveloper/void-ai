import { retryAfter } from "../models/providers/retryAfter.js";
import { ProviderUsage, voiceCaps, type VoiceOutcome } from "./provider-usage.js";

const models = ["eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_turbo_v2_5"];
const maxAudio = 4 * 1024 * 1024;
const unavailable = "ElevenLabs indisponível.";

export class VoiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

async function readLimited(response: Response, max: number) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          void reader.cancel().catch(() => {});
          throw new Error("Resposta acima do limite.");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  return Buffer.concat(chunks, size);
}

export function voiceConfiguration(env: NodeJS.ProcessEnv) {
  const voice = env.ELEVENLABS_VOICE_ID?.trim() ?? "";
  const model = env.ELEVENLABS_MODEL_ID?.trim() || models[0]!;
  const key = env.ELEVENLABS_API_KEY?.trim();
  return { voice, model: models.includes(model) ? model : null, key,
    valid: !!key && /^[A-Za-z0-9_-]{1,64}$/.test(voice) && models.includes(model) };
}

export function createVoiceService(env: NodeJS.ProcessEnv, send: typeof fetch = fetch, now = Date.now,
  usage = new ProviderUsage(":memory:", now)) {
  const { voice, model, key, valid } = voiceConfiguration(env);

  return async (text: string, signal: AbortSignal) => {
    if (!valid || !model || !key) throw new VoiceError(503, "voice_not_configured", "ElevenLabs sem configuração válida.");
    if (!text || text.length > voiceCaps.perResponse) {
      throw new VoiceError(422, "voice_text_limit", "Resposta fora do limite de 2.000 caracteres para ElevenLabs.");
    }
    signal.throwIfAborted();
    const reservation = usage.reserveVoice(model, text.length);
    if (reservation.state === "cooldown") {
      throw new VoiceError(429, "voice_cooldown", "ElevenLabs em pausa após uma resposta de limite.");
    }
    if (reservation.state === "local_limit") {
      throw new VoiceError(429, "voice_usage_limit", "Limite local de geração de voz atingido.");
    }
    const outcome: VoiceOutcome = { failed: true, httpStatus: null, credits: null, limit: null, retryAt: null };
    try {
      const response = await send("https://api.elevenlabs.io/v1/text-to-speech/" + voice + "?output_format=mp3_44100_128", {
        method: "POST", redirect: "error",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model, ...(model === "eleven_multilingual_v2" ? {} : { language_code: "pt" }) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      });
      outcome.httpStatus = response.status;
      if (!response.ok) {
        let quota = false;
        try {
          const error = JSON.parse((await readLimited(response, 16_384)).toString("utf8"));
          quota = [error?.detail?.status, error?.detail?.code, error?.error?.code].includes("quota_exceeded");
        } catch { /* Only allowlisted codes are used. */ }
        if (quota || response.status === 429) {
          const time = now();
          outcome.limit = quota ? "quota" : "rate";
          outcome.retryAt = retryAfter(response.headers, time) ?? time + 5 * 60_000;
          throw new VoiceError(429, quota ? "voice_quota" : "voice_rate_limit",
            quota ? "ElevenLabs informou cota esgotada." : "ElevenLabs limitou as requisições.");
        }
        throw new VoiceError(502, "voice_provider_error", unavailable);
      }
      const credits = response.headers.get("character-cost")?.trim();
      if (credits && /^\d+(?:\.\d+)?$/.test(credits) && Number.isFinite(Number(credits))) outcome.credits = Number(credits);
      if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "audio/mpeg") {
        void response.body?.cancel().catch(() => {});
        throw new Error("Tipo de áudio inválido.");
      }
      const audio = await readLimited(response, maxAudio);
      if (!audio.length) throw new Error("Áudio vazio.");
      outcome.failed = false;
      return audio;
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      throw new VoiceError(502, "voice_provider_error", unavailable);
    } finally { usage.finishVoice(reservation.id, outcome); }
  };
}
