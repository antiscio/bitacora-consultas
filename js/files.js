// Recibe archivos o carpetas (por ejemplo, las carpetas que crea Zoom) y
// adivina a qué parte de la consulta y a qué voz corresponde cada audio.

const AUDIO_EXT = /\.(m4a|mp3|wav|webm|ogg|oga|opus|aac|flac|mp4|m4v|mov)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov)$/i;
const ZOOM_DATE = /(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})/;

export async function filesFromDrop(dataTransfer) {
  const entries = [...dataTransfer.items]
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((file) => ({ file, path: file.name }));
  const out = [];
  for (const e of entries) await walk(e, out);
  return out;
}

async function walk(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, out);
    }
  }
}

export function filesFromInput(input) {
  return [...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

// Pista individual de Zoom: está en "Audio Record/" o se llama audio<Nombre><números>.
// El audio mezclado de Zoom se llama audio_only.m4a o audio<solo números>.m4a.
const isParticipant = (i) => /(^|\/)audio record\//i.test(i.path) || /^audio[a-zÀ-ɏ].*\d{6,}\.\w+$/i.test(i.file.name);

// Fecha y hora que traen algunos nombres, para ordenar:
// WhatsApp Android "AUD-20260920-WA0012", WhatsApp Web "WhatsApp Audio 2026-09-20 at 15.32.10".
function timeFromName(name) {
  const m = name.match(/(20\d{2})-?(\d{2})-?(\d{2})(?:\D{1,6}(\d{2})\.(\d{2})\.(\d{2}))?/);
  if (!m) return null;
  const seq = +(name.match(/WA(\d{4})/i)?.[1] || 0);
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime() + seq * 1000;
}

/**
 * items: [{file, path}] → tracks: [{id, file, path, part, role}]
 * astrologaZoomName: nombre con el que la astróloga aparece en Zoom
 */
export function guessTracks(items, astrologaZoomName) {
  const audio = items.filter((i) => AUDIO_EXT.test(i.file.name));

  // 1) Agrupar por reunión: carpeta con fecha de Zoom, o si no, por fecha de modificación.
  const withKey = audio.map((i) => {
    const m = i.path.match(ZOOM_DATE);
    const folder = m ? m[0] : null;
    const time = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : i.file.lastModified;
    return { ...i, folder, time };
  });

  const groups = [];
  const byFolder = new Map();
  for (const i of withKey.filter((i) => i.folder)) {
    if (!byFolder.has(i.folder)) byFolder.set(i.folder, { time: i.time, items: [] });
    byFolder.get(i.folder).items.push(i);
  }
  groups.push(...byFolder.values());

  // Sueltos: cada audio es una parte distinta (p. ej. una consulta mandada en
  // varios audios de WhatsApp). Solo las pistas individuales de Zoom sueltas se
  // agrupan entre sí, si se generaron con menos de 5 min de diferencia.
  const loose = withKey.filter((i) => !i.folder).map((i) => ({ ...i, time: timeFromName(i.file.name) ?? i.time }));
  let cur = null;
  for (const i of loose.filter(isParticipant).sort((a, b) => a.time - b.time)) {
    if (!cur || i.time - cur.last > 5 * 60 * 1000) {
      cur = { time: i.time, last: i.time, name: i.file.name, items: [] };
      groups.push(cur);
    }
    cur.items.push(i);
    cur.last = i.time;
  }
  for (const i of loose.filter((i) => !isParticipant(i))) groups.push({ time: i.time, name: i.file.name, items: [i] });
  groups.sort((a, b) => a.time - b.time || (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));

  // 2) Asignar voces dentro de cada parte.
  const me = norm(astrologaZoomName);
  const tracks = [];
  groups.forEach((g, gi) => {
    const part = gi + 1;
    const participants = g.items.filter(isParticipant);
    const hasAudioOnly = g.items.some((i) => !VIDEO_EXT.test(i.file.name));

    for (const i of g.items) {
      let role;
      if (participants.includes(i)) {
        role = me && norm(i.file.name).includes(me) ? 'astrologa' : 'consultante';
      } else if (participants.length) {
        role = 'omitir'; // ya tenemos las voces por separado
      } else if (VIDEO_EXT.test(i.file.name) && hasAudioOnly) {
        role = 'omitir'; // mejor usar el audio que el video
      } else {
        role = 'ambos';
      }
      tracks.push({ id: crypto.randomUUID(), file: i.file, path: i.path, part, role });
    }
    // Si hay dos voces separadas y ninguna quedó como astróloga, avisar (lo hace la interfaz).
  });
  return tracks;
}

export function checkTracks(tracks) {
  const warnings = [];
  const parts = [...new Set(tracks.filter((t) => t.role !== 'omitir').map((t) => t.part))].sort((a, b) => a - b);
  for (const p of parts) {
    const roles = tracks.filter((t) => t.part === p && t.role !== 'omitir').map((t) => t.role);
    const count = (r) => roles.filter((x) => x === r).length;
    if (count('consultante') > 0 && count('astrologa') === 0)
      warnings.push(`En la parte ${p} no hay ningún audio marcado como "Astróloga". Elegí cuál es su voz.`);
    if (count('ambos') > 0 && (count('astrologa') || count('consultante')))
      warnings.push(`En la parte ${p} hay un audio mezclado y también voces separadas: se va a transcribir dos veces. Marcá el mezclado como "No usar".`);
  }
  return warnings;
}

export function fmtSize(bytes) {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
