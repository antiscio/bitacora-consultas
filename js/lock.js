// Candado de la app: los secretos (clave de Groq, permiso de GitHub y llave de la
// biblioteca) se guardan en cada dispositivo ENCRIPTADOS con la clave de acceso.
// Sin la clave, la app no abre. El enlace/QR para vincular otro dispositivo
// también va encriptado con la misma clave.

const VAULT = 'bitacora.boveda';
const REMEMBER = 'bitacora.recordar';
const ITER = 310000;
const REMEMBER_DAYS = 30;

let mem = { groqKey: '', cloud: null }; // secretos en memoria mientras la app está abierta
let vaultKey = null;
let vaultSalt = null;

const b64 = (bytes) => {
  const u = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => s.replace(/-/g, '+').replace(/_/g, '/');

const load = (k) => {
  try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
};
const save = (k, v) => {
  try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {}
};

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: b64(iv), data: b64(data) };
}

async function open(key, box) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function persist() {
  if (!vaultKey) return;
  save(VAULT, { v: 1, salt: b64(vaultSalt), ...(await seal(vaultKey, mem)) });
}

// ---------- Estado ----------
export const hasVault = () => !!load(VAULT);
export const isUnlocked = () => !!vaultKey;
export const getSecret = (k) => mem[k];
export async function setSecret(k, v) {
  mem = { ...mem, [k]: v };
  await persist();
}

// Secretos guardados sin encriptar por versiones anteriores de la app (en este dispositivo).
export function legacySecrets() {
  const settings = load('bitacora.settings') || {};
  const cloud = load('bitacora.nube');
  if (!settings.groqKey && !cloud) return null;
  return { groqKey: settings.groqKey || '', cloud: cloud || null };
}
function clearLegacy() {
  const settings = load('bitacora.settings');
  if (settings?.groqKey) {
    delete settings.groqKey;
    save('bitacora.settings', settings);
  }
  save('bitacora.nube', null);
}

// ---------- Crear, abrir, bloquear ----------
export async function createVault(password, secrets = {}, { remember = true, salt = null } = {}) {
  vaultSalt = salt || crypto.getRandomValues(new Uint8Array(16));
  vaultKey = await deriveKey(password, vaultSalt);
  mem = { groqKey: secrets.groqKey || '', cloud: secrets.cloud || null };
  await persist();
  clearLegacy();
  if (remember) await rememberHere();
}

export async function unlock(password, { remember = true } = {}) {
  const v = load(VAULT);
  const salt = unb64(v.salt);
  const key = await deriveKey(password, salt);
  try {
    mem = await open(key, v);
  } catch {
    throw new Error('La clave no es correcta.');
  }
  vaultKey = key;
  vaultSalt = salt;
  if (remember) await rememberHere();
  else save(REMEMBER, null);
}

async function rememberHere() {
  const raw = await crypto.subtle.exportKey('raw', vaultKey);
  save(REMEMBER, { k: b64(raw), until: Date.now() + REMEMBER_DAYS * 864e5 });
}

// Abre sola si en este dispositivo se eligió "recordar" y no venció.
export async function unlockRemembered() {
  const r = load(REMEMBER);
  const v = load(VAULT);
  if (!r || !v || r.until < Date.now()) return false;
  try {
    const key = await crypto.subtle.importKey('raw', unb64(r.k), 'AES-GCM', true, ['encrypt', 'decrypt']);
    mem = await open(key, v);
    vaultKey = key;
    vaultSalt = unb64(v.salt);
    return true;
  } catch {
    save(REMEMBER, null);
    return false;
  }
}

export function lockNow() {
  save(REMEMBER, null);
  location.reload();
}

export async function changePassword(oldPassword, newPassword) {
  const v = load(VAULT);
  const oldKey = await deriveKey(oldPassword, unb64(v.salt));
  try {
    await open(oldKey, v);
  } catch {
    throw new Error('La clave actual no es correcta.');
  }
  await createVault(newPassword, mem, { remember: !!load(REMEMBER) });
}

// ---------- Vincular otro dispositivo ----------
// El enlace lleva los secretos encriptados con la clave de acceso (y la sal para derivarla).
export async function linkPayload() {
  const box = await seal(vaultKey, mem);
  return b64url(btoa(JSON.stringify({ s: b64(vaultSalt), i: box.iv, d: box.data })));
}

export function readLinkPayload(hash) {
  const m = (hash || '').match(/#vincular=([\w-]+)/);
  if (!m) return null;
  try {
    const j = JSON.parse(atob(unb64url(m[1])));
    return j.s && j.i && j.d ? j : null;
  } catch {
    return null;
  }
}

// En el dispositivo nuevo: con la clave, abre el enlace y crea su propia bóveda.
export async function acceptLink(payload, password, { remember = true } = {}) {
  const salt = unb64(payload.s);
  const key = await deriveKey(password, salt);
  let secrets;
  try {
    secrets = await open(key, { iv: payload.i, data: payload.d });
  } catch {
    throw new Error('La clave no es correcta.');
  }
  await createVault(password, secrets, { remember, salt });
  return secrets;
}
