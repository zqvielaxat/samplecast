/* =========================================================
   effects/beat-repeater.js — Beat Repeater: el "envoltorio"

   Este archivo es el que conoce la interfaz (main.js): le ofrece setParam() y
   setEnabled(). Por dentro arma el grafo y carga el procesador que hace las
   cuentas (beat-repeater-processor.js).

   GRAFO DEL EFECTO

     input ─┬─► dryGain ─────────────────────────────────────────► output
            │
            └─► [procesador] ──► wetGain ───────────────────────► output

   NO hace falta el "dryDelay" de otros efectos: el Beat Repeater no retrasa la
   señal (repite algo que ya pasó, no guarda audio para soltarlo más tarde), así
   que el seco y el húmedo ya están alineados.

   EL PASO SE MIDE EN MILISEGUNDOS
   -------------------------------
   La perilla "Paso" define directamente cuánto dura el fragmento que se repite,
   en milisegundos (de 20 ms a 1500 ms). Es una medida de TIEMPO puro: no depende
   de un BPM ni de figuras musicales.

       stepSeconds = ms / 1000

   Ejemplos: 250 ms = 0,25 s (cuatro golpes por segundo, un stutter rápido);
   500 ms = 0,5 s (dos por segundo); 125 ms = 0,125 s (ocho por segundo).
   El procesador trabaja con segundos (así se entiende con la frecuencia de
   muestreo), pero la interfaz muestra milisegundos porque son más cómodos de leer.

   IMPORTANTE PARA QUE "ESCUCHE" ANTES DE CONECTARSE
   -------------------------------------------------
   La propiedad `monitors = true` le avisa al motor (audio-engine.js) que este
   efecto necesita recibir audio AUNQUE no esté en la cadena. Sin eso, el nodo
   solo oiría a partir del instante en que lo conectás... que es justo el instante
   en que saca la foto del fragmento, y fotografiaría silencio. Con la escucha,
   su cinta circular siempre está llena de audio fresco y el stutter arranca al toque.

   CUÁNDO SUENA: igual que los demás, solo si su nodo está conectado en el
   tablero. main.js llama a setEnabled(true) al conectarlo: ESE es el momento en
   que el procesador saca la foto del fragmento y empieza a repetirlo.
   ========================================================= */

// El procesador se carga con addModule(). La dirección se calcula desde ESTE
// archivo (import.meta.url), así funciona igual en local y publicado en GitHub
// Pages (la ruta es relativa al módulo, no a la página).
const PROCESSOR_URL = new URL("./beat-repeater-processor.js", import.meta.url).href;

export class BeatRepeaterEffect {
  constructor() {
    this.id = "beat-repeater";

    // Le avisa al motor que este efecto necesita oír el audio aunque esté fuera
    // de la cadena (si no, al conectarlo repetiría silencio: ver el comentario
    // del principio del archivo).
    this.monitors = true;

    // Nodos del grafo. Son null hasta que el motor nos avise que ya existe el
    // AudioContext (método attach): antes de eso no se puede crear ningún nodo.
    this.input = null;
    this.output = null;
    this.dryGain = null;
    this.wetGain = null;
    this.processor = null;

    this.ctx = null;
    this.ready = false;        // ¿terminó de cargar el procesador de audio?
    this.readyPromise = null;
    this.enabled = true;       // ¿está conectado en el tablero?
    this.values = { ms: 250, gate: 100, decay: 0, mix: 100 };
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

    this.input.connect(this.dryGain);
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

      this.processor = new AudioWorkletNode(this.ctx, "beat-repeater");
      // Copiamos al procesador los valores que la interfaz ya tenía. "bpm" y
      // "division" no son parámetros del procesador: se convierten en
      // "stepSeconds" (la cuenta la hace stepSeconds(), acá abajo).
      this.setProcessorParam("gate", this.values.gate, true);
      this.setProcessorParam("decay", this.values.decay, true);
      this.setProcessorParam("stepSeconds", this.stepSeconds(), true);
      this.setProcessorParam("active", this.enabled ? 1 : 0, true);

      this.input.connect(this.processor);
      this.processor.connect(this.wetGain);

      this.ready = true;
      this.applyMix(true); // ahora sí el camino "wet" puede sonar
    } catch (error) {
      // Si esto falla, el efecto queda como un simple "pasar la señal": la app
      // sigue sonando, pero sin el repetidor.
      console.error("No se pudo cargar el procesador del Beat Repeater:", error);
      console.info("Tip: los AudioWorklet no funcionan abriendo index.html con file:// ; usá un servidor local.");
    }
  }

  /* ---------------- La cuenta del paso ---------------- */

  /** Duración de un paso, en segundos: la perilla "Paso" está en milisegundos. */
  stepSeconds() {
    return this.values.ms / 1000;
  }

  /**
   * Manda un valor a un parámetro del procesador.
   * immediate = true lo fija de golpe (al arrancar); si no, lo desliza suavecito
   * para que mover la perilla no produzca saltos.
   */
  setProcessorParam(name, value, immediate = false) {
    if (!this.processor) return;
    const param = this.processor.parameters.get(name);
    if (!param) return;

    if (immediate) {
      param.value = value;
      return;
    }
    param.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }

  /* ---------------- Controles de la interfaz ---------------- */

  /**
   * Cambia un parámetro por su id:
   *   "ms" (20 a 1500) · "gate" (10 a 100 %) · "decay" (0 a 100 %) · "mix" (0 a 100 %)
   */
  setParam(id, value) {
    if (!(id in this.values)) return;
    this.values[id] = value;

    if (id === "mix") {
      this.applyMix();
      return;
    }
    if (id === "ms") {
      // Cambió el largo del paso: recalculamos y mandamos uno solo.
      this.setProcessorParam("stepSeconds", this.stepSeconds());
      return;
    }
    if (id === "gate" || id === "decay") {
      this.setProcessorParam(id, value);
    }
  }

  /**
   * Prende o apaga el efecto. main.js lo llama cuando el nodo se conecta o se
   * desconecta. El 0 → 1 es MUY importante: es el instante en que el procesador
   * saca la foto del fragmento que va a repetir.
   */
  setEnabled(on) {
    this.enabled = Boolean(on);
    // Acá NO usamos setTargetAtTime: queremos que el cambio de estado sea
    // instantáneo (es el "disparador" del efecto), y el procesador ya se encarga
    // de arrancar con un fundido de 3 ms.
    if (this.processor) this.processor.parameters.get("active").value = this.enabled ? 1 : 0;
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
