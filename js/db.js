// Biblioteca de consultas guardada en el navegador (IndexedDB).
// No se guardan los audios: solo la transcripción y el análisis.

const DB_NAME = 'bitacora';
const VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('patients')) db.createObjectStore('patients', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('patientId', 'patientId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

async function put(name, obj) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).put(obj);
    tx.oncomplete = () => resolve(obj);
    tx.onerror = () => reject(tx.error);
  });
}

export const normName = (s) =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- Consultantes ----------
export async function listPatients() {
  const [patients, sessions] = await Promise.all([done((await store('patients')).getAll()), done((await store('sessions')).getAll())]);
  const byPatient = new Map();
  for (const s of sessions) {
    if (!byPatient.has(s.patientId)) byPatient.set(s.patientId, []);
    byPatient.get(s.patientId).push(s);
  }
  return patients
    .map((p) => {
      const list = (byPatient.get(p.id) || []).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
      return { ...p, sessionCount: list.length, lastDate: list[0]?.date || null, lastSummary: list[0]?.analysis?.resumen || '' };
    })
    .sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || a.name.localeCompare(b.name));
}

export async function getPatient(id) {
  return done((await store('patients')).get(id));
}

export async function findPatientByName(name) {
  const key = normName(name);
  if (!key) return null;
  const all = await done((await store('patients')).getAll());
  return all.find((p) => normName(p.name) === key) || null;
}

export async function savePatient(p) {
  return put('patients', { ...p, updatedAt: Date.now() });
}

export async function findOrCreatePatient(name, { birth } = {}) {
  let p = await findPatientByName(name);
  if (!p) {
    p = { id: crypto.randomUUID(), name: name.trim(), birth: birth || '', notes: '', createdAt: Date.now() };
  } else if (birth && !p.birth) {
    p.birth = birth;
  }
  return savePatient(p);
}

export async function deletePatient(id) {
  const db = await open();
  const sessions = await sessionsOf(id);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['patients', 'sessions'], 'readwrite');
    tx.objectStore('patients').delete(id);
    for (const s of sessions) tx.objectStore('sessions').delete(s.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Consultas ----------
export async function sessionsOf(patientId) {
  const list = await done((await store('sessions')).index('patientId').getAll(patientId));
  return list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

export async function allSessions() {
  return done((await store('sessions')).getAll());
}

export async function getSession(id) {
  return done((await store('sessions')).get(id));
}

export async function saveSession(s) {
  return put('sessions', { ...s, updatedAt: Date.now() });
}

export async function deleteSession(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Respaldo ----------
export async function exportAll() {
  const [patients, sessions] = await Promise.all([done((await store('patients')).getAll()), allSessions()]);
  return { app: 'bitacora-consultas', version: 1, exportedAt: new Date().toISOString(), patients, sessions };
}

export async function importAll(data) {
  if (data?.app !== 'bitacora-consultas' || !Array.isArray(data.patients) || !Array.isArray(data.sessions)) {
    throw new Error('Ese archivo no es un respaldo de la Bitácora.');
  }
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['patients', 'sessions'], 'readwrite');
    data.patients.forEach((p) => tx.objectStore('patients').put(p));
    data.sessions.forEach((s) => tx.objectStore('sessions').put(s));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return { patients: data.patients.length, sessions: data.sessions.length };
}

// Pide al navegador que no borre la biblioteca si falta espacio.
export async function askPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}
