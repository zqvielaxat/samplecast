/* =========================================================
   spectral-gate-processor.js — las "cuentas" del efecto Spectral Gate

   ¡ATENCIÓN! Igual que los otros procesadores, este archivo corre dentro del
   AudioWorklet: NO es un módulo (nada de import/export), no hay window ni
   document, y el audio llega en bloques de 128 muestras.

   QUÉ HACE EL EFECTO
   ------------------
   Es un efecto "espectral" (como el Binscrambler): trabaja en el dominio de la
   FRECUENCIA, por cuadros, en vez de muestra por muestra. La receta es:

     1) Cortar el audio en CUADROS de 2048 muestras que se solapan a la mitad.
     2) Pasar cada cuadro por una FFT: quedan 1025 "bins", cajitas que dicen
        cuánto hay de cada frecuencia (a 48 kHz cada cajita ocupa ~23 Hz).
     3) ACÁ ESTÁ LO NUEVO: mirar cada bin y preguntarse "¿es fuerte o es débil?".
        Si su magnitud está por encima del Umbral se deja pasar entero; si está
        por debajo, se lo apaga (o se lo baja, según la Intensidad).
     4) Volver al dominio del tiempo con la FFT inversa y pegar los cuadros
        (overlap-add), igual que en el Binscrambler.

   ¿QUÉ SE ESCUCHA? Una puerta de ruido común mira el volumen GENERAL: si el
   sonido baja, silencia todo junto. Esta mira cada frecuencia por separado, así
   que puede dejar pasar el bajo y el bombo y, al mismo tiempo, borrar el aire,
   el siseo y las colas de reverb. Quedan texturas fragmentadas, "a pedazos".

   DETALLE IMPORTANTE: la fase no se toca
   --------------------------------------
   A cada bin lo multiplicamos por un número (su ganancia de puerta). Multiplicar
   un número complejo por un real cambia la MAGNITUD y deja la FASE quieta: la
   frecuencia sigue en su lugar y no aparece el sonido "borroso" del
   Binscrambler.

   LAS DOS SUAVIDADES (para que no suene "cortado")
   -----------------------------------------------
   - RODILLA (knee): en vez de abrir/cerrar de golpe justo en el umbral, hay una
     rampa de 6 dB alrededor. Sin esto, un bin que oscila justo en el umbral
     prende y apaga en cada cuadro, y eso suena a "golpeteo".
   - SUAVIZADO EN EL TIEMPO: la apertura de cada bin no salta al valor nuevo: en
     cada cuadro avanza la mitad del camino (~40 ms). Es lo que evita el
     chasquido de la puerta al abrir y cerrar.

   LA VENTANA ES "RAÍZ DE HANN" (igual que en el Binscrambler): así la suma de
   los cuadros solapados reconstruye la señal exacta, y con Intensidad 0 el
   efecto devuelve el sonido intacto (solo retrasado 2048 muestras).

   EL UMBRAL SE MIDE EN dBFS
   -------------------------
   0 dBFS = el máximo que se puede guardar (una onda que toca +1 y −1).
   Para calcularlo hay que pasar de la MAGNITUD que devuelve la FFT a la
   AMPLITUD de la onda: con esta ventana, un seno de amplitud A deja en su bin
   una magnitud de A · (suma de la ventana) / 2, así que despejamos A y listo.
   OJO: es una referencia práctica, no un número exacto: si una frecuencia cae
   justo entre dos bins, su energía se reparte y cada mitad mide un poco menos.
   ========================================================= */

const FRAME = 2048;         // tamaño del cuadro, en muestras
const HOP = FRAME / 2;      // cada cuántas muestras se calcula un cuadro nuevo
const HALF = FRAME / 2;     // bins del lado "positivo" (sin contar el de Nyquist)
const TAU = Math.PI * 2;

// Ancho de la "rodilla", en dB: la puerta no abre/cierra de golpe en el umbral,
// sino que hace una rampa de 6 dB (3 para cada lado).
const KNEE_DB = 6;

// Suavizado temporal: cuánto del camino hacia el valor nuevo se recorre en cada
// cuadro (0 = nunca llega, 1 = salta de golpe). 0.5 ≈ unos 40 ms.
const SMOOTHING = 0.5;

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

/** Suma de todos los valores de la ventana (para pasar magnitud → amplitud). */
function windowSum(window) {
  let total = 0;
  for (let n = 0; n < window.length; n++) total += window[n];
  return total;
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
 *
 * (Es la misma clase que usa el Binscrambler. Cada procesador la lleva adentro
 * porque los archivos del AudioWorklet no pueden importar a otros archivos.)
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


class SpectralGateProcessor extends AudioWorkletProcessor {
  /** Parámetros que la interfaz puede cambiar en vivo. */
  static get parameterDescriptors() {
    return [
      // Umbral en dBFS: −90 (deja pasar casi todo) a 0 (solo lo más fuerte)
      { name: "threshold", defaultValue: -50, minValue: -90, maxValue: 0, automationRate: "k-rate" },
      // Intensidad: cuánto se apaga lo que queda por debajo del umbral
      { name: "amount", defaultValue: 100, minValue: 0, maxValue: 100, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.window = buildWindow(FRAME);
    this.fft = new FFT(FRAME);

    // Pasar de la magnitud de un bin a la amplitud de la onda: amplitud =
    // magnitud · 2 / (suma de la ventana). Lo guardamos ya calculado.
    this.magScale = 2 / windowSum(this.window);

    // Espacio de trabajo de la FFT: se reserva UNA vez y se reusa siempre.
    // (En el hilo de audio conviene no reservar memoria: produce pausas.)
    this.frameRe = new Float32Array(FRAME);
    this.frameIm = new Float32Array(FRAME);

    // Estado por canal (el sample puede ser mono o estéreo)
    this.states = [];
    this.sinceFrame = 0;
  }

  /** Crea el estado de un canal la primera vez que lo vemos. */
  stateFor(channel) {
    if (!this.states[channel]) {
      const gains = new Float32Array(HALF + 1);
      gains.fill(1); // al arrancar, todos los bins están abiertos
      this.states[channel] = {
        inputHistory: new Float32Array(FRAME),   // las últimas FRAME muestras que entraron
        outputHistory: new Float32Array(FRAME),  // lo que se va sumando para salir
        write: 0,                                // dónde entra la próxima muestra
        read: 0,                                 // qué muestra sale ahora
        gains,                                   // apertura actual de cada bin (0 a 1)
      };
    }
    return this.states[channel];
  }

  /**
   * El navegador llama a esta función una y otra vez, con bloques de 128
   * muestras. Acá llevamos el "reloj" del efecto: por cada muestra que entra
   * sale una (con retraso) y cada HOP muestras se calcula un cuadro nuevo.
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true; // sin entrada no hay nada que hacer

    const channels = input.length;
    const blockLength = input[0].length;
    const threshold = parameters.threshold[0];
    const amount = parameters.amount[0];

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
        for (let ch = 0; ch < channels; ch++) this.processFrame(ch, threshold, amount);
      }
    }

    return true;
  }

  /**
   * Calcula un cuadro completo de un canal:
   * ventana → FFT → abrir/cerrar cada bin → FFT inversa → ventana → sumar.
   */
  processFrame(channel, threshold, amount) {
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

    // 3) La puerta: acá pasa todo lo interesante
    this.gateSpectrum(state.gains, threshold, amount);

    // 4) De vuelta al dominio del tiempo
    this.fft.transform(this.frameRe, this.frameIm, true);

    // 5) Ventana de síntesis y suma en el acumulador (overlap-add)
    for (let n = 0; n < FRAME; n++) {
      const index = state.read + n;
      state.outputHistory[index >= FRAME ? index - FRAME : index] += this.frameRe[n] * window[n];
    }
  }

  /**
   * Abre o cierra cada bin según su magnitud. No devuelve nada: modifica
   * this.frameRe / this.frameIm, que es donde vive el espectro del cuadro.
   */
  gateSpectrum(gains, threshold, amount) {
    const re = this.frameRe;
    const im = this.frameIm;
    const minGain = 1 - amount / 100;   // cuánto sobrevive lo que está por debajo

    for (let i = 1; i <= HALF; i++) {
      // Magnitud del bin → amplitud de la onda → dBFS
      const amplitude = Math.hypot(re[i], im[i]) * this.magScale;
      const db = 20 * Math.log10(amplitude + 1e-12);  // el +1e-12 evita el log(0)

      // ¿Qué tan abierta debería estar esta puerta? 0 = cerrada, 1 = abierta.
      // La recta sube 1 cada KNEE_DB dB y está centrada en el umbral: esa es la
      // "rodilla" (arriba del umbral abre, abajo cierra, y en el medio acompaña).
      let open = (db - threshold) / KNEE_DB + 0.5;
      if (open < 0) open = 0;
      else if (open > 1) open = 1;

      // Con Intensidad 100, minGain = 0 (se apaga del todo); con 50, lo débil
      // queda a la mitad; con 0, minGain = 1 y la puerta nunca cierra nada.
      const target = minGain + (1 - minGain) * open;

      // Suavizado: avanzamos solo una parte del camino en cada cuadro.
      const current = gains[i] + (target - gains[i]) * SMOOTHING;
      gains[i] = current;

      // Multiplicar por un número real: cambia la magnitud y deja la fase quieta.
      re[i] *= current;
      im[i] *= current;

      // El lado negativo del espectro es el espejo del positivo: misma ganancia,
      // para que la señal siga siendo real al volver al dominio del tiempo.
      if (i < HALF) {
        const mirror = FRAME - i;
        re[mirror] *= current;
        im[mirror] *= current;
      }
    }
    // El bin 0 (la componente continua) se deja quieto a propósito: si el sample
    // tiene un pequeño desplazamiento de continua, conviene no estar abriéndolo
    // y cerrándolo en cada cuadro.
  }
}

// Le ponemos nombre al procesador: la interfaz lo crea con este mismo nombre.
registerProcessor("spectral-gate", SpectralGateProcessor);
