/* =========================================================
   audio-engine.js — el "motor" de audio: contexto, grafo y archivos

   Acá vive la CONSTRUCCIÓN del grafo de nodos de la Web Audio API.
   La reproducción en sí (play, pausa, posición, loop) la maneja Transport
   (js/transport.js); el motor solo se lo crea y le dice a dónde conectarse.

   IDEA CLAVE: el audio fluye por un "grafo" de NODOS conectados con cables (connect):

     [Transport: fuente] → [entrada efectos] → (efectos...) → [salida efectos]
                                                                  │
                                                             [volumen]
                                                              │      └──→ [analizador] (solo mira)
                                                              └──→ [altavoces]
   NOTA IMPORTANTE: el orden de los efectos NO es fijo; lo decide el tablero de
   nodos (js/patch-board.js). Por eso hay dos listas parecidas:
     this.effects → TODOS los efectos registrados (los nodos que existen)
     this.chain   → los que están CONECTADOS ahora, en orden (el camino del audio)
   Un nodo suelto, sin cable, no está en el camino de la señal.
   ========================================================= */

import { Transport } from "./transport.js";

export class AudioEngine {
  constructor() {
    // El AudioContext es el "estudio" donde viven todos los nodos.
    // Todavía no lo creamos: los navegadores exigen que nazca después de un gesto del usuario.
    this.ctx = null;

    // El transporte existe desde el principio (así main.js puede configurarlo ya),
    // pero recién se conecta al audio cuando se crea el contexto.
    this.transport = new Transport();

    this.volume = 0.8;   // guardado por si el usuario mueve el control antes de cargar un sample

    this.effects = [];   // TODOS los efectos registrados (los nodos que existen en el tablero)
    this.chain = [];     // los que están conectados AHORA, en orden (lo decide el tablero)
    this.taps = [];      // nodos SIN salida (la Grabadora): escuchan la salida del nodo del que cuelgan
    this._links = [];    // los cables que armamos nosotros, para poder desarmarlos después
  }

  /** Crea el AudioContext y los nodos fijos del grafo (una sola vez). */
  ensureContext(existingContext = null) {
    if (this.ctx) return;

    // Normalmente creamos un AudioContext nuevo. Si nos pasan uno ya hecho
    // (por ejemplo un OfflineAudioContext desde una prueba automática), lo usamos.
    // webkitAudioContext = nombre viejo en Safari antiguo
    this.ctx = existingContext ?? new (window.AudioContext || window.webkitAudioContext)();

    // Nodos "gain" = perillas de volumen. Los usamos también como puntos de conexión.
    this.effectsInput = this.ctx.createGain();
    this.effectsOutput = this.ctx.createGain();
    this.outputGain = this.ctx.createGain();
    this.outputGain.gain.value = this.volume;

    // El AnalyserNode calcula la FFT en vivo. SOLO MIRA la señal: no la cambia.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;               // 4096 muestras por análisis → 2048 bins
    this.analyser.smoothingTimeConstant = 0.78; // suaviza entre cuadros
    this.analyser.minDecibels = -95;
    this.analyser.maxDecibels = -20;

    // Cableado fijo. Sin efectos, la entrada va directo a la salida.
    // Primero le pedimos a cada efecto que arme sus nodos (antes no se podía:
    // recién ahora existe el AudioContext).
    for (const fx of this.effects) fx.attach(this.ctx);

    this.rebuildChain();
    this.effectsOutput.connect(this.outputGain);
    this.outputGain.connect(this.ctx.destination); // destination = los parlantes
    this.outputGain.connect(this.analyser);        // rama paralela: el analizador escucha lo mismo

    // El transporte hará sonar el sample hacia la entrada de la cadena de efectos.
    this.transport.attach(this.ctx, this.effectsInput);
  }

  /**
   * Define qué efectos están conectados y en qué orden.
   * main.js le pasa la lista que resulta de leer los cables del tablero.
   */
  setChain(effects) {
    this.chain = effects.slice();
    if (this.ctx) this.rebuildChain();
  }

  /**
   * Define los nodos "tap" (sin salida, como la Grabadora).
   * Cada uno es { from: idDelNodo, effect }: su entrada recibe la SALIDA del
   * nodo `from`, sin interrumpir la cadena.
   */
  setTaps(taps) {
    this.taps = taps;
    if (this.ctx) this.rebuildChain();
  }

  /** Vuelve a cablear: entrada → efecto1 → efecto2 → ... → salida, más las escuchas. */
  rebuildChain() {
    // Desconectamos SOLO los cables que armamos nosotros en la vuelta anterior.
    // No sirve hacer fx.output.disconnect() a secas: cada efecto tiene conexiones
    // internas propias (su seco, su húmedo) que no queremos romper.
    for (const link of this._links) {
      try { link.from.disconnect(link.to); } catch { /* ese cable ya no estaba */ }
    }
    this._links = [];

    // 1) La cadena en serie: entrada → efecto → efecto → ... → salida.
    let previous = this.effectsInput;
    for (const fx of this.chain) {
      this._link(previous, fx.input);
      previous = fx.output;
    }
    this._link(previous, this.effectsOutput);

    // 2) LAS ESCUCHAS. Un efecto que NO está conectado no recibe audio por la
    //    cadena... pero algunos necesitan oír lo que pasa para funcionar cuando
    //    los conectás (el Beat Repeater guarda el audio reciente en memoria: si
    //    no escuchara nada mientras está suelto, al conectarlo repetiría
    //    silencio). Les conectamos la entrada de los efectos; su salida no va a
    //    ningún lado, así que NO se escuchan: solo miran.
    for (const fx of this.effects) {
      if (fx.monitors && !this.chain.includes(fx)) this._link(this.effectsInput, fx.input);
    }

    // 3) Los nodos "tap" (Grabadora): reciben la salida del nodo del que cuelgan.
    for (const tap of this.taps) {
      const source = this._outputOfNode(tap.from);
      if (source) this._link(source, tap.effect.input);
    }
  }

  /**
   * La salida de un nodo del tablero: "main" es la entrada de la cadena de efectos.
   * OJO: acá NO usamos `effect.id` (que es el TIPO de efecto, ej. "distortion"):
   * usamos `effect.nodeId`, que es el id ÚNICO de cada copia en el tablero. Si
   * comparáramos por tipo, al conectar dos copias del mismo efecto la segunda
   * nunca se encontraría y la Grabadora quedaría sin señal.
   */
  _outputOfNode(id) {
    if (id === "main") return this.effectsInput;
    const fx = this.effects.find((effect) => effect.nodeId === id);
    return fx ? fx.output : null;
  }

  /** Conecta dos nodos y se acuerda del cable, para poder cortarlo después. */
  _link(from, to) {
    from.connect(to);
    this._links.push({ from, to });
  }

  /** Punto de extensión: así se enchufa cada efecto nuevo. */
  addEffect(effect) {
    this.effects.push(effect);
    // Si el contexto ya existe, el efecto se arma y se recablea la cadena.
    if (this.ctx) {
      effect.attach(this.ctx);
      this.rebuildChain();
    }
  }

  /**
   * Saca un efecto del grafo de audio. Solo lo quita de la lista: main.js se
   * encarga de recablear la cadena (setChain / setTaps) justo después de borrarlo.
   */
  removeEffect(effect) {
    const index = this.effects.indexOf(effect);
    if (index >= 0) this.effects.splice(index, 1);
  }

  /** Lee un archivo del disco, lo decodifica y se lo entrega al transporte. */
  async loadFile(file) {
    this.ensureContext();

    const arrayBuffer = await file.arrayBuffer();               // bytes crudos del archivo
    // decodeAudioData entiende MP3, WAV, OGG... y devuelve un AudioBuffer.
    // Lo remuestrea a la frecuencia de muestreo del AudioContext.
    const buffer = await this.ctx.decodeAudioData(arrayBuffer);

    this.transport.setBuffer(buffer); // recién acá reemplazamos el sample anterior

    return {
      name: file.name,
      buffer,
      duration: buffer.duration,
      channels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    };
  }

  /** value va de 0 a 1. */
  setVolume(value) {
    this.volume = value;
    if (!this.ctx) return;
    // setTargetAtTime hace una transición suave (~10 ms). Un salto brusco produce "clicks".
    this.outputGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }
}
