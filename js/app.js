// Arranque de la app: candado, navegación entre pantallas y configuración.

import { $, hydrateIcons, toast } from './ui.js';
import { initSettings, getSettings, onSettingsChange, loadSecrets, refreshCloudUi } from './settings.js';
import { getCloud, startAutoSync } from './cloud.js';
import { hasVault, unlock, unlockRemembered, createVault, legacySecrets, readLinkPayload, acceptLink } from './lock.js';
import { askPersistence } from './db.js';
import { initNueva, refreshPatientNames, renderHome } from './views/nueva.js';
import { renderBiblioteca, renderConsultante } from './views/biblioteca.js';
import { renderSesion } from './views/sesion.js';

const VIEWS = ['nueva', 'biblioteca', 'consultante', 'sesion'];

// ---------- Candado ----------
function askPassword({ message, create = false, action }) {
  $('lockMsg').textContent = message;
  $('lockForm').hidden = false;
  $('lockPass2').hidden = !create;
  $('lockPass').autocomplete = create ? 'new-password' : 'current-password';
  $('lockBtn').textContent = create ? 'Crear clave y entrar' : 'Entrar';
  $('lockPass').focus();
  return new Promise((resolve) => {
    $('lockForm').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('lockError');
      err.hidden = true;
      const pw = $('lockPass').value;
      try {
        if (create && pw.length < 8) throw new Error('La clave tiene que tener al menos 8 caracteres.');
        if (create && pw !== $('lockPass2').value) throw new Error('Las dos claves no coinciden.');
        $('lockBtn').disabled = true;
        $('lockBtn').textContent = 'Abriendo…';
        await action(pw, $('lockRemember').checked);
        resolve();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        $('lockBtn').disabled = false;
        $('lockBtn').textContent = create ? 'Crear clave y entrar' : 'Entrar';
        $('lockPass').select();
      }
    };
  });
}

async function gate() {
  const link = readLinkPayload(location.hash);
  if (link) {
    await askPassword({
      message: 'Para vincular este dispositivo a la Bitácora, ingresá la clave de acceso.',
      action: (pw, remember) => acceptLink(link, pw, { remember }),
    });
    toast('Listo: este dispositivo quedó vinculado a la biblioteca');
  } else if (hasVault()) {
    if (!(await unlockRemembered())) {
      await askPassword({ message: 'Ingresá la clave de acceso.', action: (pw, remember) => unlock(pw, { remember }) });
    }
  } else if (legacySecrets() || location.hash === '#primera-vez') {
    const legacy = legacySecrets();
    await askPassword({
      message: legacy
        ? 'Para proteger la app, elegí una clave de acceso (mínimo 8 caracteres). Se va a pedir para entrar y para vincular otros dispositivos.'
        : 'Elegí la clave de acceso de la Bitácora (mínimo 8 caracteres).',
      create: true,
      action: (pw, remember) => createVault(pw, legacy || {}, { remember }),
    });
  } else {
    $('lockMsg').textContent = 'Esta app es privada. Para usarla en este dispositivo, escaneá el código QR de vinculación desde un dispositivo que ya la use.';
    return new Promise(() => {}); // queda bloqueada
  }
  if (/^#(vincular=|primera-vez)/.test(location.hash)) history.replaceState(null, '', location.pathname + '#/nueva');
  $('lockPass').value = $('lockPass2').value = '';
  $('lockScreen').hidden = true;
  document.querySelector('.shell').hidden = false;
}

// ---------- Navegación ----------
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

// ---------- Inicio ----------
hydrateIcons();
await gate();
loadSecrets();
initSettings();
initNueva();
refreshKeyState();
refreshCloudUi();
if (getCloud()) startAutoSync();
onSettingsChange(() => {
  refreshKeyState();
  refreshPatientNames();
  route();
});
window.addEventListener('hashchange', route);
window.addEventListener('bitacora:datos', () => {
  // Llegaron cambios de otro dispositivo: refrescar, salvo que se esté escribiendo.
  if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) route();
});
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
