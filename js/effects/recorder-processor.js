/* =========================================================
   recorder-processor.js — las "cuentas" de la Grabadora

   ¡ATENCIÓN! Igual que los otros procesadores, este archivo corre dentro del
   AudioWorklet: NO es un módulo, no hay window ni document, y el audio llega en
   bloques de 128 muestras.

   QUÉ HACE
   --------
   Es un procesador MUY simple: NO transforma el sonido (lo deja pasar como
   llegó). Su único trabajo es, mientras está "grabando", ir COPIANDO lo que
   entra en una lista de bloques. Cuando la grabación termina (el parámetro
   "recording" pasa de 1 a 0), une todos los bloques y se los manda al hilo
   principal con postMessage: ahí el envoltorio (recorder.js) los convierte en
   un archivo WAV.

   POR QUÉ EN BLOQUES: en el hilo de audio conviene no reservar memoria nueva en
   cada muestra (produce "pausas" audibles). Guardamos pedazos de 128 muestras
   (que es lo que ya llega gratis) y recién al final juntamos todo.

   TOPE DE SEGURIDAD: si nadie aprieta "Parar", la grabación no puede crecer para
   siempre. A los 60 segundos se corta sola y se manda lo grabado.
   ========================================================= */

const MAX_SECONDS = 60;

class RecorderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    // 1 = grabando, 0 = parada. El cambio 0→1 arranca una grabación nueva y el
    // 1→0 la cierra y la envía.
    return [{ name: "recording", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.maxFrames = Math.round(MAX_SECONDS * sampleRate);
    this.chunks = [];        // un arreglo de bloques por canal
    this.channelCount = 0;
    this.recordedFrames = 0;
    this.wasRecording = false;
    this.full = false;       // ¿ya llegamos al tope de 60 s?
    this.sent = false;       // ¿ya mandamos el resultado? (para no mandarlo dos veces)
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const recording = parameters.recording[0] >= 0.5;

    // 0 → 1: arranca una grabación nueva (descarta la anterior, si había).
    if (recording && !this.wasRecording) {
      this.channelCount = input && input.length ? input.length : 0;
      this.chunks = [];
      for (let ch = 0; ch < this.channelCount; ch++) this.chunks.push([]);
      this.recordedFrames = 0;
      this.full = false;
      this.sent = false;
    }

    // 1 → 0: se termina la grabación y mandamos lo juntado.
    if (!recording && this.wasRecording) this.send();

    this.wasRecording = recording;

    // Copiamos lo que entra, si hay entrada y todavía hay lugar.
    if (recording && input && input.length > 0 && !this.full) {
      const blockLength = input[0].length;
      const room = this.maxFrames - this.recordedFrames;
      const take = room < blockLength ? room : blockLength;

      if (take < blockLength) this.full = true;
      if (take > 0) {
        for (let ch = 0; ch < this.channelCount && ch < input.length; ch++) {
          this.chunks[ch].push(input[ch].slice(0, take));
        }
        this.recordedFrames += take;
      }

      // Si se llenó (tope de 60 s), mandamos sin esperar a que aprieten "Parar".
      if (this.full) this.send();
    }

    return true;
  }

  /** Une los bloques y manda los canales al hilo principal. */
  send() {
    if (this.sent || this.channelCount === 0 || this.chunks.length === 0) return;
    this.sent = true;

    const channels = this.chunks.map((blocks) => {
      const joined = new Float32Array(this.recordedFrames);
      let offset = 0;
      for (const block of blocks) {
        joined.set(block, offset);
        offset += block.length;
      }
      return joined;
    });

    // Los ArrayBuffer viajan "transferidos" (no se copian): más rápido y sin
    // duplicar memoria. postMessage acepta la lista de buffers transferibles.
    this.port.postMessage({ type: "done", frames: this.recordedFrames, channels },
      channels.map((channel) => channel.buffer));
  }
}

// Le ponemos nombre al procesador: la interfaz lo crea con este mismo nombre.
registerProcessor("recorder", RecorderProcessor);
