/* =========================================================
   transport.js — el "transporte": play, pausa, posición, seek y loop

   ¿Qué es un transporte? Es la parte de un reproductor que decide
   "QUÉ parte del sample suena y CUÁNDO" (como los botones de una casetera).
   NO sabe nada de efectos, volumen ni dibujos: solo maneja la reproducción.

   REGLA DE ORO DE ESTE ARCHIVO: hay UNA sola fuente de verdad para la posición:
       posición = this.offset + (tiempo transcurrido desde que arrancó)
   Todo lo demás (pausa, seek, loop, el reloj de la pantalla) pregunta a
   getPosition(). Nadie más calcula posiciones por su cuenta.

   Cómo suena el audio: usamos un AudioBufferSourceNode (un nodo que reproduce
   un AudioBuffer en memoria). No usamos un elemento <audio> de HTML.
   Esos nodos son de UN SOLO USO: para saltar a otra posición hay que crear uno
   nuevo. Eso hace startSource() (ver más abajo).
   ========================================================= */

// Un loop no puede durar menos que esto (segundos). Evita loops de 0 segundos que no tienen sentido.
const MIN_LOOP = 0.01;

export class Transport {
  constructor() {
    this.ctx = null;        // el AudioContext (llega en attach)
    this.output = null;     // nodo al que conectamos el sonido (la entrada de la cadena de efectos)

    this.buffer = null;     // el sample decodificado. El transporte es su ÚNICO dueño.
    this.source = null;     // el nodo que está sonando ahora (o null)
    this.isPlaying = false;

    this.offset = 0;              // posición del sample (segundos) en el momento en que arrancó el nodo actual
    this.startedAtCtxTime = 0;    // lectura del reloj de audio (ctx.currentTime) en ese mismo momento
    this.sourceLoops = false;     // ¿el nodo actual está en modo loop?

    // Objeto con la configuración del loop. Otros archivos lo LEEN (por ejemplo para dibujarlo),
    // pero solo se modifica con setLoopEnabled / setLoopRegion.
    this.loop = { enabled: false, start: 0, end: 0 };

    this.onEnded = null;    // callback: main.js nos da una función para avisarle cuando el sample termina
  }

  /** El motor nos entrega el contexto y el nodo de salida cuando ya existen. */
  attach(ctx, output) {
    this.ctx = ctx;
    this.output = output;
  }

  /** Recibe un sample nuevo: frena todo y vuelve al estado inicial. */
  setBuffer(buffer) {
    this.stopSource();
    this.isPlaying = false;
    this.offset = 0;
    this.buffer = buffer;
    // La región de loop por defecto es el sample entero. (enabled se conserva: si tenías el loop activado, sigue activado.)
    this.loop.start = 0;
    this.loop.end = buffer.duration;
  }

  /* ---------------- Reproducción ---------------- */

  async play() {
    if (!this.buffer || this.isPlaying) return;

    // Si el navegador dejó el contexto "suspended" (política de autoplay), lo despertamos.
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (this.isPlaying) return; // por si hubo doble click mientras esperábamos

    if (this.offset >= this.buffer.duration) this.offset = 0;
    this.startSource();
  }

  pause() {
    if (!this.isPlaying) return;
    this.offset = this.getPosition(); // guardamos el punto ANTES de frenar
    this.stopSource();
    this.isPlaying = false;
  }

  /** Salta a una posición (en segundos). Si estaba sonando, sigue sonando desde ahí; si estaba en pausa, solo mueve el cursor. */
  seek(seconds) {
    if (!this.buffer) return;
    const target = Math.min(Math.max(seconds, 0), this.buffer.duration); // "clamp": lo dejamos dentro de 0..duración

    if (this.isPlaying) {
      this.stopSource();
      this.offset = target;
      this.startSource(); // el mismo código que usa play(): no hay una segunda forma de arrancar
    } else {
      this.offset = target;
    }
  }

  /** Reiniciar = saltar al segundo 0. Reutiliza seek() en vez de repetir lógica. */
  restart() {
    this.seek(0);
  }

  /* ---------------- Loop ---------------- */

  setLoopEnabled(enabled) {
    this.rebase();
    this.loop.enabled = Boolean(enabled);
    this.applyLoopToSource();
  }

  /** Define inicio y fin del loop (segundos). Corrige valores imposibles. */
  setLoopRegion(start, end) {
    if (!this.buffer) return;
    this.rebase();

    const duration = this.buffer.duration;
    const safeStart = Math.min(Math.max(start, 0), duration - MIN_LOOP);
    const safeEnd = Math.min(Math.max(end, safeStart + MIN_LOOP), duration);
    this.loop.start = safeStart;
    this.loop.end = safeEnd;

    this.applyLoopToSource();
  }

  /* ---------------- Posición ---------------- */

  /** LA función de posición. Devuelve segundos dentro del sample. */
  getPosition() {
    if (!this.buffer) return 0;
    if (!this.isPlaying) return this.offset;

    let position = this.offset + (this.ctx.currentTime - this.startedAtCtxTime);

    if (this.sourceLoops && position >= this.loop.end) {
      // Pasamos el final del loop: la posición real "dio vueltas".
      // El operador % (resto) calcula cuánto avanzamos dentro de la vuelta actual.
      const loopLength = this.loop.end - this.loop.start;
      position = this.loop.start + ((position - this.loop.start) % loopLength);
    }
    return Math.min(position, this.buffer.duration);
  }

  getDuration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /* ---------------- Interno (uso solo dentro de esta clase) ---------------- */

  /** Crea un nodo nuevo y lo hace sonar desde this.offset. Lo usan play() y seek(). */
  startSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.output);

    // Se dispara solo cuando el sample llega al final (con loop activo nunca llega).
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.isPlaying = false;
      this.offset = 0;
      if (this.onEnded) this.onEnded();
    };

    this.source = src;
    this.startedAtCtxTime = this.ctx.currentTime;
    this.isPlaying = true;
    this.applyLoopToSource();
    src.start(0, this.offset); // start(cuándo, desdeQuéSegundo)
  }

  stopSource() {
    if (!this.source) return;
    this.source.onended = null; // si no, "ended" se dispararía como si hubiera terminado solo
    try { this.source.stop(); } catch { /* ya estaba detenido */ }
    this.source.disconnect();
    this.source = null;
  }

  /**
   * "Rebase": dice "a partir de AHORA, cuento desde la posición actual".
   * Se llama ANTES de cambiar el loop, porque getPosition() usa los valores
   * viejos del loop para calcular dónde estamos. Después de cambiarlos, ya no sería correcto.
   */
  rebase() {
    if (!this.isPlaying) return;
    this.offset = this.getPosition();
    this.startedAtCtxTime = this.ctx.currentTime;
  }

  /**
   * Copia la configuración de loop al nodo que está sonando.
   * El loop solo se "engancha" si la reproducción todavía NO pasó el final del loop
   * (this.offset < end). Si estás más allá (por ejemplo hiciste clic después del fin del loop),
   * el sample suena hasta el final y se detiene.
   */
  applyLoopToSource() {
    if (!this.source) return;
    const { enabled, start, end } = this.loop; // "desestructuración": saca 3 propiedades del objeto de una vez
    this.sourceLoops = enabled && this.offset < end;
    this.source.loopStart = start;
    this.source.loopEnd = end;
    this.source.loop = this.sourceLoops;
  }
}
