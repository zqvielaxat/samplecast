/* =========================================================
   effects/registry.js — catálogo de efectos

   Es una LISTA DE DATOS que describe cada efecto: nombre, resumen, parámetros
   y dónde nace su nodo dentro del espacio infinito.

   main.js lee esta lista y arma un NODO por efecto. Convenciones de los controles:
     - El parámetro con id "mix" se dibuja como FADER (Dry/Wet).
     - Un parámetro con kind: "select" se dibuja como LISTA DESPLEGABLE (por
       ejemplo el "Tipo" de la Distortion). Trae su value y sus options.
     - Un parámetro con kind: "number" se dibuja como CAMPO NUMÉRICO.
     - Todos los demás se dibujan como PERILLAS (P1, P2, ...).
   Por eso cada parámetro trae min, max, step, value y unit.

   También hay dos banderas para nodos especiales:
     - ui: "recorder" → la tarjeta NO se arma desde params; main.js la dibuja a
       mano (botones de grabar/parar/descargar).
     - tap: true → el nodo no tiene salida: es un "oído" que recibe la salida del
       nodo del que cuelga sin interrumpir la cadena (la Grabadora).

   available: false → el efecto todavía no existe: su nodo aparece en gris, con
   línea de puntos, y no acepta conexiones. Cuando lo implementamos pasa a true
   y sumamos su archivo (por ejemplo js/effects/frequency-shift.js). Si el efecto
   usa un AudioWorklet, va también su procesador (frequency-shift-processor.js);
   si se arma solo con nodos nativos de la Web Audio API (como la Distortion,
   que usa un WaveShaperNode), el procesador no hace falta.
   main.js une cada slot con su clase mediante el objeto EFFECT_CLASSES.
   ========================================================= */

import { MULTIBAND_OTT_PRESETS } from "./multiband-ott-presets.js";
import { BITCRUSHER_PRESETS } from "./bitcrusher-presets.js";
import { buildPresetOptions } from "./presets.js";

export const EFFECT_SLOTS = [
  {
    id: "frequency-shift",
    name: "Freq Shift",
    summary: "Corre todas las frecuencias una cantidad fija de Hz: sonido metálico.",
    stage: 2,
    available: true,
    // Posición de su nodo dentro del espacio (coordenadas de mundo)
    home: { x: 720, y: 60 },
    params: [
      { id: "shift", label: "Desplazamiento", unit: "Hz", min: -1000, max: 1000, step: 1, value: 0 },
      { id: "mix", label: "Dry/Wet", unit: "%", min: 0, max: 100, step: 1, value: 100 },
    ],
  },
  {
    id: "distortion",
    name: "Distortion",
    summary: "Aplasta la onda muestra por muestra: armónicos nuevos y mordida.",
    stage: 2,
    available: true,
    home: { x: 720, y: 960 },
    params: [
      { id: "drive", label: "Drive", unit: "%", min: 0, max: 100, step: 1, value: 50 },
      {
        id: "type",
        label: "Tipo",
        kind: "select",          // ← se dibuja como lista desplegable
        value: "soft",
        options: [
          { value: "soft", label: "Soft clip (tanh)" },
          { value: "hard", label: "Hard clip" },
          { value: "fold", label: "Wavefolder" },
        ],
      },
      { id: "tone", label: "Tono", unit: "%", min: 0, max: 100, step: 1, value: 100 },
      { id: "level", label: "Nivel", unit: "dB", min: -24, max: 24, step: 1, value: 0 },
      { id: "mix", label: "Dry/Wet", unit: "%", min: 0, max: 100, step: 1, value: 100 },
    ],
  },
  {
    id: "bin-scrambler",
    name: "Binscrambler",
    summary: "Reordena y altera bins de frecuencia: resultados glitchy y ásperos.",
    stage: 3,
    available: true,
    home: { x: 720, y: -400 },
    params: [
      { id: "amount", label: "Intensidad", unit: "%", min: 0, max: 100, step: 1, value: 50 },
      { id: "rate", label: "Velocidad", unit: "", min: 1, max: 100, step: 1, value: 20 },
      { id: "mix", label: "Dry/Wet", unit: "%", min: 0, max: 100, step: 1, value: 100 },
    ],
  },
  {
    id: "beat-repeater",
    name: "Beat Repeater",
    summary: "Congela el último fragmento y lo repite en bucle: stutter.",
    stage: 3,
    available: true,
    home: { x: 1500, y: 60 },
    params: [
      { id: "ms", label: "Paso", unit: "ms", min: 20, max: 1500, step: 5, value: 250 },
      { id: "gate", label: "Gate", unit: "%", min: 10, max: 100, step: 1, value: 100 },
      { id: "decay", label: "Decay", unit: "%", min: 0, max: 100, step: 1, value: 0 },
      { id: "mix", label: "Dry/Wet", unit: "%", min: 0, max: 100, step: 1, value: 100 },
    ],
  },
  {
    id: "flanger",
    name: "Flanger",
    summary: "Peine de retardos cortos barrido por un LFO: el barrido espacial de \"avión\".",
    stage: 3,
    available: true,
    home: { x: 1500, y: -280 },
    params: [
      { id: "rate", label: "Rate", unit: "Hz", min: 0.05, max: 8, step: 0.05, value: 0.3 },
      { id: "depth", label: "Depth", unit: "ms", min: 0, max: 3.5, step: 0.1, value: 2 },
      { id: "feedback", label: "Feedback", unit: "%", min: 0, max: 100, step: 1, value: 50 },
      { id: "mix", label: "Dry/Wet", unit: "%", min: 0, max: 100, step: 1, value: 100 },
    ],
  },
  {
    id: "recorder",
    name: "Grabadora",
    summary: "Graba lo que le llega y lo descarga como WAV. No corta la señal.",
    stage: 3,
    available: true,
    ui: "recorder",     // su tarjeta se dibuja a mano (botones, no perillas)
    tap: true,          // nodo SIN salida: solo escucha, no interrumpe la cadena
    home: { x: 1500, y: 560 },
    params: [],         // sin parámetros: la lógica vive en recorder.js
  },
  {
    id: "spectral-gate",
    name: "Spectral Gate",
    summary: "Elimina los componentes espectrales débiles: texturas fragmentadas.",
    stage: 4,
    available: true,
    home: { x: 720, y: 1400 },
    params: [
      { id: "threshold", label: "Umbral", unit: "dB", min: -90, max: 0, step: 1, value: -50 },
      { id: "amount", label: "Intensidad", unit: "%", min: 0, max: 100, step: 1, value: 100 },
      { id: "mix", label: "Dry/Wet", unit: "%", min: 0, max: 100, step: 1, value: 100 },
    ],
  },
  {
    id: "multiband-ott",
    name: "Multiband OTT",
    summary: "Compresión multibanda ascendente y descendente: denso, brillante y sin dinámica.",
    stage: 4,
    available: true,
    home: { x: 720, y: 1900 },
    params: [
      {
        id: "preset",
        label: "Preset",
        kind: "select",          // ← lista desplegable con los presets
        value: "neutro",
        options: buildPresetOptions(MULTIBAND_OTT_PRESETS),
      },
      { id: "depth", label: "Depth", unit: "%", kind: "slider", min: 0, max: 100, step: 1, value: 0 },
      { id: "time", label: "Time", unit: "%", kind: "slider", min: 0, max: 100, step: 1, value: 50 },
      { id: "low", label: "Low", unit: "dB", min: -12, max: 12, step: 0.5, value: 0 },
      { id: "mid", label: "Mid", unit: "dB", min: -12, max: 12, step: 0.5, value: 0 },
      { id: "high", label: "High", unit: "dB", min: -12, max: 12, step: 0.5, value: 0 },
      { id: "out", label: "Out", unit: "dB", min: -24, max: 24, step: 0.5, value: 0 },
      { id: "mix", label: "Dry/Wet", unit: "%", min: 0, max: 100, step: 1, value: 100 },
    ],
  },
  {
    id: "bitcrusher",
    name: "Bitcrusher",
    summary: "Baja la resolución de bits y la frecuencia de muestreo: sonido lo-fi y áspero.",
    stage: 4,
    available: true,
    home: { x: 720, y: 2360 },
    params: [
      {
        id: "preset",
        label: "Preset",
        kind: "select",          // ← lista desplegable con los presets
        value: "neutro",
        options: buildPresetOptions(BITCRUSHER_PRESETS),
      },
      // `decimals: 1` → el fader muestra SIEMPRE un decimal: "12.5 bits".
      { id: "bits", label: "Bits", unit: "bits", kind: "slider", min: 1, max: 16, step: 0.1, value: 16, decimals: 1 },
      // `log: true` → el fader va de 0 a 1 y el efecto lo convierte a Hz con
      // escala LOGARÍTMICA (500 Hz → frecuencia del contexto). main.js muestra Hz/kHz.
      { id: "rate", label: "Rate", unit: "Hz", kind: "slider", min: 0, max: 1, step: 0.001, value: 1, log: true },
      { id: "out", label: "Out", unit: "dB", min: -24, max: 24, step: 0.5, value: 0 },
      { id: "mix", label: "Dry/Wet", unit: "%", min: 0, max: 100, step: 1, value: 100 },
    ],
  },
];