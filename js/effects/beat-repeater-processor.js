/* =========================================================
   beat-repeater-processor.js — las "cuentas" del efecto Beat Repeater

   ¡ATENCIÓN! Igual que los otros procesadores, este archivo corre dentro del
   AudioWorklet: NO es un módulo (nada de import/export), no hay window ni
   document, y el audio llega en bloques de 128 muestras.

   QUÉ HACE EL EFECTO (un "stutter" / beat repeater)
   -------------------------------------------------
   Es un efecto en el dominio del TIEMPO, pero distinto de la Distortion: acá no
   transformamos cada muestra, sino que GUARDAMOS audio en memoria y lo
   repetimos. La receta:

     1) Mientras el efecto está conectado, TODO lo que entra se va guardando en
        un BUFFER CIRCULAR (una cinta que da vueltas: cuando llega al final,
        sigue por el principio, pisando lo más viejo).
     2) En el instante en que el efecto se ACTIVA, sacamos una FOTO de ese
        buffer (lo copiamos a un segundo arreglo: el "fragmento congelado").
        A partir de ahí el fragmento ya no cambia.
     3) Mientras siga activo, reproducimos ese fragmento una y otra vez, al
        ritmo que marca el paso (BPM + división), bajando el volumen en cada
        vuelta si hay Decay, y callándolo una parte de cada vuelta si el Gate
        es menor que 100 %.

   Por eso el efecto NO agrega retraso a la señal: no estamos guardando el audio
   para soltarlo más tarde, estamos releyendo algo que ya pasó.

   LOS FUNDIDOS (por qué el efecto no hace clic)
   --------------------------------------------
   Cada vuelta arranca en un punto cualquiera de la onda (donde quedó el
   puntero): si empezáramos a leer ahí de golpe, la onda daría un salto brusco y
   se escucharía un "clic". Solución: los primeros FADE_SECONDS de cada vuelta
   suben de 0 a 1, y los últimos bajan de 1 a 0. Con 3 ms alcanza para que el
   oído no note nada y el salto desaparezca.

   OJO CON EL TAMAÑO DEL BUFFER: la cinta tiene que poder guardar el paso MÁS
   LARGO que permite la interfaz (1500 ms). Con 2 segundos sobra. Si el paso
   fuera más largo que la cinta, no habría fragmento completo para repetir (es
   una limitación de esta primera versión).
   ========================================================= */

// Cuántos segundos de audio guarda la cinta.
const BUFFER_SECONDS = 2;

// Un paso no puede ser más corto que esto (en muestras). Con BPM 240 y 1/32T el
// paso más corto posible es de ~1000 muestras, así que este piso no molesta.
const MIN_STEP_SAMPLES = 64;

// Duración de los fundidos de entrada y salida de cada vuelta.
const FADE_SECONDS = 0.003;   // 3 ms

class BeatRepeaterProcessor extends AudioWorkletProcessor {
  /** Parámetros que la interfaz puede cambiar en vivo. */
  static get parameterDescriptors() {
    return [
      // Largo del paso, en segundos. La cuenta (BPM × división) la hace la
      // interfaz (beat-repeater.js) y nos la manda ya resuelta.
      { name: "stepSeconds", defaultValue: 0.25, minValue: 0.005, maxValue: BUFFER_SECONDS, automationRate: "k-rate" },
      // Qué parte de cada vuelta suena (10 a 100 %).
      { name: "gate", defaultValue: 100, minValue: 10, maxValue: 100, automationRate: "k-rate" },
      // Cuánto baja el volumen en cada vuelta (0 = no baja nunca).
      { name: "decay", defaultValue: 0, minValue: 0, maxValue: 100, automationRate: "k-rate" },
      // 1 = repetiendo, 0 = apagado. El cambio de 0 a 1 es el momento en que
      // sacamos la foto del buffer.
      { name: "active", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();

    // Cuántas muestras guarda la cinta. sampleRate es una variable global del
    // AudioWorklet (nos la da el navegador).
    this.bufferSamples = Math.max(1024, Math.round(BUFFER_SECONDS * sampleRate));

    this.history = [];      // la cinta circular, un arreglo por canal
    this.frozen = [];       // la foto del fragmento, un arreglo por canal
    this.write = 0;         // dónde entra la próxima muestra en la cinta

    // Reloj de la repetición (uno solo para todos los canales: la repetición es
    // un asunto de tiempo, no de canal).
    this.step = 0;          // largo del paso con el que estamos repitiendo, en muestras
    this.phase = 0;         // en qué muestra del paso estamos
    this.repeat = 0;        // cuántas vueltas van (para el Decay)
    this.gain = 1;          // volumen de la vuelta actual
    this.wasActive = false; // para detectar el momento exacto de la activación
  }

  /** Crea la cinta y la foto de un canal la primera vez que lo vemos. */
  ensureChannels(channels) {
    while (this.history.length < channels) {
      this.history.push(new Float32Array(this.bufferSamples));
      this.frozen.push(new Float32Array(this.bufferSamples));
    }
  }

  /**
   * Saca la foto de la cinta: copia el buffer circular "en orden cronológico"
   * (de la muestra más vieja a la más nueva). Así la muestra más nueva queda al
   * FINAL de la copia y el fragmento a repetir es siempre un pedacito pegado al
   * final: no hay que dar vueltas, se lee derecho.
   */
  capture(channels) {
    for (let ch = 0; ch < channels; ch++) {
      const history = this.history[ch];
      const frozen = this.frozen[ch];
      for (let n = 0; n < this.bufferSamples; n++) {
        const index = this.write + n;
        frozen[n] = history[index >= this.bufferSamples ? index - this.bufferSamples : index];
      }
    }
  }


  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true; // sin entrada no hay nada que hacer

    const channels = input.length;
    const blockLength = input[0].length;
    const active = parameters.active[0] >= 0.5;

    // El paso, en muestras, recortado a lo que entra en la cinta.
    let stepSamples = Math.round(parameters.stepSeconds[0] * sampleRate);
    if (stepSamples < MIN_STEP_SAMPLES) stepSamples = MIN_STEP_SAMPLES;
    if (stepSamples > this.bufferSamples) stepSamples = this.bufferSamples;

    // Cuántas muestras de cada vuelta suenan, y cuánto dura el fundido.
    const gateSamples = Math.max(1, Math.round((stepSamples * parameters.gate[0]) / 100));
    const fade = Math.max(1, Math.min(Math.round(FADE_SECONDS * sampleRate), Math.floor(gateSamples / 4)));

    // Cuánto queda del volumen después de cada vuelta (Decay 0 % → queda todo).
    const decayPerRepeat = 1 - parameters.decay[0] / 100;

    this.ensureChannels(channels);

    for (let i = 0; i < blockLength; i++) {
      // 1) ¿Nos acaban de activar, o cambió el largo del paso? Re-anclamos el
      //    ciclo: volvemos al principio del fragmento. El fundido de entrada se
      //    encarga de que ese salto no se escuche.
      if (active && (!this.wasActive || this.step !== stepSamples)) {
        if (!this.wasActive) this.capture(channels); // recién ahora sacamos la foto
        this.step = stepSamples;
        this.phase = 0;
        this.repeat = 0;
        this.gain = 1;
      }
      this.wasActive = active;

      // 2) Guardamos la entrada en la cinta y sacamos la muestra que toca.
      if (this.step > 0) {
        // El fragmento ocupa el final de la foto: de acá hasta el final.
        const start = this.bufferSamples - this.step;

        // Envolvente del Gate: 1 mientras suena, 0 cuando calla, con rampas.
        let env = 0;
        if (this.phase < gateSamples) {
          env = 1;
          if (this.phase < fade) env = this.phase / fade;              // fundido de entrada
          const remaining = gateSamples - this.phase;
          if (remaining < fade) env = Math.min(env, remaining / fade);  // fundido de salida
        }
        const level = env * this.gain;

        for (let ch = 0; ch < channels; ch++) {
          this.history[ch][this.write] = input[ch][i];
          output[ch][i] = this.frozen[ch][start + this.phase] * level;
        }
      } else {
        // Todavía nunca se activó: la salida es silencio (el Dry/Wet se ocupa de
        // que se siga escuchando el camino seco).
        for (let ch = 0; ch < channels; ch++) {
          this.history[ch][this.write] = input[ch][i];
          output[ch][i] = 0;
        }
      }

      // 3) Avanzamos la cinta y el reloj de la repetición.
      this.write++;
      if (this.write >= this.bufferSamples) this.write = 0;

      if (this.step > 0) {
        this.phase++;
        if (this.phase >= this.step) {
          // Se terminó la vuelta: arranca otra, un poquito más floja si hay Decay.
          this.phase = 0;
          this.repeat++;
          this.gain = Math.pow(decayPerRepeat, this.repeat);
        }
      }
    }

    return true;
  }
}

// Le ponemos nombre al procesador: la interfaz lo crea con este mismo nombre.
registerProcessor("beat-repeater", BeatRepeaterProcessor);
