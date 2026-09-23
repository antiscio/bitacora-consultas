// Arma las secciones del informe (las usa la pantalla y las descargas) y las
// exporta a Word (.docx) o texto (.txt). El Word está pensado para leerse cómodo:
// aireado, sin tablas, y sin títulos o bloques cortados entre páginas.

import { transcriptLines } from './transcribe.js';
import { normalize, ASTRO_TYPES } from './analyze.js';

export function buildSections(result) {
  const r = normalize(result);
  const s = r.situacion;
  const groups = new Map();
  for (const a of r.astrologia) {
    if (!groups.has(a.tipo)) groups.set(a.tipo, []);
    groups.get(a.tipo).push(a);
  }
  const order = [...ASTRO_TYPES, ...[...groups.keys()].filter((k) => !ASTRO_TYPES.includes(k))];

  return [
    { id: 'resumen', title: 'Resumen', kind: 'paragraphs', items: r.resumen ? r.resumen.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [] },
    { id: 'puntos', title: 'Puntos clave', kind: 'bullets', items: r.puntos_clave },
    {
      id: 'situacion',
      title: 'Situación del consultante',
      kind: 'fields',
      items: [
        s.motivo_consulta && ['Motivo de la consulta', s.motivo_consulta],
        s.estado_emocional && ['Estado emocional', s.estado_emocional],
        ...s.areas.map((a) => [a.area || 'Otro', a.descripcion]),
      ].filter(Boolean),
    },
    { id: 'astrologia', title: 'Astrología de la consulta', kind: 'astro', items: order.filter((k) => groups.has(k)).map((k) => ({ tipo: k, items: groups.get(k) })) },
    { id: 'fechas', title: 'Fechas mencionadas', kind: 'dates', items: r.fechas },
    { id: 'preguntas', title: 'Preguntas del consultante', kind: 'qa', items: r.preguntas_consultante },
    { id: 'recomendaciones', title: 'Consejos de la astróloga', kind: 'quoted', items: r.recomendaciones },
    { id: 'seguimiento', title: 'Para retomar en la próxima consulta', kind: 'bullets', items: r.seguimiento },
  ];
}

export const isEmpty = (sec) => !sec.items?.length;

export function fileBase(meta) {
  const name = (meta.consultante || 'Consultante').replace(/[\\/:*?"<>|]/g, '').trim();
  return `Consulta - ${name} - ${meta.date}`;
}

// ---------- Texto (.txt) ----------
export function toText(meta, result, turns) {
  const out = ['CONSULTA ASTROLÓGICA', meta.consultante, [meta.dateLong || meta.dateLabel, meta.datosNacimiento].filter(Boolean).join(' · '), ''];
  if (meta.notas) out.push(`Notas: ${meta.notas}`, '');
  const rule = (t) => out.push('', t.toUpperCase(), '─'.repeat(Math.min(60, t.length)), '');
  for (const sec of buildSections(result)) {
    if (isEmpty(sec)) continue;
    rule(sec.title);
    if (sec.kind === 'paragraphs') sec.items.forEach((p) => out.push(p, ''));
    if (sec.kind === 'bullets') sec.items.forEach((b) => out.push(`• ${b}`));
    if (sec.kind === 'fields') sec.items.forEach(([k, v]) => out.push(`${k}:`, `  ${v}`, ''));
    if (sec.kind === 'astro') {
      for (const g of sec.items) {
        out.push(`${g.tipo}`, '');
        for (const a of g.items) {
          out.push(`  ✦ ${a.detalle}`);
          const m = [a.cuando && `Cuándo: ${a.cuando}`, a.area && `Área: ${a.area}`].filter(Boolean).join(' · ');
          if (m) out.push(`    ${m}`);
          if (a.interpretacion) out.push(`    ${a.interpretacion}`);
          if (a.cita) out.push(`    «${a.cita}»`);
          out.push('');
        }
      }
    }
    if (sec.kind === 'dates') sec.items.forEach((f) => out.push(`• ${f.fecha} — ${f.evento}`, ...(f.cita ? [`    «${f.cita}»`] : [])));
    if (sec.kind === 'qa') sec.items.forEach((q) => out.push(`P: ${q.pregunta}`, ...(q.respuesta ? [`R: ${q.respuesta}`] : []), ''));
    if (sec.kind === 'quoted') sec.items.forEach((x) => out.push(`• ${x.texto}`, ...(x.cita ? [`    «${x.cita}»`] : [])));
  }
  if (turns?.length) {
    rule('Transcripción');
    for (const l of transcriptLines(turns, meta.names)) {
      out.push(l.header ? `\n— ${l.header} —\n` : `${l.speaker ? l.speaker.toUpperCase() + ': ' : ''}${l.text}\n`);
    }
  }
  return out.join('\n');
}

// ---------- Word (.docx) ----------
const INK = '1C1830';
const MUTED = '7A7489';
const VIOLET = '4B3BB8';
const GOLD = '9A6B12';

export async function toDocx(meta, result, turns) {
  const d = await import('https://cdn.jsdelivr.net/npm/docx@9.7.1/+esm');
  const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, Footer, PageNumber, LevelFormat } = d;

  const P = (runs, opts = {}) => new Paragraph({ children: Array.isArray(runs) ? runs : [runs], ...opts });
  const T = (text, opts = {}) => new TextRun({ text, ...opts });
  const children = [];

  // Encabezado
  children.push(
    P(T('CONSULTA ASTROLÓGICA', { color: GOLD, size: 18, bold: true, characterSpacing: 40 }), { spacing: { after: 120 } }),
    P(T(meta.consultante, { font: 'Georgia', size: 52, color: INK }), { spacing: { after: 80 } }),
    P(T([meta.dateLong || meta.dateLabel, meta.datosNacimiento].filter(Boolean).join('   ·   '), { color: MUTED, size: 21 }), {
      spacing: { after: 360 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D7CFC1', space: 12 } },
    }),
  );
  if (meta.notas) children.push(P([T('Notas: ', { bold: true, color: MUTED }), T(meta.notas, { color: MUTED })], { spacing: { after: 240 } }));

  const h1 = (text, pageBreakBefore = false) =>
    P(T(text, { font: 'Georgia', size: 30, color: VIOLET }), { keepNext: true, keepLines: true, pageBreakBefore, spacing: { before: 480, after: 160 } });
  const h2 = (text) => P(T(text.toUpperCase(), { bold: true, size: 18, color: GOLD, characterSpacing: 30 }), { keepNext: true, spacing: { before: 280, after: 120 } });
  const quote = (text) =>
    P(T(`«${text}»`, { italics: true, color: MUTED, size: 19, font: 'Georgia' }), { indent: { left: 360 }, keepLines: true, spacing: { after: 200 } });
  const bullet = (runs, keepNext = false) => P(runs, { numbering: { reference: 'vinetas', level: 0 }, keepLines: true, keepNext, spacing: { after: 100 } });

  for (const sec of buildSections(result)) {
    if (isEmpty(sec)) continue;
    children.push(h1(sec.title));
    if (sec.kind === 'paragraphs') sec.items.forEach((p) => children.push(P(T(p), { spacing: { after: 200 }, alignment: AlignmentType.JUSTIFIED })));
    if (sec.kind === 'bullets') sec.items.forEach((b) => children.push(bullet(T(b))));
    if (sec.kind === 'fields') {
      sec.items.forEach(([k, v]) => {
        children.push(P(T(k, { bold: true, color: VIOLET }), { keepNext: true, spacing: { after: 40 } }));
        children.push(P(T(v), { keepLines: true, spacing: { after: 200 } }));
      });
    }
    if (sec.kind === 'astro') {
      for (const g of sec.items) {
        children.push(h2(g.tipo));
        for (const a of g.items) {
          const info = [a.cuando && `Cuándo: ${a.cuando}`, a.area && `Área: ${a.area}`].filter(Boolean).join('   ·   ');
          const more = !!(info || a.interpretacion || a.cita);
          children.push(P(T(a.detalle, { bold: true, font: 'Georgia', size: 23 }), { keepNext: more, keepLines: true, spacing: { after: more ? 40 : 220 } }));
          if (info) children.push(P(T(info, { color: GOLD, size: 18 }), { keepNext: !!(a.interpretacion || a.cita), spacing: { after: 60 } }));
          if (a.interpretacion) children.push(P(T(a.interpretacion), { keepLines: true, keepNext: !!a.cita, spacing: { after: a.cita ? 60 : 220 } }));
          if (a.cita) children.push(quote(a.cita));
        }
      }
    }
    if (sec.kind === 'dates') {
      sec.items.forEach((f) => {
        children.push(bullet([T(f.fecha, { bold: true, color: GOLD }), T('  —  '), T(f.evento)], !!f.cita));
        if (f.cita) children.push(quote(f.cita));
      });
    }
    if (sec.kind === 'qa') {
      sec.items.forEach((q) => {
        children.push(P([T('P  ', { bold: true, color: GOLD }), T(q.pregunta, { bold: true })], { keepNext: !!q.respuesta, keepLines: true, spacing: { after: q.respuesta ? 60 : 220 } }));
        if (q.respuesta) children.push(P([T('R  ', { bold: true, color: VIOLET }), T(q.respuesta)], { keepLines: true, spacing: { after: 220 } }));
      });
    }
    if (sec.kind === 'quoted') {
      sec.items.forEach((x) => {
        children.push(bullet(T(x.texto), !!x.cita));
        if (x.cita) children.push(quote(x.cita));
      });
    }
  }

  if (turns?.length) {
    children.push(h1('Transcripción', true));
    for (const l of transcriptLines(turns, meta.names)) {
      if (l.header) {
        children.push(h2(l.header));
        continue;
      }
      const runs = [];
      if (l.speaker) runs.push(T(l.speaker.toUpperCase() + ':  ', { bold: true, size: 18, color: l.role === 'astrologa' ? VIOLET : GOLD }));
      runs.push(T(l.text));
      runs.push(T(`   ${l.time}`, { color: 'A8A2B8', size: 16 }));
      children.push(P(runs, { keepLines: true, spacing: { after: 180 } }));
    }
  }

  const doc = new Document({
    creator: 'Bitácora de Consultas',
    title: fileBase(meta),
    styles: { default: { document: { run: { font: 'Calibri', size: 22, color: INK }, paragraph: { spacing: { line: 300 } } } } },
    numbering: {
      config: [{
        reference: 'vinetas',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 240 } } } }],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1300, bottom: 1300, left: 1400, right: 1400 } } },
      footers: {
        default: new Footer({
          children: [P([T(`${meta.consultante} · ${meta.dateLabel}      `, { color: MUTED, size: 16 }), new TextRun({ children: [PageNumber.CURRENT], color: MUTED, size: 16 })], { alignment: AlignmentType.RIGHT })],
        }),
      },
      children,
    }],
  });
  return Packer.toBlob(doc);
}
