/* =========================================================
   bin-scrambler-processor.js — las "cuentas" del efecto Binscrambler

   ¡ATENCIÓN! Igual que frequency-shift-processor.js, este archivo corre dentro
   del AudioWorklet: NO es un módulo (nada de import/export), no hay window ni
   document, y el audio llega en bloques de 128 muestras.

   QUÉ HACE EL EFECTO
   ------------------
   Este efecto trabaja en el dominio de la FRECUENCIA (es "espectral"), no
   muestra por muestra. La receta es:

     1) Cortar el audio en CUADROS de 2048 muestras que se solapan a la mitad.
     2) Convertir cada cuadro al dominio de la frecuencia con una FFT. Eso nos
        deja 1025 "bins": cajitas que dicen cuánto hay de cada frecuencia
        (a 48 kHz cada cajita ocupa ~23 Hz).
     3) REORDENAR los bins: lo que había en un bin se muda a otro bin. Eso es lo
        que rompe el sonido: las frecuencias quedan en otro lado, pero la
        energía se conserva, porque reordenar es una PERMUTACIÓN (cada bin va a
        un lugar y ningún bin queda vacío ni repetido).
     4) Volver al dominio del tiempo con la FFT inversa y pegar los cuadros de
        nuevo (sumándolos donde se solapan: "overlap-add").

   La permutación se genera ordenando los bins por una clave al azar: cuanto más
   grande es "Intensidad", más se desordena esa clave. Con Intensidad = 0 el
   orden es el original (no pasa nada). Con 100 el orden queda casi al azar.

   Detalle importante: los bins guardan NÚMEROS COMPLEJOS (magnitud y fase) y
   los mudamos completos, con su fase. Como esa fase "corresponde" a la
   frecuencia vieja y no a la nueva, el resultado suena borroso, soplado y
   metálico. Eso es justamente lo que buscamos en un efecto glitch.

   POR QUÉ LA VENTANA ES "RAÍZ DE HANN"
   ------------------------------------
   Para que al solapar los cuadros la señal se reconstruya SIN ondulaciones, la
   suma de las ventanas (por la ventana) tiene que dar 1 en todo momento. Con
   ventana raíz-de-Hann en el análisis y en la síntesis, el producto es Hann, y
   la suma de Hann solapada al 50 % vale exactamente 1. Por eso el efecto, con
   Intensidad 0, devuelve la señal intacta (solo que retrasada 2048 muestras).
   ========================================================= */

const FRAME = 2048;         // tamaño del cuadro, en muestras
const HOP = FRAME / 2;      // cada cuántas muestras se calcula un cuadro nuevo
const HALF = FRAME / 2;     // bins del lado "positivo" (sin contar el de Nyquist)
const TAU = Math.PI * 2;

/**
 * Ventana raíz de Hann: empieza y termina en 0 (sin saltos) y, multiplicada por
 * sí misma, da Hann. Se usa para el análisis y para la síntesis.
 */
function buildWindow(size) {
  const window = new Float32Array(size);
  for (let n = 0; n < size; n++) {
    const hann = 0.5 * (1 - Math.cos((TAU * n) / size));
    window[n] = Math.sqrt(hann);
  }
  return window;
}

/**
 * FFT (transformada rápida de Fourier) escrita a mano, "radix 2".
 *
 * Qué hace: agarra `size` números complejos (en los arreglos re e im) y devuelve
 * la misma cantidad de números complejos, que dicen "cuánto hay de cada
 * frecuencia". Con inverse = true hace el camino al revés (vuelve al tiempo).
 *
 * Cómo funciona: reordena las muestras con la "inversión de bits" y después
 * combina pares de valores en etapas (esas combinaciones se llaman "mariposas").
 * Es el algoritmo clásico de Cooley-Tukey: O(n·log n) en vez de O(n²).
 */
class FFT {
  constructor(size) {
    this.size = size;
    const bits = Math.round(Math.log2(size));

    // Tabla de inversión de bits: rev[i] = el número i con sus bits al revés
    this.rev = new Uint16Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }

    // Cosenos y senos del "twiddle factor" e^(-2πi·k/size), precalculados
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let k = 0; k < size / 2; k++) {
      this.cos[k] = Math.cos((-TAU * k) / size);
      this.sin[k] = Math.sin((-TAU * k) / size);
    }
  }

  /** Transforma en el lugar: modifica re e im. */
  transform(re, im, inverse) {
    const n = this.size;

    // 1) Reordenar (si no, las mariposas no combinan los pares correctos)
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let temp = re[i]; re[i] = re[j]; re[j] = temp;
        temp = im[i]; im[i] = im[j]; im[j] = temp;
      }
    }

    // 2) Mariposas: en cada etapa combinamos bloques cada vez más grandes
    for (let len = 2; len <= n; len *= 2) {
      const half = len / 2;
      const step = n / len;              // cada cuántos twiddles avanzamos
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const twiddle = k * step;
          const wr = this.cos[twiddle];
          // La transformada inversa usa el conjugado (seno al revés)
          const wi = inverse ? -this.sin[twiddle] : this.sin[twiddle];

          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;

          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }

    // 3) La inversa viene sin normalizar: hay que dividir por n
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }
}

/**
 * Generador de números al azar propio ("xorshift"), con semilla.
 * Usamos uno propio y no Math.random() por dos razones:
 *   1) Es MUY rápido y no reserva memoria (el hilo de audio no debe reservar).
 *   2) Con la misma semilla da SIEMPRE la misma secuencia: el efecto es
 *      reproducible, y eso permite probarlo automáticamente.
 * Devuelve un número entre 0 y 1.
 */
function nextRandom(state) {
  let x = state.value;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  state.value = x;
  return x / 4294967296;
}

/**
 * Arma el patrón: un arreglo donde pattern[origen] = destino.
 * El truco para que sea una permutación de verdad (y que "Intensidad" controle
 * cuánto desordena) es: a cada bin le damos una CLAVE = su número + un desvío al
 * azar proporcional a la intensidad, y después los ordenamos por esa clave.
 *   - Intensidad 0   → las claves son 1,2,3,... → el orden no cambia.
 *   - Intensidad 100 → el desvío es tan grande como todo el espectro → casi azar.
 * Ojo: el bin 0 (continua) y el último (Nyquist) se dejan quietos, porque ahí
 * suele haber continua y ruido que conviene no mover de lugar.
 */
function buildPattern(amount, state, order, keys, pattern) {
  const strength = (amount / 100) * HALF;
  for (let i = 1; i < HALF; i++) {
    order[i - 1] = i;
    keys[i - 1] = i + (nextRandom(state) - 0.5) * strength;
  }

  // Ordenamos los índices según su clave (ordenar = barajar en serio)
  order.sort((a, b) => keys[a - 1] - keys[b - 1]);

  for (let i = 0; i <= HALF; i++) pattern[i] = i;   // por defecto, cada bin se queda
  for (let i = 1; i < HALF; i++) pattern[i] = order[i - 1];
  return pattern;
}

/**
 * Muda cada bin a su nuevo lugar: out[pattern[i]] = in[i].
 * Los dos lados del espectro se mueven juntos (el de las frecuencias positivas y
 * el de las negativas) para que la señal siga siendo real al volver al tiempo.
 */
function scrambleSpectrum(re, im, outRe, outIm, pattern) {
  outRe[0] = re[0];
  outIm[0] = im[0];
  outRe[HALF] = re[HALF];
  outIm[HALF] = im[HALF];

  for (let i = 1; i < HALF; i++) {
    const j = pattern[i];
    outRe[j] = re[i];
    outIm[j] = im[i];
    // El lado negativo es el espejo del positivo: FRAME - j
    outRe[FRAME - j] = re[FRAME - i];
    outIm[FRAME - j] = im[FRAME - i];
  }
}

/**
 * Cuántos cuadros dura un patrón, según la "Velocidad" (1 a 100).
 *   Velocidad 1   → cambia cada 100 cuadros (~2 segundos): un desorden estable.
 *   Velocidad 20  → cada 5 cuadros (~107 ms).
 *   Velocidad 100 → en cada cuadro (~21 ms): un festival de glitches.
 */
function framesPerPattern(rate) {
  return Math.max(1, Math.round(100 / rate));
}

class BinScramblerProcessor extends AudioWorkletProcessor {
  /** Parámetros que la interfaz puede cambiar en vivo. */
  static get parameterDescriptors() {
    return [
      { name: "amount", defaultValue: 50, minValue: 0, maxValue: 100, automationRate: "k-rate" },
      { name: "rate", defaultValue: 20, minValue: 1, maxValue: 100, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.window = buildWindow(FRAME);
    this.fft = new FFT(FRAME);

    // Espacio de trabajo de la FFT: se reserva UNA vez y se reusa siempre.
    // (En el hilo de audio conviene no reservar memoria: produce pausas.)
    this.frameRe = new Float32Array(FRAME);
    this.frameIm = new Float32Array(FRAME);
    this.scrambledRe = new Float32Array(FRAME);
    this.scrambledIm = new Float32Array(FRAME);

    // El patrón actual (al principio no desordena nada) y las tablas auxiliares
    this.pattern = new Int32Array(HALF + 1);
    for (let i = 0; i <= HALF; i++) this.pattern[i] = i;
    this.order = new Array(HALF - 1);
    this.keys = new Float32Array(HALF - 1);
    this.random = { value: 0x9e3779b9 };   // semilla fija: el efecto es reproducible
    // Arranca en un número enorme para que el PRIMER patrón se arme en el primer
    // cuadro: así el efecto se escucha apenas conectás el nodo (si no, con
    // Velocidad = 1 habría que esperar 2 segundos a que cambie algo).
    this.framesSincePattern = Number.MAX_SAFE_INTEGER;

    // Estado por canal (el sample puede ser mono o estéreo)
    this.states = [];
    this.sinceFrame = 0;
  }

  /** Crea el estado de un canal la primera vez que lo vemos. */
  stateFor(channel) {
    if (!this.states[channel]) {
      this.states[channel] = {
        inputHistory: new Float32Array(FRAME),   // las últimas FRAME muestras que entraron
        outputHistory: new Float32Array(FRAME),  // lo que se va sumando para salir
        write: 0,                                // dónde entra la próxima muestra
        read: 0,                                 // qué muestra sale ahora
      };
    }
    return this.states[channel];
  }

  /**
   * El navegador llama a esta función una y otra vez, con bloques de 128 muestras.
   * Acá llevamos el "reloj" del efecto: por cada muestra que entra sale una (con
   * retraso) y cada HOP muestras se calcula un cuadro nuevo.
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true; // sin entrada no hay nada que hacer

    const channels = input.length;
    const blockLength = input[0].length;
    const amount = parameters.amount[0];
    const rate = parameters.rate[0];

    for (let i = 0; i < blockLength; i++) {
      // 1) Guardamos la muestra que entra y entregamos la que toca salir
      for (let ch = 0; ch < channels; ch++) {
        const state = this.stateFor(ch);
        state.inputHistory[state.write] = input[ch][i];
        output[ch][i] = state.outputHistory[state.read];
        state.outputHistory[state.read] = 0;   // ya salió: limpiamos el lugar
        state.write = (state.write + 1) % FRAME;
        state.read = (state.read + 1) % FRAME;
      }

      // 2) ¿Ya juntamos HOP muestras nuevas? Entonces toca un cuadro nuevo
      this.sinceFrame++;
      if (this.sinceFrame >= HOP) {
        this.sinceFrame = 0;
        this.framesSincePattern++;
        if (this.framesSincePattern >= framesPerPattern(rate)) {
          buildPattern(amount, this.random, this.order, this.keys, this.pattern);
          this.framesSincePattern = 0;
        }
        for (let ch = 0; ch < channels; ch++) this.processFrame(ch);
      }
    }

    return true;
  }

  /**
   * Calcula un cuadro completo de un canal:
   * ventana → FFT → reordenar bins → FFT inversa → ventana → sumar al acumulador.
   */
  processFrame(channel) {
    const state = this.stateFor(channel);
    const window = this.window;

    // 1) Juntamos las últimas FRAME muestras en orden (la más vieja primero)
    for (let n = 0; n < FRAME; n++) {
      const index = state.write + n;
      this.frameRe[n] = state.inputHistory[index >= FRAME ? index - FRAME : index] * window[n];
      this.frameIm[n] = 0;
    }

    // 2) Al dominio de la frecuencia
    this.fft.transform(this.frameRe, this.frameIm, false);

    // 3) El reordenamiento: acá pasa todo lo interesante
    scrambleSpectrum(this.frameRe, this.frameIm, this.scrambledRe, this.scrambledIm, this.pattern);

    // 4) De vuelta al dominio del tiempo
    this.fft.transform(this.scrambledRe, this.scrambledIm, true);

    // 5) Ventana de síntesis y suma en el acumulador (overlap-add)
    for (let n = 0; n < FRAME; n++) {
      const index = state.read + n;
      state.outputHistory[index >= FRAME ? index - FRAME : index] += this.scrambledRe[n] * window[n];
    }
  }
}

// Le ponemos nombre al procesador: la interfaz lo crea con este mismo nombre.
registerProcessor("bin-scrambler", BinScramblerProcessor);