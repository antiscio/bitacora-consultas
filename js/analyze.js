// Análisis de la consulta con los modelos de texto gratuitos de Groq.
// 1) Si no se sabe quién habla (audio mezclado), la IA marca cada línea
//    como astróloga o consultante, para armar la transcripción como un guion.
// 2) Un modelo grande extrae resumen, situación, astrología y fechas, por partes.
// 3) Se unen las partes: lo narrativo con IA; las listas (astrología, fechas) sin IA,
//    para no perder nada.
// Cada modelo tiene su propio cupo gratuito, así que repartir el trabajo rinde más.

import { mergeTurns, roleOf } from './transcribe.js';

// Para identificar hablantes: Qwen (tiene su propio cupo diario); si no está, el grande.
const LABEL_MODEL = 'qwen/qwen3.8-27b';
const LABEL_FALLBACK = 'openai/gpt-oss-120b';
const FALLBACK_MODEL = 'openai/gpt-oss-20b';
// Groq cuenta cada pedido como texto enviado + máximo de respuesta, y el plan
// gratis rechaza los que superan 8000 tokens. Estos tamaños dejan margen.
const LABEL_CHUNK_CHARS = 6000;
const CHUNK_CHARS = 6500;
const MERGE_BUDGET_CHARS = 6000;

export const ASTRO_TYPES = ['Carta natal', 'Revolución solar', 'Tránsito', 'Progresión', 'Eclipse / lunación', 'Sinastría', 'Otro'];

const SCHEMA = `{
  "resumen": "string",
  "puntos_clave": ["string"],
  "situacion": {
    "motivo_consulta": "string",
    "estado_emocional": "string",
    "areas": [{ "area": "string", "descripcion": "string" }]
  },
  "astrologia": [{ "tipo": "string", "detalle": "string", "cuando": "string", "area": "string", "interpretacion": "string", "cita": "string" }],
  "fechas": [{ "fecha": "string", "evento": "string", "cita": "string" }],
  "recomendaciones": [{ "texto": "string", "cita": "string" }],
  "preguntas_consultante": [{ "pregunta": "string", "respuesta": "string" }],
  "seguimiento": ["string"]
}`;

const GUIDE = `Qué va en cada campo:
- puntos_clave: las ideas principales, una por ítem, concretas.
- situacion: la situación de vida del consultante. motivo_consulta = por qué vino; estado_emocional = cómo se lo percibe; areas = una entrada por cada área de vida de la que se habló (Amor y pareja, Trabajo y dinero, Familia, Salud, Vocación, Casa y mudanzas, Espiritualidad u otra), contando lo que dijo el consultante.
- astrologia: TODA mención astrológica, sin excepción, aunque sea al pasar: planetas en signos o casas, Ascendente, Medio Cielo, aspectos, tránsitos, revolución solar, progresiones, eclipses, lunaciones, nodos, retrogradaciones, Quirón, Lilith, etc.
    tipo = uno de: ${ASTRO_TYPES.map((t) => `"${t}"`).join(', ')}.
    detalle = la configuración concreta con todos sus datos (ej. "Venus en Cáncer en casa 8", "Ascendente de la revolución solar en Cáncer, sobre Venus natal", "Saturno en tránsito por la casa 10", "Luna llena en Aries").
    cuando = fecha o período SOLO si se dijo sobre ese mismo elemento; si no, "".
    area = área de vida a la que se refiere.
    interpretacion = qué dijo la astróloga sobre eso, en 1 a 3 oraciones.
    cita = la frase textual de la transcripción de donde sale (hasta 25 palabras, copiada tal cual).
    Si algo se menciona varias veces, una sola entrada que junte todo lo dicho.
- fechas: toda fecha, mes, año o período nombrado, con lo que pasa o pasó en ese momento según la conversación, y su cita textual.
- recomendaciones: SOLO los consejos, tareas o prácticas que la astróloga le dio EXPLÍCITAMENTE al consultante en la conversación. Nunca agregues consejos propios ni generales. texto = el consejo, breve; cita = la frase textual donde lo dice. Si no dio consejos, [].
- preguntas_consultante: cada pregunta concreta que hizo el consultante. pregunta = la pregunta, resumida en una línea; respuesta = qué le respondió la astróloga, en 1 o 2 oraciones (si no respondió, "").
- seguimiento: temas que quedaron abiertos o pendientes para que la astróloga retome en la PRÓXIMA consulta (lo que se dijo que se iba a ver después, lo que no se llegó a tratar). No son consejos para el consultante.

REGLAS DE FIDELIDAD (muy importantes):
- No mezcles datos de partes distintas de la conversación: una fecha, un período o un tema van con el elemento del que se habló en ese momento, no con otro.
- No agregues conocimiento astronómico propio (fechas de retrogradaciones, ingresos, posiciones de planetas): solo lo que dijo la astróloga, aunque parezca incompleto.
- Una fecha con hora exacta (ej. "26 de agosto a las 6 y 46") casi siempre es el momento exacto de la revolución solar, es decir, el cumpleaños del consultante: registralo así ("Momento de la revolución solar"), no como un evento que va a pasar.
- Los comentarios al pasar (logística, tecnología, cómo mandar el dibujo de la carta o conectarse a la llamada, no tener computadora para la videollamada, horarios de la sesión) no son temas de la consulta: no los pongas en el resumen ni en la situación, salvo que el consultante los plantee claramente como un problema de su vida.
- Si una frase quedó cortada o no se entiende (ej. "termina como a fin de a…"), no la completes adivinando: copiala como está o dejá el dato vacío.
- Si no estás seguro de qué significa algo, describilo literalmente en vez de interpretarlo.`;

function systemPrompt(ctx, resumenGuide) {
  return `Sos asistente de una astróloga profesional. Trabajás con transcripciones automáticas de sus consultas (español rioplatense), escritas como guion ("ASTRÓLOGA: …", "CONSULTANTE: …").
Ordená la información sin inventar nada: usá solo lo que está en el texto. Si algo no aparece, dejá el campo vacío ("" o []).
La transcripción puede tener errores: si un término astrológico está claramente mal transcripto, corregilo (ej. "Venus en cáncer" aunque diga "venus en cancer").
La consulta fue el ${ctx.date}. Si se menciona una fecha relativa ("el mes que viene", "este año"), agregá entre paréntesis la fecha probable.
El consultante se llama ${ctx.consultante}.${ctx.datosNacimiento ? ` Datos de nacimiento: ${ctx.datosNacimiento}.` : ''}${ctx.notas ? ` Notas de la astróloga: ${ctx.notas}` : ''}
Respondé SOLO con un objeto JSON válido con esta forma:
${SCHEMA}

- resumen: ${resumenGuide}
${GUIDE}`;
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
  }
  throw new Error('El modelo devolvió una respuesta que no se pudo leer. Probá "Volver a analizar".');
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function normalizeAstro(a) {
  const tipo = str(a?.tipo);
  return {
    tipo: ASTRO_TYPES.find((t) => t.toLowerCase() === tipo.toLowerCase()) || tipo || 'Otro',
    detalle: str(a?.detalle),
    cuando: str(a?.cuando),
    area: str(a?.area),
    interpretacion: str(a?.interpretacion),
    cita: str(a?.cita),
  };
}

// Deja el análisis con la forma esperada. Convierte análisis guardados con la
// versión anterior (transitos y carta_natal por separado).
export function normalize(r = {}) {
  const s = r.situacion || {};
  const astro = arr(r.astrologia).map(normalizeAstro);
  arr(r.carta_natal).forEach((c) => astro.push({ tipo: 'Carta natal', detalle: str(c), cuando: '', area: '', interpretacion: '' }));
  arr(r.transitos).forEach((t) => astro.push({ tipo: 'Tránsito', detalle: str(t?.transito), cuando: str(t?.periodo), area: str(t?.area), interpretacion: str(t?.interpretacion) }));
  return {
    resumen: str(r.resumen),
    puntos_clave: arr(r.puntos_clave).map(str).filter(Boolean),
    situacion: {
      motivo_consulta: str(s.motivo_consulta),
      estado_emocional: str(s.estado_emocional),
      areas: arr(s.areas).map((a) => ({ area: str(a?.area), descripcion: str(a?.descripcion) })).filter((a) => a.descripcion),
    },
    astrologia: astro.filter((a) => a.detalle),
    fechas: arr(r.fechas).map((f) => ({ fecha: str(f?.fecha), evento: str(f?.evento), cita: str(f?.cita) })).filter((f) => f.fecha || f.evento),
    // (antes eran listas de texto; se aceptan las dos formas)
    recomendaciones: arr(r.recomendaciones)
      .map((x) => (typeof x === 'string' ? { texto: str(x), cita: '' } : { texto: str(x?.texto), cita: str(x?.cita) }))
      .filter((x) => x.texto),
    preguntas_consultante: arr(r.preguntas_consultante)
      .map((x) => (typeof x === 'string' ? { pregunta: str(x), respuesta: '' } : { pregunta: str(x?.pregunta), respuesta: str(x?.respuesta) }))
      .filter((x) => x.pregunta),
    seguimiento: arr(r.seguimiento).map(str).filter(Boolean),
  };
}

// Agrupa líneas consecutivas en pedazos de hasta maxChars caracteres.
function chunkLines(lines, maxChars) {
  const chunks = [];
  let cur = [], size = 0;
  for (const l of lines) {
    if (cur.length && size + l.length > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(l);
    size += l.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Parte líneas muy largas (p. ej. transcripciones viejas sin cortes) entre oraciones.
function splitLongTurns(turns, max = 300) {
  const out = [];
  for (const t of turns) {
    let rest = t.text;
    while (rest.length > max) {
      const w = rest.slice(0, max);
      const cut = Math.max(w.lastIndexOf('. '), w.lastIndexOf('? '), w.lastIndexOf('! '));
      const at = cut > max * 0.4 ? cut + 2 : Math.max(1, w.lastIndexOf(' ') + 1);
      out.push({ ...t, text: rest.slice(0, at).trim() });
      rest = rest.slice(at);
    }
    if (rest.trim()) out.push({ ...t, text: rest.trim() });
  }
  return out;
}

// Si se terminó el cupo diario de un modelo (o Groq lo dio de baja), probar con el siguiente.
async function chat(groq, messages, { model, maxTokens, fallbacks = [FALLBACK_MODEL] }) {
  const models = [model, ...fallbacks.filter((m) => m !== model)];
  for (let i = 0; ; i++) {
    try {
      return await groq.chat(messages, { model: models[i], maxTokens });
    } catch (e) {
      const unavailable = e.daily || e.status === 404 || e.code === 'model_not_found' || e.code === 'model_decommissioned';
      if (!unavailable || i === models.length - 1) throw e;
    }
  }
}

// ---------- 1) Quién habla ----------
const LABEL_SYS = `Vas a leer la transcripción automática de una consulta astrológica entre dos personas: una astróloga (A) y un consultante (C). No dice quién habla. Indicá quién dice cada línea numerada.
Pistas: la astróloga explica la carta natal, planetas, signos, casas, tránsitos y revolución solar, pregunta para orientar la lectura, interpreta y aconseja. El consultante cuenta su vida y sus dudas, pregunta y reacciona. En una conversación los turnos se alternan seguido: una pregunta suele ir seguida de la respuesta de la otra persona, y las respuestas cortas ("sí", "claro", "ajá", "mirá vos") suelen ser de quien está escuchando. Si una línea mezcla a los dos, elegí a quien dice la mayor parte.
Decidí línea por línea. Respondé SOLO con JSON: {"hablantes": "1A 2C 3C 4A …"}, con TODAS las líneas numeradas, en orden.`;

export async function labelChunk(groq, lines, offset, context, model = LABEL_MODEL) {
  const numbered = lines.map((t, i) => `[${offset + i + 1}] ${t.text}`).join('\n');
  const ctxText = context.length ? `Contexto (líneas anteriores, ya identificadas):\n${context.join('\n')}\n\n` : '';
  const content = await chat(groq, [
    { role: 'system', content: LABEL_SYS },
    { role: 'user', content: `${ctxText}LÍNEAS:\n${numbered}` },
  ], { model, maxTokens: 1800, fallbacks: [LABEL_FALLBACK] });
  const out = new Array(lines.length).fill(null);
  const parsed = parseJSON(content);
  const flat = typeof parsed.hablantes === 'string' ? parsed.hablantes : JSON.stringify(parsed);
  for (const [, n, who] of flat.matchAll(/(\d+)\s*[:=]?\s*"?([AC])\b/gi)) {
    const i = +n - offset - 1;
    if (i >= 0 && i < out.length) out[i] = /a/i.test(who) ? 'astrologa' : 'consultante';
  }
  // Líneas sin marcar: igual que la anterior.
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = out[i - 1] || null;
  return out;
}

// ---------- 2) Extracción por partes ----------
async function extract(groq, sys, script, isFragment, model) {
  try {
    const content = await chat(groq, [
      { role: 'system', content: sys },
      { role: 'user', content: `${isFragment ? 'Este es un FRAGMENTO de la consulta; extraé lo de este fragmento.\n' : ''}TRANSCRIPCIÓN:\n${script}` },
    ], { model, maxTokens: 3200 });
    return [normalize(parseJSON(content))];
  } catch (e) {
    if (!e.tooLarge || script.length < 1500) throw e;
    const lines = script.split('\n');
    const half = Math.ceil(lines.length / 2);
    if (half >= lines.length) throw e;
    return [
      ...(await extract(groq, sys, lines.slice(0, half).join('\n'), true, model)),
      ...(await extract(groq, sys, lines.slice(half).join('\n'), true, model)),
    ];
  }
}

/**
 * turns: líneas de la transcripción. ctx: {date, consultante, astrologa, notas, datosNacimiento}
 * Devuelve { analysis, turns } — turns con quién habla, si antes no se sabía.
 */
export async function analyze(groq, turns, ctx, { model, onProgress }) {
  const names = { astrologa: ctx.astrologa, consultante: 'Consultante' };
  let lines = splitLongTurns(turns);
  const needsLabels = lines.some((t) => !roleOf(t, names));

  const labelChunks = needsLabels ? chunkLines(lines.map((t) => t.text), LABEL_CHUNK_CHARS) : [];
  const extractPlan = chunkLines(lines.map((t) => t.text + '             '), CHUNK_CHARS); // margen para "ASTRÓLOGA: "
  const totalSteps = labelChunks.length + extractPlan.length + (extractPlan.length > 1 ? 2 : 0);
  let step = 0;
  const progress = (label, detail) => onProgress({ step: label, detail, fraction: step / totalSteps });

  // 1) Quién habla
  if (needsLabels) {
    let offset = 0;
    for (let ci = 0; ci < labelChunks.length; ci++) {
      progress('Identificando quién habla', labelChunks.length > 1 ? `Parte ${ci + 1} de ${labelChunks.length}` : '');
      const n = labelChunks[ci].length;
      const context = lines.slice(Math.max(0, offset - 6), offset).map((t) => `${t.role === 'astrologa' ? 'A' : 'C'}: ${t.text.slice(0, 160)}`);
      const roles = await labelChunk(groq, lines.slice(offset, offset + n), offset, context);
      roles.forEach((r, i) => (lines[offset + i] = { ...lines[offset + i], role: r }));
      offset += n;
      step++;
    }
    lines = mergeTurns(lines);
  }

  // 2) Extraer por partes, sobre el guion
  const script = lines.map((t) => {
    const r = roleOf(t, names);
    return `${r ? (r === 'astrologa' ? 'ASTRÓLOGA' : 'CONSULTANTE') + ': ' : ''}${t.text}`;
  });
  const chunks = chunkLines(script, CHUNK_CHARS);
  const single = chunks.length === 1;
  const sys = systemPrompt(ctx, single
    ? 'de 3 a 5 párrafos (300 a 500 palabras) que cuenten la consulta en orden: por qué vino, qué se vio de la carta y de cada tema, qué se le dijo y con qué conclusiones.'
    : 'un párrafo detallado (100 a 180 palabras) de lo que se habló en este fragmento, con los temas y lo que dijo la astróloga.');
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    progress('Analizando la conversación', single ? '' : `Parte ${i + 1} de ${chunks.length}`);
    partials.push(...(await extract(groq, sys, chunks[i].join('\n'), !single, model)));
    step++;
  }

  // 3) Unir
  let analysis;
  if (partials.length === 1) {
    analysis = partials[0];
  } else {
    progress('Armando el resumen final', '');
    const narrative = await mergeNarrative(groq, partials, ctx, model);
    step++;
    progress('Ordenando la astrología', '');
    const astrologia = await consolidateAstro(groq, partials.flatMap((p) => p.astrologia), ctx, model);
    analysis = { ...narrative, astrologia, fechas: uniqueBy(partials.flatMap((p) => p.fechas), (f) => f.fecha + ' ' + f.evento) };
  }
  return { analysis, turns: needsLabels ? lines : turns };
}

// ---------- 3) Unir ----------
const NARRATIVE = ['resumen', 'puntos_clave', 'situacion', 'recomendaciones', 'preguntas_consultante', 'seguimiento'];
const pickNarrative = (p) => Object.fromEntries(NARRATIVE.map((k) => [k, p[k]]));

async function mergeNarrative(groq, partials, ctx, model) {
  const parts = partials.map(pickNarrative);
  // Si no entran todos juntos, se unen primero de a grupos.
  const groups = [];
  let cur = [], size = 0;
  for (const p of parts) {
    const len = JSON.stringify(p).length;
    if (cur.length && size + len > MERGE_BUDGET_CHARS) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += len;
  }
  if (cur.length) groups.push(cur);
  if (groups.length === parts.length && parts.length > 1) {
    // ninguno entra de a varios: unir de a pares igual, para que siempre avance
    groups.length = 0;
    for (let i = 0; i < parts.length; i += 2) groups.push(parts.slice(i, i + 2));
  }
  const final = groups.length === 1;
  const merged = [];
  for (const g of groups) merged.push(g.length === 1 && !final ? g[0] : await mergeGroup(groq, g, ctx, model, final));
  return merged.length === 1 ? merged[0] : mergeNarrative(groq, merged, ctx, model);
}

async function mergeGroup(groq, group, ctx, model, final) {
  const sys = `Sos asistente de una astróloga profesional. Te paso los resúmenes de fragmentos consecutivos de UNA MISMA consulta astrológica con ${ctx.consultante} (${ctx.date}), en orden.
Unilos en uno solo. Respondé SOLO con JSON con esta forma:
{"resumen": "string", "puntos_clave": ["string"], "situacion": {"motivo_consulta": "string", "estado_emocional": "string", "areas": [{"area": "string", "descripcion": "string"}]}, "recomendaciones": [{"texto": "string", "cita": "string"}], "preguntas_consultante": [{"pregunta": "string", "respuesta": "string"}], "seguimiento": ["string"]}
- resumen: ${final ? 'de 3 a 5 párrafos (300 a 500 palabras) que cuenten la consulta completa en orden: por qué vino, qué se vio de la carta y de cada tema, qué se le dijo y con qué conclusiones. Separá los párrafos con una línea en blanco.' : 'un resumen detallado de estos fragmentos (200 a 300 palabras).'}
- En las listas, juntá los ítems repetidos pero no pierdas ninguno distinto. Mantené las citas y las respuestas tal como vienen.
- recomendaciones: solo consejos que dio la astróloga (ya vienen con su cita); no agregues consejos nuevos.
- seguimiento: temas pendientes para retomar en la próxima consulta.
- situacion: unificá; una entrada por área de vida.
No inventes nada que no esté en los fragmentos, no relaciones entre sí temas que en la conversación no se relacionaron y no le des importancia a comentarios al pasar (logística, tecnología, horarios).`;
  try {
    const content = await chat(groq, [
      { role: 'system', content: sys },
      { role: 'user', content: group.map((p, i) => `FRAGMENTO ${i + 1}:\n${JSON.stringify(p)}`).join('\n\n') },
    ], { model, maxTokens: 3000 });
    return pickNarrative(normalize(parseJSON(content)));
  } catch (e) {
    if (!e.tooLarge) throw e;
    if (group.length > 2) {
      const half = Math.ceil(group.length / 2);
      const a = await mergeGroup(groq, group.slice(0, half), ctx, model, false);
      const b = await mergeGroup(groq, group.slice(half), ctx, model, false);
      return mergeGroup(groq, [a, b], ctx, model, final);
    }
    return pickNarrative(mergeLocally(group.map((p) => normalize(p))));
  }
}

// Junta menciones astrológicas repetidas. Si la IA devuelve bastantes menos de las
// que había, se desconfía y se deja la lista original (sin repetidos exactos).
async function consolidateAstro(groq, items, ctx, model) {
  const unique = uniqueBy(items, (a) => a.tipo + ' ' + a.detalle);
  if (unique.length < 6) return unique;
  const pieces = chunkLines(unique.map((a) => JSON.stringify(a)), 6500);
  const out = [];
  for (const piece of pieces) {
    try {
      const content = await chat(groq, [
        {
          role: 'system',
          content: `Te paso las menciones astrológicas extraídas de distintas partes de UNA consulta astrológica (${ctx.date}). Algunas se repiten con otras palabras.
Uní SOLO las que hablan de lo mismo (misma configuración), juntando sus interpretaciones y datos. No elimines ninguna mención distinta y no inventes nada.
Ordená: primero "Carta natal", después "Revolución solar", "Tránsito", "Progresión", "Eclipse / lunación" y el resto.
Respondé SOLO con JSON: {"astrologia": [{"tipo": "string", "detalle": "string", "cuando": "string", "area": "string", "interpretacion": "string", "cita": "string"}]} (en "cita" dejá la cita textual más representativa).`,
        },
        { role: 'user', content: `[${piece.join(',\n')}]` },
      ], { model, maxTokens: 3500 });
      const result = normalize({ astrologia: parseJSON(content).astrologia }).astrologia;
      out.push(...(result.length >= piece.length * 0.6 ? result : piece.map((p) => JSON.parse(p))));
    } catch (e) {
      if (e.daily || e.status === 401) throw e;
      out.push(...piece.map((p) => JSON.parse(p)));
    }
  }
  return out;
}

const key = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\W+/g, ' ').trim();

function uniqueBy(items, f) {
  const seen = new Set();
  return items.filter((x) => {
    const k = key(f(x));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function mergeLocally(parts) {
  const all = (f) => parts.flatMap(f);
  const areas = new Map();
  for (const a of all((p) => p.situacion.areas)) {
    const k = key(a.area);
    areas.set(k, areas.has(k) ? { ...a, descripcion: areas.get(k).descripcion + ' ' + a.descripcion } : { ...a });
  }
  return {
    resumen: parts.map((p) => p.resumen).filter(Boolean).join('\n\n'),
    puntos_clave: uniqueBy(all((p) => p.puntos_clave), (x) => x),
    situacion: {
      motivo_consulta: parts.map((p) => p.situacion.motivo_consulta).find(Boolean) || '',
      estado_emocional: parts.map((p) => p.situacion.estado_emocional).filter(Boolean).pop() || '',
      areas: [...areas.values()],
    },
    astrologia: uniqueBy(all((p) => p.astrologia), (a) => a.tipo + ' ' + a.detalle),
    fechas: uniqueBy(all((p) => p.fechas), (f) => f.fecha + ' ' + f.evento),
    recomendaciones: uniqueBy(all((p) => p.recomendaciones), (x) => x.texto),
    preguntas_consultante: uniqueBy(all((p) => p.preguntas_consultante), (x) => x.pregunta),
    seguimiento: uniqueBy(all((p) => p.seguimiento), (x) => x),
  };
}
