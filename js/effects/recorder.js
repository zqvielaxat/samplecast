/* =========================================================
   effects/recorder.js — Grabadora: el "envoltorio"

   Este nodo NO transforma el sonido: solo LO ESCUCHA y lo guarda. Por eso no
   tiene salida (es un "tap"): el motor conecta la salida del nodo del que
   cuelga directamente a su entrada, y la cadena sigue su camino sin interrumpirse.

   GRAFO (interno):

      input ──► output          (paso directo, por si acaso)
        └────► [recorder-processor]   ← este es el que copia el audio

   CÓMO SE USA
   -----------
   1) start() → pone "recording" en 1: el procesador empieza a juntar audio.
   2) stop()  → pone "recording" en 0: el procesador manda lo grabado por
      postMessage y acá lo convertimos a un Blob WAV.
   3) download(trim) → descarga ese Blob. Si `trim` trae { start, end } en
      segundos, decodifica el WAV a AudioBuffer y exporta solo ese rango.
      Tope: 2 minutos (los pone el procesador).

   main.js usa onChange() para enterarse de cuándo refrescar los botones y el
   contador de la tarjeta.
   ========================================================= */

// El codificador WAV vive en js/wav.js (un módulo normal, no un worklet).
import { encodeWav } from "../wav.js";

// El procesador se carga con addModule(); la ruta es relativa a ESTE archivo.
const PROCESSOR_URL = new URL("./recorder-processor.js", import.meta.url).href;

// ---- Constantes del slice (fáciles de ajustar) ----
// Cuántas muestras entran en cada ventana de la curva de energía.
// Con 48 kHz, 256 muestras ≈ 5,3 ms: lo bastante corto para "ver" un ataque.
const SLICE_WINDOW_SIZE = 256;
// Largo MÍNIMO que puede tener un slice (evita cortes absurdos de pocos ms).
const SLICE_MIN_SECONDS = 0.025;
// Cantidad MÁXIMA de slices que devolvemos aunque la sensibilidad esté al 100.
const SLICE_MAX_SLICES = 64;
// A sensibilidad 100, el umbral de ataque cae hasta este 5 % del ataque más grande.
const SLICE_SENSITIVITY_FLOOR = 0.05;

export class RecorderEffect {
  constructor() {
    this.id = "recorder";

    this.input = null;      // a dónde llega el audio a grabar
    this.output = null;     // no se usa (es un nodo tap), pero lo dejamos por seguridad
    this.processor = null;
    this.analyser = null;   // "mira" la misma señal que se graba, para el dibujo en vivo

    this.ctx = null;
    this.ready = false;
    this.readyPromise = null;

    this.recording = false;        // ¿está grabando ahora?
    this.startedAt = 0;            // ctx.currentTime cuando arrancó
    this.recordingSeconds = 0;     // duración de la última grabación terminada
    this.lastBlob = null;          // el WAV listo para descargar
    this.lastChannels = null;      // canales EXACTOS de la última toma (para dibujar)
    this.lastSampleRate = 0;       // frecuencia de muestreo de esos canales

    this._sliceAnalysis = null;    // curva de energía cacheada (una por grabación)

    this._auditionSource = null;  // nodo que suena la pre-escucha actual
    this._auditionBuffer = null;  // AudioBuffer completo cacheado de la última toma

    this.onChange = null;          // main.js: "cambió el estado, refrescá la tarjeta"
  }

  /* ---------------- Ciclo de vida ---------------- */

  attach(ctx) {
    if (this.input) return; // ya estaba armado
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.output = ctx.createGain();

    // Paso directo: si algún día este nodo quedara en la cadena, la señal no se
    // cortaría. En la práctica el motor nunca lo conecta a la salida.
    this.input.connect(this.output);

    // AnalyserNode: "mira" la MISMA señal que copia el procesador. No modifica
    // el sonido; solo nos da las muestras recientes para dibujar la onda EN VIVO.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;   // ≈ 43 ms de audio a 48 kHz
    this.input.connect(this.analyser);

    this.readyPromise = this.loadProcessor();
  }

  /** Descarga el módulo del AudioWorklet y crea el nodo que copia el audio. */
  async loadProcessor() {
    try {
      await this.ctx.audioWorklet.addModule(PROCESSOR_URL);

      this.processor = new AudioWorkletNode(this.ctx, "recorder");
      this.processor.port.onmessage = (event) => this._onMessage(event.data);

      // El procesador escucha SIEMPRE lo que entra (grabar o no es su decisión).
      this.input.connect(this.processor);

      this.ready = true;
    } catch (error) {
      console.error("No se pudo cargar el procesador de la Grabadora:", error);
      console.info("Tip: los AudioWorklet no funcionan abriendo index.html con file:// ; usá un servidor local.");
    }
  }

  /** Llegó el audio grabado desde el worklet: lo convertimos a WAV. */
  _onMessage(message) {
    if (message.type !== "done") return;
    if (!message.channels || message.channels.length === 0 || message.frames <= 0) {
      this.recording = false;
      if (this.onChange) this.onChange();
      return;
    }

    this.recordingSeconds = message.frames / this.ctx.sampleRate;
    this.lastSampleRate = this.ctx.sampleRate;
    this.lastChannels = message.channels;               // los canales EXACTOS
    this.lastBlob = encodeWav(message.channels, this.ctx.sampleRate);
    this.recording = false;
    // Dejamos el parámetro en 0: si la grabación se cortó SOLA (tope de 2 min),
    // el procesador todavía lo tiene en 1, y hay que resetearlo para la próxima toma.
    this.processor.parameters.get("recording").value = 0;

    if (this.onChange) this.onChange();
  }

  /* ---------------- Controles ---------------- */

  /** Empieza a grabar. Devuelve false si ya estaba grabando o no está listo. */
  start() {
    if (!this.processor || !this.ready || this.recording) return false;

    // Si el contexto quedó en pausa (política de autoplay: pasa cuando todavía no
    // se reprodujo nada), lo despertamos YA. Así el procesador puede correr su
    // process() desde el primer momento y la toma queda registrada aunque el
    // usuario "arme" la grabación ANTES de darle play al sample.
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => { /* todavía no hay audio, no pasa nada */ });
    }

    this.recording = true;
    this.lastBlob = null;
    this.lastChannels = null;
    this.lastSampleRate = 0;
    this.recordingSeconds = 0;
    this._sliceAnalysis = null;   // la curva de energía vale solo para CADA grabación
    this._auditionBuffer = null;  // el buffer cacheado de la pre-escucha tampoco vale
    this.stopAudition();          // cortamos cualquier pre-escucha que estuviera sonando
    this.startedAt = this.ctx.currentTime;
    this.processor.parameters.get("recording").value = 1;
    if (this.onChange) this.onChange();
    return true;
  }

  /** Para de grabar. El procesador manda el audio y onChange avisa cuando llega. */
  stop() {
    if (!this.processor || !this.recording) return false;

    // Le avisamos al procesador que cierre la toma. El audio final nos llega por
    // postMessage ("done"), pero NO dependemos de ese mensaje para actualizar la
    // interfaz: marcamos el fin ya mismo. Así, aunque el contexto esté en pausa y
    // el procesador no haya podido correr su process(), el botón vuelve a
    // "● Grabar" y la próxima toma arranca limpia (esto arregla el bug de "no me
    // deja dar stop" al armar la grabación antes de reproducir).
    this.recording = false;
    this.processor.parameters.get("recording").value = 0;
    if (this.onChange) this.onChange();
    return true;
  }

  /** Segundos grabados en la toma actual (0 si está parada). */
  elapsedSeconds() {
    return this.recording ? this.ctx.currentTime - this.startedAt : this.recordingSeconds;
  }

  /** Descarga el WAV de la última grabación, recortado o completo. */
  async download(trim = null) {
    if (!this.lastBlob) return false;

    let blob = this.lastBlob;   // por defecto: la grabación completa
    let suffix = "";

    // Si hay un recorte válido, exportamos SOLO ese rango.
    if (trim && trim.end > trim.start) {
      blob = await this._trimBlob(trim.start, trim.end);
      if (!blob) return false;
      suffix = `-recorte-${trim.start.toFixed(2)}s-${trim.end.toFixed(2)}s`;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this._triggerDownload(blob, `grabacion${suffix}-${stamp}.wav`);
    return true;
  }

  /** Crea un enlace temporal y dispara la descarga de un Blob con `filename`. */
  _triggerDownload(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /**
   * Descarga cada slice como un WAV separado (slice1.wav, slice2.wav, ...).
   * `boundaries` son los límites en SEGUNDOS: el primero inicia el slice 1 y el
   * último cierra el último slice. Cortamos DIRECTAMENTE sobre los canales
   * exactos que guardó el procesador: no hace falta volver a decodificar.
   */
  async downloadPack(boundaries) {
    if (!this.lastChannels || this.lastChannels.length === 0) return 0;
    if (!boundaries || boundaries.length < 2) return 0;

    const rate = this.lastSampleRate || this.ctx.sampleRate;
    const totalLength = this.lastChannels[0].length;
    let written = 0;

    for (let i = 0; i < boundaries.length - 1; i++) {
      const startFrame = Math.max(0, Math.floor(boundaries[i] * rate));
      const endFrame = Math.min(totalLength, Math.ceil(boundaries[i + 1] * rate));
      const count = Math.max(1, endFrame - startFrame);
      // Cada canal se recorta igual que hace el exportador normal (mismo formato).
      const channels = this.lastChannels.map((channel) => channel.slice(startFrame, startFrame + count));
      const blob = encodeWav(channels, rate);
      this._triggerDownload(blob, `slice${i + 1}.wav`);
      written++;
      // Entre tandas dejamos que el navegador procese varios disparos de descarga.
      if (written % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return written;
  }

  /**
   * Pre-escucha (audición) de un tramo [start, end] en SEGUNDOS de la última
   * grabación. Suena por los parlantes (salida directa), sin tocar la cadena ni
   * la grabación. Solo se usa desde el modo "click" de la tarjeta.
   *
   * Construimos UN AudioBuffer con los canales exactos que guardó el procesador
   * (lastChannels) y lo cacheamos: así mover el mouse sobre los slices no
   * vuelve a armar el buffer cada vez.
   */
  audition(startSeconds, endSeconds) {
    if (!this.ctx || !this.lastChannels || this.lastChannels.length === 0) return false;
    const buffer = this._getPlaybackBuffer();
    if (!buffer) return false;

    this.stopAudition(); // siempre suena una sola pre-escucha a la vez

    // Si el contexto quedó en pausa (autoplay), lo despertamos para poder oír.
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});

    const offset = Math.max(0, Math.min(buffer.duration, startSeconds));
    const length = Math.max(0, Math.min(buffer.duration - offset, endSeconds - startSeconds));
    if (length <= 0) return false;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.8; // volumen fijo y moderado de pre-escucha
    source.connect(gain);
    gain.connect(this.ctx.destination);
    source.start(0, offset, length);
    this._auditionSource = { source, gain };
    return true;
  }

  /** Corta la pre-escucha que esté sonando, si hay una. */
  stopAudition() {
    if (!this._auditionSource) return;
    try { this._auditionSource.source.stop(); } catch { /* ya estaba parado */ }
    try { this._auditionSource.source.disconnect(); } catch { /* ya estaba suelto */ }
    try { this._auditionSource.gain.disconnect(); } catch { /* idem */ }
    this._auditionSource = null;
  }

  /** Devuelve (cacheado) el AudioBuffer completo de la última toma. */
  _getPlaybackBuffer() {
    if (this._auditionBuffer) return this._auditionBuffer;
    if (!this.lastChannels || this.lastChannels.length === 0) return null;

    const length = this.lastChannels[0].length;
    const rate = this.lastSampleRate || this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(this.lastChannels.length, length, rate);
    for (let ch = 0; ch < this.lastChannels.length; ch++) {
      buffer.copyToChannel(this.lastChannels[ch], ch);
    }
    this._auditionBuffer = buffer;
    return buffer;
  }

  /**
   * "Dejar solo este slice": recorta la grabación guardada al rango
   * [startSeconds, endSeconds]. Es DESTRUCTIVO sobre la última toma (el resto se
   * descarta de veras, no solo de la vista). Después main.js vuelve a dibujar la
   * onda y a recalcular los slices.
   */
  cropToSlice(startSeconds, endSeconds) {
    if (!this.lastChannels || this.lastChannels.length === 0) return false;

    const rate = this.lastSampleRate || this.ctx.sampleRate;
    const total = this.lastChannels[0].length;
    const startFrame = Math.max(0, Math.floor(startSeconds * rate));
    const endFrame = Math.min(total, Math.ceil(endSeconds * rate));
    const length = Math.max(1, endFrame - startFrame);

    const channels = this.lastChannels.map((channel) => channel.slice(startFrame, startFrame + length));
    this.lastChannels = channels;
    this.recordingSeconds = length / rate;
    this.lastBlob = encodeWav(channels, rate);

    this._sliceAnalysis = null; // la curva de energía vieja ya no describe esta toma
    this._auditionBuffer = null;
    this.stopAudition();
    return true;
  }

  /**
   * Calcula (UNA SOLA VEZ por grabación) la curva de energía por ventanas y el
   * ataque más grande. La guardamos en this._sliceAnalysis para que, al mover la
   * sensibilidad, solo se repita la selección de picos (barata) y no este análisis.
   */
  async ensureSliceAnalysis() {
    if (this._sliceAnalysis) return this._sliceAnalysis;
    if (!this.lastChannels || this.lastChannels.length === 0) return null;

    const channels = this.lastChannels;
    const length = channels[0].length;
    const sampleRate = this.lastSampleRate || this.ctx.sampleRate;
    const windowSize = SLICE_WINDOW_SIZE;
    const windowCount = Math.max(1, Math.ceil(length / windowSize));
    const energy = new Float32Array(windowCount);
    let maxOnset = 0;

    // Dividimos el trabajo en tandas y, entre tanda y tanda, dejamos "respirar"
    // al navegador con un setTimeout(0). Así este análisis pesado no congela la interfaz.
    const CHUNK_WINDOWS = 4096;
    for (let first = 0; first < windowCount; first += CHUNK_WINDOWS) {
      const end = Math.min(windowCount, first + CHUNK_WINDOWS);
      for (let w = first; w < end; w++) {
        const from = w * windowSize;
        const to = Math.min(length, from + windowSize);

        // Energía RMS de la ventana: promediamos los canales a mono y medimos.
        let sum = 0;
        let count = 0;
        for (let i = from; i < to; i++) {
          let mono = 0;
          for (let ch = 0; ch < channels.length; ch++) mono += channels[ch][i];
          mono /= channels.length;
          sum += mono * mono;
          count++;
        }
        energy[w] = count ? Math.sqrt(sum / count) : 0;

        // El "ataque" de esta ventana es cuánto SUBIÓ la energía respecto a la anterior.
        if (w > 0) {
          const onset = energy[w] - energy[w - 1];
          if (onset > maxOnset) maxOnset = onset;
        }
      }
      if (end < windowCount) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    this._sliceAnalysis = { energy, windowSize, sampleRate, maxOnset };
    return this._sliceAnalysis;
  }

  /**
   * Elige los picos (ataques) que se convierten en límites de slice, para una
   * región [startSeconds, endSeconds] y una sensibilidad 0..100. Es BARATO: solo
   * recorre la curva de energía ya cacheada. Devuelve los límites en SEGUNDOS:
   * el primero es `startSeconds` y el último `endSeconds`.
   */
  computeSlices(startSeconds, endSeconds, sensitivity) {
    const analysis = this._sliceAnalysis;
    if (!analysis || endSeconds - startSeconds <= 0) {
      return [startSeconds, endSeconds];
    }

    const { energy, windowSize, sampleRate, maxOnset } = analysis;
    const minSeconds = SLICE_MIN_SECONDS;

    // La sensibilidad mueve el umbral entre dos extremos:
    //   sensibilidad 0   → umbral = el ataque más grande (ninguno lo supera) → 1 solo slice
    //   sensibilidad 100 → umbral = solo el 5 % del ataque más grande → pasan muchos
    const t = Math.min(100, Math.max(0, sensitivity)) / 100;
    const threshold = maxOnset * (1 - t * (1 - SLICE_SENSITIVITY_FLOOR));

    // Juntamos los ataques que superan el umbral, cuidando el largo mínimo.
    const candidates = [];
    for (let w = 1; w < energy.length; w++) {
      const onset = energy[w] - energy[w - 1];
      if (onset <= threshold) continue;                       // no es un ataque lo bastante fuerte
      const time = (w * windowSize) / sampleRate;             // el ataque cae al inicio de la ventana
      if (time <= startSeconds + minSeconds) continue;        // demasiado pegado al inicio
      if (time >= endSeconds - minSeconds) continue;          // demasiado pegado al final
      candidates.push({ time, onset });
    }

    // Primero los ataques más fuertes, y de cada uno nos aseguramos de dejar
    // el largo mínimo respecto de los marcadores que ya elegimos.
    candidates.sort((a, b) => b.onset - a.onset);
    const markers = [];
    const maxMarkers = SLICE_MAX_SLICES - 1; // los slices son marcadores + 1
    for (const candidate of candidates) {
      if (markers.length >= maxMarkers) break;
      let ok = true;
      for (const marker of markers) {
        if (Math.abs(marker - candidate.time) < minSeconds) { ok = false; break; }
      }
      if (ok) markers.push(candidate.time);
    }
    markers.sort((a, b) => a - b);

    return [startSeconds, ...markers, endSeconds];
  }

  /** ¿Hay una grabación terminada lista para descargar? */
  hasRecording() {
    return Boolean(this.lastBlob);
  }

  /** Picos min/max exactos de la última toma, en `columns` columnas. */
  getPeaks(columns) {
    if (!this.lastChannels || this.lastChannels.length === 0) return null;
    const length = this.lastChannels[0].length;
    const peaks = new Float32Array(columns * 2);
    const samplesPerColumn = length / columns;

    for (let col = 0; col < columns; col++) {
      const start = Math.floor(col * samplesPerColumn);
      const end = Math.max(start + 1, Math.min(length, Math.floor((col + 1) * samplesPerColumn)));
      // ~200 muestras vistas por columna alcanzan para una onda nítida.
      const stride = Math.max(1, Math.floor((end - start) / 200));
      let min = 1;
      let max = -1;
      for (const channel of this.lastChannels) {
        for (let i = start; i < end && i < length; i += stride) {
          const value = channel[i];
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
      peaks[col * 2] = min;
      peaks[col * 2 + 1] = max;
    }
    return peaks;
  }

  /**
   * Recorta la grabación CON PRECISIÓN DE MUESTRA: decodifica el WAV a un
   * AudioBuffer y corta justo en los índices pedidos. La selección se hizo sobre
   * la pantalla (fracciones de la onda); el AudioBuffer nos da el arreglo real de
   * muestras para cortar exacto.
   */
  async _trimBlob(start, end) {
    try {
      const arrayBuffer = await this.lastBlob.arrayBuffer();
      const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

      const rate = audioBuffer.sampleRate;
      const startFrame = Math.max(0, Math.floor(start * rate));
      const endFrame = Math.min(audioBuffer.length, Math.ceil(end * rate));
      const length = Math.max(1, endFrame - startFrame);

      const channels = [];
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        channels.push(audioBuffer.getChannelData(ch).slice(startFrame, startFrame + length));
      }

      return encodeWav(channels, rate);
    } catch (error) {
      console.error("No se pudo decodificar/recortar la grabación:", error);
      return null;
    }
  }
}
