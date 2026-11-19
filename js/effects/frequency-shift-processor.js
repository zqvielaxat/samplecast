/* =========================================================
   frequency-shift-processor.js — las "cuentas" del efecto Frequency Shift

   ¡ATENCIÓN! Este archivo NO es un módulo normal de JavaScript.
   Se carga dentro del AudioWorklet (ctx.audioWorklet.addModule), que es un
   hilo aparte reservado para el audio. Por eso:
     - NO se puede usar import / export, ni window, ni document.
     - SÍ existen estas variables globales: sampleRate, currentTime y
       registerProcessor (la función con la que "avisamos" que este procesador existe).
     - El audio llega en bloques de 128 muestras (se llama "render quantum").

   QUÉ HACE EL EFECTO
   ------------------
   "Frequency shift" NO es lo mismo que "pitch shift" (subir el tono):
     - Pitch shift  → MULTIPLICA todas las frecuencias por un mismo factor
                      (440 → 880, 880 → 1760). La relación entre armónicos se
                      mantiene: suena como la misma voz/cuerda más aguda.
     - Frequency shift → SUMA una cantidad fija de Hz
                      (440 → 540, 880 → 980). Los armónicos dejan de ser
                      múltiplos del fundamental: el sonido queda metálico,
                      inarmónico, "espacial" (tipo anillo de teléfono o ventilador).

   CÓMO SE LOGRA (truco clásico llamado SSB / banda lateral única)
   -------------------------------------------------------------
   1) Se arma la "señal analítica"  s(t) + j·ŝ(t),
      donde ŝ(t) es la transformada de Hilbert de la señal: la MISMA señal pero
      con todas sus frecuencias giradas 90°. Eso lo consigue el filtro FIR de
      más abajo (un filtro de 201 coeficientes).
   2) Se multiplica esa señal compleja por un giro e^{jθ}, con θ = 2π·f·t:

          y(t) = s(t)·cos(θ) − ŝ(t)·sin(θ)

      Multiplicar por e^{jθ} es, literalmente, "mover todas las frecuencias
      f·Hz". Si f es positiva suben, si es negativa bajan.

   Detalle importante: si en vez de esto multiplicáramos la señal por un coseno
   a secas (eso se llama modulación en anillo) saldrían DOS copias, una por
   arriba y otra por abajo del original. La señal analítica y esa resta son las
   que "borran" la copia que no queremos.
   ========================================================= */

// Largo del filtro de Hilbert. Debe ser IMPAR para que exista una muestra central exacta.
// Cuanto más largo, mejor cancela la copia indeseada: medido con 201 daba -34 dB
// y con 401 baja a -81 dB en la zona media. Cuesta el doble de cuentas (200
// multiplicaciones por muestra y por canal), que sigue siendo poco.
const FIR_LENGTH = 401;
// Muestra central = retardo (en muestras) que introduce el filtro en el camino "en fase".
const CENTER = (FIR_LENGTH - 1) / 2;
const TAU = Math.PI * 2;

/**
 * Calcula los coeficientes (taps) del transformador de Hilbert.
 * La respuesta ideal es 2/(π·m) y solo tiene valores en las posiciones impares.
 * Como no podemos usar infinitos coeficientes, cortamos en FIR_LENGTH y para
 * que el corte no genere ondulaciones raras aplicamos una "ventana Blackman".
 */
function buildHilbertTaps() {
  const taps = new Float32Array(FIR_LENGTH);

  for (let n = 0; n < FIR_LENGTH; n++) {
    const m = n - CENTER;
    if (m === 0 || m % 2 === 0) continue; // las posiciones pares valen 0 en la fórmula ideal

    const w = 0.42
      - 0.5 * Math.cos((TAU * n) / (FIR_LENGTH - 1))
      + 0.08 * Math.cos((2 * TAU * n) / (FIR_LENGTH - 1));

    taps[n] = (2 / (Math.PI * m)) * w;
  }

  // La ventana baja un poco la ganancia del filtro. La medimos en fs/4 (la zona
  // donde el filtro es más exacto: H(ω) = -j) y la corregimos para que valga 1.
  const wQuarter = Math.PI / 2;
  let re = 0;
  let im = 0;
  for (let n = 0; n < FIR_LENGTH; n++) {
    re += taps[n] * Math.cos(wQuarter * n);
    im -= taps[n] * Math.sin(wQuarter * n);
  }
  const gain = Math.hypot(re, im) || 1;
  for (let n = 0; n < FIR_LENGTH; n++) taps[n] /= gain;

  return taps;
}

class FrequencyShiftProcessor extends AudioWorkletProcessor {
  /** Los "parámetros" son valores que la interfaz puede cambiar en vivo. */
  static get parameterDescriptors() {
    return [{
      name: "shift",              // desplazamiento en Hz (negativo = hacia abajo)
      defaultValue: 0,
      minValue: -12000,           // más allá de ±fs/2 la modulación empieza a "aliarse"
      maxValue: 12000,
      automationRate: "k-rate",   // alcanza con 1 valor por bloque de 128 muestras
    }];
  }

  constructor() {
    super();
    this.taps = buildHilbertTaps();

    // Estado por canal (el sample puede ser mono o estéreo). Se crea a medida
    // que aparecen canales, así funciona igual con 1 o con 2.
    this.histories = []; // un "anillo" (buffer circular) con las últimas FIR_LENGTH muestras
    this.phases = [];    // ángulo θ del giro, en radianes
    this.writes = [];    // posición donde se escribe la muestra más nueva del anillo
  }

  /** Crea el estado de un canal la primera vez que lo vemos. */
  ensureState(channel) {
    if (!this.histories[channel]) {
      this.histories[channel] = new Float32Array(FIR_LENGTH);
      this.phases[channel] = 0;
      this.writes[channel] = 0;
    }
  }

  /**
   * process() es el corazón: el navegador la llama solo, una y otra vez.
   * inputs/outputs son listas de canales, y cada canal es un arreglo de 128 números.
   * Devolver true significa "seguí llamándome" (si devolviéramos false, el nodo moriría).
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true; // sin entrada no hay nada que hacer

    const taps = this.taps;
    // Cuánto avanza el ángulo θ en cada muestra: 2π·f/frecuenciaDeMuestreo.
    const increment = (TAU * parameters.shift[0]) / sampleRate;

    for (let ch = 0; ch < input.length; ch++) {
      const inChannel = input[ch];
      const outChannel = output[ch];
      if (!outChannel) continue;

      this.ensureState(ch);
      const history = this.histories[ch];
      let phase = this.phases[ch];
      let write = this.writes[ch];

      for (let i = 0; i < inChannel.length; i++) {
        history[write] = inChannel[i]; // guardamos la muestra más nueva en el anillo

        // --- Parte imaginaria: convolución con el filtro de Hilbert ---
        // history[write] es la muestra actual, write-1 la anterior, etc.
        // Como los taps impares son los únicos que valen algo, caminamos el
        // anillo de a 2 posiciones hacia atrás (mucho más rápido que calcular
        // el resto de una división en cada paso).
        let index = write - 1;
        if (index < 0) index += FIR_LENGTH;
        let imaginary = 0;
        for (let k = 1; k < FIR_LENGTH; k += 2) {
          imaginary += taps[k] * history[index];
          index -= 2;
          if (index < 0) index += FIR_LENGTH;
        }

        // --- Parte real: la misma muestra, retrasada CENTER muestras ---
        // (el filtro de Hilbert también retrasa su camino, así los alineamos)
        let realIndex = write - CENTER;
        if (realIndex < 0) realIndex += FIR_LENGTH;
        const real = history[realIndex];

        // --- Giro y resta ---
        outChannel[i] = real * Math.cos(phase) - imaginary * Math.sin(phase);

        // Avanzamos el ángulo y el puntero del anillo (con "vuelta" al llegar al final).
        phase += increment;
        if (phase >= TAU) phase -= TAU;
        else if (phase <= -TAU) phase += TAU;

        write += 1;
        if (write >= FIR_LENGTH) write = 0;
      }

      this.phases[ch] = phase;
      this.writes[ch] = write;
    }

    return true;
  }
}

// Le ponemos nombre al procesador: la interfaz lo crea con este mismo nombre.
registerProcessor("frequency-shift", FrequencyShiftProcessor);