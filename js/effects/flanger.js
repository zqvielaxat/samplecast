/* =========================================================
   effects/flanger.js — Flanger: un "peine" de retardos modulado por un LFO

   Es un efecto NATIVO: no necesita AudioWorklet (igual que la Distortion). Lo
   armamos solo con nodos que ya trae la Web Audio API.

   QUÉ ES UN FLANGER
   -----------------
   Un flanger mezcla la señal original (DRY) con una copia suya retrasada unos
   pocos milisegundos (WET). Al sumar una onda con esa copia, algunas frecuencias
   se cancelan y otras se refuerzan: se forma un "peine" de picos/muescas en el
   espectro. Si además ese retardo CAMBIA de tamaño todo el tiempo, el peine se
   mueve y escuchamos el barrido espacial típico de "avión pasando".

   El retardo lo mueve un LFO (Low Frequency Oscillator): un oscilador muy lento
   (fracciones de Hz) cuya onda senoidal empuja el tiempo del delay hacia arriba
   y hacia abajo. Por eso nuestras perillas son:

     rate     → qué tan rápido barre el LFO (Hz)
     depth    → cuánto estira/encoge el retardo (ms) = qué tan ancho es el barrido
     feedback → cuánta salida vuelve a entrar al delay (resonancia del peine)
     mix      → Dry/Wet (fader estándar, como en todos los efectos)

   GRAFO
   -----
     input ─┬─► dryGain ──────────────────────────────► output
            └─► delay ──► wetGain ───────────────► output
                ▲   │
                │   └─► feedback ──► (vuelve al delay)
                │
                └── lfoDepth ◄── lfo (OscillatorNode senoidal)

   CUÁNDO SUENA: forma parte de la cadena solo si su nodo está conectado en el
   tablero (main.js llama a setEnabled(true) al conectarlo). Apagado, pasa todo
   por el camino seco.
   ========================================================= */

// Retardo base del peine (en milisegundos). Es el centro alrededor del cual
// barre el LFO. Con 4 ms de base y 3,5 ms de profundidad, el retardo total va
// de 0,5 ms a 7,5 ms: el rango clásico de un flanger.
const FLANGE_BASE_MS = 4;

// Tope de la realimentación. Si dejáramos llegar el feedback a 1.0, la señal
// podría realimentarse sin parar y "explotar". Con 0.9 queda resonante pero
// controlada.
const FLANGE_FEEDBACK_MAX = 0.9;

export class FlangerEffect {
  constructor() {
    this.id = "flanger";

    // Nodos del grafo. Son null hasta que el motor nos avise que ya existe el
    // AudioContext (método attach): antes no se puede crear ningún nodo.
    this.input = null;
    this.output = null;
    this.dryGain = null;
    this.wetGain = null;
    this.delay = null;
    this.feedback = null;
    this.lfo = null;
    this.lfoDepth = null;

    this.ctx = null;
    this.ready = false;       // queda true apenas se arman los nodos (no hay worklet)
    this.enabled = true;      // ¿está conectado en el tablero?
    // Estos valores DEBEN coincidir con los del catálogo (registry.js).
    this.values = { rate: 0.3, depth: 2, feedback: 50, mix: 100 };
  }

  /* ---------------- Ciclo de vida ---------------- */

  /** El motor llama a esto cuando el AudioContext ya existe. Acá armamos todo. */
  attach(ctx) {
    if (this.input) return; // ya estaba armado
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    // El DelayNode guarda la señal y la suelta milisegundos después. Con 0.1 s de
    // "buffer" alcanza de sobra para los retardos cortos de un flanger.
    this.delay = ctx.createDelay(0.1);
    this.delay.delayTime.value = FLANGE_BASE_MS / 1000;

    // La realimentación: un GainNode que lleva parte de la salida del delay de
    // vuelta a su entrada. Al pasar de nuevo por el delay, ese eco se suma al
    // peine y lo vuelve resonante/afilado.
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.45; // 50 % → 0.9 * 0.5

    // Camino seco: pasa derecho (no hace falta alinearlo porque el "desfase" del
    // wet ES justamente lo que produce el efecto de peine).
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Camino húmedo: delay → wetGain, más el lazo de realimentación.
    this.input.connect(this.delay);
    this.delay.connect(this.wetGain);
    this.wetGain.connect(this.output);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);

    // LFO: oscilador senoidal lento. Su salida (entre −1 y 1) pasa por lfoDepth,
    // que le da la amplitud en segundos, y de ahí va al AudioParam delayTime:
    // el valor base del delay se suma con esta onda → el retardo "respira".
    this.lfo = ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = 0.3;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 2 / 1000; // 2 ms
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.delay.delayTime);
    this.lfo.start(); // un oscilador nace "apagado"; hay que arrancarlo

    this.ready = true;
    this.applyRate(true);
    this.applyDepth(true);
    this.applyFeedback(true);
    this.applyMix(true);
  }

  /* ---------------- Controles de la interfaz ---------------- */

  /** Cambia un parámetro por su id: "rate" | "depth" | "feedback" | "mix". */
  setParam(id, value) {
    if (!(id in this.values)) return;
    this.values[id] = value;

    if (id === "mix") {
      this.applyMix();
      return;
    }
    if (!this.ctx) return; // todavía no hay AudioContext: guardamos el valor y listo

    if (id === "rate") this.applyRate();
    else if (id === "depth") this.applyDepth();
    else if (id === "feedback") this.applyFeedback();
  }

  /** Prende o apaga el efecto. main.js lo llama al conectar/desconectar el nodo. */
  setEnabled(on) {
    this.enabled = Boolean(on);
    this.applyMix();
  }

  /** Rate: velocidad del LFO en Hz. */
  applyRate(immediate = false) {
    if (!this.lfo) return;
    if (immediate) {
      this.lfo.frequency.value = this.values.rate;
      return;
    }
    // setTargetAtTime = pequeño deslizamiento (~20 ms) en vez de un salto brusco.
    this.lfo.frequency.setTargetAtTime(this.values.rate, this.ctx.currentTime, 0.02);
  }

  /** Depth: cuántos milisegundos sube/baja el retardo alrededor del centro. */
  applyDepth(immediate = false) {
    if (!this.lfoDepth) return;
    const seconds = this.values.depth / 1000;
    if (immediate) {
      this.lfoDepth.gain.value = seconds;
      return;
    }
    this.lfoDepth.gain.setTargetAtTime(seconds, this.ctx.currentTime, 0.02);
  }

  /** Feedback: cuánta señal realimentamos (0 a 100, internamente tope 0.9). */
  applyFeedback(immediate = false) {
    if (!this.feedback) return;
    const gain = (this.values.feedback / 100) * FLANGE_FEEDBACK_MAX;
    if (immediate) {
      this.feedback.gain.value = gain;
      return;
    }
    this.feedback.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  /** Dry/Wet: cuánta señal original (dry) y cuánta procesada (wet) se suman. */
  applyMix(immediate = false) {
    if (!this.dryGain) return; // todavía no hay contexto

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