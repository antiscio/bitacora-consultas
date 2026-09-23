// Plan B: grabar desde la app (para consultas que no son por Zoom).
// Graba el micrófono y, opcionalmente, el audio de una pestaña o de la pantalla
// (la llamada), en archivos separados para saber quién habla.

function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function startRecorder(stream) {
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48000 } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.start(1000);
  return {
    rec,
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = () => resolve(new Blob(parts, { type: rec.mimeType || 'audio/webm' }));
        if (rec.state !== 'inactive') rec.stop();
        else resolve(new Blob(parts, { type: rec.mimeType || 'audio/webm' }));
      }),
  };
}

export class Recorder {
  get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }
  get canCaptureCall() {
    return !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad/i.test(navigator.userAgent);
  }

  async start({ captureCall }) {
    this.streams = [];
    this.recs = [];
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.streams.push(mic);
    this.mic = startRecorder(mic);

    this.call = null;
    if (captureCall) {
      let display;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' });
      } catch {
        this.cancel();
        throw new Error('Se canceló la elección de la pestaña o pantalla.');
      }
      this.streams.push(display);
      const audioTracks = display.getAudioTracks();
      if (!audioTracks.length) {
        this.cancel();
        throw new Error('No se compartió el audio. Al elegir la pestaña o pantalla, activá "Compartir audio".');
      }
      display.getVideoTracks().forEach((t) => t.stop()); // solo queremos el sonido
      this.call = startRecorder(new MediaStream(audioTracks));
    }
    this.startedAt = new Date();
  }

  async stop() {
    const stamp = this.startedAt.toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const ext = (this.mic.rec.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
    const files = [];
    const micBlob = await this.mic.stop();
    files.push({ file: new File([micBlob], `microfono-${stamp}.${ext}`, { type: micBlob.type }), role: this.call ? 'astrologa' : 'ambos' });
    if (this.call) {
      const callBlob = await this.call.stop();
      files.push({ file: new File([callBlob], `llamada-${stamp}.${ext}`, { type: callBlob.type }), role: 'consultante' });
    }
    this.cancel();
    return files;
  }

  cancel() {
    (this.streams || []).forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
  }
}
