/* =========================================================
   recorder-wave.js — la "pantalla" de la Grabadora

   Dibuja la forma de onda de la grabación en un <canvas> y, encima, la región
   de RECORTE (lo que se va a descargar). Tiene dos modos:

     - EN VIVO: mientras grabamos, en cada cuadro leemos el AnalyserNode de la
       Grabadora y agregamos el pico (mínimo/máximo) de ese instante a una lista.
     - EXACTO: al terminar, la Grabadora nos da las muestras reales
       (Float32Array por canal) y calculamos los picos exactos.

   En ambos casos la onda se dibuja EN COLUMNAS verticales. Cuanto más largo es
   el audio, más finas son las columnas: así la onda se "comprime" horizontalmente
   y SIEMPRE entra completa en la pantalla (el nodo NO cambia de tamaño).

   Este archivo SOLO dibuja: no toca audio por su cuenta. El analyser viene de
   recorder.js y se lo pasa main.js.
   ========================================================= */

// Tope de ampliación del zoom: va de 1× (todo el sample) hasta MAX_ZOOM×.
export const MAX_ZOOM = 8;

/** Ajusta el canvas a su tamaño real en pantalla (retina incluida). */
function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const pxW = Math.max(1, Math.round(rect.width * dpr));
  const pxH = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;   // cambiar width/height borra el canvas
    canvas.height = pxH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // dibujamos en píxeles CSS
  return { ctx, width: rect.width, height: rect.height };
}

export class RecorderWaveView {
  constructor(canvas) {
    this.canvas = canvas;
    this.livePeaks = [];   // [{ min, max }] una columna por cuadro (en vivo)
    this.exactPeaks = null; // Float32Array [min0, max0, min1, max1, ...] al terminar
    this.columnCount = 0;   // cuántas columnas tiene exactPeaks
    this.trim = null;       // { start, end } en fracciones 0..1, o null
    this.cutActive = false; // ¿el botón "cut" está encendido?
    this.slices = null;     // límites de los slices en fracciones 0..1 (o null)
    this.hoverSlice = null; // índice del slice bajo el mouse (para el modo "click")
    this.clickActive = false; // ¿el modo "click" está encendido?
    this.zoom = 1;          // 1 = todo el sample; >1 = ampliado (se ve 1/zoom del total)
    this.center = 0.5;      // fracción del sample que está en el centro de la vista
    this.timeData = null;   // buffer reutilizable para leer el analyser
  }

  /** Vuelve al estado "sin grabación". */
  reset() {
    this.livePeaks = [];
    this.exactPeaks = null;
    this.columnCount = 0;
    this.trim = null;
    this.slices = null;
    this.zoom = 1;
    this.center = 0.5;
    this.draw();
  }

  /** Lee el AnalyserNode y agrega UNA columna con el pico de este instante. */
  capture(analyser) {
    const size = analyser.fftSize;
    if (!this.timeData || this.timeData.length !== size) {
      this.timeData = new Float32Array(size);
    }
    analyser.getFloatTimeDomainData(this.timeData);

    // Miramos 1 de cada 4 muestras: para una vista previa en vivo es suficiente.
    const stride = 4;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < size; i += stride) {
      const value = this.timeData[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (!Number.isFinite(min)) { min = 0; max = 0; } // sin señal = silencio

    this.livePeaks.push({ min, max });
  }

  /** Pone los picos EXACTOS (ya calculados) y descarta la toma en vivo. */
  setExact(peaks, columnCount) {
    this.exactPeaks = peaks;
    this.columnCount = columnCount;
    this.livePeaks = [];
  }

  /** fija la región de recorte (fracciones 0..1). null = sin recorte. */
  setTrim(start, end) {
    this.trim = start == null || end == null ? null : { start, end };
  }

  setCutActive(active) {
    this.cutActive = active;
  }

  /** Pone los límites de los slices (fracciones 0..1 del total, incluye inicio y
      fin). null = ocultar los marcadores. */
  setSlices(boundaries) {
    this.slices = boundaries && boundaries.length >= 2 ? boundaries : null;
  }

  /** Enciende/apaga el modo "click" (pre-escucha y recorte por slice). */
  setClickActive(active) {
    this.clickActive = active;
    if (!active) this.hoverSlice = null;
  }

  /** Marca qué slice está bajo el mouse (o null si ninguno). */
  setHoverSlice(index) {
    this.hoverSlice = index;
  }

  /**
   * Devuelve el índice del marcador INTERIOR que está a `tolerancePx` píxeles del
   * cursor, o −1 si no hay ninguno. `screenFraction` es la posición horizontal del
   * mouse dentro del canvas (0 a 1).
   */
  markerAt(screenFraction, tolerancePx = 6) {
    if (!this.slices || this.slices.length < 3) return -1;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return -1;

    const range = this.visibleRange();
    const span = range.end - range.start || 1;
    const targetX = screenFraction * rect.width;

    let best = -1;
    let bestDist = tolerancePx;
    for (let i = 1; i < this.slices.length - 1; i++) {
      const x = ((this.slices[i] - range.start) / span) * rect.width;
      const dist = Math.abs(x - targetX);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  }

  /**
   * Devuelve el índice del slice (0…n−1) que contiene la fracción `fraction`
   * (0..1 del total), o −1 si cae fuera de la región con slices.
   */
  sliceIndexAt(fraction) {
    if (!this.slices || this.slices.length < 2) return -1;
    if (fraction < this.slices[0] - 1e-9 || fraction > this.slices[this.slices.length - 1] + 1e-9) return -1;
    for (let i = 0; i < this.slices.length - 1; i++) {
      if (fraction >= this.slices[i] - 1e-9 && fraction <= this.slices[i + 1] + 1e-9) return i;
    }
    return -1;
  }

  /** Rango visible [0..1] del sample según el zoom y el centro de la vista. */
  visibleRange() {
    if (this.zoom <= 1) return { start: 0, end: 1 };
    const half = 0.5 / this.zoom;
    let start = this.center - half;
    let end = this.center + half;
    if (start < 0) { end -= start; start = 0; }
    if (end > 1) { start -= end - 1; end = 1; }
    start = Math.max(0, Math.min(1, start));
    end = Math.max(0, Math.min(1, end));
    return { start, end };
  }

  /** Convierte una fracción de pantalla (0..1 del canvas) a fracción real del sample. */
  screenToSample(fraction) {
    const { start, end } = this.visibleRange();
    return start + fraction * (end - start);
  }

  /**
   * Cambia el nivel de zoom (mult = 2 para acercar, 0.5 para alejar).
   * `focus` es la fracción del sample que conviene mantener centrada (por lo
   * general, el medio de la selección actual). Devuelve true si cambió.
   */
  zoomStep(mult, focus = null) {
    const before = this.zoom;
    this.zoom = Math.min(MAX_ZOOM, Math.max(1, this.zoom * mult));
    if (focus != null && Number.isFinite(focus)) {
      this.center = Math.min(1, Math.max(0, focus));
    }
    return this.zoom !== before;
  }

  /**
   * Reduce la fuente (picos vivos o exactos) a un número ENTERO de columnas,
   * muestreando solo el rango [from, to] (fracciones 0..1 del total). Así el
   * zoom puede mostrar una porción con la misma resolución de pantalla.
   * new Array(n) solo acepta un entero, así que redondeamos hacia abajo. Si el
   * ancho no es válido (0, NaN, etc.), devolvemos un arreglo vacío.
   */
  _resample(width, from = 0, to = 1) {
    if (!Number.isFinite(width) || width <= 0) return [];
    const count = Math.max(1, Math.floor(width));
    const columns = new Array(count);
    const source = this.exactPeaks ? this.columnCount : this.livePeaks.length;
    const span = to - from;

    for (let px = 0; px < count; px++) {
      // Índices de la fuente que caen dentro de esta columna (dentro del rango).
      const si = (from + (px / count) * span) * source;
      const ei = (from + ((px + 1) / count) * span) * source;
      let i0 = Math.floor(si);
      let i1 = Math.ceil(ei);
      if (i1 <= i0) i1 = i0 + 1;
      if (i0 < 0) i0 = 0;
      if (i1 > source) i1 = source;

      let min = Infinity;
      let max = -Infinity;
      for (let i = i0; i < i1 && i < source; i++) {
        if (this.exactPeaks) {
          if (this.exactPeaks[i * 2] < min) min = this.exactPeaks[i * 2];
          if (this.exactPeaks[i * 2 + 1] > max) max = this.exactPeaks[i * 2 + 1];
        } else {
          const peak = this.livePeaks[i];
          if (peak.min < min) min = peak.min;
          if (peak.max > max) max = peak.max;
        }
      }
      if (!Number.isFinite(min)) { min = 0; max = 0; }
      columns[px] = { min, max };
    }
    return columns;
  }

  draw() {
    const { ctx, width, height } = fitCanvas(this.canvas);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return;
    }

    // _resample necesita un ancho ENTERO (new Array(n) no acepta decimales).
    const columnsW = Math.max(1, Math.floor(width));
    const range = this.visibleRange();   // qué porción del sample se ve ahora

    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    const amp = Math.max(1, height / 2 - 2);

    // Línea central (el "cero" de la onda).
    ctx.fillStyle = "rgba(22, 22, 26, 0.18)";
    ctx.fillRect(0, mid, width, 1);

    const hasData = this.exactPeaks ? this.columnCount > 0 : this.livePeaks.length > 0;
    if (hasData && columnsW > 1) {
      const columns = this._resample(columnsW, range.start, range.end);
      ctx.fillStyle = "rgba(22, 22, 26, 0.60)";
      for (let px = 0; px < columns.length; px++) {
        const { min, max } = columns[px];
        const top = mid - max * amp;
        const bottom = mid - min * amp;
        const h = Math.max(1, bottom - top);
        ctx.fillRect(px, top, 1, h);
      }
    }

    // RECORTE: oscurecemos lo EXCLUIDO y marcamos con borde verde lo elegido.
    // Con el zoom, la selección (fracciones del TOTAL) se proyecta a píxeles.
    if (this.cutActive && this.trim) {
      const span = range.end - range.start || 1;
      const toX = (f) => ((f - range.start) / span) * width;
      const x0 = Math.max(0, Math.min(width, toX(this.trim.start)));
      const x1 = Math.max(0, Math.min(width, toX(this.trim.end)));
      ctx.fillStyle = "rgba(22, 22, 26, 0.45)";
      ctx.fillRect(0, 0, x0, height);
      ctx.fillRect(x1, 0, width - x1, height);

      ctx.strokeStyle = "#17e33c";
      ctx.lineWidth = 2;
      ctx.strokeRect(x0, 2, Math.max(1, x1 - x0), height - 4);
    }

    // SLICES: líneas verticales sobre la onda en cada corte. Dibujamos solo los
    // marcadores INTERIORES: el primero y el último son los bordes de la región
    // (o de la grabación), que ya se ven con el recorte.
    if (this.slices && this.slices.length > 2) {
      const span = range.end - range.start || 1;
      const toX = (f) => ((f - range.start) / span) * width;
      ctx.strokeStyle = "#ff7a1a";   // naranja, distinto del verde del recorte
      ctx.lineWidth = 2;
      for (let i = 1; i < this.slices.length - 1; i++) {
        const f = this.slices[i];
        if (f < range.start || f > range.end) continue;
        const x = Math.round(toX(f)) + 0.5;   // +0.5 para que la línea quede nítida
        ctx.beginPath();
        ctx.moveTo(x, 3);
        ctx.lineTo(x, height - 3);
        ctx.stroke();
      }
    }

    // Realce del slice bajo el mouse (modo "click"): pintamos una franja suave
    // sobre la región que ocupa ese slice, así se ve a cuál vas a hacerle la
    // pre-escucha o "dejar solo".
    if (this.clickActive && this.hoverSlice != null && this.slices &&
        this.hoverSlice >= 0 && this.hoverSlice < this.slices.length - 1) {
      const span = range.end - range.start || 1;
      const toX = (f) => ((f - range.start) / span) * width;
      const x0 = Math.max(0, Math.min(width, toX(this.slices[this.hoverSlice])));
      const x1 = Math.max(0, Math.min(width, toX(this.slices[this.hoverSlice + 1])));
      if (x1 > x0) {
        ctx.fillStyle = "rgba(23, 227, 60, 0.16)";
        ctx.fillRect(x0, 0, x1 - x0, height);
      }
    }
  }
}