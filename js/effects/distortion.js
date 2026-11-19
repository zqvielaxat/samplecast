/* =========================================================
   effects/distortion.js — Distortion: el "envoltorio"

   OJO: este efecto NO tiene un archivo "distortion-processor.js", a diferencia
   del Freq Shift y del Binscrambler. No hace falta: la cuenta la hace el
   WaveShaperNode, un nodo que ya viene dentro de la Web Audio API (y encima
   corre en C++, más rápido que un AudioWorklet escrito por nosotros).

   QUÉ ES UNA DISTORSIÓN EN EL DOMINIO DEL TIEMPO
   ----------------------------------------------
   El Freq Shift y el Binscrambler trabajan en el dominio de la FRECUENCIA
   (miran el espectro y lo reordenan o lo corren). La distorsión es lo
   contrario: trabaja MUESTRA POR MUESTRA, en el dominio del TIEMPO.

   La idea entera entra en una frase: agarramos cada muestra y la pasamos por
   una función que "aplasta" los valores grandes. Esa función se llama
   transferencia SIN MEMORIA, porque la salida depende SOLO de la muestra
   actual (no mira las vecinas ni el pasado).

   ¿Por qué cambia el sonido? Porque aplastar los picos ya no es una recta: la
   onda deja de ser una copia fiel de la entrada y aparecen ARMÓNICOS NUEVOS
   (múltiplos de la frecuencia original). Eso es lo que escuchamos como
   "mordida", "rugosidad" o "suciedad".

   ¿Y EL ALIASING? (por qué el oversample="4x")
   --------------------------------------------
   Cuando la onda se aplasta, esos armónicos nuevos siguen hacia arriba: 1 kHz
   genera 2, 3, 4... kHz sin parar. Pero un archivo digital no puede guardar
   frecuencias por encima de la mitad de la frecuencia de muestreo (Nyquist:
   ~24 kHz si el sample es de 48 kHz). Todo lo que se pasa de ese techo no
   "desaparece": SE PLEGA y vuelve a aparecer como un tono FALSO, desafinado y
   que no tiene relación con la nota (por ejemplo 25 kHz vuelve disfrazado de
   23 kHz). Eso es el ALIASING, y una vez que pasó ya no se puede arreglar:
   la basura quedó mezclada con lo demás.

   El WaveShaperNode tiene una salida: la propiedad `oversample`. Con "4x", el
   nodo hace esto por dentro:
     1) SUBE la señal a 4 veces la frecuencia de muestreo (192 kHz): ahí el
        techo de Nyquist también se multiplica por 4 (96 kHz), así que los
        armónicos que antes se plegaban ahora entran de verdad.
     2) Aplasta la onda a esa frecuencia alta, o sea que muchos más armónicos
        se representan bien (no se pliegan).
     3) BAJA de nuevo a la frecuencia original, pero antes de descartar las
        muestras de más le pasa un filtro pasabajos fuerte: lo que todavía
        sobraba por encima de Nyquist se elimina ANTES de que pueda plegarse.
   Resultado: menos aliasing (no cero, porque el filtro no es perfecto) a
   cambio de más trabajo por muestra. Con "none" el efecto suena más "vidrioso"
   y desafinado justamente en los agudos y con drive alto.

   GRAFO DEL EFECTO

     input ─┬─► dryGain ───────────────────────────────────────────────────► output
            │
            └─► shaper ─► swapGain ─► toneFilter ─► levelGain ─► wetGain ──► output
                (4x)

     shaper      WaveShaperNode: aplica la curva (que ya incluye el Drive y el Tipo)
     swapGain    solo se mueve al cambiar el TIPO: evita el clic de ese cambio
     toneFilter  filtro pasabajos = "Tono": recorta el filo de los armónicos
     levelGain   "Nivel" en dB (+ una pequeña compensación automática)
     dryGain/wetGain  Dry/Wet y el encendido/apagado (como en los otros efectos)

   NO HACE FALTA EL "dryDelay": los otros efectos retrasaban su salida (un
   filtro FIR de 401 coeficientes, un cuadro de 2048 muestras) y por eso había
   que retrasar también el camino seco para que no se cancelaran frecuencias al
   mezclar. Estos nodos nativos no agregan retraso, así que se mezclan directo.

   CUÁNDO SUENA: igual que los demás, forma parte de la cadena solo si su nodo
   está conectado en el tablero (main.js llama a setEnabled(true) al conectarlo
   y a setEnabled(false) al desconectarlo).
   ========================================================= */

// Cuántos puntos tiene la tabla de la curva. El WaveShaperNode no guarda una
// fórmula: guarda una TABLA. La muestra que entra se usa como índice y entre
// dos puntos el nodo interpola en línea recta. Con pocos puntos esa recta se
// nota (suena "escalonado"); con 4096 la diferencia es inaudible y la tabla
// sigue siendo chica (16 KB).
const CURVE_POINTS = 4096;

// "Drive": 0 % = x1 (sin distorsión) y 100 % = x32 (unos 30 dB de ganancia).
// Se mapea de forma EXPONENCIAL porque el oído escucha el volumen en dB: así
// cada vuelta de perilla agrega una cantidad parecida de distorsión.
const DRIVE_MAX = 32;

// "Tono": 0 % = 200 Hz (oscuro, sin agudos) y 100 % = 20 kHz (no filtra nada
// audible). También exponencial: las frecuencias se perciben en octavas.
const TONE_MIN_HZ = 200;
const TONE_MAX_HZ = 20000;

// Compensación automática de volumen: con drive al máximo bajamos 6 dB. No
// puede ser exacta (cuánto sube depende del material que suena), así que
// compensamos "la mitad del camino": el resto lo ajustás con la perilla Nivel.
const AUTO_COMP_DB = -6;

// Al cambiar de TIPO la curva cambia de forma de golpe y eso haría un clic.
// Solución: bajamos el volumen del camino húmedo, cambiamos la curva, y lo
// volvemos a subir. Son milisegundos: no se escucha el hueco.
const SWAP_FADE_S = 0.005;   // 5 ms para bajar
const SWAP_RETURN_S = 0.008; // 8 ms para volver
const SWAP_DELAY_MS = 8;     // cuándo cambiamos la curva (ya con el volumen abajo)

/**
 * Las tres funciones de transferencia (x entra entre −1 y 1).
 * Las tres terminan en ±1: el TECHO de salida es el mismo que el de la señal
 * original, así el volumen nunca se dispara por encima de lo que había.
 *   soft → tangente hiperbólica: curva suave, comprime de a poco (lo más musical)
 *   hard → recorte duro: corta en seco, llena de armónicos (lo más agresivo)
 *   fold → wavefolder: cuando la señal pasa de 1 no se recorta, SE DA VUELTA
 *          (rebota hacia adentro). Es el sonido "plegado" de los sintetizadores
 *          west coast: con mucho drive suena metálico, tipo anillo.
 */
const SHAPES = {
  soft: (x) => Math.tanh(x),
  hard: (x) => Math.max(-1, Math.min(1, x)),
  fold: (x) => Math.sin((Math.PI / 2) * x),
};

/** Perilla "Drive" (0 a 100) → ganancia (1 a 32). */
function driveGain(drive) {
  return Math.pow(DRIVE_MAX, drive / 100);
}

/** Perilla "Tono" (0 a 100) → frecuencia del pasabajos, en Hz. */
function toneToHz(tone) {
  return TONE_MIN_HZ * Math.pow(TONE_MAX_HZ / TONE_MIN_HZ, tone / 100);
}

/** Cuántos dB bajamos automáticamente según el drive (de 0 a −6). */
function autoCompensationDb(drive) {
  return AUTO_COMP_DB * (drive / 100);
}

/** dB → ganancia lineal: 0 dB = x1, −6 dB = x0.5, +6 dB = x2. */
function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export class DistortionEffect {
  constructor() {
    this.id = "distortion";

    // Nodos del grafo. Son null hasta que el motor nos avise que ya existe el
    // AudioContext (método attach): antes de eso no se puede crear ningún nodo.
    this.input = null;
    this.output = null;
    this.dryGain = null;
    this.wetGain = null;
    this.shaper = null;       // el WaveShaperNode: acá vive la curva
    this.swapGain = null;     // volumen del húmedo; solo se mueve al cambiar el tipo
    this.toneFilter = null;   // pasabajos = "Tono"
    this.levelGain = null;    // "Nivel" + compensación automática

    this.ctx = null;
    // Este efecto no carga nada asincrónico (no hay AudioWorklet), así que queda
    // listo apenas se arman los nodos. Igual guardamos el dato para que el
    // archivo se lea igual que los otros efectos.
    this.ready = false;
    this.enabled = true;      // ¿está conectado en el tablero?
    this.values = { drive: 50, type: "soft", tone: 100, level: 0, mix: 100 };
    this._swapTimer = null;   // el relojito del cambio de tipo
  }

  /* ---------------- Ciclo de vida ---------------- */

  /**
   * El motor llama a esto cuando el AudioContext ya existe (al cargar el primer
   * sample). Acá construimos todos los nodos y los cableamos.
   */
  attach(ctx) {
    if (this.input) return; // ya estaba armado
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.swapGain = ctx.createGain();
    this.levelGain = ctx.createGain();

    // El WaveShaperNode es el corazón del efecto. `oversample` es la propiedad
    // que se ocupa del aliasing (ver la explicación del principio del archivo).
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = "4x";

    // El filtro de tono: pasabajos con Q = 0.7 (respuesta plana, sin "pico"
    // justo en la frecuencia de corte).
    this.toneFilter = ctx.createBiquadFilter();
    this.toneFilter.type = "lowpass";
    this.toneFilter.Q.value = 0.7;

    // Camino seco: pasa derecho (este efecto no retrasa nada, no hace falta
    // alinearlo como en el Freq Shift o el Binscrambler).
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Camino húmedo: distorsión → tono → nivel.
    this.input.connect(this.shaper);
    this.shaper.connect(this.swapGain);
    this.swapGain.connect(this.toneFilter);
    this.toneFilter.connect(this.levelGain);
    this.levelGain.connect(this.wetGain);
    this.wetGain.connect(this.output);

    // Fijamos de una vez todos los valores que la interfaz ya tenía.
    this.ready = true;
    this.buildCurve();
    this.applyTone(true);
    this.applyLevel(true);
    this.applyMix(true);
  }

  /* ---------------- La curva del WaveShaper ---------------- */

  /**
   * Recalcula la tabla del WaveShaperNode con el Drive y el Tipo actuales.
   *
   * OJO: el Drive se mete DENTRO de la curva (shape(x · ganancia)) en vez de
   * usar un nodo de ganancia antes del shaper. ¿Por qué? Porque el
   * WaveShaperNode solo puede mirar su tabla entre −1 y 1: si la señal llegara
   * más grande, la recortaría contra los bordes de la tabla y el wavefolder
   * (que necesita seguir "plegando" más allá de 1) dejaría de funcionar bien.
   * Metiendo el drive en la tabla, la tabla cubre todo el recorrido posible.
   */
  buildCurve() {
    if (!this.shaper) return;

    const gain = driveGain(this.values.drive);
    const shape = SHAPES[this.values.type] ?? SHAPES.soft; // si el id es raro, usamos soft

    const curve = new Float32Array(CURVE_POINTS);
    for (let i = 0; i < CURVE_POINTS; i++) {
      const x = (i / (CURVE_POINTS - 1)) * 2 - 1; // de −1 a 1, repartido en la tabla
      curve[i] = shape(x * gain);
    }
    this.shaper.curve = curve;
  }

  /* ---------------- Controles de la interfaz ---------------- */

  /**
   * Cambia un parámetro por su id:
   *   "drive" (0 a 100) · "type" ("soft" | "hard" | "fold") · "tone" (0 a 100)
   *   "level" (−24 a 24 dB) · "mix" (0 a 100)
   */
  setParam(id, value) {
    if (!(id in this.values)) return;
    this.values[id] = value;

    if (id === "mix") {
      this.applyMix();
      return;
    }
    if (!this.ctx) return; // todavía no hay AudioContext: guardamos el valor y listo

    if (id === "drive") {
      this.buildCurve();  // la curva ya lleva el drive adentro
      this.applyLevel();  // y la compensación automática depende del drive
      return;
    }
    if (id === "type") {
      this.swapType();    // este es el único cambio que necesita el "fundido"
      return;
    }
    if (id === "tone") {
      this.applyTone();
      return;
    }
    if (id === "level") {
      this.applyLevel();
    }
  }

  /** Prende o apaga el efecto. main.js lo llama cuando el nodo se conecta o se desconecta. */
  setEnabled(on) {
    this.enabled = Boolean(on);
    this.applyMix();
  }

  /**
   * Cambia el tipo SIN que se escuche el clic: bajamos el volumen del camino
   * húmedo unos milisegundos, cambiamos la curva en ese silencio, y lo volvemos
   * a subir. El camino seco (y el resto de la app) siguen sonando normalmente.
   */
  swapType() {
    if (!this.swapGain) return;

    const now = this.ctx.currentTime;
    const volume = this.swapGain.gain;
    volume.cancelScheduledValues(now);
    volume.setValueAtTime(volume.value, now);
    volume.linearRampToValueAtTime(0, now + SWAP_FADE_S);

    // Si el usuario cambia el tipo dos veces seguidas, cancelamos el cambio
    // anterior: así manda siempre el último.
    clearTimeout(this._swapTimer);
    this._swapTimer = setTimeout(() => {
      this.buildCurve();

      const later = this.ctx.currentTime;
      volume.cancelScheduledValues(later);
      volume.setValueAtTime(0, later);
      volume.linearRampToValueAtTime(1, later + SWAP_RETURN_S);
    }, SWAP_DELAY_MS);
  }

  /** Tono: mueve la frecuencia del pasabajos. */
  applyTone(immediate = false) {
    if (!this.toneFilter) return;
    const hz = toneToHz(this.values.tone);

    if (immediate) {
      this.toneFilter.frequency.value = hz;
      return;
    }
    // setTargetAtTime = pequeña transición (~20 ms) en vez de un salto brusco.
    this.toneFilter.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }

  /** Nivel: volumen de salida en dB, más la compensación automática del drive. */
  applyLevel(immediate = false) {
    if (!this.levelGain) return;
    const db = this.values.level + autoCompensationDb(this.values.drive);
    const gain = dbToGain(db);

    if (immediate) {
      this.levelGain.gain.value = gain;
      return;
    }
    this.levelGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  /**
   * Calcula las ganancias del seco y del húmedo.
   * immediate = true las fija de golpe (al arrancar); si no, las cambia suavecito.
   */
  applyMix(immediate = false) {
    if (!this.dryGain) return; // todavía no hay contexto

    // Hasta que esté listo (o si está apagado) todo va por el camino seco.
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
