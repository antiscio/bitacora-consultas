// Pantalla de una consulta guardada: resumen, astrología y fechas, transcripción.

import { $, el, set, icon, avatar, fmtDate, dmy, fmtMinutes, fold, toast, confirmDialog, download } from '../ui.js';
import { getSession, getPatient, saveSession, deleteSession } from '../db.js';
import { buildSections, isEmpty, toText, toDocx, fileBase } from '../export.js';
import { normalize } from '../analyze.js';
import { transcriptLines, roleOf } from '../transcribe.js';
import { GroqClient } from '../groq.js';
import { getSettings, openSettings } from '../settings.js';
import { runAnalysis, isBusy, setBusy, rememberVoice } from './nueva.js';

let tab = 'resumen';

export async function renderSesion(id) {
  const view = $('view-sesion');
  const s = await getSession(id);
  if (!s) {
    set(view, el('p', { class: 'muted' }, 'Esa consulta ya no está en la biblioteca.'), el('a', { href: '#/biblioteca' }, 'Volver a la biblioteca'));
    return;
  }
  const p = await getPatient(s.patientId);
  const a = normalize(s.analysis || {});
  const names = { astrologa: getSettings().name, consultante: 'Consultante' };

  const meta = () => ({
    consultante: p.name,
    date: s.date,
    dateLabel: dmy(s.date),
    dateLong: fmtDate(s.date, true),
    datosNacimiento: s.birth || p.birth,
    notas: [s.notas, s.misNotas].filter(Boolean).join(' — '),
    names,
  });

  const astroCount = a.astrologia.length + a.fechas.length;
  const tabs = [
    ['resumen', 'Resumen', null],
    ['astro', 'Astrología y fechas', astroCount || null],
    ['transcripcion', 'Transcripción', null],
  ];
  const body = el('div', { class: 'tab-body' });
  const seg = el('div', { class: 'seg', role: 'tablist' }, tabs.map(([k, label, count]) =>
    el('button', { type: 'button', role: 'tab', onclick: () => { tab = k; draw(); } }, label, count ? el('span', { class: 'count' }, count) : null)));

  function draw() {
    seg.querySelectorAll('button').forEach((b, i) => {
      b.classList.toggle('on', tabs[i][0] === tab);
      b.setAttribute('aria-selected', tabs[i][0] === tab ? 'true' : 'false');
    });
    const sections = Object.fromEntries(buildSections(a).map((x) => [x.id, x]));
    if (tab === 'resumen') {
      const main = ['resumen', 'puntos', 'preguntas'].map((k) => sections[k]).filter((x) => !isEmpty(x)).map(renderSection);
      const side = ['situacion', 'recomendaciones', 'seguimiento'].map((k) => sections[k]).filter((x) => !isEmpty(x)).map(renderSection);
      set(body,
        !s.analysis ? pendingBanner() : null,
        el('div', { class: 'summary-grid' },
          el('div', { class: 'col' }, main),
          el('div', { class: 'col' }, side, notesBox())));
    } else if (tab === 'astro') {
      set(body, !s.analysis ? pendingBanner() : null, astroView(sections));
    } else {
      set(body, transcriptView(s, names));
    }
  }

  function pendingBanner() {
    return el('div', { class: 'banner warn' }, icon('alert'),
      el('div', { class: 'grow' }, el('strong', {}, 'Falta el resumen. '), 'La transcripción está guardada; se puede analizar ahora.'),
      el('button', { class: 'btn primary', type: 'button', onclick: reanalyze }, icon('sparkles'), 'Analizar'));
  }

  function notesBox() {
    let t = null;
    const status = el('span', { class: 'hint' });
    return el('section', { class: 'rsec notes' },
      el('h3', {}, 'Mis notas'),
      el('textarea', {
        rows: 4,
        placeholder: 'Anotaciones propias sobre esta consulta (se guardan solas).',
        oninput: (e) => {
          clearTimeout(t);
          status.textContent = '';
          t = setTimeout(async () => {
            s.misNotas = e.target.value;
            await saveSession(s);
            status.textContent = 'Guardado';
          }, 600);
        },
      }, s.misNotas || ''),
      status);
  }

  const progress = el('div', { class: 'inline-progress', hidden: true },
    el('div', { class: 'bar' }, el('div', { class: 'fill' })),
    el('p', { class: 'muted small' }));

  async function reanalyze() {
    const st = getSettings();
    if (!st.groqKey) return openSettings();
    if (isBusy()) return toast('Hay otra consulta procesándose. Esperá a que termine.', 'error');
    if (s.analysis && !(await confirmDialog({ title: '¿Volver a analizar?', text: 'Se rehace el resumen, la astrología y quién habla, a partir de la transcripción. Lo actual se reemplaza.', ok: 'Analizar' }))) return;
    progress.hidden = false;
    view.querySelectorAll('.banner .btn').forEach((b) => (b.disabled = true));
    const fill = progress.querySelector('.fill');
    const txt = progress.querySelector('p');
    let detail = 'Analizando…';
    let timer = null;
    const groq = new GroqClient(st.groqKey, {
      onWait: (w) => {
        clearInterval(timer);
        if (!w) { txt.textContent = detail; return; }
        const tick = () => (txt.textContent = `${w.reason}: esperando ${Math.max(0, Math.ceil((w.until - Date.now()) / 1000))} s…`);
        tick();
        timer = setInterval(tick, 1000);
      },
    });
    setBusy(true, p.name);
    try {
      await runAnalysis(groq, s, p, (fraction, d) => {
        fill.style.width = `${Math.round(fraction * 100)}%`;
        detail = d || 'Analizando…';
        txt.textContent = detail;
      });
      toast('Consulta actualizada');
      if (location.hash === `#/sesion/${id}`) renderSesion(id);
    } catch (e) {
      console.error(e);
      progress.hidden = true;
      view.querySelectorAll('.banner .btn').forEach((b) => (b.disabled = false));
      toast(e.message || String(e), 'error');
    } finally {
      clearInterval(timer);
      setBusy(false);
    }
  }

  const menu = el('details', { class: 'menu' },
    el('summary', { class: 'icon-btn', 'aria-label': 'Más opciones' }, icon('more')),
    el('div', { class: 'menu-pop' },
      el('button', { type: 'button', onclick: (e) => { e.target.closest('details').open = false; downloadTxt(); } }, icon('file', 16), 'Descargar texto (.txt)'),
      el('button', { type: 'button', onclick: (e) => { e.target.closest('details').open = false; reanalyze(); } }, icon('refresh', 16), 'Volver a analizar'),
      el('button', { type: 'button', class: 'danger', onclick: async (e) => {
        e.target.closest('details').open = false;
        if (await confirmDialog({ title: '¿Borrar esta consulta?', text: `Se borra la consulta del ${fmtDate(s.date)} de ${p.name}. No se puede deshacer.`, ok: 'Borrar', danger: true })) {
          await deleteSession(s.id);
          toast('Consulta borrada');
          location.hash = `#/consultante/${p.id}`;
        }
      } }, icon('trash', 16), 'Borrar consulta')));

  async function downloadDocx(btn) {
    btn.disabled = true;
    try {
      download(await toDocx(meta(), a, s.turns), fileBase(meta()) + '.docx');
    } catch (e) {
      console.error(e);
      toast('No se pudo armar el Word (¿hay internet?). Probá con el texto.', 'error');
    } finally {
      btn.disabled = false;
    }
  }
  function downloadTxt() {
    download(new Blob(['﻿' + toText(meta(), a, s.turns)], { type: 'text/plain;charset=utf-8' }), fileBase(meta()) + '.txt');
  }

  set(view,
    el('a', { class: 'back', href: `#/consultante/${p.id}` }, icon('back', 16), p.name),
    el('header', { class: 'band night' },
      avatar(p.name, 'lg'),
      el('div', { class: 'grow' },
        el('p', { class: 'eyebrow' }, 'Consulta'),
        el('h1', {}, p.name),
        el('p', { class: 'band-meta' },
          el('span', {}, icon('calendar', 15), fmtDate(s.date, true)),
          s.durationSec ? el('span', {}, icon('clock', 15), fmtMinutes(s.durationSec)) : null,
          s.birth || p.birth ? el('span', {}, icon('sparkles', 15), s.birth || p.birth) : null)),
      el('div', { class: 'band-actions' },
        el('button', { class: 'btn gold', type: 'button', onclick: (e) => downloadDocx(e.currentTarget) }, icon('download'), 'Descargar Word'),
        menu)),
    progress,
    seg,
    body,
  );
  draw();
}

const q = (text) => el('blockquote', {}, `“${text}”`);

// Una sección del informe, con el mismo orden y formato que el Word.
function renderSection(sec) {
  const box = el('section', { class: `rsec rsec-${sec.id}` }, el('h3', {}, sec.title));
  if (sec.kind === 'paragraphs') sec.items.forEach((t) => box.append(el('p', { class: sec.id === 'resumen' ? 'lead' : '' }, t)));
  if (sec.kind === 'bullets') box.append(el('ul', {}, sec.items.map((b) => el('li', {}, b))));
  if (sec.kind === 'fields') box.append(el('dl', {}, sec.items.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v)))));
  if (sec.kind === 'qa') {
    box.append(el('div', { class: 'qa' }, sec.items.map((x) =>
      el('div', { class: 'qa-item' },
        el('p', { class: 'qa-q' }, el('span', { class: 'qa-tag' }, 'P'), x.pregunta),
        x.respuesta ? el('p', { class: 'qa-a' }, el('span', { class: 'qa-tag' }, 'R'), x.respuesta) : null))));
  }
  if (sec.kind === 'quoted') box.append(el('ul', { class: 'quoted' }, sec.items.map((x) => el('li', {}, x.texto, x.cita ? q(x.cita) : null))));
  return box;
}

// Astrología agrupada por tipo, y fechas.
function astroView(sections) {
  const astro = sections.astrologia;
  const fechas = sections.fechas;
  const blocks = astro.items.map((g) =>
    el('section', { class: 'astro-group' },
      el('h2', { class: 'astro-group-title' }, g.tipo, el('span', { class: 'chip gold' }, g.items.length)),
      el('div', { class: 'astro-grid' }, g.items.map((x) =>
        el('article', { class: 'astro' },
          el('strong', {}, x.detalle),
          x.cuando || x.area ? el('div', { class: 'chips' }, x.cuando ? el('span', { class: 'chip gold' }, icon('calendar', 13), x.cuando) : null, x.area ? el('span', { class: 'chip violet' }, x.area) : null) : null,
          x.interpretacion ? el('p', {}, x.interpretacion) : null,
          x.cita ? q(x.cita) : null)))));

  return el('div', {},
    blocks.length ? blocks : el('div', { class: 'rsec' }, el('p', { class: 'empty' }, 'No se registraron menciones astrológicas.')),
    el('section', { class: 'astro-group' },
      el('h2', { class: 'astro-group-title' }, fechas.title, fechas.items.length ? el('span', { class: 'chip gold' }, fechas.items.length) : null),
      fechas.items.length
        ? el('ul', { class: 'dates' }, fechas.items.map((f) => el('li', {}, el('span', { class: 'd' }, f.fecha), el('span', {}, f.evento), f.cita ? el('span', { class: 'q' }, `“${f.cita}”`) : null)))
        : el('div', { class: 'rsec' }, el('p', { class: 'empty' }, 'No se mencionaron fechas.'))));
}

// Transcripción como guion de teatro, con buscador. Tocando el nombre se corrige
// quién dijo esa parte; "Invertir" da vuelta todo si las voces quedaron al revés.
function transcriptView(s, names) {
  const list = el('div', { class: 'script' });
  const count = el('span', { class: 'hint' });
  const search = el('input', { type: 'search', placeholder: 'Buscar en la transcripción', oninput: () => draw() });
  const other = (r) => (r === 'astrologa' ? 'consultante' : 'astrologa');

  async function setRole(idx, role) {
    const t = s.turns[idx];
    t.role = role;
    t.roleSource = 'manual';
    delete t.speaker;
    await saveSession(s);
    draw();
  }

  async function swapAll() {
    for (const t of s.turns) {
      const r = roleOf(t, names);
      if (r) t.role = other(r);
      delete t.speaker;
    }
    if (s.voices?.astrologa && s.voices?.otra) {
      [s.voices.astrologa, s.voices.otra] = [s.voices.otra, s.voices.astrologa];
      rememberVoice(s.voices.astrologa);
    }
    await saveSession(s);
    toast('Listo: se invirtieron las voces');
    draw();
  }

  function draw() {
    const q = search.value.trim();
    const f = fold(q);
    const lines = transcriptLines(s.turns, names);
    let n = 0;
    set(list, lines.map((l) => {
      if (l.header) return f ? null : el('div', { class: 'part' }, l.header);
      if (f && !fold(l.text).includes(f)) return null;
      n++;
      return el('div', { class: `line ${l.role || ''}` },
        el('button', {
          type: 'button',
          class: `who ${l.role || 'none'}`,
          title: 'Cambiar quién dijo esto',
          onclick: () => setRole(l.idx, l.role ? other(l.role) : 'astrologa'),
        }, l.speaker || '¿Quién habla?'),
        el('span', { class: 't' }, l.time),
        el('p', {}, f ? mark(l.text, q) : l.text));
    }));
    count.textContent = f ? `${n} ${n === 1 ? 'coincidencia' : 'coincidencias'}` : '';
  }
  draw();

  return el('div', {},
    el('div', { class: 'script-tools' },
      el('label', { class: 'search' }, icon('search'), search),
      count,
      el('div', { class: 'legend' },
        el('span', {}, el('i', { style: 'background:var(--accent)' }), names.astrologa),
        el('span', {}, el('i', { style: 'background:var(--gold)' }), names.consultante)),
      el('button', { class: 'btn sm', type: 'button', onclick: swapAll, title: 'Si quedaron al revés' }, icon('refresh', 15), 'Invertir voces')),
    el('p', { class: 'hint script-hint' }, 'Si una parte está mal atribuida, tocá el nombre para cambiarlo.'),
    list);
}

function mark(text, q) {
  const i = fold(text).indexOf(fold(q));
  return i < 0 ? text : [text.slice(0, i), el('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}
