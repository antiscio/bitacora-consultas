// Configuración (clave de Groq, nombres, modelos) y respaldo de la biblioteca.

import { $, prefs, toast, download } from './ui.js';
import { GroqClient } from './groq.js';
import { exportAll, importAll } from './db.js';

const KEY = 'bitacora.settings';
const DEFAULTS = { groqKey: '', name: 'Astróloga', zoomName: '', stt: 'whisper-large-v3', llm: 'openai/gpt-oss-120b' };

let settings = { ...DEFAULTS, ...prefs.get(KEY, {}) };
const listeners = new Set();

export const getSettings = () => settings;
export const onSettingsChange = (fn) => listeners.add(fn);

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

  $('settings').addEventListener('close', () => {
    if ($('settings').returnValue !== 'save') return;
    settings = {
      groqKey: $('setKey').value.trim(),
      name: $('setName').value.trim() || DEFAULTS.name,
      zoomName: $('setZoomName').value.trim(),
      stt: $('setStt').value,
      llm: $('setLlm').value.trim() || DEFAULTS.llm,
    };
    prefs.set(KEY, settings);
    listeners.forEach((fn) => fn(settings));
    toast('Configuración guardada');
  });

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
