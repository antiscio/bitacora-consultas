// Configuración (clave de Groq, nombres, modelos), biblioteca en la nube y respaldo.

import { $, prefs, toast, download } from './ui.js';
import { GroqClient } from './groq.js';
import { exportAll, importAll } from './db.js';
import { getCloud, connect, disconnect, sync, linkUrl, cloudStatus, startAutoSync } from './cloud.js';
import { getSecret, setSecret, lockNow, changePassword } from './lock.js';

const KEY = 'bitacora.settings';
const DEFAULTS = { groqKey: '', name: 'Astróloga', zoomName: '', stt: 'whisper-large-v3', llm: 'openai/gpt-oss-120b' };

let settings = { ...DEFAULTS, ...prefs.get(KEY, {}), groqKey: '' };
const listeners = new Set();

export const getSettings = () => settings;
export const onSettingsChange = (fn) => listeners.add(fn);

// La clave de Groq no se guarda con el resto: va a la bóveda encriptada (lock.js).
function store() {
  const { groqKey, ...rest } = settings;
  prefs.set(KEY, rest);
}

// Después de abrir el candado: traer la clave de Groq de la bóveda.
export function loadSecrets() {
  settings = { ...settings, groqKey: getSecret('groqKey') || '' };
}

export async function updateSettings(patch) {
  settings = { ...settings, ...patch };
  store();
  if ('groqKey' in patch) await setSecret('groqKey', settings.groqKey);
  listeners.forEach((fn) => fn(settings));
}

// ---------- Biblioteca en la nube ----------
function ago(t) {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'recién' : m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`;
}

export function refreshCloudUi() {
  const c = getCloud();
  const st = cloudStatus();
  $('cloudOff').hidden = !!c;
  $('cloudOn').hidden = !c;
  const text = !c
    ? 'Para usar la biblioteca en la compu y en el celular.'
    : st.state === 'sync'
      ? `Conectada a ${c.repo} · sincronizando…`
      : st.state === 'error' || st.state === 'offline'
        ? `Conectada a ${c.repo} · ${st.message}`
        : `Conectada a ${c.repo}${st.at ? ' · sincronizada ' + ago(st.at) : ''}`;
  $('cloudState').textContent = text;
  $('cloudState').className = 'hint' + (st.state === 'error' ? ' bad' : c ? ' ok' : '');
  const side = $('cloudSide');
  side.hidden = !c;
  side.textContent = st.state === 'sync' ? 'Sincronizando…' : st.state === 'error' ? 'Error al sincronizar' : st.state === 'offline' ? 'Sin conexión' : st.at ? `En la nube · ${ago(st.at)}` : 'En la nube';
  side.classList.toggle('bad', st.state === 'error');
}

async function showLinkQr() {
  const url = await linkUrl();
  $('linkText').value = url;
  const box = $('qrBox');
  box.textContent = 'Generando código…';
  $('linkDialog').showModal();
  try {
    const { default: qrcode } = await import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm');
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch {
    box.textContent = 'No se pudo dibujar el código. Copiá el enlace y abrilo en el celular.';
  }
}

export function openSettings() {
  $('setKey').value = settings.groqKey;
  $('setName').value = settings.name;
  $('setZoomName').value = settings.zoomName;
  $('setStt').value = settings.stt;
  $('setLlm').value = settings.llm;
  $('keyStatus').textContent = '';
  $('settings').showModal();
}

export function initSettings() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-settings]')) openSettings();
    if (e.target.closest('[data-close-dialog]')) e.target.closest('dialog').close('cancel');
  });
  // Enter en un campo no debe cerrar el cuadro (el primer botón es "Cancelar").
  $('settings').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
  });

  $('btnShowKey').addEventListener('click', () => {
    const i = $('setKey');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('btnShowKey').textContent = i.type === 'password' ? 'Ver' : 'Ocultar';
  });

  $('btnTestKey').addEventListener('click', async () => {
    const st = $('keyStatus');
    const key = $('setKey').value.trim();
    if (!key) {
      st.textContent = 'Pegá la clave primero.';
      st.className = 'hint bad';
      return;
    }
    st.textContent = 'Probando…';
    st.className = 'hint';
    try {
      await new GroqClient(key).testKey();
      st.textContent = '✓ La clave funciona';
      st.className = 'hint ok';
    } catch (e) {
      st.textContent = e.message;
      st.className = 'hint bad';
    }
  });

  $('settings').addEventListener('close', async () => {
    if ($('settings').returnValue !== 'save') return;
    await updateSettings({
      groqKey: $('setKey').value.trim(),
      name: $('setName').value.trim() || DEFAULTS.name,
      zoomName: $('setZoomName').value.trim(),
      stt: $('setStt').value,
      llm: $('setLlm').value.trim() || DEFAULTS.llm,
    });
    toast('Configuración guardada');
  });

  $('btnLockNow').addEventListener('click', lockNow);
  $('btnChangePass').addEventListener('click', async () => {
    const err = $('passError');
    err.hidden = true;
    const [a, b, c] = ['passOld', 'passNew', 'passNew2'].map((id) => $(id).value);
    try {
      if (b.length < 8) throw new Error('La clave nueva tiene que tener al menos 8 caracteres.');
      if (b !== c) throw new Error('Las dos claves nuevas no coinciden.');
      await changePassword(a, b);
      ['passOld', 'passNew', 'passNew2'].forEach((id) => ($(id).value = ''));
      toast('Clave de acceso cambiada. Los otros dispositivos siguen con la anterior hasta volver a vincularlos.');
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });

  $('btnCloudConnect').addEventListener('click', async () => {
    const err = $('cloudError');
    err.hidden = true;
    const btn = $('btnCloudConnect');
    btn.disabled = true;
    try {
      await connect({ repo: $('cloudRepo').value, token: $('cloudToken').value });
      $('cloudToken').value = '';
      toast('Biblioteca conectada a la nube');
      refreshCloudUi();
      startAutoSync();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  $('btnCloudSync').addEventListener('click', () => sync());
  $('btnCloudLink').addEventListener('click', showLinkQr);
  $('btnCopyLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('linkText').value);
      toast('Enlace copiado');
    } catch {
      $('linkText').select();
    }
  });
  $('btnCloudOff').addEventListener('click', async () => {
    await disconnect();
    refreshCloudUi();
    toast('Este dispositivo ya no sincroniza (la biblioteca queda guardada acá y en la nube).');
  });
  window.addEventListener('bitacora:nube', refreshCloudUi);
  setInterval(refreshCloudUi, 60000);
  refreshCloudUi();

  $('btnExport').addEventListener('click', async () => {
    const data = await exportAll();
    const d = new Date().toISOString().slice(0, 10);
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `bitacora-respaldo-${d}.json`);
    toast(`Respaldo descargado (${data.sessions.length} consultas)`);
  });

  $('btnImport').addEventListener('click', () => $('inputImport').click());
  $('inputImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const r = await importAll(JSON.parse(await file.text()));
      toast(`Se recuperaron ${r.sessions.length} consultas de ${r.patients.length} consultantes`);
      listeners.forEach((fn) => fn(settings));
    } catch (err) {
      toast(err instanceof SyntaxError ? 'Ese archivo no es un respaldo válido.' : err.message, 'error');
    }
  });
}
