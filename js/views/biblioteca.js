// Pantallas "Biblioteca" (lista de consultantes y búsqueda) y ficha del consultante.

import { $, el, set, icon, avatar, fmtDate, fold, toast, confirmDialog } from '../ui.js';
import { listPatients, allSessions, getPatient, sessionsOf, savePatient, deletePatient } from '../db.js';
import { prefillPatient } from './nueva.js';
import { normalize } from '../analyze.js';

let query = '';

// ---------- Biblioteca ----------
export async function renderBiblioteca() {
  const view = $('view-biblioteca');
  const [patients, sessions] = await Promise.all([listPatients(), allSessions()]);

  const search = el('input', {
    type: 'search',
    placeholder: 'Buscar por nombre, tema, tránsito…',
    value: query,
    'aria-label': 'Buscar en la biblioteca',
    oninput: (e) => {
      query = e.target.value;
      drawResults();
    },
  });

  const results = el('div', { class: 'lib-results' });
  set(view, 
    el('div', { class: 'page-head row' },
      el('div', {},
        el('h1', {}, 'Biblioteca'),
        el('p', { class: 'muted' }, patients.length
          ? `${patients.length} ${patients.length === 1 ? 'consultante' : 'consultantes'} · ${sessions.length} ${sessions.length === 1 ? 'consulta' : 'consultas'}`
          : 'Acá se van guardando todas las consultas.')),
      el('a', { class: 'btn primary', href: '#/nueva' }, icon('plus'), 'Nueva consulta')),
    patients.length ? el('label', { class: 'search' }, icon('search'), search) : null,
    results,
  );

  function drawResults() {
    const q = fold(query.trim());
    if (!patients.length) {
      set(results, 
        el('div', { class: 'empty-state' },
          el('div', { class: 'empty-icon' }, icon('book', 28)),
          el('h3', {}, 'Todavía no hay consultas guardadas'),
          el('p', { class: 'muted' }, 'Cada consulta que proceses queda guardada acá, ordenada por consultante.'),
          el('a', { class: 'btn primary', href: '#/nueva' }, icon('plus'), 'Procesar la primera')),
      );
      return;
    }
    if (!q) {
      set(results, el('div', { class: 'patient-grid' }, patients.map(patientCard)));
      return;
    }

    const byId = new Map(patients.map((p) => [p.id, p]));
    const namesHit = patients.filter((p) => fold(p.name).includes(q));
    const sessionHits = sessions
      .map((s) => ({ s, snippet: findSnippet(s, q) }))
      .filter((x) => x.snippet && byId.has(x.s.patientId))
      .sort((a, b) => b.s.date.localeCompare(a.s.date));

    set(results, 
      namesHit.length ? el('div', { class: 'patient-grid' }, namesHit.map(patientCard)) : null,
      sessionHits.length
        ? el('div', { class: 'section' },
            el('h2', { class: 'section-title' }, `En ${sessionHits.length} ${sessionHits.length === 1 ? 'consulta' : 'consultas'}`),
            el('div', { class: 'list' }, sessionHits.map(({ s, snippet }) =>
              el('a', { class: 'list-item', href: `#/sesion/${s.id}` },
                avatar(byId.get(s.patientId).name, 'sm'),
                el('div', { class: 'grow' },
                  el('div', { class: 'li-title' }, byId.get(s.patientId).name, el('span', { class: 'muted' }, ` · ${fmtDate(s.date)}`)),
                  el('div', { class: 'li-sub' }, highlight(snippet, query.trim()))),
                icon('chevron')))))
        : null,
      !namesHit.length && !sessionHits.length ? el('p', { class: 'muted center' }, `No hay nada con “${query}”.`) : null,
    );
  }
  drawResults();
}

function patientCard(p) {
  return el('a', { class: 'pcard', href: `#/consultante/${p.id}` },
    el('div', { class: 'pc-head' },
      avatar(p.name),
      el('div', {},
        el('div', { class: 'pc-name' }, p.name),
        el('div', { class: 'pc-meta' }, `${p.sessionCount} ${p.sessionCount === 1 ? 'consulta' : 'consultas'}${p.lastDate ? ' · última ' + fmtDate(p.lastDate) : ''}`))),
    p.lastSummary ? el('p', { class: 'pc-summary' }, p.lastSummary) : null);
}

// Busca el texto en el análisis o la transcripción y devuelve un fragmento.
function findSnippet(s, q) {
  const a = normalize(s.analysis || {});
  const texts = [a.resumen, ...a.astrologia.map((x) => `${x.detalle} ${x.cuando} ${x.interpretacion}`), ...a.puntos_clave, s.notas, s.misNotas, ...s.turns.map((t) => t.text)];
  for (const t of texts) {
    if (!t) continue;
    const i = fold(t).indexOf(q);
    if (i >= 0) {
      const a = Math.max(0, i - 60);
      return (a > 0 ? '…' : '') + t.slice(a, i + q.length + 90) + (i + q.length + 90 < t.length ? '…' : '');
    }
  }
  return null;
}

function highlight(text, q) {
  const i = fold(text).indexOf(fold(q));
  if (i < 0 || !q) return text;
  return [text.slice(0, i), el('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

// ---------- Ficha del consultante ----------
export async function renderConsultante(id) {
  const view = $('view-consultante');
  const p = await getPatient(id);
  if (!p) {
    set(view, el('p', { class: 'muted' }, 'Ese consultante ya no está en la biblioteca.'), el('a', { href: '#/biblioteca' }, 'Volver'));
    return;
  }
  const sessions = await sessionsOf(id);
  const astro = sessions.flatMap((s) => normalize(s.analysis || {}).astrologia.map((x) => ({ ...x, date: s.date, sid: s.id })));

  set(view,
    el('a', { class: 'back', href: '#/biblioteca' }, icon('back', 16), 'Biblioteca'),
    el('header', { class: 'band night' },
      avatar(p.name, 'lg'),
      el('div', { class: 'grow' },
        el('p', { class: 'eyebrow' }, 'Consultante'),
        el('h1', {}, p.name),
        el('p', { class: 'band-meta' },
          el('span', {}, icon('sparkles', 15), p.birth || 'Sin datos de nacimiento'),
          el('span', {}, icon('book', 15), `${sessions.length} ${sessions.length === 1 ? 'consulta' : 'consultas'}`)),
        p.notes ? el('p', { class: 'band-notes' }, p.notes) : null),
      el('div', { class: 'band-actions' },
        el('button', { class: 'btn gold', type: 'button', onclick: () => { prefillPatient(p.name); location.hash = '#/nueva'; } }, icon('plus'), 'Nueva consulta'),
        el('button', { class: 'btn glass', type: 'button', onclick: () => editPatient(p) }, icon('edit'), 'Editar'))),

    el('div', { class: 'section' },
      el('h2', { class: 'section-title' }, 'Consultas'),
      sessions.length
        ? el('ol', { class: 'timeline' }, sessions.map((s) => {
            const a = normalize(s.analysis || {});
            return el('li', {},
              el('a', { class: 'tl-card', href: `#/sesion/${s.id}` },
                el('div', { class: 'tl-date' }, fmtDate(s.date, true)),
                el('p', { class: 'tl-summary' }, a.resumen || 'Transcripción guardada, falta el resumen.'),
                el('div', { class: 'chips' },
                  a.astrologia.length ? el('span', { class: 'chip gold' }, `${a.astrologia.length} menciones astrológicas`) : null,
                  a.fechas.length ? el('span', { class: 'chip' }, `${a.fechas.length} fechas`) : null,
                  !s.analysis ? el('span', { class: 'chip gold' }, 'Sin resumen') : null)));
          }))
        : el('p', { class: 'muted' }, 'Sin consultas.')),

    astro.length
      ? el('div', { class: 'section' },
          el('h2', { class: 'section-title' }, 'Astrología a lo largo de sus consultas'),
          el('div', { class: 'table-wrap' },
            el('table', {},
              el('thead', {}, el('tr', {}, ['Tipo', 'Qué', 'Cuándo', 'Consulta'].map((h) => el('th', {}, h)))),
              el('tbody', {}, astro.map((x) =>
                el('tr', {},
                  el('td', {}, el('span', { class: 'chip gold' }, x.tipo)),
                  el('td', {}, x.detalle),
                  el('td', {}, x.cuando),
                  el('td', {}, el('a', { href: `#/sesion/${x.sid}` }, fmtDate(x.date)))))))))
      : null,
  );
}

function editPatient(p) {
  const d = el('dialog', { class: 'edit' },
    el('form', { method: 'dialog', class: 'form' },
      el('h3', {}, 'Editar consultante'),
      el('label', { class: 'field' }, 'Nombre', el('input', { name: 'name', value: p.name, required: true })),
      el('label', { class: 'field' }, 'Datos de nacimiento', el('input', { name: 'birth', value: p.birth || '', placeholder: 'Ej.: 14/03/1985, 22:10 h, Rosario' })),
      el('label', { class: 'field' }, 'Notas', el('textarea', { name: 'notes', rows: 3 }, p.notes || '')),
      el('div', { class: 'dialog-actions spread' },
        el('button', { class: 'btn danger-ghost', type: 'button', onclick: async () => {
          d.close();
          if (await confirmDialog({ title: `¿Borrar a ${p.name}?`, text: 'Se borran también todas sus consultas. No se puede deshacer.', ok: 'Borrar', danger: true })) {
            await deletePatient(p.id);
            toast('Consultante borrado');
            location.hash = '#/biblioteca';
          }
        } }, icon('trash', 16), 'Borrar'),
        el('div', { class: 'row' },
          el('button', { class: 'btn ghost', value: 'cancel' }, 'Cancelar'),
          el('button', { class: 'btn primary', value: 'save' }, 'Guardar')))));
  d.addEventListener('close', async () => {
    if (d.returnValue === 'save') {
      const f = d.querySelector('form').elements;
      await savePatient({ ...p, name: f.namedItem('name').value.trim() || p.name, birth: f.namedItem('birth').value.trim(), notes: f.namedItem('notes').value.trim() });
      toast('Datos guardados');
      renderConsultante(p.id);
    }
    d.remove();
  });
  document.body.append(d);
  d.showModal();
}
