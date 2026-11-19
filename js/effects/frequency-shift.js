/* =========================================================
   effects/frequency-shift.js — Frequency Shift: el "envoltorio"

   Este archivo es el que conoce la interfaz (main.js): le ofrece dos métodos,
   setParam() y setEnabled(). Por dentro arma el grafo de nodos y carga el
   procesador que hace las cuentas (frequency-shift-processor.js).

   GRAFO DEL EFECTO (siempre son los mismos 5 nodos):

     input ─┬─► dryDelay ──► dryGain ──┐
            │                           ├─► output
            └─► [procesador] ──► wetGain ┘

   "Dry" = señal original (sin efecto), "Wet" = señal procesada. El parámetro
   Dry/Wet decide cuánta de cada una se suma. El dryDelay retrasa el camino seco
   exactamente lo mismo que el filtro del procesador: si no lo hiciéramos, al
   mezclar ambas señales se cancelarían algunas frecuencias (efecto peine).

   CUÁNDO SUENA: este efecto forma parte de la cadena solo si su nodo está
   conectado en el tablero (main.js llama a setEnabled(true) al conectarlo y a
   setEnabled(false) al desconectarlo). Si el efecto está apagado o el procesador
   todavía no se cargó, dryGain = 1 y wetGain = 0: la señal atraviesa sin cambios.
   ========================================================= */

// El procesador se carga con addModule(). Calculamos su dirección a partir de la
// dirección de ESTE archivo, así funciona sin importar en qué carpeta esté la página.
const PROCESSOR_URL = new URL("./frequency-shift-processor.js", import.meta.url).href;

// Debe coincidir con FIR_LENGTH del procesador (su retardo interno, en muestras).
const FIR_LENGTH = 401;
const ALIGN_DELAY_SAMPLES = (FIR_LENGTH - 1) / 2;

export class FrequencyShiftEffect {
  constructor() {
    this.id = "frequency-shift";

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
    this.enabled = true;       // estado del interruptor de la tarjeta
    this.values = { shift: 0, mix: 100 }; // valores actuales de los parámetros
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

    // DelayNode con un máximo de 50 ms, de sobra para retrasar ~2 ms.
    this.dryDelay = ctx.createDelay(0.05);
    this.dryDelay.delayTime.value = ALIGN_DELAY_SAMPLES / ctx.sampleRate;

    this.input.connect(this.dryDelay);
    this.dryDelay.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);

    this.applyMix(true); // fija las ganancias de una vez (todavía no suena nada)

    // Cargar el procesador es asincrónico (hay que descargar un archivo). Guardamos
    // la promesa para poder esperarla, por ejemplo desde una prueba automática.
    this.readyPromise = this.loadProcessor();
  }

  /** Descarga el módulo del AudioWorklet y crea el nodo procesador. */
  async loadProcessor() {
    try {
      await this.ctx.audioWorklet.addModule(PROCESSOR_URL);

      this.processor = new AudioWorkletNode(this.ctx, "frequency-shift");
      this.processor.parameters.get("shift").value = this.values.shift;

      this.input.connect(this.processor);
      this.processor.connect(this.wetGain);

      this.ready = true;
      this.applyMix(true); // ahora sí el camino "wet" puede sonar
    } catch (error) {
      // Si esto falla, el efecto queda como un simple "pasar la señal": la app
      // sigue sonando, pero sin el desplazamiento de frecuencia.
      console.error("No se pudo cargar el procesador del Frequency Shift:", error);
      console.info("Tip: los AudioWorklet no funcionan abriendo index.html con file:// ; usá un servidor local.");
    }
  }

  /* ---------------- Controles de la interfaz ---------------- */

  /** Cambia un parámetro por su id: "shift" (Hz) o "mix" (0 a 100). */
  setParam(id, value) {
    if (!(id in this.values)) return;
    this.values[id] = value;

    if (id === "shift" && this.processor) {
      // setTargetAtTime hace un pequeño "deslizamiento" hasta el valor nuevo,
      // en vez de un salto brusco. Suena mucho más natural al mover el slider.
      const param = this.processor.parameters.get("shift");
      param.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    }

    if (id === "mix") this.applyMix();
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