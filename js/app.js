// Arranque de la app: navegación entre pantallas y configuración.

import { $, hydrateIcons } from './ui.js';
import { initSettings, getSettings, onSettingsChange } from './settings.js';
import { askPersistence } from './db.js';
import { initNueva, refreshPatientNames, renderHome } from './views/nueva.js';
import { renderBiblioteca, renderConsultante } from './views/biblioteca.js';
import { renderSesion } from './views/sesion.js';

const VIEWS = ['nueva', 'biblioteca', 'consultante', 'sesion'];

function show(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  const section = name === 'nueva' ? 'nueva' : 'biblioteca';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === section));
  window.scrollTo(0, 0);
}

async function route() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/consultante\/(.+)$/))) {
    await renderConsultante(m[1]);
    show('consultante');
  } else if ((m = h.match(/^#\/sesion\/(.+)$/))) {
    await renderSesion(m[1]);
    show('sesion');
  } else if (h === '#/biblioteca') {
    await renderBiblioteca();
    show('biblioteca');
  } else {
    await renderHome();
    show('nueva');
  }
}

function refreshKeyState() {
  const hasKey = !!getSettings().groqKey;
  $('setupBanner').hidden = hasKey;
  $('keyDot').classList.toggle('off', !hasKey);
  $('keyDot').title = hasKey ? 'Clave de Groq cargada' : 'Falta la clave de Groq';
}

hydrateIcons();
initSettings();
initNueva();
refreshKeyState();
onSettingsChange(() => {
  refreshKeyState();
  refreshPatientNames();
  route();
});
window.addEventListener('hashchange', route);
window.addEventListener('jobchange', (e) => {
  const { on, label } = e.detail;
  $('busyCard').hidden = !on;
  $('busyMini').hidden = !on;
  $('busyText').textContent = label || 'una consulta';
});
// Evitar que el navegador abra el archivo si se suelta fuera de la zona de carga.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
askPersistence();
route();
