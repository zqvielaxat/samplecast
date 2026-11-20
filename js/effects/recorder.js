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
   3) download() → descarga ese Blob como archivo.

   main.js usa onChange() para enterarse de cuándo refrescar los botones y el
   contador de la tarjeta.
   ========================================================= */

// El codificador WAV vive en js/wav.js (un módulo normal, no un worklet).
import { encodeWav } from "../wav.js";

// El procesador se carga con addModule(); la ruta es relativa a ESTE archivo.
const PROCESSOR_URL = new URL("./recorder-processor.js", import.meta.url).href;

export class RecorderEffect {
  constructor() {
    this.id = "recorder";

    this.input = null;      // a dónde llega el audio a grabar
    this.output = null;     // no se usa (es un nodo tap), pero lo dejamos por seguridad
    this.processor = null;

    this.ctx = null;
    this.ready = false;
    this.readyPromise = null;

    this.recording = false;        // ¿está grabando ahora?
    this.startedAt = 0;            // ctx.currentTime cuando arrancó
    this.recordingSeconds = 0;     // duración de la última grabación terminada
    this.lastBlob = null;          // el WAV listo para descargar

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
    if (!message.channels || message.channels.length === 0) {
      this.recording = false;
      if (this.onChange) this.onChange();
      return;
    }

    this.recordingSeconds = message.frames / this.ctx.sampleRate;
    this.lastBlob = encodeWav(message.channels, this.ctx.sampleRate);
    this.recording = false;

    if (this.onChange) this.onChange();
  }

  /* ---------------- Controles ---------------- */

  /** Empieza a grabar. Devuelve false si ya estaba grabando o no está listo. */
  start() {
    if (!this.processor || !this.ready || this.recording) return false;
    this.recording = true;
    this.lastBlob = null;
    this.recordingSeconds = 0;
    this.startedAt = this.ctx.currentTime;
    this.processor.parameters.get("recording").value = 1;
    if (this.onChange) this.onChange();
    return true;
  }

  /** Para de grabar. El procesador manda el audio y onChange avisa cuando llega. */
  stop() {
    if (!this.processor || !this.recording) return false;
    this.processor.parameters.get("recording").value = 0;
    return true;
  }

  /** Segundos grabados en la toma actual (0 si está parada). */
  elapsedSeconds() {
    return this.recording ? this.ctx.currentTime - this.startedAt : this.recordingSeconds;
  }

  /** Descarga el WAV de la última grabación. Devuelve false si no hay nada. */
  download() {
    if (!this.lastBlob) return false;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(this.lastBlob);
    link.download = `grabacion-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return true;
  }
}
