// Cliente mínimo de la API de Groq (plan gratuito), con esperas automáticas
// cuando se alcanza el límite por minuto/hora.

const BASE = 'https://api.groq.com/openai/v1';
const TPM_LIMIT = 8000; // tokens por minuto del plan gratis en los modelos de texto
const MAX_WAIT_S = 15 * 60; // más que esto, mejor avisar y que se reintente después

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "7.66s", "2m59.56s", "1h2m3s" o "12" → segundos
function parseDuration(s) {
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  let total = 0, ok = false;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    ok = true;
    total += parseFloat(n) * { h: 3600, m: 60, s: 1, ms: 0.001 }[u];
  }
  return ok ? total : null;
}

export class GroqClient {
  constructor(apiKey, { onWait } = {}) {
    this.key = apiKey;
    this.onWait = onWait || (() => {});
    this.buckets = {}; // cupo estimado de tokens por minuto, uno por modelo
  }

  async request(path, init, { attempts = 6 } = {}) {
    for (let i = 0; ; i++) {
      let res;
      try {
        res = await fetch(BASE + path, {
          ...init,
          headers: { Authorization: `Bearer ${this.key}`, ...(init.headers || {}) },
        });
      } catch (e) {
        if (i >= attempts) throw new Error('No hay conexión con Groq. Revisá internet y probá de nuevo.');
        await this.wait(5 * (i + 1), 'Sin conexión, reintentando');
        continue;
      }
      if (res.ok) return res.json();

      let body = {};
      try { body = await res.json(); } catch {}
      const msg = body?.error?.message || res.statusText;

      if (res.status === 401) throw new Error('La clave de Groq no es válida. Revisala en Configuración.');
      if (res.status === 413) {
        // Groq usa 413 tanto para archivos grandes como para pedidos que superan
        // los tokens por minuto del plan gratis. En el segundo caso se reintenta más chico.
        const tooManyTokens = body?.error?.type === 'tokens' || /tokens per minute/i.test(msg);
        const err = new Error(tooManyTokens ? 'El texto enviado supera el límite gratuito por pedido.' : 'Un pedazo de audio es demasiado grande para Groq.');
        err.status = 413;
        err.tooLarge = tooManyTokens;
        throw err;
      }
      if ((res.status === 429 || res.status >= 500) && i < attempts) {
        const wait =
          parseDuration(res.headers.get('retry-after')) ??
          parseDuration(msg.match(/try again in ([\dhms.]+)/i)?.[1]) ??
          10 * (i + 1);
        if (wait > MAX_WAIT_S) {
          const mins = Math.ceil(wait / 60);
          const daily = /per day|\(RPD\)|\(TPD\)|\(ASD\)/i.test(msg);
          const err = new Error(
            daily
              ? `Se llegó al límite diario gratuito de Groq. Probá de nuevo en ${mins >= 60 ? Math.round(mins / 60) + ' h' : mins + ' min'}.`
              : `Se llegó al límite gratuito de Groq por hora. Probá de nuevo en ${mins} min.`,
          );
          err.status = 429;
          err.daily = daily;
          throw err;
        }
        await this.wait(Math.ceil(wait) + 1, res.status === 429 ? 'Límite gratuito de Groq' : 'Groq está ocupado');
        continue;
      }
      const err = new Error(`Groq respondió ${res.status}: ${msg}`);
      err.status = res.status;
      err.code = body?.error?.code;
      throw err;
    }
  }

  // Un solo temporizador largo (y no uno por segundo): si la pestaña queda en
  // segundo plano, Chrome demora mucho los temporizadores repetidos.
  async wait(seconds, reason) {
    this.onWait({ until: Date.now() + seconds * 1000, reason });
    await sleep(seconds * 1000);
    this.onWait(null);
  }

  async testKey() {
    await this.request('/models', { method: 'GET' }, { attempts: 1 });
    return true;
  }

  async transcribe(blob, { model, prompt, language = 'es' }) {
    const fd = new FormData();
    fd.append('file', blob, 'audio.wav');
    fd.append('model', model);
    fd.append('language', language);
    fd.append('temperature', '0');
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'segment');
    if (prompt) fd.append('prompt', prompt);
    return this.request('/audio/transcriptions', { method: 'POST', body: fd });
  }

  // El cupo de tokens por minuto se recarga de a poco (8000 por minuto): se estima
  // cuánto hay disponible y se espera solo lo necesario. Si igual Groq dice que no,
  // request() espera lo que Groq indique y reintenta.
  available(model) {
    const b = this.buckets[model] || { tokens: TPM_LIMIT, at: 0 };
    return Math.min(TPM_LIMIT, b.tokens + ((Date.now() - b.at) / 1000) * (TPM_LIMIT / 60));
  }

  async throttle(estimate, model) {
    const need = Math.min(estimate, TPM_LIMIT * 0.9);
    const missing = need - this.available(model);
    if (missing > 0) await this.wait(Math.ceil(missing / (TPM_LIMIT / 60)) + 1, 'Respetando el límite gratuito por minuto');
  }

  spend(tokens, model) {
    this.buckets[model] = { tokens: this.available(model) - tokens, at: Date.now() };
  }

  async chat(messages, { model, maxTokens = 3000, json = true }) {
    const chars = messages.reduce((a, m) => a + m.content.length, 0);
    const estimate = Math.round(chars / 3.2) + Math.round(maxTokens * 0.6);
    await this.throttle(estimate, model);
    const payload = {
      model,
      messages,
      temperature: 0.2,
      max_completion_tokens: maxTokens,
    };
    if (model.startsWith('openai/gpt-oss')) payload.reasoning_effort = 'low';
    if (json) payload.response_format = { type: 'json_object' };

    let data;
    try {
      data = await this.request('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // Si el modelo devolvió JSON mal formado, reintentamos sin el modo JSON estricto.
      if (json && e.status === 400 && /json/i.test(e.message)) {
        delete payload.response_format;
        data = await this.request('/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else throw e;
    }
    this.spend(data.usage?.total_tokens ?? estimate, model);
    return data.choices?.[0]?.message?.content ?? '';
  }
}
