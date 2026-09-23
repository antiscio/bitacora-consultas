// Pantalla "Nueva consulta": subir audios, datos del consultante y procesar.

import { $, el, set, icon, avatar, fmtDate, todayISO, fmtMinutes, mediaDuration, toast, prefs } from '../ui.js';
import { filesFromDrop, filesFromInput, guessTracks, checkTracks, fmtSize } from '../files.js';
import { transcribeTracks, ROLES } from '../transcribe.js';
import { analyze } from '../analyze.js';
import { GroqClient } from '../groq.js';
import { Recorder } from '../recorder.js';
import { listPatients, allSessions, findPatientByName, findOrCreatePatient, saveSession, getSession, getPatient } from '../db.js';
import { getSettings, openSettings } from '../settings.js';

let tracks = [];
let busy = false;

export const isBusy = () => busy;
export function setBusy(on, label = '') {
  busy = on;
  window.dispatchEvent(new CustomEvent('jobchange', { detail: { on, label } }));
}

// ---------- Inicio: saludo y últimas consultas ----------
export async function renderHome() {
  const s = getSettings();
  const d = new Date();
  const day = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('today').textContent = day;
  const h = d.getHours();
  const saludo = h < 6 ? 'Buenas noches' : h < 13 ? 'Buen día' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
  $('hello').textContent = s.zoomName ? `${saludo}, ${s.zoomName}` : saludo;

  const [patients, sessions] = await Promise.all([listPatients(), allSessions()]);
  const byId = new Map(patients.map((p) => [p.id, p]));
  const recent = sessions.filter((x) => byId.has(x.patientId)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 6);
  $('recent').hidden = !recent.length;
  set($('recentList'), recent.map((x) => {
    const p = byId.get(x.patientId);
    return el('a', { class: 'pcard', href: `#/sesion/${x.id}` },
      el('div', { class: 'pc-head' }, avatar(p.name),
        el('div', {}, el('div', { class: 'pc-name' }, p.name), el('div', { class: 'pc-meta' }, fmtDate(x.date)))),
      el('p', { class: 'pc-summary' }, x.analysis?.resumen || 'Transcripción guardada, falta el resumen.'));
  }));
}

// La huella de la voz de la astróloga se va afinando con cada consulta, para
// reconocerla mejor en las siguientes.
const VOICE_KEY = 'bitacora.voz';
export function rememberVoice(v) {
  const prev = prefs.get(VOICE_KEY, null);
  const sum = prev && prev.length === v.length ? v.map((x, i) => x + prev[i] * 2) : v;
  const n = Math.hypot(...sum) || 1;
  prefs.set(VOICE_KEY, sum.map((x) => +(x / n).toFixed(5)));
}

// ---------- Audios ----------
const trackKey = (t) => `${t.path}|${t.file.size}|${t.file.lastModified}`;

async function addItems(items, preset) {
  const s = getSettings();
  if (preset) {
    const part = Math.max(0, ...tracks.map((t) => t.part)) + 1;
    items.forEach((i) => tracks.push({ id: crypto.randomUUID(), file: i.file, path: i.file.name, part, role: i.role, userEdited: true }));
  } else {
    const previous = new Map(tracks.map((t) => [trackKey(t), t]));
    const seen = new Set();
    const unique = [...tracks.map((t) => ({ file: t.file, path: t.path })), ...items].filter((i) => {
      const k = `${i.path}|${i.file.size}|${i.file.lastModified}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const guessed = guessTracks(unique, s.zoomName);
    if (items.length && !guessed.some((g) => items.some((i) => i.file === g.file))) {
      showWarnings(['Ninguno de esos archivos es de audio.']);
      return;
    }
    tracks = guessed.map((g) => {
      const prev = previous.get(trackKey(g));
      return prev?.userEdited ? prev : { ...g, duration: prev?.duration };
    });
  }
  renderFiles();
  // Duraciones, para mostrar y estimar el tiempo.
  for (const t of tracks) {
    if (t.duration === undefined) {
      t.duration = null;
      mediaDuration(t.file).then((d) => {
        t.duration = d;
        renderFiles();
      });
    }
  }
}

function renderFiles() {
  const list = $('fileList');
  list.replaceChildren();
  list.hidden = !tracks.length;
  $('dropzone').classList.toggle('compact', tracks.length > 0);
  const multi = tracks.length > 1;
  const maxPart = Math.max(1, ...tracks.map((t) => t.part));
  const sorted = [...tracks].sort((a, b) => a.part - b.part || a.path.localeCompare(b.path));
  const name = getSettings().name;

  for (const t of sorted) {
    const folder = t.path.includes('/') ? t.path.split('/').slice(-3, -1).join(' / ') : '';
    const meta = [t.duration ? fmtMinutes(t.duration) : null, fmtSize(t.file.size), folder].filter(Boolean).join(' · ');
    const roleSel = el('select', { class: 'mini', 'aria-label': 'Qué contiene', onchange: (e) => { t.role = e.target.value; t.userEdited = true; renderFiles(); } },
      Object.entries(ROLES).map(([v, label]) => el('option', { value: v, selected: t.role === v }, v === 'astrologa' ? `Solo ${name}` : v === 'consultante' ? 'Solo consultante' : label)));
    const partSel = multi && el('select', { class: 'mini', 'aria-label': 'Orden', onchange: (e) => { t.part = +e.target.value; t.userEdited = true; renderFiles(); } },
      Array.from({ length: Math.max(maxPart + 1, 2) }, (_, i) => el('option', { value: i + 1, selected: t.part === i + 1 }, `Parte ${i + 1}`)));

    list.append(
      el('li', { class: 'file' + (t.role === 'omitir' ? ' skip' : '') },
        el('span', { class: 'file-icon' }, icon('wave')),
        el('div', { class: 'file-info' }, el('div', { class: 'file-name' }, t.file.name), el('div', { class: 'file-meta' }, meta)),
        el('div', { class: 'file-controls' }, partSel, roleSel),
        el('button', { class: 'icon-btn sm', type: 'button', title: 'Quitar', 'aria-label': `Quitar ${t.file.name}`, onclick: () => { tracks = tracks.filter((x) => x !== t); renderFiles(); } }, icon('x', 16)),
      ),
    );
  }
  showWarnings(checkTracks(tracks));
  updateEstimate();
}

function showWarnings(list) {
  const w = $('fileWarn');
  w.hidden = !list.length;
  w.textContent = list.join(' ');
}

function updateEstimate() {
  const active = tracks.filter((t) => t.role !== 'omitir');
  const total = active.reduce((a, t) => a + (t.duration || 0), 0);
  const known = active.every((t) => t.duration);
  // Medido: ~4 s de transcripción y ~3 s de análisis por minuto de audio, más identificar quién habla.
  const mins = Math.max(1, Math.round((total / 60) * 0.11 + 1));
  $('estimate').textContent = active.length && known ? `${fmtMinutes(total)} de audio · tarda aprox. ${mins} min` : '';
}

// ---------- Consultante ----------
async function refreshPatientNames() {
  const patients = await listPatients();
  set($('patientNames'), ...patients.map((p) => el('option', { value: p.name })));
}

async function onNameChange() {
  const hint = $('patientHint');
  const p = await findPatientByName($('consultante').value);
  if (p) {
    const all = await listPatients();
    const count = all.find((x) => x.id === p.id)?.sessionCount || 0;
    set(hint, icon('check', 14), ` Ya está en la biblioteca · ${count} ${count === 1 ? 'consulta' : 'consultas'}. Esta se agrega a su historial.`);
    hint.hidden = false;
    if (p.birth && !$('nacimiento').value) $('nacimiento').value = p.birth;
  } else {
    hint.hidden = true;
  }
}

export function prefillPatient(name) {
  $('consultante').value = name;
  onNameChange();
}

// ---------- Procesar ----------
let waitTimer = null;
function onWait(w) {
  const p = $('procWait');
  clearInterval(waitTimer);
  if (!w) { p.hidden = true; return; }
  const show = () => {
    const s = Math.max(0, Math.ceil((w.until - Date.now()) / 1000));
    set(p, icon('clock', 16), ` ${w.reason}: esperando ${s} s. Es normal en el plan gratuito.`);
  };
  show();
  p.hidden = false;
  waitTimer = setInterval(show, 1000);
}

const STEPS = ['audio', 'transcribe', 'analyze', 'save'];
function setStep(step, fraction, detail) {
  const idx = STEPS.indexOf(step);
  $('procSteps').querySelectorAll('li').forEach((li, i) => {
    li.className = i < idx ? 'done' : i === idx ? 'active' : '';
  });
  if (fraction !== undefined) $('procFill').style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
  if (detail !== undefined) $('procDetail').textContent = detail;
}

function showProcessing(on) {
  $('newForm').hidden = on;
  $('processing').hidden = !on;
  $('procError').hidden = true;
  $('procSpinner').hidden = false;
}

function procFail(message, sessionId) {
  $('procSpinner').hidden = true;
  $('procTitle').textContent = 'No se pudo terminar';
  $('procError').hidden = false;
  $('procErrorText').textContent = message;
  $('procSaved').hidden = !sessionId;
  $('btnProcOpen').hidden = !sessionId;
  $('btnProcOpen').onclick = () => (location.hash = `#/sesion/${sessionId}`);
  $('btnProcRetry').onclick = () => (sessionId ? runAnalysisFor(sessionId) : process());
}

async function keepAwake() {
  try { return await navigator.wakeLock?.request('screen'); } catch { return null; }
}

function validate() {
  const s = getSettings();
  if (busy) return 'Hay otra consulta procesándose. Esperá a que termine.';
  if (!s.groqKey) { openSettings(); return 'Primero cargá tu clave de Groq en Configuración.'; }
  if (!tracks.some((t) => t.role !== 'omitir')) return 'Subí la grabación de la consulta.';
  if (!$('consultante').value.trim()) { $('consultante').focus(); return 'Escribí el nombre del consultante.'; }
  return '';
}

async function process() {
  const problem = validate();
  $('formError').hidden = !problem;
  $('formError').textContent = problem;
  if (problem) return;

  const s = getSettings();
  const name = $('consultante').value.trim();
  const date = $('fecha').value || todayISO();
  const birth = $('nacimiento').value.trim();
  const notas = $('notas').value.trim();
  const groq = new GroqClient(s.groqKey, { onWait });
  const lock = await keepAwake();

  setBusy(true, name);
  showProcessing(true);
  $('procTitle').textContent = 'Procesando la consulta';
  $('procSub').textContent = name;
  setStep('audio', 0, '');
  let sessionId = null;
  try {
    const { turns, audioSeconds, astrologerVoice, otherVoice } = await transcribeTracks(groq, tracks, {
      model: s.stt,
      knownVoice: prefs.get(VOICE_KEY, null),
      onProgress: ({ step, detail, fraction }) => setStep(step === 'Transcribiendo' ? 'transcribe' : 'audio', fraction * 0.55, detail),
    });
    if (astrologerVoice) rememberVoice(astrologerVoice);

    setStep('save', 0.56, 'Guardando la transcripción');
    const patient = await findOrCreatePatient(name, { birth });
    const session = await saveSession({
      id: crypto.randomUUID(),
      patientId: patient.id,
      date,
      notas,
      birth,
      turns,
      analysis: null,
      audio: tracks.filter((t) => t.role !== 'omitir').map((t) => t.file.name),
      durationSec: Math.round(tracks.filter((t) => t.role !== 'omitir').reduce((a, t) => a + (t.duration || 0), 0)) || Math.round(audioSeconds),
      models: { stt: s.stt },
      voices: astrologerVoice ? { astrologa: astrologerVoice, otra: otherVoice } : null,
      createdAt: Date.now(),
    });
    sessionId = session.id;
    await runAnalysis(groq, session, patient, (fraction, detail) => setStep('analyze', 0.58 + fraction * 0.4, detail));
    setStep('save', 1, '');
    finish(session.id);
  } catch (e) {
    console.error(e);
    procFail(e.message || String(e), sessionId);
  } finally {
    setBusy(false);
    onWait(null);
    lock?.release?.();
  }
}

// Analiza (o re-analiza) una consulta guardada y la actualiza en la biblioteca.
export async function runAnalysis(groq, session, patient, onStep) {
  const s = getSettings();
  const { analysis, turns } = await analyze(groq, session.turns, {
    date: session.date.split('-').reverse().join('/'),
    consultante: patient.name,
    astrologa: s.name,
    datosNacimiento: session.birth || patient.birth,
    notas: session.notas,
  }, {
    model: s.llm,
    onProgress: ({ step, detail, fraction }) => onStep(fraction, [step, detail].filter(Boolean).join(' · ')),
  });
  session.analysis = analysis;
  session.turns = turns;
  session.models = { ...(session.models || {}), llm: s.llm };
  await saveSession(session);
  return session;
}

async function runAnalysisFor(sessionId) {
  const s = getSettings();
  const session = await getSession(sessionId);
  const patient = await getPatient(session.patientId);
  const lock = await keepAwake();
  setBusy(true, patient.name);
  showProcessing(true);
  $('procTitle').textContent = 'Armando el resumen';
  setStep('analyze', 0.58, '');
  try {
    await runAnalysis(new GroqClient(s.groqKey, { onWait }), session, patient, (fraction, detail) => setStep('analyze', 0.58 + fraction * 0.4, detail));
    finish(sessionId);
  } catch (e) {
    console.error(e);
    procFail(e.message || String(e), sessionId);
  } finally {
    setBusy(false);
    onWait(null);
    lock?.release?.();
  }
}

function finish(sessionId) {
  resetForm();
  showProcessing(false);
  toast('Consulta guardada en la biblioteca');
  location.hash = `#/sesion/${sessionId}`;
}

function resetForm() {
  tracks = [];
  renderFiles();
  for (const id of ['consultante', 'nacimiento', 'notas']) $(id).value = '';
  $('fecha').value = todayISO();
  $('patientHint').hidden = true;
  $('formError').hidden = true;
  refreshPatientNames();
}

// ---------- Grabador (plan B) ----------
function initRecorder() {
  const recorder = new Recorder();
  let timer = null;
  if (!recorder.supported) $('recorderBox').hidden = true;
  if (!recorder.canCaptureCall) $('captureCallRow').hidden = true;

  $('btnRec').addEventListener('click', async () => {
    const btn = $('btnRec');
    $('recError').hidden = true;
    if (!btn.classList.contains('on')) {
      try {
        await recorder.start({ captureCall: $('captureCall').checked });
      } catch (e) {
        $('recError').textContent = e.name === 'NotAllowedError' ? 'No hay permiso para usar el micrófono.' : e.message;
        $('recError').hidden = false;
        return;
      }
      btn.classList.add('on');
      $('btnRecLabel').textContent = 'Terminar grabación';
      $('recTimer').hidden = false;
      const t0 = Date.now();
      const tick = () => {
        const s = Math.floor((Date.now() - t0) / 1000);
        $('recTimer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      };
      tick();
      timer = setInterval(tick, 1000);
      setBusy(true, 'Grabando');
    } else {
      clearInterval(timer);
      btn.classList.remove('on');
      $('btnRecLabel').textContent = 'Empezar a grabar';
      $('recTimer').hidden = true;
      const files = await recorder.stop();
      setBusy(false);
      addItems(files, true);
      // Copia del audio por las dudas (la biblioteca no guarda audios).
      files.forEach((f) => {
        const a = el('a', { href: URL.createObjectURL(f.file), download: f.file.name });
        a.click();
      });
    }
  });
}

// ---------- Inicio ----------
export function initNueva() {
  $('fecha').value = todayISO();

  const dz = $('dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    if (!busy) addItems(await filesFromDrop(e.dataTransfer));
  });
  $('btnPickFolder').addEventListener('click', () => $('inputFolder').click());
  $('btnPickFiles').addEventListener('click', () => $('inputFiles').click());
  for (const id of ['inputFolder', 'inputFiles']) {
    $(id).addEventListener('change', (e) => {
      addItems(filesFromInput(e.target));
      e.target.value = '';
    });
  }

  let t = null;
  $('consultante').addEventListener('input', () => { clearTimeout(t); t = setTimeout(onNameChange, 250); });
  $('btnProcess').addEventListener('click', process);
  $('btnProcBack').addEventListener('click', () => showProcessing(false));
  initRecorder();
  refreshPatientNames();

  window.addEventListener('beforeunload', (e) => {
    if (busy) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Migrar la última consulta de la versión anterior (antes no había biblioteca).
  const legacy = prefs.get('bitacora.last', null);
  if (legacy?.turns?.length) {
    (async () => {
      const m = legacy.meta || {};
      const p = await findOrCreatePatient(m.consultante || 'Sin nombre', { birth: m.datosNacimiento });
      await saveSession({ id: crypto.randomUUID(), patientId: p.id, date: m.date || todayISO(), notas: m.notas || '', birth: m.datosNacimiento || '', turns: legacy.turns, analysis: legacy.analysis, audio: [], createdAt: Date.now() });
      prefs.del('bitacora.last');
      refreshPatientNames();
    })();
  }
}

export { resetForm, refreshPatientNames };
