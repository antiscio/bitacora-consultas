// Separar las voces de un audio mezclado ("quién habla") por cómo suena cada voz,
// dentro del navegador y sin mandar nada afuera. Usa WeSpeaker, un modelo de
// reconocimiento de voz (~26 MB, se descarga una sola vez y queda guardado).
// Cada frase se convierte en una "huella de voz" y las huellas se agrupan en dos.

import { SR } from './audio.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
const MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
const MAX_S = 2.5; // de cada frase alcanza con 2,5 s para reconocer la voz
const MIN_S = 1.0; // las frases más cortas se completan con el audio de alrededor

let loading = null;

// Carga el modelo (con la placa de video si hay; si no, la versión liviana).
export function loadVoiceModel() {
  if (!loading) {
    loading = (async () => {
      const T = await import(LIB);
      T.env.allowLocalModels = false;
      const processor = await T.AutoProcessor.from_pretrained(MODEL);
      let model;
      if (navigator.gpu) {
        try {
          model = await T.AutoModel.from_pretrained(MODEL, { dtype: 'fp32', device: 'webgpu' });
        } catch {}
      }
      model ||= await T.AutoModel.from_pretrained(MODEL, { dtype: 'q8' });
      return { processor, model };
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

// Huella de voz (vector normalizado) de un tramo de audio [start, end] en segundos.
export async function voiceprint(samples, start, end) {
  const { processor, model } = await loadVoiceModel();
  let a = start, b = end;
  if (b - a > MAX_S) {
    const mid = (a + b) / 2;
    a = mid - MAX_S / 2;
    b = mid + MAX_S / 2;
  } else if (b - a < MIN_S) {
    const mid = (a + b) / 2;
    a = mid - MIN_S / 2;
    b = mid + MIN_S / 2;
  }
  const total = samples.length / SR;
  a = Math.max(0, a);
  b = Math.min(total, b);
  const out = await model(await processor(samples.subarray(Math.round(a * SR), Math.round(b * SR))));
  const v = Float32Array.from(out.last_hidden_state.data);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

function centroid(vs) {
  const c = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i];
  const n = Math.sqrt(dot(c, c)) || 1;
  for (let i = 0; i < c.length; i++) c[i] /= n;
  return c;
}

// Agrupa las huellas en dos voces. Devuelve 0/1 por frase y los centros de cada grupo.
export function twoSpeakers(prints) {
  const n = prints.length;
  if (n < 2) return { labels: prints.map(() => 0), centers: prints.length ? [prints[0], prints[0]] : [] };
  // Arranque: las dos frases que menos se parecen (sobre una muestra, para que sea rápido).
  const step = Math.max(1, Math.floor(n / 300));
  let best = [0, 1], min = Infinity;
  for (let i = 0; i < n; i += step) {
    for (let j = i + 1; j < n; j += step) {
      const s = dot(prints[i], prints[j]);
      if (s < min) { min = s; best = [i, j]; }
    }
  }
  let centers = [prints[best[0]], prints[best[1]]];
  let labels = new Array(n).fill(0);
  for (let iter = 0; iter < 25; iter++) {
    const next = prints.map((p) => (dot(p, centers[0]) >= dot(p, centers[1]) ? 0 : 1));
    const changed = next.some((l, i) => l !== labels[i]);
    labels = next;
    const g0 = prints.filter((_, i) => labels[i] === 0);
    const g1 = prints.filter((_, i) => labels[i] === 1);
    if (!g0.length || !g1.length) break;
    centers = [centroid(g0), centroid(g1)];
    if (!changed && iter > 0) break;
  }
  return { labels, centers };
}

// Palabras típicas de la astróloga, para decidir cuál de las dos voces es la suya.
const ASTRO = /\b(sol|luna|mercurio|venus|marte|j[uú]piter|saturno|urano|neptuno|plut[oó]n|quir[oó]n|lilith|nodo|ascendente|medio cielo|casa|signo|tr[aá]nsito|revoluci[oó]n|retr[oó]grad\w*|conjunci[oó]n|oposici[oó]n|cuadratura|tr[ií]gono|sextil|aries|tauro|g[eé]minis|c[aá]ncer|leo|virgo|libra|escorpio|sagitario|capricornio|acuario|piscis|carta)\b/gi;

/**
 * Decide qué grupo es la astróloga.
 * Si ya se conoce su voz (de consultas anteriores), se usa esa; si no, gana
 * el grupo que más habla de astrología.
 */
export function pickAstrologer(centers, texts, labels, knownVoice) {
  if (knownVoice && knownVoice.length === centers[0].length) {
    const s0 = dot(centers[0], knownVoice);
    const s1 = dot(centers[1], knownVoice);
    if (Math.abs(s0 - s1) > 0.08) return s0 > s1 ? 0 : 1;
  }
  const score = [0, 0], words = [1, 1];
  texts.forEach((t, i) => {
    score[labels[i]] += (t.match(ASTRO) || []).length;
    words[labels[i]] += t.split(/\s+/).length;
  });
  return score[0] / words[0] >= score[1] / words[1] ? 0 : 1;
}
