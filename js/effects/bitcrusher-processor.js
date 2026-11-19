/* =========================================================
   bitcrusher-processor.js — las "cuentas" del efecto Bitcrusher

   ¡ATENCIÓN! Igual que los otros procesadores, este archivo corre dentro del
   AudioWorklet: NO es un módulo (nada de import/export), no hay window ni
   document, y el audio llega en bloques de 128 muestras.

   POR QUÉ HACE FALTA PROCESAR MUESTRA POR MUESTRA
   ----------------------------------------------
   El bitcrusher modifica CADA muestra individualmente (la cantidad de niveles de
   amplitud y el instante en que se renueva cada muestra). No hay un nodo nativo
   de la Web Audio API que haga esa cuenta exacta y con parámetros continuos, así
   que la escribimos en un AudioWorklet, que es justamente el lugar donde codeamos
   que corre en el hilo de audio, muestra por muestra.

   QUÉ HACE (dos efectos, en este orden)
   -------------------------------------
   1) REDUCCIÓN DE FRECUENCIA DE MUESTREO (sample & hold):
      Con un "acumulador de fase" (en realidad usamos una CUENTA REGRESIVA con
      decimales) retenemos el último valor leído y no lo cambiamos hasta que toca
      tomar el siguiente. Como el período se calcula con decimales
      (period = sampleRate / rateObjetivo), funciona con CUALQUIER frecuencia,
      no solo con divisores enteros: 11025 Hz da grupos de 4 muestras, pero
      13500 Hz da grupos irregulares de 3 y 4 que en promedio respetan 13500 Hz.
   2) REDUCCIÓN DE BITS (cuantización):
      Redondeamos cada muestra a un número limitado de niveles. La fórmula con
      `bits` CONTINUO (puede ser 7.3) es:

          niveles = 2^bits
          índice  = redondear hacia abajo( (muestra + 1) / 2 * niveles )
          salida  = ( índice / (niveles − 1) ) * 2 − 1

      Con bits = 16 hay 65536 niveles (igual que el audio normal: casi no se nota);
      con bits = 1 hay solo 2 niveles (−1 y +1). Como `bits` puede tener decimales,
      `niveles` toma valores intermedios y el fader se puede mover SUAVE.

   POR QUÉ NO HAY FILTRO ANTI-ALIASING (y por qué acá eso es BUENO)
   ---------------------------------------------------------------
   "Aliasing" es lo que pasa cuando una onda cambia muy rápido para la frecuencia
   de muestreo que la representa: las frecuencias que quedan por encima de la
   mitad de esa frecuencia (Nyquist) se "doblan" y reaparecen como tonos FALSOS,
   desafinados, que no estaban en la señal original. En un sistema normal eso es
   un defecto y se elimina con un filtro anti-aliasing; acá es JUSTO el carácter
   lo-fi/áspero que buscamos, así que lo dejamos. Está explicado de vuelta en el
   resumen final.

   TRANSPARENCIA Y SEGURIDAD
   -------------------------
   - Con bits = 16 y rate = sampleRate la salida queda casi igual a la entrada
     (solo el error de redondeo de 16 bits, inaudible).
   - La salida se limita siempre a −1..1 y cualquier NaN/infinito se convierte
     en valor seguro.
   - Los cambios de bits/rate se SUAVIZAN (≈10 ms) para que mover un fader no
     produzca clics.
   ========================================================= */

// Suavizado de los parámetros, en segundos (~10 ms).
const SMOOTH_S = 0.01;

/** Recorta un número entre min y max. */
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Cuantiza una muestra a `bits` bits (continuo). Devuelve un valor en −1..1.
 * Ver el comentario de arriba para la fórmula.
 */
function quantize(value, bits) {
  const levels = Math.pow(2, bits);
  // Si levels no es finito o es ≤1, devolvemos el signo (casos límite).
  if (!Number.isFinite(levels) || levels <= 1) {
    if (value > 0) return 1;
    if (value < 0) return -1;
    return 0;
  }
  const maxIndex = levels - 1;
  let index = Math.floor((value + 1) * 0.5 * levels);
  if (index < 0) index = 0;
  else if (index > maxIndex) index = maxIndex;
  return (index / maxIndex) * 2 - 1;
}
class BitcrusherProcessor extends AudioWorkletProcessor {
  /**
   * Parámetros que la interfaz puede cambiar EN VIVO:
   *   bits → 1..16 (continuo)
   *   rate → frecuencia de muestreo objetivo en Hz (se recorta a sampleRate acá)
   */
  static get parameterDescriptors() {
    return [
      { name: "bits", defaultValue: 16, minValue: 1, maxValue: 16, automationRate: "k-rate" },
      { name: "rate", defaultValue: 48000, minValue: 1, maxValue: 192000, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    // Estado del sample & hold (UN solo reloj compartido por los canales).
    this.countdown = 0;         // cuántas muestras faltan para tomar el próximo valor
    this.hold = [0, 0];         // último valor retenido (izquierdo, derecho)
    // Valores SUAVIZADOS (arrancan "transparentes": 16 bits y rate máximo).
    this.smoothBits = 16;
    this.smoothRate = sampleRate;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true; // sin entrada no hay nada que hacer

    const channelCount = Math.min(input.length, output.length, 2);
    const blockLength = input[0].length;

    // k-rate: un único valor por bloque.
    const targetBits = clamp(Number(parameters.bits[0]) || 16, 1, 16);
    const targetRate = clamp(Number(parameters.rate[0]) || sampleRate, 1, sampleRate);

    // Coeficiente del suavizado (≈10 ms) para que mover los faders no "clickee".
    const smoothCoeff = 1 - Math.exp(-1 / (SMOOTH_S * sampleRate));

    for (let i = 0; i < blockLength; i++) {
      // Suavizamos los parámetros muestra a muestra hacia su objetivo.
      this.smoothBits += (targetBits - this.smoothBits) * smoothCoeff;
      this.smoothRate += (targetRate - this.smoothRate) * smoothCoeff;
      const bits = clamp(this.smoothBits, 1, 16);
      const period = sampleRate / clamp(this.smoothRate, 1, sampleRate); // muestras por held

      // 1) Sample & hold con UN reloj compartido por los dos canales.
      if (this.countdown <= 0) {
        for (let ch = 0; ch < channelCount; ch++) {
          const v = input[ch][i];
          this.hold[ch] = Number.isFinite(v) ? v : 0; // NaN/infinito → silencio
        }
        this.countdown += period;
      }
      this.countdown -= 1;

      // 2) Cuantizamos CADA canal por separado y recortamos a −1..1.
      for (let ch = 0; ch < channelCount; ch++) {
        let value = quantize(this.hold[ch], bits);
        value = clamp(value, -1, 1);
        output[ch][i] = Number.isFinite(value) ? value : 0;
      }
    }

    // Si la salida tuviera más canales que la entrada, los dejamos en silencio.
    for (let ch = channelCount; ch < output.length; ch++) {
      output[ch].fill(0);
    }

    return true;
  }
}

// Le ponemos nombre al procesador: la interfaz lo crea con este mismo nombre.
registerProcessor("bitcrusher", BitcrusherProcessor);