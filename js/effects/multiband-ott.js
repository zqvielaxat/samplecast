/* =========================================================
   effects/multiband-ott.js — Multiband OTT: el "envoltorio"

   Este archivo es el que conoce la interfaz (main.js): le ofrece setParam() y
   setEnabled(). Por dentro arma el grafo de nodos, el cruce de 3 bandas y carga
   las tres instancias del procesador (multiband-ott-processor.js).

   DE QUÉ SE TRATA EL EFECTO
   -------------------------
   "OTT" (por Over The Top) es un compresor multibanda que no solo aplasta lo
   fuerte (compresión descendente) sino que ADEMÁS sube lo suave (compresión
   ascendente). El resultado es un sonido denso, brillante y con muy poca
   dinámica. Para eso dividimos la señal en 3 bandas y cada banda tiene su
   propio procesador de dinámica (graves lentos, agudos rápidos).

   EL CRUCE DE 3 BANDAS (Linkwitz-Riley de 4.º orden)
   --------------------------------------------------
   Repartimos la señal con dos frecuencias de cruce (graves/medios y
   medios/agudos). Cada filtro Linkwitz-Riley de 4.º orden se arma poniendo EN
   CASCADA dos filtros Butterworth de 2.º orden (un biquad nativo, con la Q
   clásica de Butterworth: 1/√2 ≈ 0,7071).

       graves:  entrada → LP(f1)          (dos pasabajos en cascada)
       medios:  entrada → HP(f1) → LP(f2) (pasa-altos + pasa-bajos)
       agudos:  entrada → HP(f2)          (dos pasa-altos en cascada)

   SUMA PLANA (por qué no hace falta "compensar fase")
   ---------------------------------------------------
   La propiedad clave de un par Linkwitz-Riley es: al SUMAR el pasa-bajos y el
   pasa-altos de un mismo cruce, el resultado es un filtro TODO-PASO (all-pass):
   su MAGNITUD es perfectamente plana (0 dB en todas las frecuencias), aunque
   rote la FASE cerca del cruce. La fórmula para LR4 es:

       LP(s) + HP(s) = (s² − √2·s + 1) / (s² + √2·s + 1)

   que es un todo-paso clásico (numerador y denominador son espejo). Por eso, con
   la compresión neutralizada (Depth 0, ganancias 0), la suma de las tres bandas
   tiene la MISMA curva de energía que la señal original: no hay huecos ni picos
   en los cruces. Queda una pequeña rotación de fase alrededor de 120 Hz y
   2500 Hz, pero es inaudible para el oído en la práctica.

   (Esta cuenta se verifica numéricamente en check/multiband-ott-check.js.)

   GRAFO DEL EFECTO
   ----------------
      input ─┬─► dryGain ─────────────────────────────────────────────► output
              │
              └─► [cruce 3 bandas] ─► [worklet por banda] ─► [ganancia banda]
                                       (graves/medios/agudos)
                    └──────────────────────► sumGain ─► outGain
                                                 ─► limitador (WaveShaper)
                                                 ─► wetGain ─► output

      dryGain/wetGain  Dry/Wet con "potencia constante" (ver applyMix)
      limitador        saturador suave: por debajo de ~0 dBFS es transparente,
                       por encima dobla suave hasta nunca pasar de 0 dBFS.

   EL CAMINO SECO NO SE RETRASA: los biquads y los worklets de este efecto
   procesan la muestra "al instante" (no acumulan un buffer de, por ejemplo,
   2048 muestras como el Binscrambler), así que el seco y el húmedo quedan
   ALINEADOS EN EL TIEMPO. La única diferencia es la rotación de fase de los
   cruces: a mezclas Dry/Wet intermedias puede aparecer una cancelación sutil
   justo en 120 Hz / 2500 Hz (limitación honesta de este diseño; a 100 % wet no
   importa). El cruce en "potencia constante" evita el salto de volumen al mover
   el fader.

   CUÁNDO SUENA: igual que los demás efectos, forma parte de la cadena solo si su
   nodo está conectado (main.js llama a setEnabled(true/false)). El paso a on/off
   se hace con un fundido corto en applyMix (sin clics).
   ========================================================= */
import { MULTIBAND_OTT_PRESETS } from "./multiband-ott-presets.js";
import { applyPresetValues, markPresetCustom } from "./presets.js";

// El procesador se carga con addModule(); la ruta es relativa a ESTE archivo.
const PROCESSOR_URL = new URL("./multiband-ott-processor.js", import.meta.url).href;

// ---- Frecuencias de cruce (fáciles de cambiar) ----
const LOW_CROSSOVER = 120;   // Hz — frontera graves/medios
const HIGH_CROSSOVER = 2500; // Hz — frontera medios/agudos

// Q de Butterworth: la que hace que cada biquad de 2.º orden sea "máximamente
// plano" y el par LP+HP de un Linkwitz-Riley sume 0 dB.
const BUTTER_Q = Math.SQRT1_2; // 1/√2 ≈ 0,7071

// ---- Tiempos base por banda (graves lentos, agudos rápidos) ----
// El parámetro "Time" (0..100) los estira o encoge en el procesador.
const BANDS = [
  { key: "low",  attack: 0.030, release: 0.450 }, // graves: lentos
  { key: "mid",  attack: 0.012, release: 0.200 },
  { key: "high", attack: 0.003, release: 0.080 }, // agudos: rápidos
];

// ---- Limitador suave de salida (WaveShaper) ----
// Por debajo de LIMITER_KNEE la curva es la identidad (no toca nada); por encima
// se dobla suave (tanh) y se acerca a 1.0 sin pasarse jamás de 0 dBFS.
const LIMITER_POINTS = 4096;  // puntos de la tabla (igual que la Distortion)
const LIMITER_KNEE = 0.98;    // ≈ −0,18 dBFS: de acá para abajo sale derecho
const LIMITER_HEADROOM = 4;   // cubre entradas hasta ±4 (≈ +12 dB) sin recorte duro

/** dB → ganancia lineal (0 dB = x1). */
function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * Curva del saturador suave. Recibe la amplitud real (puede pasar de 1) y
 * devuelve una amplitud que nunca excede ~1.0:
 *   |x| ≤ KNEE           → x exacto (transparente)
 *   |x| > KNEE           → KNEE + (1−KNEE)·tanh((|x|−KNEE)/(1−KNEE))
 */
function softLimit(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  if (a <= LIMITER_KNEE) return x;
  const span = 1 - LIMITER_KNEE;
  return sign * (LIMITER_KNEE + span * Math.tanh((a - LIMITER_KNEE) / span));
}

/**
 * Construye la tabla del WaveShaper. El shaper lee un índice entre −1 y 1, así
 * que "encogemos" la entrada con un GainNode de 1/LIMITER_HEADROOM y acá
 * deshacemos ese encogimiento: índice `i` (de −1 a 1) corresponde a la amplitud
 * real `i · LIMITER_HEADROOM`.
 */
function buildLimiterCurve() {
  const curve = new Float32Array(LIMITER_POINTS);
  for (let i = 0; i < LIMITER_POINTS; i++) {
    const index = (i / (LIMITER_POINTS - 1)) * 2 - 1; // −1..1
    curve[i] = softLimit(index * LIMITER_HEADROOM);
  }
  return curve;
}
export class MultibandOttEffect {
  constructor() {
    this.id = "multiband-ott";

    // Nodos del grafo. Son null hasta que el motor nos avise que ya existe el
    // AudioContext (método attach): antes de eso no se puede crear ningún nodo.
    this.input = null;
    this.output = null;
    this.dryGain = null;
    this.wetGain = null;
    this.sumGain = null;
    this.outGain = null;
    this.limiterPreGain = null; // "encoge" la entrada antes del WaveShaper
    this.limiterShaper = null;

    this.bandSignals = null; // { low, mid, high } → salida del cruce de cada banda
    this.bandGains = {};     // { low, mid, high } → GainNode (Low/Mid/High dB)
    this.worklets = {};      // { low, mid, high } → AudioWorkletNode

    this.ctx = null;
    this.ready = false;        // ¿terminó de cargar el procesador de audio?
    this.readyPromise = null;
    this.enabled = true;       // ¿está conectado en el tablero?

    // Valores visibles: coinciden con el preset "Neutro".
    this.values = { depth: 0, time: 50, low: 0, mid: 0, high: 0, out: 0, mix: 100 };
    // Valores OCULTOS (los usa cada preset; no aparecen en la tarjeta).
    this.internal = { up: 1, down: 1, inv: 0 };

    this.presetId = "neutro";  // qué preset está elegido ("custom" = ajuste manual)
    this.onUiSync = null;      // main.js: "cambió un valor, espejá la tarjeta"
  }

  /* ---------------- Ciclo de vida ---------------- */

  /**
   * El motor llama a esto cuando el AudioContext ya existe. Acá construimos los
   * nodos y empezamos a cargar el procesador (asincrónico).
   */
  attach(ctx) {
    if (this.input) return; // ya estaba armado
    this.ctx = ctx;

    // Nodos base.
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.sumGain = ctx.createGain();
    this.outGain = ctx.createGain();

    // Limitador suave: un GainNode que encoge la entrada a ±1 (tabla del
    // WaveShaper) y el WaveShaper con la curva de saturador construida arriba.
    this.limiterPreGain = ctx.createGain();
    this.limiterPreGain.gain.value = 1 / LIMITER_HEADROOM;
    this.limiterShaper = ctx.createWaveShaper();
    this.limiterShaper.curve = buildLimiterCurve();

    // Camino seco: pasa derecho (no hay retardo que alinear).
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Cruce de 3 bandas.
    this.bandSignals = this._buildCrossover();

    // Por cada banda, creamos su ganancia (Low/Mid/High) y la conectamos a la
    // suma. El worklet de dinámica se crea más tarde (loadProcessor), porque
    // antes hay que descargar su módulo.
    for (const band of BANDS) {
      const gain = ctx.createGain();
      this.bandGains[band.key] = gain;
      gain.connect(this.sumGain);
    }

    // Suma → salida → limitador → wet.
    this.sumGain.connect(this.outGain);
    this.outGain.connect(this.limiterPreGain);
    this.limiterPreGain.connect(this.limiterShaper);
    this.limiterShaper.connect(this.wetGain);
    this.wetGain.connect(this.output);

    // Fijamos lo que ya se puede fijar (todavía no suena nada).
    this._pushAll(true);

    // Cargar el procesador es asincrónico (hay que descargar un archivo).
    this.readyPromise = this.loadProcessor();
  }

  /**
   * Arma los filtros del cruce Linkwitz-Riley de 4.º orden y devuelve las tres
   * señales (low, mid, high) sin procesar todavía.
   */
  _buildCrossover() {
    const ctx = this.ctx;
    const makeLP = (freq) => {
      const b = ctx.createBiquadFilter();
      b.type = "lowpass";
      b.frequency.value = freq;
      b.Q.value = BUTTER_Q;
      return b;
    };
    const makeHP = (freq) => {
      const b = ctx.createBiquadFilter();
      b.type = "highpass";
      b.frequency.value = freq;
      b.Q.value = BUTTER_Q;
      return b;
    };

    // graves: input → LP(f1) ×2
    const lowLP1 = makeLP(LOW_CROSSOVER);
    const lowLP2 = makeLP(LOW_CROSSOVER);
    this.input.connect(lowLP1);
    lowLP1.connect(lowLP2);

    // medios: input → HP(f1) ×2 → LP(f2) ×2
    const midHP1 = makeHP(LOW_CROSSOVER);
    const midHP2 = makeHP(LOW_CROSSOVER);
    const midLP1 = makeLP(HIGH_CROSSOVER);
    const midLP2 = makeLP(HIGH_CROSSOVER);
    this.input.connect(midHP1);
    midHP1.connect(midHP2);
    midHP2.connect(midLP1);
    midLP1.connect(midLP2);

    // agudos: input → HP(f2) ×2
    const highHP1 = makeHP(HIGH_CROSSOVER);
    const highHP2 = makeHP(HIGH_CROSSOVER);
    this.input.connect(highHP1);
    highHP1.connect(highHP2);

    return { low: lowLP2, mid: midLP2, high: highHP2 };
  }

  /** Descarga el módulo del AudioWorklet y crea las tres instancias por banda. */
  async loadProcessor() {
    try {
      await this.ctx.audioWorklet.addModule(PROCESSOR_URL);

      for (const band of BANDS) {
        // Cada banda nace con SUS tiempos base (graves lentos, agudos rápidos),
        // que viajan en processorOptions.
        const worklet = new AudioWorkletNode(this.ctx, "multiband-ott", {
          processorOptions: { attackBase: band.attack, releaseBase: band.release },
        });
        this.worklets[band.key] = worklet;
        this.bandSignals[band.key].connect(worklet);
        worklet.connect(this.bandGains[band.key]);
      }

      this.ready = true;
      this._pushAll(true); // ahora sí se envían Depth/Time y los internos
    } catch (error) {
      // Si esto falla, el efecto queda como un simple "pasar la señal": la app
      // sigue sonando, pero sin la compresión multibanda.
      console.error("No se pudo cargar el procesador del Multiband OTT:", error);
      console.info("Tip: los AudioWorklet no funcionan abriendo index.html con file:// ; usá un servidor local.");
    }
  }
/* ---------------- Envío de valores a los nodos ---------------- */

  /** Envía un dB a la ganancia de una banda (Low/Mid/High). */
  _pushBandGain(key, db, immediate = false) {
    const node = this.bandGains[key];
    if (!node) return;
    const gain = dbToGain(db);
    if (immediate) node.gain.value = gain;
    else node.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  /** Envía el valor de salida (Out, en dB). */
  _pushOut(immediate = false) {
    if (!this.outGain) return;
    const gain = dbToGain(this.values.out);
    if (immediate) this.outGain.gain.value = gain;
    else this.outGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  /** Envía UN valor a las TRES instancias del procesador (por su nombre). */
  _pushProcessorParam(name, value, immediate = false) {
    for (const band of BANDS) {
      const worklet = this.worklets[band.key];
      if (!worklet) continue;
      const param = worklet.parameters.get(name);
      if (!param) continue;
      if (immediate) param.value = value;
      else param.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    }
  }

  /** Envía TODO el estado actual a los nodos. */
  _pushAll(immediate = false) {
    this._pushBandGain("low", this.values.low, immediate);
    this._pushBandGain("mid", this.values.mid, immediate);
    this._pushBandGain("high", this.values.high, immediate);
    this._pushOut(immediate);
    if (this.ready) {
      this._pushProcessorParam("depth", this.values.depth / 100, immediate);
      this._pushProcessorParam("time", this.values.time / 100, immediate);
      this._pushProcessorParam("up", this.internal.up, immediate);
      this._pushProcessorParam("down", this.internal.down, immediate);
      this._pushProcessorParam("inv", this.internal.inv, immediate);
    }
    this.applyMix(immediate);
  }

  /* ---------------- Controles de la interfaz ---------------- */

  /**
   * Cambia un parámetro por su id. "preset" es especial: aplica un preset
   * completo; el resto son los controles visibles.
   */
  setParam(id, value) {
    if (id === "preset") {
      this.applyPreset(value);
      return;
    }
    if (!(id in this.values)) return;
    this.values[id] = value;
    markPresetCustom(this); // cualquier ajuste manual sale del preset

    if (id === "mix") this.applyMix();
    else if (id === "out") this._pushOut();
    else if (id === "low" || id === "mid" || id === "high") this._pushBandGain(id, value);
    else if (id === "depth" && this.ready) this._pushProcessorParam("depth", value / 100);
    else if (id === "time" && this.ready) this._pushProcessorParam("time", value / 100);

    if (this.onUiSync) this.onUiSync();
  }

  /** Aplica un preset completo (valores visibles + internos). */
  applyPreset(id) {
    const preset = applyPresetValues(this, MULTIBAND_OTT_PRESETS, id, { up: 1, down: 1, inv: 0 });
    if (!preset) return;

    this._pushAll();

    if (this.onUiSync) this.onUiSync();
  }

  /** Prende o apaga el efecto. main.js lo llama al conectar/desconectar el nodo. */
  setEnabled(on) {
    this.enabled = Boolean(on);
    this.applyMix();
  }

  /**
   * Calcula las ganancias del seco y del húmedo con POTENCIA CONSTANTE.
   *
   * En vez de un cruce lineal (dry = 1 − wet), usamos seno y coseno del ángulo
   * que marca el fader:
   *      wet = sin(θ) · (efecto activo ? 1 : 0) ,  dry = cos(θ)
   * con θ = (mix/100) · 90°. Como sin² + cos² = 1 en todo momento, la energía
   * total se mantiene y el fader no produce el "hueco" de −3 dB que tendría un
   * cruce lineal justo a la mitad.
   */
  applyMix(immediate = false) {
    if (!this.dryGain) return; // todavía no hay contexto

    const active = this.enabled && this.ready;
    const angle = (this.values.mix / 100) * (Math.PI / 2);
    const wet = active ? Math.sin(angle) : 0;
    const dry = active ? Math.cos(angle) : 1;

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