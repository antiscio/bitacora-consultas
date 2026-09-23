// Procesamiento de audio en el navegador: decodificar, detectar voz,
// quitar silencios y partir en pedazos WAV que entren en el límite de Groq (25 MB).

export const SR = 16000; // Whisper trabaja a 16 kHz
const FRAME = 480; // 30 ms a 16 kHz
const MAX_CHUNK_S = 480; // 8 min por pedazo ≈ 15 MB en WAV (Groq acepta hasta 25 MB)
const MIN_CHUNK_S = 240;
const GAP_S = 0.4; // silencio que se deja entre tramos de voz

// Decodifica cualquier formato que entienda el navegador (m4a, mp3, webm, wav, mp4…)
// directamente a 16 kHz mono, para no gastar memoria de más.
export async function decodeToMono16k(file) {
  const data = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, SR);
  let audio;
  try {
    audio = await ctx.decodeAudioData(data);
  } catch {
    throw new Error(`No se pudo leer el audio de "${file.name}". ¿Es un archivo de audio o video válido?`);
  }
  if (audio.numberOfChannels === 1) return audio.getChannelData(0);
  const out = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i];
  }
  const k = 1 / audio.numberOfChannels;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

function frameDb(samples) {
  const n = Math.floor(samples.length / FRAME);
  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const o = f * FRAME;
    for (let i = 0; i < FRAME; i++) sum += samples[o + i] * samples[o + i];
    db[f] = 10 * Math.log10(sum / FRAME + 1e-12);
  }
  return db;
}

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// Devuelve los tramos con voz, en segundos: [{start, end}]
// mergeGapS: silencios más cortos que esto no se cortan. padS: margen alrededor de cada tramo.
export function detectSpeech(samples, { mergeGapS = 0.6, padS = 0.25 } = {}) {
  const db = frameDb(samples);
  if (db.length === 0) return [];
  const floor = percentile(db, 0.1);
  const loud = percentile(db, 0.95);
  if (loud < -60) return []; // pista prácticamente muda
  // Umbral entre el ruido de fondo y la voz; nunca a menos de 20 dB de lo más fuerte
  // (si casi no hay silencios, el "piso" es la voz misma).
  const thr = Math.min(Math.max(floor + 10, loud - 45), loud - 20);

  const fs = FRAME / SR;
  const mergeGap = Math.round(mergeGapS / fs);
  const minLen = Math.round(0.25 / fs);
  const pad = padS;

  let regions = [];
  let start = -1, lastOn = -1;
  for (let f = 0; f < db.length; f++) {
    if (db[f] > thr) {
      if (start < 0) start = f;
      else if (f - lastOn > mergeGap) {
        regions.push([start, lastOn]);
        start = f;
      }
      lastOn = f;
    }
  }
  if (start >= 0) regions.push([start, lastOn]);

  const total = samples.length / SR;
  regions = regions
    .filter(([a, b]) => b - a + 1 >= minLen)
    .map(([a, b]) => ({ start: Math.max(0, a * fs - pad), end: Math.min(total, (b + 1) * fs + pad) }));

  // unir tramos que se pisan por el margen agregado
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

// Arma un audio nuevo solo con los tramos de voz, y un mapa para volver
// del tiempo "compacto" al tiempo real de la grabación.
export function compact(samples, regions) {
  const gap = Math.round(GAP_S * SR);
  let len = 0;
  for (const r of regions) len += Math.round((r.end - r.start) * SR) + gap;
  const out = new Float32Array(len);
  const map = [];
  const gaps = []; // puntos de corte naturales (en segundos compactos)
  let pos = 0;
  for (const r of regions) {
    const a = Math.round(r.start * SR);
    const b = Math.round(r.end * SR);
    out.set(samples.subarray(a, b), pos);
    map.push({ c: pos / SR, o: r.start, d: (b - a) / SR });
    pos += b - a + gap;
    gaps.push(pos / SR - GAP_S / 2);
  }
  return { samples: out, map, gaps };
}

export function toOriginalTime(map, t) {
  let lo = 0, hi = map.length - 1, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid].c <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const m = map[idx];
  if (!m) return t;
  return m.o + Math.min(Math.max(0, t - m.c), m.d);
}

// Parte el audio compacto en pedazos de hasta 8 minutos, cortando en silencios.
export function split(samples, gaps) {
  const total = samples.length / SR;
  const cuts = [];
  let start = 0;
  while (total - start > MAX_CHUNK_S) {
    const candidates = gaps.filter((g) => g > start + MIN_CHUNK_S && g <= start + MAX_CHUNK_S);
    let cut = candidates.length ? candidates[candidates.length - 1] : quietestPoint(samples, start + MAX_CHUNK_S - 60, start + MAX_CHUNK_S);
    cuts.push(cut);
    start = cut;
  }
  const bounds = [0, ...cuts, total];
  const chunks = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = Math.round(bounds[i] * SR);
    const b = Math.round(bounds[i + 1] * SR);
    if (b - a < SR * 0.5) continue;
    chunks.push({ offset: bounds[i], samples: samples.subarray(a, b) });
  }
  return chunks;
}

function quietestPoint(samples, fromS, toS) {
  const win = Math.round(0.1 * SR);
  let best = toS, bestE = Infinity;
  for (let s = Math.round(fromS * SR); s + win < Math.round(toS * SR); s += win) {
    let e = 0;
    for (let i = 0; i < win; i++) e += samples[s + i] * samples[s + i];
    if (e < bestE) { bestE = e; best = (s + win / 2) / SR; }
  }
  return best;
}

export function toWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
