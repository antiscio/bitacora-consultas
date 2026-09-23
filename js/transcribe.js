// Convierte las pistas de audio de una consulta en una transcripción con
// quién habla y en qué momento.

import { decodeToMono16k, detectSpeech, compact, split, toWav, toOriginalTime, SR } from './audio.js';
import { loadVoiceModel, voiceprint, twoSpeakers, pickAstrologer } from './diarize.js';

// Vocabulario para que Whisper escriba bien los términos astrológicos.
const VOCAB =
  'Consulta astrológica. Carta natal, tránsitos, revolución solar, progresiones. ' +
  'Sol, Luna, Mercurio, Venus, Marte, Júpiter, Saturno, Urano, Neptuno, Plutón, Quirón, Lilith, ' +
  'Nodo Norte, Nodo Sur, Ascendente, Medio Cielo, casa, conjunción, oposición, cuadratura, trígono, sextil, ' +
  'retrógrado, eclipse, Aries, Tauro, Géminis, Cáncer, Leo, Virgo, Libra, Escorpio, Sagitario, Capricornio, Acuario, Piscis. ' +
  'Registros akáshicos, chakras, chakra sacro, constelaciones familiares, biodecodificación, tarot, Reiki.';

// Frases que Whisper "inventa" en los silencios.
const HALLUCINATIONS = [
  /amara\.org/i,
  /subt[ií]tul(os|ado)/i,
  /suscr[ií]b(ete|anse)/i,
  /gracias por (ver|mirar)/i,
  /(dale|den) like/i,
  /^[\p{P}\p{S}\s]*$/u, // solo signos
];

function keepSegment(seg) {
  const text = (seg.text || '').trim();
  if (!text) return false;
  if (HALLUCINATIONS.some((r) => r.test(text))) return false;
  if (seg.no_speech_prob > 0.6 && seg.avg_logprob < -0.7) return false;
  if (seg.compression_ratio > 2.6) return false; // frases repetidas en bucle
  return true;
}

export const ROLES = {
  astrologa: 'Astróloga',
  consultante: 'Consultante',
  ambos: 'Conversación completa',
  omitir: 'No usar',
};

/**
 * tracks: [{file, role, part}]
 * onProgress({step, detail, fraction})
 * knownVoice: huella de la voz de la astróloga guardada de consultas anteriores (o null).
 * Devuelve {turns, audioSeconds, stats, astrologerVoice, otherVoice}.
 */
export async function transcribeTracks(groq, tracks, { model, onProgress, knownVoice = null }) {
  const active = tracks.filter((t) => t.role !== 'omitir').sort((a, b) => a.part - b.part);
  if (!active.length) throw new Error('No hay audios para transcribir (todos están en "No usar").');

  const segments = [];
  const stats = [];
  let audioSeconds = 0;

  // Si hay audios con las dos voces juntas, se reconocen las voces en la compu.
  const hasMixed = active.some((t) => t.role === 'ambos');
  let voiceOk = false;
  const voiceReady = hasMixed ? loadVoiceModel().then(() => (voiceOk = true), (e) => console.warn('Sin reconocimiento de voces:', e)) : null;
  let pending = []; // frases esperando su huella de voz
  const embedPending = async () => {
    if (!pending.length) return;
    await voiceReady;
    const list = pending;
    pending = [];
    if (!voiceOk) return;
    for (const p of list) {
      try { p.seg.print = await voiceprint(p.samples, p.a, p.b); } catch {}
    }
  };

  for (let ti = 0; ti < active.length; ti++) {
    const t = active[ti];
    const label = active.length > 1 ? `Audio ${ti + 1} de ${active.length}` : 'Audio';
    const base = ti / active.length;
    const span = 1 / active.length;
    const st = { name: t.file.name, minutes: 0, speechMinutes: 0, received: 0, kept: 0 };
    stats.push(st);

    onProgress({ step: 'Preparando el audio', detail: label, fraction: base });
    let samples = await decodeToMono16k(t.file);
    const duration = samples.length / SR;
    st.minutes = +(duration / 60).toFixed(1);

    // En una conversación mezclada solo se quitan los silencios largos; en una pista
    // individual (una sola voz) se puede recortar más.
    const mixed = t.role === 'ambos';
    let regions = detectSpeech(samples, mixed ? { mergeGapS: 1.5, padS: 0.4 } : {});
    const speech = regions.reduce((a, r) => a + r.end - r.start, 0);
    if (mixed && speech < duration * 0.25) regions = [{ start: 0, end: duration }]; // no confiar: usar todo
    if (!regions.length) {
      onProgress({ step: 'Preparando el audio', detail: `${label}: no se detectó voz, se saltea.`, fraction: base + span });
      continue;
    }
    const comp = compact(samples, regions);
    samples = null; // liberar memoria
    const chunks = split(comp.samples, comp.gaps);
    audioSeconds += comp.samples.length / SR;
    st.speechMinutes = +(comp.samples.length / SR / 60).toFixed(1);

    const role = mixed ? null : t.role; // null = todavía no se sabe quién habla
    for (let ci = 0; ci < chunks.length; ci++) {
      const c = chunks[ci];
      onProgress({
        step: 'Transcribiendo',
        detail: `${label} · tramo ${ci + 1} de ${chunks.length}${mixed ? ' · reconociendo voces' : ''}`,
        fraction: base + span * (0.1 + 0.9 * (ci / chunks.length)),
      });
      // Mientras Groq transcribe este tramo, se reconocen las voces del anterior.
      const request = groq.transcribe(toWav(c.samples), { model, prompt: VOCAB });
      request.catch(() => {}); // el error se maneja abajo, al esperarlo
      await embedPending();
      const res = await request;
      for (const seg of res.segments || []) {
        st.received++;
        if (!keepSegment(seg)) continue;
        st.kept++;
        const s = {
          part: t.part,
          start: toOriginalTime(comp.map, c.offset + seg.start),
          end: toOriginalTime(comp.map, c.offset + seg.end),
          role,
          text: seg.text.trim(),
        };
        segments.push(s);
        if (mixed) pending.push({ seg: s, samples: comp.samples, a: c.offset + seg.start, b: c.offset + seg.end });
      }
    }
    onProgress({ step: 'Transcribiendo', detail: `${label} · terminando de reconocer voces`, fraction: base + span * 0.98 });
    await embedPending();
  }

  if (!segments.length) {
    const detail = stats
      .map((s) => `${s.name}: ${s.minutes} min, ${s.speechMinutes} min con voz, ${s.received} frases recibidas, ${s.kept} usadas`)
      .join(' | ');
    throw new Error(`No se entendió ninguna voz en los audios. Detalle: ${detail}`);
  }

  // Agrupar las huellas en dos voces y decidir cuál es la astróloga.
  let astrologerVoice = null, otherVoice = null;
  const withPrint = segments.filter((s) => s.print);
  if (withPrint.length >= 4) {
    const { labels, centers } = twoSpeakers(withPrint.map((s) => s.print));
    const astro = pickAstrologer(centers, withPrint.map((s) => s.text), labels, knownVoice);
    withPrint.forEach((s, i) => {
      s.role = labels[i] === astro ? 'astrologa' : 'consultante';
      s.roleSource = 'voz';
    });
    astrologerVoice = Array.from(centers[astro]);
    otherVoice = Array.from(centers[1 - astro]);
  }
  segments.forEach((s) => delete s.print);

  return { turns: toTurns(segments), audioSeconds, stats, astrologerVoice, otherVoice };
}


// Ordena por parte y tiempo, y junta frases seguidas de la misma persona.
// Si no se sabe quién habla (audio mezclado), se dejan frases cortas para que
// después el análisis pueda marcar cada una como astróloga o consultante.
function toTurns(segments) {
  segments.sort((a, b) => a.part - b.part || a.start - b.start);
  const turns = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    const gap = last ? s.start - last.end : Infinity;
    const sameBlock = s.role ? gap < 3 : gap < 0.8 && last.text.length < 280;
    if (last && last.part === s.part && last.role === s.role && sameBlock) {
      if (last.text.endsWith(s.text)) continue; // repetición exacta
      last.text += ' ' + s.text;
      last.end = Math.max(last.end, s.end);
    } else turns.push({ ...s });
  }
  return turns;
}

// Junta líneas seguidas de la misma persona (después de identificar quién habla).
export function mergeTurns(turns) {
  const out = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.part === t.part && last.role && last.role === t.role) {
      last.text += ' ' + t.text;
      last.end = Math.max(last.end, t.end);
    } else out.push({ ...t });
  }
  return out;
}

// Rol de una línea: las consultas guardadas antes tenían el nombre en "speaker".
export function roleOf(t, names) {
  if (t.role) return t.role;
  if (!t.speaker) return null;
  return t.speaker === names?.astrologa ? 'astrologa' : 'consultante';
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Líneas de la transcripción como guion: {time, role, speaker, text} o {header}.
export function transcriptLines(turns, names = { astrologa: 'Astróloga', consultante: 'Consultante' }) {
  const multiPart = new Set(turns.map((t) => t.part)).size > 1;
  const lines = [];
  let part = null;
  turns.forEach((t, idx) => {
    if (multiPart && t.part !== part) {
      part = t.part;
      lines.push({ header: `Parte ${part}` });
    }
    const role = roleOf(t, names);
    lines.push({ idx, time: fmtTime(t.start), role, speaker: role ? names[role] : null, text: t.text });
  });
  return lines;
}

export function transcriptText(turns, names) {
  return transcriptLines(turns, names)
    .map((l) => (l.header ? `\n— ${l.header} —` : `${l.speaker ? l.speaker.toUpperCase() + ': ' : ''}${l.text}`))
    .join('\n')
    .trim();
}
