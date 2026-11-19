/* =========================================================
   multiband-ott-processor.js — las "cuentas" de una banda del Multiband OTT

   ¡ATENCIÓN! Igual que los otros procesadores, este archivo corre dentro del
   AudioWorklet: NO es un módulo (nada de import/export), no hay window ni
   document, y el audio llega en bloques de 128 muestras.

   POR QUÉ HACE FALTA UN AUDIOWORKLET (y no sirve DynamicsCompressorNode)
   ---------------------------------------------------------------------
   La Web Audio API trae un compresor nativo (DynamicsCompressorNode), pero ese
   nodo solo sabe una cosa: "si la señal pasa de un umbral, BAJALE la ganancia".
   Eso es la compresión DESCENDENTE (aplanar lo fuerte). Para el efecto OTT
   también necesitamos la compresión ASCENDENTE (subirle la ganancia a lo
   suave), y necesitamos las DOS a la vez, cada una con su propio umbral, más un
   seguidor de envolvente y un suavizado de ganancia que controlamos muestra por
   muestra. Un nodo nativo no deja meterle mano a eso.

   Un AudioWorklet es el lugar de la Web Audio API donde NOSOTROS escribimos el
   código que se ejecuta en el hilo de audio, muestra por muestra (cada bloque de
   128 muestras). Ahí podemos medir el nivel en decibelios, decidir "esto está
   fuerte → bajo, esto está suave → subo", y aplicar la ganancia que queramos.

   QUÉ HACE ESTE PROCESADOR (UNA banda)
   ------------------------------------
   Una "instancia" recibe UNA banda (graves, medios o agudos) y le aplica su
   dinámica. El envoltorio (multiband-ott.js) crea TRES instancias, una por
   banda, cada una con tiempos distintos:

      graves → lentos   ·   agudos → rápidos

   La receta, paso a paso (por bloque de muestras):

     1) Medir el nivel: tomamos el pico (el valor absoluto más grande de los dos
        canales) y lo convertimos a decibelios. Usamos el MISMO nivel para los
        dos canales: eso es la "detección enlazada", que evita mover la imagen
        estéreo (si cada canal comprimiera por su cuenta, el panorama bailaría).
     2) Envolvente: el nivel medido se suaviza con ataque y release. El ataque
        sube rápido cuando llega un pico; el release baja lento cuando el sonido
        se apaga. Así la ganancia no "tiembla" muestra a muestra.
     3) Dos umbrales (en dB):
          - Por ENCIMA de UPPER_DB  → compresión descendente (reducir ganancia).
          - Por DEBAJO de LOWER_DB  → compresión ascendente (subir ganancia).
          - En el medio no se toca nada.
        La cantidad de ambas la escala el parámetro Depth, y cada una tiene su
        "ratio" (pendiente) como constante editable.
     4) Suavizar la ganancia resultante (unos 5 ms) para que no haya zumbidos ni
        clics al encender/apagar o al mover Depth.
     5) Protecciones:
          a) La ganancia por banda se recorta a ±MAX_GAIN_DB (por defecto ±24 dB).
          b) "Suelo de ruido": por debajo de NOISE_FLOOR_DB no se aplica ganancia
             ascendente, para no amplificar el silencio, el ruido de fondo ni la
             cola de las notas.
          c) El recorte final contra 0 dBFS lo hace el limitador suave del
             envoltorio (un WaveShaper), que vive DESPUÉS de sumar las bandas.
          d) Cualquier cálculo que produzca NaN o infinito se reemplaza por un
             valor seguro (y si una muestra de salida quedara no-finita, se
             devuelve 0 = silencio en esa muestra).

   MODO "DINÁMICA INVERTIDA" (parámetro interno `inv`)
   ---------------------------------------------------
   El preset "Dinámica invertida" pide lo contrario: que lo fuerte suene MÁS BAJO
   que lo suave. Para lograrlo usamos un "espejo": en vez de "aplanar hacia el
   medio", calculamos una ganancia que INVIERTE el orden (pendiente negativa
   alrededor de un pivote). Como una inversión total no es posible sin ganancia
   infinita, la recortamos a ±INV_MAX_DB: esto invierte del todo una ventana de
   unos 36 dB de dinámica y "achata" lo que caiga fuera (así el volumen no
   explota). Los límites están en las constantes de más abajo.
   ========================================================= */

// ---- Umbrales y límites (fáciles de cambiar) ----
const UPPER_DB = -20;        // por encima: compresión DESCENDENTE (bajar lo fuerte)
const LOWER_DB = -50;        // por debajo: compresión ASCENDENTE (subir lo suave)
const NOISE_FLOOR_DB = -60;  // por debajo de acá NO se sube nada (no amplificar ruido)
const MAX_GAIN_DB = 24;      // tope de ganancia por banda, en dB (protección a)

// Las "pendientes" de cada compresión. Una ratio de 4 quiere decir que, por
// cada 4 dB que el nivel se aleja del umbral, corregimos 3 dB (1 − 1/4 = 0.75).
const DOWN_RATIO = 4;
const UP_RATIO = 4;
const DOWN_SLOPE = 1 - 1 / DOWN_RATIO;
const UP_SLOPE = 1 - 1 / UP_RATIO;

// "Time": cuánto estira o encoge los tiempos de ataque/release.
// Time = 0  → 0.25× (muy rápido y agresivo); Time = 100 → 4× (lento y suave).
const TIME_SCALE_MAX = 4;

// Suavizado final de la ganancia (segundos): ~5 ms.
const GAIN_SMOOTH_S = 0.005;

// Modo "dinámica invertida" (parámetro interno del preset).
const INV_SLOPE = 2.0;      // pendiente del espejo (2.0 = inversión "a espejo")
const INV_PIVOT_DB = -30;   // nivel alrededor del cual se invierte
const INV_MAX_DB = 36;      // recorte de seguridad del modo invertido, en dB

const FLOOR_DB = -160;      // nivel "silencio" inicial del seguidor de envolvente

/** Recorta un número entre min y max. */
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
class MultibandOttProcessor extends AudioWorkletProcessor {
  /**
   * Estos son los parámetros que el envoltorio puede cambiar EN VIVO.
   *   depth / time son los controles visibles (Depth y Time).
   *   up / down / inv son INTERNOS: los fija cada preset (no salen en la tarjeta).
   */
  static get parameterDescriptors() {
    return [
      { name: "depth", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "time",  defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "up",    defaultValue: 1, minValue: 0, maxValue: 4, automationRate: "k-rate" },
      { name: "down",  defaultValue: 1, minValue: 0, maxValue: 4, automationRate: "k-rate" },
      { name: "inv",   defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor(options) {
    super();

    // Cada banda se crea con tiempos base distintos (graves lentos, agudos
    // rápidos). Llegan en options.processorOptions y son editables en
    // multiband-ott.js.
    const opts = (options && options.processorOptions) || {};
    this.attackBase = Math.max(0.0005, Number(opts.attackBase) || 0.010);
    this.releaseBase = Math.max(0.001, Number(opts.releaseBase) || 0.150);

    // Estado del efecto (una instancia = una banda).
    this.envDb = FLOOR_DB; // nivel suavizado (dB)
    this.gainDb = 0;       // ganancia que estamos aplicando ahora (dB)
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true; // sin entrada no hay nada que hacer

    const channelCount = Math.min(input.length, output.length);
    const blockLength = input[0].length;

    // Los parámetros son "k-rate": un único valor por bloque.
    const depth = clamp(Number(parameters.depth[0]) || 0, 0, 1);
    const time = clamp(Number(parameters.time[0]) || 0, 0, 1);
    const up = clamp(Number(parameters.up[0]) || 1, 0, 4);
    const down = clamp(Number(parameters.down[0]) || 1, 0, 4);
    const inv = (Number(parameters.inv[0]) || 0) >= 0.5 ? 1 : 0;

    // "Time" 0..1 → 0.25×..4× (exponencial: Time 50 % = 1×).
    const timeScale = Math.pow(TIME_SCALE_MAX, time * 2 - 1);

    // Coeficientes del seguidor de envolvente (uno por muestra).
    const attackSamples = Math.max(1, this.attackBase * timeScale * sampleRate);
    const releaseSamples = Math.max(1, this.releaseBase * timeScale * sampleRate);
    const attackCoeff = 1 - Math.exp(-1 / attackSamples);
    const releaseCoeff = 1 - Math.exp(-1 / releaseSamples);

    // Coeficiente del suavizado final de ganancia.
    const gainSmoothCoeff = 1 - Math.exp(-1 / (GAIN_SMOOTH_S * sampleRate));

    for (let i = 0; i < blockLength; i++) {
      // 1) Detección ENLAZADA: el pico entre todos los canales (mismo control
      //    para el izquierdo y el derecho → no se mueve la imagen estéreo).
      let peak = 0;
      for (let ch = 0; ch < channelCount; ch++) {
        const value = input[ch][i];
        const abs = value < 0 ? -value : value;
        if (abs > peak) peak = abs;
      }

      // 2) Nivel instantáneo en dB. Un pico ínfimo cuenta como silencio.
      let instDb;
      if (peak > 1e-9 && Number.isFinite(peak)) instDb = 20 * Math.log10(peak);
      else instDb = FLOOR_DB;

      // 3) Envolvente: sube con el ataque, baja con el release.
      const coeff = instDb > this.envDb ? attackCoeff : releaseCoeff;
      this.envDb += (instDb - this.envDb) * coeff;
      if (!Number.isFinite(this.envDb)) this.envDb = FLOOR_DB;

      // 4) Ganancia objetivo, en dB.
      let targetDb = 0;

      if (inv) {
        // Modo invertido: espejo con pendiente negativa alrededor del pivote.
        targetDb = INV_SLOPE * (INV_PIVOT_DB - this.envDb);
        targetDb = clamp(targetDb, -INV_MAX_DB, INV_MAX_DB);
      } else {
        // Compresión descendente (lo fuerte baja)...
        if (this.envDb > UPPER_DB) {
          targetDb -= depth * down * (this.envDb - UPPER_DB) * DOWN_SLOPE;
        }
        // ... y ascendente (lo suave sube), respetando el suelo de ruido.
        if (this.envDb < LOWER_DB && this.envDb > NOISE_FLOOR_DB) {
          targetDb += depth * up * (LOWER_DB - this.envDb) * UP_SLOPE;
        }
        targetDb = clamp(targetDb, -MAX_GAIN_DB, MAX_GAIN_DB);
      }

      // 5) Suavizado de la ganancia (evita clics y zumbido fino).
      this.gainDb += (targetDb - this.gainDb) * gainSmoothCoeff;
      if (!Number.isFinite(this.gainDb)) this.gainDb = 0;

      // 6) De dB a ganancia lineal (protección d: si no es finita, no cambiamos).
      let linear = Math.pow(10, this.gainDb / 20);
      if (!Number.isFinite(linear)) linear = 1;

      // 7) Aplicamos la MISMA ganancia a los dos canales (detección enlazada).
      for (let ch = 0; ch < channelCount; ch++) {
        const value = input[ch][i] * linear;
        output[ch][i] = Number.isFinite(value) ? value : 0; // NaN/infinito → silencio
      }
    }

    // Si la salida tuviera más canales que la entrada, los dejamos en silencio
    // (no queremos arrastrar basura de bloques anteriores).
    for (let ch = channelCount; ch < output.length; ch++) {
      output[ch].fill(0);
    }

    return true;
  }
}

// Le ponemos nombre al procesador: la interfaz lo crea con este mismo nombre.
registerProcessor("multiband-ott", MultibandOttProcessor);