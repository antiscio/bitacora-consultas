// Biblioteca en la nube: sincroniza la biblioteca del navegador con un repositorio
// PRIVADO de GitHub, para usarla desde la compu y el celular.
// Todo se encripta en el navegador (AES-GCM 256) antes de subirlo: en GitHub solo
// quedan archivos ilegibles con nombres al azar. La llave nunca sale de los
// dispositivos vinculados (viaja en el código QR de vinculación).

import { prefs } from './ui.js';
import * as db from './db.js';

const KEY = 'bitacora.nube';
const API = 'https://api.github.com/repos/';
const CHECK_PATH = 'datos/llave.json';
const STORES = ['patients', 'sessions'];

export const getCloud = () => prefs.get(KEY, null);
const setCloud = (c) => (c ? prefs.set(KEY, c) : prefs.del(KEY));

let status = { state: getCloud() ? 'idle' : 'off', at: null, message: '' };
export const cloudStatus = () => status;
function setStatus(s) {
  status = { ...status, ...s };
  window.dispatchEvent(new CustomEvent('bitacora:nube', { detail: status }));
}

// ---------- Encriptación ----------
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let keyCache = null;

async function cryptoKey(k) {
  if (keyCache?.raw !== k) keyCache = { raw: k, key: await crypto.subtle.importKey('raw', unb64(k), 'AES-GCM', false, ['encrypt', 'decrypt']) };
  return keyCache.key;
}

export function newLibraryKey() {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

async function encrypt(obj, k) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  // Se hace en pedazos para que btoa no falle con textos grandes.
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(k), data));
  let bin = '';
  for (let i = 0; i < enc.length; i += 0x8000) bin += String.fromCharCode(...enc.subarray(i, i + 0x8000));
  return JSON.stringify({ v: 1, iv: b64(iv), data: btoa(bin) });
}

async function decrypt(text, k) {
  const { iv, data } = JSON.parse(text);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await cryptoKey(k), unb64(data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------- GitHub ----------
async function gh(c, path, init = {}) {
  const res = await fetch(API + c.repo + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) throw new Error('El permiso de GitHub venció o no es válido. Hay que volver a conectar la biblioteca.');
  if (res.status === 403 || res.status === 404) {
    const err = new Error('No hay acceso al repositorio de datos. Revisá el nombre y los permisos del token.');
    err.status = res.status;
    throw err;
  }
  return res;
}

async function listRemote(c) {
  const res = await gh(c, '/git/trees/HEAD?recursive=1');
  if (res.status === 409) return new Map(); // repositorio vacío
  if (!res.ok) throw new Error(`GitHub respondió ${res.status} al leer la biblioteca.`);
  const { tree } = await res.json();
  return new Map(tree.filter((t) => t.type === 'blob' && t.path.startsWith('datos/')).map((t) => [t.path, t.sha]));
}

async function readFile(c, sha) {
  const res = await gh(c, `/git/blobs/${sha}`);
  if (!res.ok) throw new Error(`GitHub respondió ${res.status} al leer un archivo.`);
  const { content } = await res.json();
  const bin = atob(content.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

async function writeFile(c, path, text, sha) {
  const res = await gh(c, `/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'Actualiza la biblioteca', content: btoa(text), ...(sha ? { sha } : {}) }),
  });
  if (res.status === 409 || res.status === 422) return null; // cambió en otro dispositivo: se resuelve en la próxima vuelta
  if (!res.ok) throw new Error(`GitHub respondió ${res.status} al guardar.`);
  return (await res.json()).content.sha;
}

async function removeFile(c, path, sha) {
  const res = await gh(c, `/contents/${path}`, { method: 'DELETE', body: JSON.stringify({ message: 'Borra de la biblioteca', sha }) });
  if (!res.ok && res.status !== 404 && res.status !== 409 && res.status !== 422) throw new Error(`GitHub respondió ${res.status} al borrar.`);
}

// ---------- Conectar y vincular ----------

/**
 * Conecta este dispositivo a un repositorio privado de datos.
 * Si la biblioteca en la nube es nueva, crea la llave. Si ya tiene datos,
 * hace falta la llave (se consigue vinculando con el QR de otro dispositivo).
 */
export async function connect({ repo, token, key }) {
  repo = repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('El repositorio tiene que ser del tipo usuario/nombre.');
  const c = { repo, token: token.trim(), key };
  const info = await gh(c, '');
  if (!info.ok) throw new Error('No se pudo abrir el repositorio.');
  if (!(await info.json()).private) throw new Error('Por seguridad, el repositorio de datos tiene que ser PRIVADO.');

  const remote = await listRemote(c);
  if (remote.has(CHECK_PATH)) {
    if (!c.key) throw new Error('Esta biblioteca ya tiene datos y está encriptada. Vinculá este dispositivo con el código QR que muestra la compu donde ya está conectada.');
    try {
      await decrypt(await readFile(c, remote.get(CHECK_PATH)), c.key);
    } catch {
      throw new Error('La llave no coincide con la de esta biblioteca.');
    }
  } else {
    c.key ||= newLibraryKey();
    await writeFile(c, CHECK_PATH, await encrypt({ bitacora: true, creada: new Date().toISOString() }, c.key));
  }
  setCloud(c);
  setStatus({ state: 'idle', message: '' });
  return c;
}

export function disconnect() {
  setCloud(null);
  setStatus({ state: 'off', at: null, message: '' });
}

// Código para vincular otro dispositivo: lleva el acceso a la biblioteca y la clave de Groq.
export function linkUrl(groqKey) {
  const c = getCloud();
  const payload = btoa(JSON.stringify({ r: c.repo, t: c.token, k: c.key, g: groqKey || '' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}#vincular=${payload}`;
}

export function readLink(hash) {
  const m = hash.match(/#vincular=([\w-]+)/);
  if (!m) return null;
  try {
    const j = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
    return { repo: j.r, token: j.t, key: j.k, groqKey: j.g };
  } catch {
    return null;
  }
}

// ---------- Sincronizar ----------
let running = null;
let again = false;

export function sync() {
  if (!getCloud()) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let rounds = 0;
    do {
      again = false;
      await syncOnce();
    } while (again && ++rounds < 3);
  })().finally(() => (running = null));
  return running;
}

async function syncOnce() {
  const c = getCloud();
  if (!c) return;
  setStatus({ state: 'sync', message: '' });
  try {
    const remote = await listRemote(c);
    const entries = new Map((await db.getAllRaw('sync')).map((e) => [e.path, e]));
    let pulled = 0;

    // 1) Traer lo que cambió en otros dispositivos.
    for (const [path, sha] of remote) {
      const m = path.match(/^datos\/(patients|sessions)\/(.+)\.json$/);
      if (!m) continue;
      const entry = entries.get(path);
      if (entry?.sha === sha || entry?.pendingDelete) continue;
      const obj = await decrypt(await readFile(c, sha), c.key);
      const local = await db.getRaw(m[1], m[2]);
      if (!local || (obj.updatedAt || 0) >= (local.updatedAt || 0)) {
        await db.putRaw(m[1], obj);
        pulled++;
        await db.putRaw('sync', { path, sha, updatedAt: obj.updatedAt || 0 });
      } else {
        // Lo de acá es más nuevo: se sube en el paso 3 encima de esta versión.
        await db.putRaw('sync', { path, sha, updatedAt: obj.updatedAt || 0 });
      }
      entries.set(path, await db.getRaw('sync', path));
    }

    // 2) Borrados: los hechos en otro dispositivo, y los hechos acá.
    for (const [path, entry] of entries) {
      const m = path.match(/^datos\/(patients|sessions)\/(.+)\.json$/);
      if (!m) continue;
      if (entry.pendingDelete) {
        if (remote.has(path)) await removeFile(c, path, remote.get(path));
        await db.deleteRaw('sync', path);
        remote.delete(path);
      } else if (entry.sha && !remote.has(path)) {
        await db.deleteRaw(m[1], m[2]);
        await db.deleteRaw('sync', path);
        pulled++;
      }
    }

    // 3) Subir lo nuevo o cambiado acá.
    for (const s of STORES) {
      for (const rec of await db.getAllRaw(s)) {
        const path = db.pathOf(s, rec.id);
        const entry = await db.getRaw('sync', path);
        if (entry && (rec.updatedAt || 0) <= (entry.updatedAt || 0)) continue;
        const sha = await writeFile(c, path, await encrypt(rec, c.key), remote.get(path));
        if (sha) await db.putRaw('sync', { path, sha, updatedAt: rec.updatedAt || 0 });
        else again = true;
      }
    }

    setStatus({ state: 'ok', at: Date.now(), message: '' });
    if (pulled) window.dispatchEvent(new CustomEvent('bitacora:datos'));
  } catch (e) {
    console.error(e);
    setStatus({ state: navigator.onLine ? 'error' : 'offline', message: navigator.onLine ? e.message : 'Sin internet: se sincroniza cuando vuelva.' });
  }
}

// Sincroniza al abrir, al volver a la app, cada 5 minutos y un rato después de cada cambio.
let autoStarted = false;
export function startAutoSync() {
  if (autoStarted) return sync();
  autoStarted = true;
  let t = null;
  window.addEventListener('bitacora:cambio', () => {
    clearTimeout(t);
    t = setTimeout(sync, 2500);
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
  window.addEventListener('online', sync);
  setInterval(() => document.visibilityState === 'visible' && sync(), 5 * 60 * 1000);
  sync();
}
