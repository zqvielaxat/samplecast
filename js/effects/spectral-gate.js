/* =========================================================
   effects/spectral-gate.js — Spectral Gate: el "envoltorio"

   Este archivo es el que conoce la interfaz (main.js): le ofrece setParam() y
   setEnabled(). Por dentro arma el grafo de nodos y carga el procesador que
   hace las cuentas (spectral-gate-processor.js).

   GRAFO DEL EFECTO (igual que el Binscrambler):

     input ─┬─► dryDelay ──► dryGain ──┐
            │                           ├─► output
            └─► [procesador] ──► wetGain ┘

   OJO CON EL RETRASO: este efecto trabaja por cuadros de 2048 muestras, así que
   su salida viene retrasada 2048 muestras (unos 43 ms a 48 kHz). Para que al
   mezclar seco y húmedo no se cancelen frecuencias, el camino seco se retrasa
   lo mismo con un DelayNode.

   CUÁNDO SUENA: este efecto forma parte de la cadena solo si su nodo está
   conectado en el tablero (main.js llama a setEnabled(true) al conectarlo y a
   setEnabled(false) al desconectarlo).
   ========================================================= */

// El procesador se carga con addModule(). La dirección se calcula desde ESTE
// archivo (import.meta.url), así funciona sin importar dónde esté la página.
const PROCESSOR_URL = new URL("./spectral-gate-processor.js", import.meta.url).href;

// Debe coincidir con FRAME del procesador: es su retraso interno, en muestras.
const FRAME_SAMPLES = 2048;

export class SpectralGateEffect {
  constructor() {
    this.id = "spectral-gate";

    // Nodos del grafo. Son null hasta que el motor nos avise que ya existe el
    // AudioContext (método attach): antes de eso no se puede crear ningún nodo.
    this.input = null;
    this.output = null;
    this.dryGain = null;
    this.wetGain = null;
    this.dryDelay = null;
    this.processor = null;

    this.ctx = null;
    this.ready = false;        // ¿terminó de cargar el procesador de audio?
    this.readyPromise = null;
    this.enabled = true;       // ¿está conectado en el tablero?
    this.values = { threshold: -50, amount: 100, mix: 100 };  // valores actuales
  }

  /* ---------------- Ciclo de vida ---------------- */

  /**
   * El motor llama a esto cuando el AudioContext ya existe (al cargar el primer
   * sample). Acá construimos los nodos y empezamos a cargar el procesador.
   */
  attach(ctx) {
    if (this.input) return; // ya estaba armado
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    // El máximo del DelayNode se mide en segundos: 0,5 s alcanza y sobra para
    // 2048 muestras incluso con frecuencias de muestreo bajas.
    this.dryDelay = ctx.createDelay(0.5);
    this.dryDelay.delayTime.value = FRAME_SAMPLES / ctx.sampleRate;

    this.input.connect(this.dryDelay);
    this.dryDelay.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);

    this.applyMix(true); // fija las ganancias de una vez (todavía no suena nada)

    // Cargar el procesador es asincrónico (hay que descargar un archivo).
    this.readyPromise = this.loadProcessor();
  }

  /** Descarga el módulo del AudioWorklet y crea el nodo procesador. */
  async loadProcessor() {
    try {
      await this.ctx.audioWorklet.addModule(PROCESSOR_URL);

      this.processor = new AudioWorkletNode(this.ctx, "spectral-gate");
      // Copiamos al procesador los valores que la interfaz ya tenía
      for (const [name, value] of Object.entries(this.values)) {
        const param = this.processor.parameters.get(name);
        if (param) param.value = value;
      }

      this.input.connect(this.processor);
      this.processor.connect(this.wetGain);

      this.ready = true;
      this.applyMix(true); // ahora sí el camino "wet" puede sonar
    } catch (error) {
      // Si esto falla, el efecto queda como un simple "pasar la señal": la app
      // sigue sonando, pero sin la puerta espectral.
      console.error("No se pudo cargar el procesador del Spectral Gate:", error);
      console.info("Tip: los AudioWorklet no funcionan abriendo index.html con file:// ; usá un servidor local.");
    }
  }

  /* ---------------- Controles de la interfaz ---------------- */

  /**
   * Cambia un parámetro por su id: "threshold" (−90 a 0 dB), "amount" (0 a 100)
   * o "mix" (0 a 100). Los dos primeros son parámetros del procesador; "mix" es
   * del grafo (las ganancias de seco y húmedo).
   */
  setParam(id, value) {
    if (!(id in this.values)) return;
    this.values[id] = value;

    if (id === "mix") {
      this.applyMix();
      return;
    }

    if (this.processor) {
      const param = this.processor.parameters.get(id);
      if (param) {
        // setTargetAtTime hace un pequeño "deslizamiento" hasta el valor nuevo
        // (evita saltos bruscos cuando movés la perilla).
        param.setTargetAtTime(value, this.ctx.currentTime, 0.02);
      }
    }
  }

  /** Prende o apaga el efecto. main.js lo llama cuando el nodo se conecta o se desconecta. */
  setEnabled(on) {
    this.enabled = Boolean(on);
    this.applyMix();
  }

  /**
   * Calcula las ganancias del seco y del húmedo.
   * immediate = true las fija de golpe (al arrancar); si no, las cambia suavecito.
   */
  applyMix(immediate = false) {
    if (!this.dryGain) return; // todavía no hay contexto

    // Hasta que el procesador esté listo (o si está apagado) todo va por el camino seco.
    const wet = this.enabled && this.ready ? this.values.mix / 100 : 0;
    const dry = 1 - wet;

    if (immediate) {
      this.dryGain.gain.value = dry;
      this.wetGain.gain.value = wet;
      return;
    }

    const now = this.ctx.currentTime;
    this.dryGain.gain.setTargetAtTime(dry, now, 0.01);
    this.wetGain.gain.setTargetAtTime(wet, now, 0.01);
  }
}
