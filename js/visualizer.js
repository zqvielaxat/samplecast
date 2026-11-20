/* =========================================================
   visualizer.js — dibujo con Canvas 2D

   Dos clases:
   - WaveformView:       forma de onda del sample entero + cabezal de reproducción.
   - SpectrumVisualizer: espectro FFT en tiempo real (barras que "bailan").

   IMPORTANTE: nada de lo que se dibuja acá cambia el sonido.
   Solo LEEMOS datos (las muestras del sample y la salida del AnalyserNode).
   ========================================================= */

/**
 * Ajusta los píxeles reales del canvas a su tamaño en pantalla.
 * Sin esto, en pantallas de alta densidad (retina) el dibujo se ve borroso.
 * Devuelve el "pincel" (ctx) y el tamaño en píxeles CSS.
 */
function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const pxW = Math.max(1, Math.round(rect.width * dpr));
  const pxH = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;   // cambiar width/height borra el canvas, por eso solo lo hacemos si cambió
    canvas.height = pxH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // desde acá dibujamos en píxeles CSS
  return { ctx, width: rect.width, height: rect.height };
}

/* ---------------------------------------------------------
   FORMA DE ONDA
   Un sample de 3 minutos tiene ~8 millones de números. No podemos dibujarlos
   todos: dividimos el audio en "columnas" (una cada pocos píxeles) y, de cada
   columna, guardamos el valor mínimo y el máximo. Eso es lo que dibujamos.
   --------------------------------------------------------- */
export class WaveformView {
  constructor(canvas) {
    this.canvas = canvas;
    this.buffer = null;
    this.peaks = null;      // [min0, max0, min1, max1, ...] por columna
    this.peaksColumns = 0;  // para cuántas columnas se calcularon
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    this.peaks = null; // forzamos recalcular
  }

  computePeaks(columns) {
    const peaks = new Float32Array(columns * 2);
    const length = this.buffer.length;
    const channels = [];
    for (let c = 0; c < this.buffer.numberOfChannels; c++) channels.push(this.buffer.getChannelData(c));

    const samplesPerColumn = length / columns;
    for (let col = 0; col < columns; col++) {
      const start = Math.floor(col * samplesPerColumn);
      const end = Math.max(start + 1, Math.min(length, Math.floor((col + 1) * samplesPerColumn)));
      const stride = Math.max(1, Math.floor((end - start) / 200)); // no hace falta mirar TODAS las muestras
      let min = 1, max = -1;
      for (const data of channels) {
        for (let i = start; i < end; i += stride) {
          const v = data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      peaks[col * 2] = min;
      peaks[col * 2 + 1] = max;
    }
    return peaks;
  }

  /**
   * progress: 0 a 1 (qué parte del sample ya sonó). Se llama en cada cuadro de animación.
   * loop: null, o un objeto { start, end } con la región de loop en fracciones 0..1 (solo si el loop está activo).
   */
  render(progress, loop = null) {
    const { ctx, width, height } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;

    // Línea central
    ctx.fillStyle = "rgba(22, 22, 26, 0.18)";
    ctx.fillRect(0, mid, width, 1);

    if (!this.buffer) {
      ctx.fillStyle = "#9b9ba1";
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("La forma de onda aparece acá", width / 2, mid - 10);
      return;
    }

    const step = 3;                              // ancho de cada columna en píxeles
    const columns = Math.max(1, Math.floor(width / step));
    if (!this.peaks || this.peaksColumns !== columns) {
      this.peaks = this.computePeaks(columns);   // solo recalcula si cambió el ancho de la ventana
      this.peaksColumns = columns;
    }

    const amp = (height / 2) * 0.92;
    const playedColumns = Math.floor(progress * columns);
    for (let col = 0; col < columns; col++) {
      const min = this.peaks[col * 2];
      const max = this.peaks[col * 2 + 1];
      const top = mid - max * amp;
      const h = Math.max(1, (max - min) * amp);
      // Lo que falta por sonar va gris; lo ya reproducido, negro (como en el diseño)
      ctx.fillStyle = col < playedColumns ? "#16161a" : "rgba(22, 22, 26, 0.3)";
      ctx.fillRect(col * step, top, step - 1, h);
    }

    // Región de loop: una franja apenas oscurecida con dos bordes
    if (loop) {
      const x0 = loop.start * width;
      const x1 = loop.end * width;
      ctx.fillStyle = "rgba(22, 22, 26, 0.07)";
      ctx.fillRect(x0, 0, x1 - x0, height);
      ctx.fillStyle = "rgba(22, 22, 26, 0.55)";
      ctx.fillRect(x0, 0, 1, height);
      ctx.fillRect(x1 - 1, 0, 1, height);
    }

    // Cabezal de reproducción: una línea gruesa con un punto arriba
    const x = progress * width;
    ctx.fillStyle = "#16161a";
    ctx.fillRect(Math.min(x, width - 2), 0, 2, height);
    ctx.beginPath();
    ctx.arc(Math.min(x, width - 2) + 1, 3, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ---------------------------------------------------------
   ESPECTRO FFT
   El AnalyserNode nos da, en cada cuadro, un arreglo con la energía de cada
   "bin" (banda de frecuencia muy angosta). Con fftSize 4096 hay 2048 bins y
   cada uno ocupa sampleRate/4096 Hz (≈ 10,8 Hz a 44,1 kHz).

   El oído percibe las frecuencias en escala LOGARÍTMICA (de 100 a 200 Hz hay
   una octava, igual que de 5000 a 10000 Hz). Por eso agrupamos los bins en
   barras cuyo ancho crece con la frecuencia.
   --------------------------------------------------------- */
export class SpectrumVisualizer {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.engine = engine;
    this.barCount = 72;
    this.peaks = new Float32Array(this.barCount); // "tapitas" que caen despacio
    this.freqData = null;
  }

  draw() {
    const { ctx, width, height } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, width, height);

    const analyser = this.engine.analyser; // es undefined hasta que se carga el primer sample
    const labelH = 26;                     // franja de abajo, para los rótulos de frecuencia
    const plotH = height - labelH;
    let nyquist = 22050; // frecuencia máxima representable = mitad de la frecuencia de muestreo

    if (analyser) {
      if (!this.freqData || this.freqData.length !== analyser.frequencyBinCount) {
        this.freqData = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(this.freqData); // llena el arreglo con valores 0..255
      nyquist = this.engine.ctx.sampleRate / 2;
    }

    const fMin = 40;
    const fMax = Math.min(18000, nyquist);
    const ratio = fMax / fMin;
    const binCount = this.freqData ? this.freqData.length : 1;

    // Líneas guía y rótulos de frecuencia (en blanco, sobre el fondo gris del panel)
    ctx.font = "13px 'Instrument Sans', system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const [hz, label] of [[100, "100 Hz"], [1000, "1 kHz"], [10000, "10 kHz"]]) {
      if (hz > fMax) continue;
      const x = (Math.log(hz / fMin) / Math.log(ratio)) * width; // posición logarítmica
      ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
      ctx.fillRect(x, 0, 1, plotH);
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fillText(label, Math.min(Math.max(x, 30), width - 30), height - 8);
    }

    const slot = width / this.barCount;
    const barW = Math.max(1, slot * 0.66);
    const peakLine = [];  // puntos por donde pasa la línea punteada de picos

    for (let i = 0; i < this.barCount; i++) {
      let value = 0;

      if (this.freqData) {
        // Rango de frecuencias que cubre esta barra
        const f0 = fMin * Math.pow(ratio, i / this.barCount);
        const f1 = fMin * Math.pow(ratio, (i + 1) / this.barCount);
        // Convertimos Hz → índice de bin
        const b0 = Math.floor((f0 / nyquist) * binCount);
        const b1 = Math.max(b0 + 1, Math.ceil((f1 / nyquist) * binCount));
        // La barra muestra el bin más fuerte de su rango
        let max = 0;
        for (let b = b0; b < b1 && b < binCount; b++) if (this.freqData[b] > max) max = this.freqData[b];
        value = max / 255;
      }

      // Tapita: sube de golpe, cae despacio
      this.peaks[i] = Math.max(value, this.peaks[i] - 0.006);

      const barH = Math.max(3, value * plotH);
      const x = i * slot + (slot - barW) / 2;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, plotH - barH, barW, barH);

      // La línea de picos va un poco por encima de las barras, como en el diseño
      peakLine.push({ x: x + barW / 2, y: plotH - Math.max(3, this.peaks[i] * plotH) - 9 });
    }

    // Línea punteada que une los picos (así se lee mejor la "envolvente")
    ctx.save();
    ctx.setLineDash([6, 7]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.beginPath();
    peakLine.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
    ctx.stroke();
    ctx.restore();
  }
}
