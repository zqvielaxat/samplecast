/* =========================================================
   main.js — la "interfaz": conecta el tablero de nodos, el motor de audio,
   el transporte y los dibujos.

   ORDEN DE EJECUCIÓN (muy importante para entender el programa):
   1) El navegador carga index.html y ejecuta este archivo de arriba a abajo UNA vez.
      En esa pasada solo se "preparan" cosas: se buscan elementos, se crean objetos,
      se arman los nodos y se REGISTRAN eventos. Todavía no suena nada.
   2) Desde ese momento el programa "espera". Cada vez que el usuario hace algo
      (click, mover una perilla, elegir un archivo, arrastrar un cable), el navegador
      ejecuta la función que registramos para ese evento.
   3) En paralelo, frame() se ejecuta ~60 veces por segundo y redibuja la pantalla.

   QUIÉN LLAMA A QUIÉN:
       main.js ──► engine (AudioEngine)    carga archivos, volumen, orden de la cadena
       main.js ──► transport (Transport)   play, pausa, seek, loop, posición
       main.js ──► board (PatchBoard)      el espacio infinito y los cables
       main.js ──► waveform / spectrum     dibujar
       main.js ──► effects                 ajustar parámetros y prenderlos
       board   ──► main.js (onChange)      "cambió un cable" → main.js rearma la cadena
       engine  ──► effects                 les pide sus nodos y los cablea en la cadena
       engine  ──► transport               le entrega el sample y la conexión de audio
   main.js es el único que conoce a todos; los demás archivos no se conocen entre sí
   (salvo engine → transport).
   ========================================================= */

// `import` trae código de otros archivos (por eso index.html usa type="module")
import { AudioEngine } from "./audio-engine.js";
import { SpectrumVisualizer, WaveformView } from "./visualizer.js";
import { PatchBoard } from "./patch-board.js";
import { createKnob } from "./knob.js";
import { enableFader } from "./slider.js";
import { createRangeSelector } from "./range-selector.js";
import { RecorderWaveView, MAX_ZOOM as RECORDER_MAX_ZOOM } from "./recorder-wave.js";
import { EFFECT_SLOTS } from "./effects/registry.js";
import { FrequencyShiftEffect } from "./effects/frequency-shift.js";
import { DistortionEffect } from "./effects/distortion.js";
import { BinScramblerEffect } from "./effects/bin-scrambler.js";
import { SpectralGateEffect } from "./effects/spectral-gate.js";
import { BeatRepeaterEffect } from "./effects/beat-repeater.js";
import { FlangerEffect } from "./effects/flanger.js";
import { MultibandOttEffect } from "./effects/multiband-ott.js";
import { BitcrusherEffect, hzLabel, RATE_MIN as BITCRUSHER_RATE_MIN } from "./effects/bitcrusher.js";
import { RecorderEffect } from "./effects/recorder.js";
import {
  FACTORY_PRESETS, STORAGE_KEY, FORMAT_VERSION,
  readUserPresets, persistAddPreset, persistRemovePreset, persistRenamePreset,
  persistImportPresets, parseImportPayload, filterChainByKnownTypes,
  makeUserId, createMemoryStorage,
} from "./presets-store.js";

/* ---------- 1) Referencias al HTML ---------- */
const $ = (id) => document.getElementById(id); // atajo: $("btn-play") en vez de document.getElementById("btn-play")

// Un OBJETO agrupa valores relacionados bajo nombres: els.btnPlay, els.status, etc.
const els = {
  board: $("board"),
  world: $("board-world"),
  wires: $("wires"),
  nodeMain: $("node-main"),
  status: $("status"),
  btnRecenter: $("btn-recenter"),
  btnLoad: $("btn-load"),
  fileInput: $("file-input"),
  name: $("sample-name"),
  duration: $("sample-duration"),
  time: $("time-readout"),
  waveCanvas: $("waveform"),
  btnPlay: $("btn-play"),
  btnRestart: $("btn-restart"),
  volume: $("volume"),
  volumeOut: $("volume-out"),
  loopEnabled: $("loop-enabled"),
  spectrumPanel: $("spectrum-panel"),
  btnSpectrum: $("btn-spectrum"),
  palette: $("palette"),
  compatWarning: $("compat-warning"),
  appVersion: $("app-version"),
};

// Versión de la app, en UNA sola constante (se muestra en el pie de la página).
const APP_VERSION = "0.1.0";

/* ---------- 2) Objetos principales ---------- */
const engine = new AudioEngine();
const transport = engine.transport; // atajo: es el MISMO objeto que engine.transport (no una copia)
const waveform = new WaveformView(els.waveCanvas);
const spectrum = new SpectrumVisualizer($("spectrum"), engine);

// El tablero es el espacio infinito. Los nodos viven adentro.
const board = new PatchBoard({ board: els.board, world: els.world, wires: els.wires });

// El NODO PRINCIPAL es el origen del patch: de acá sale la señal.
// rx/ry son los semi-anchos de la píldora (460 x 212 en píxeles de mundo).
board.addNode("main", els.nodeMain, {
  x: 0,
  y: 0,
  rx: 230,
  ry: 106,
  canInput: false,          // no recibe nada: es el principio de la cadena
  angles: { out: 0 },        // su puerto de salida nace justo a la derecha, a la altura del centro
  label: "UR SAMPLE",
});

// El volumen usa el mismo estilo de slider que los efectos (con su parte verde)
els.volume.classList.add("slider");
els.volume.style.setProperty("--fill", `${els.volume.value}%`);
enableFader(els.volume);   // arrastre horizontal: sube/baja el volumen

/* ---------- 2b) El analizador es un nodo más: se mueve y se puede ocultar ---------- */

// Lo registramos en el tablero para poder arrastrarlo como cualquier otro nodo.
// No tiene puertos (no es parte de la cadena de audio): solo se mira.
board.addNode("spectrum", els.spectrumPanel, {
  x: 0,
  y: 450,                       // donde estaba antes: abajo del nodo principal
  rx: 380,
  ry: 150,
  localCenter: { x: 380, y: 150 }, // su centro cae en la mitad de su propia caja
  label: "Analizador",
  canInput: false,
  canOutput: false,
});

let spectrumVisible = true;     // ¿está desplegado?

els.btnSpectrum.addEventListener("click", () => {
  spectrumVisible = !spectrumVisible;
  // El CSS se encarga del resto: plegado queda una pestaña angosta y redondeada.
  els.spectrumPanel.classList.toggle("is-collapsed", !spectrumVisible);
  els.btnSpectrum.setAttribute("aria-expanded", String(spectrumVisible));
  els.btnSpectrum.title = spectrumVisible ? "Ocultar el analizador" : "Mostrar el analizador";
  els.btnSpectrum.setAttribute("aria-label", els.btnSpectrum.title);
  setStatus(spectrumVisible ? "Analizador visible." : "Analizador oculto: quedó la pestaña.");
});

/* ---------- 3) Nodos de efectos (se construyen desde el catálogo) ---------- */

// Acá se une cada "slot" del catálogo (registry.js) con la clase que lo hace
// sonar. Un efecto disponible = una entrada en este objeto.
const EFFECT_CLASSES = {
  "frequency-shift": FrequencyShiftEffect,
  "distortion": DistortionEffect,
  "bin-scrambler": BinScramblerEffect,
  "spectral-gate": SpectralGateEffect,
  "beat-repeater": BeatRepeaterEffect,
  "flanger": FlangerEffect,
  "multiband-ott": MultibandOttEffect,
  "bitcrusher": BitcrusherEffect,
  "recorder": RecorderEffect,
};

const effectNodes = new Map();  // id → { instance, slot, el, controls }

/* ---------- Presets de cadenas (localStorage) ---------- */

// Almacén: localStorage si el navegador lo deja; si lo bloquea, uno en memoria
// (los presets duran solo esta sesión). storeBlocked recuerda ese caso.
const storeBlocked = (() => {
  try { const s = window.localStorage; s.getItem(STORAGE_KEY); return false; }
  catch { return true; }
})();
const presetStorage = storeBlocked ? createMemoryStorage() : window.localStorage;

let userPresets = readUserPresets(presetStorage); // presets del usuario (los de fábrica viven en el código)
let persistRequested = false;                     // ¿ya pedimos almacenamiento persistente?

/** Muestra un valor con su unidad: 100 → "100 Hz" (o "50%"). Si el parámetro pide
  * decimales fijos (ej. "Bits"), los aplica. */
function formatParamValue(param, value) {
  if (param.unit === "%") return `${value}%`;
  if (param.decimals != null) return `${Number(value).toFixed(param.decimals)}${param.unit ? " " + param.unit : ""}`;
  return param.unit ? `${value} ${param.unit}` : String(value);
}

/**
 * ¿Este parámetro se dibuja como PERILLA?
 * El "mix" es un fader, y los "select" y "number" son listas y campos numéricos.
 */
function isKnob(param) {
  return param.id !== "mix" && param.kind !== "select" && param.kind !== "number" && param.kind !== "slider";
}

/** Porcentaje de la pista ya "llenada" de un fader (0..100) según su rango. */
function fillPercent(param, value) {
  const min = Number(param.min ?? 0);
  const max = Number(param.max ?? 100);
  const span = max - min || 1;
  return Math.round(((Number(value) - min) / span) * 100);
}

/** Máximo de muestra del fader Rate antes de que exista el AudioContext. */
const LOG_RATE_MAX_FALLBACK = 48000;

/**
 * Texto para mostrar un valor: el efecto puede darle un formato propio (por
 * ejemplo la frecuencia en Hz/kHz del Bitcrusher); si no, el formato genérico.
 */
function customParamDisplay(instance, param, value) {
  if (instance && typeof instance.readoutFor === "function") {
    const text = instance.readoutFor(param.id, value);
    if (text != null) return text;
  }
  return formatParamValue(param, value);
}

/** El círculo crece un poco si el efecto tiene más perillas, faders o listas que mostrar. */
function nodeDiameter(slot) {
  if (slot.ui === "recorder") return 640;   // la Grabadora es grande: lleva pantalla + botones
  const knobCount = slot.params.filter(isKnob).length;
  const sliderCount = slot.params.filter((p) => p.kind === "slider").length;
  const selectCount = slot.params.filter((p) => p.kind === "select").length;
  return 280 + 42 * Math.max(0, knobCount - 1) + 52 * sliderCount + 30 * selectCount;
}

/**
 * HTML interno de un nodo de efecto:
 *   - un título,
 *   - un hueco por cada perilla (createKnob lo rellena después),
 *   - las listas desplegables (por ejemplo el "Tipo" de la Distortion),
 *   - los campos numéricos (por ejemplo el "BPM" del Beat Repeater),
 *   - el fader de Dry/Wet,
 *   - y el cartel de "etapa" si todavía no existe.
 */
function effectNodeHTML(slot) {
  // La Grabadora no se arma desde params: su tarjeta es a mano (botones).
  if (slot.ui === "recorder") {
    return `
      <div class="fx-title">${slot.name}</div>
      <p class="fx-summary">${slot.summary}</p>
      <div class="recorder-body">
        <canvas class="rec-screen" data-no-drag aria-label="Forma de onda de la grabación"></canvas>
        <div class="rec-zoom">
          <button class="btn-zoom" data-zoom="-1" type="button" aria-label="Alejar la onda">−</button>
          <span class="rec-zoom-label">zoom</span>
          <button class="btn-zoom" data-zoom="1" type="button" aria-label="Acercar la onda">+</button>
        </div>
        <div class="rec-row">
          <button class="btn-record" type="button" aria-label="Empezar a grabar">● Grabar</button>
          <button class="btn-cut" type="button" aria-pressed="false" aria-label="Activar el recorte">cut</button>
          <button class="btn-slice" type="button" aria-pressed="false" aria-label="Activar los slices">slice</button>
          <button class="btn-click" type="button" aria-pressed="false" aria-label="Activar el modo click">click</button>
        </div>
        <div class="slice-row">
          <span>Sensibilidad</span>
          <span class="slice-value" data-value="slice-sensitivity">50</span>
        </div>
        <div class="slice-wrap" data-no-drag>
          <input class="slider" type="range" data-param="slice-sensitivity" min="0" max="100" step="1" value="50" style="--fill: 50%" aria-label="Grabadora: sensibilidad de slice">
        </div>
        <span class="rec-time" aria-live="polite">0.0 s</span>
        <button class="btn-download" type="button" aria-label="Descargar sample" disabled>⬇ Descargar sample</button>
        <button class="btn-download-pack" type="button" aria-label="Descargar pack de slices" disabled>⬇ Descargar pack</button>
        <p class="rec-format">WAV · PCM 16 bits</p>
      </div>`;
  }

  const knobParams = slot.params.filter(isKnob);
  const selectParams = slot.params.filter((p) => p.kind === "select" && p.id !== "preset");
  const presetParam = slot.params.find((p) => p.id === "preset");
  const sliderParams = slot.params.filter((p) => p.kind === "slider");
  const numberParams = slot.params.filter((p) => p.kind === "number");
  const mixParam = slot.params.find((p) => p.id === "mix");
  const editable = slot.available ? "" : "disabled";

  const knobs = knobParams.map((p, index) => `
    <div class="knob-cell">
      <span class="knob-tag">P${index + 1}</span>
      <div data-knob="${p.id}"></div>
      <span class="knob-name">${p.label}</span>
      <span class="knob-value" data-value="${p.id}">${formatParamValue(p, p.value)}</span>
    </div>`).join("");

  // Una lista desplegable: cada opción es { value, label } y `value` es el valor
  // inicial (el que ya está elegido).
  const selects = selectParams.map((p) => `
    <div class="select-row">
      <span>${p.label}</span>
      <select class="fx-select" data-param="${p.id}"
              aria-label="${slot.name}: ${p.label}" ${editable}>
        ${p.options.map((option) => `
        <option value="${option.value}"${option.value === p.value ? " selected" : ""}>${option.label}</option>`).join("")}
      </select>
    </div>`).join("");

  // El selector de presets (solo lo tienen algunos efectos, como el Multiband
  // OTT). Se dibuja PRIMERO, arriba de todo, para que sea fácil elegir uno.
  const presetSelect = presetParam ? `
    <div class="select-row">
      <span>${presetParam.label}</span>
      <select class="fx-select" data-param="preset"
              aria-label="${slot.name}: ${presetParam.label}" ${editable}>
        ${presetParam.options.map((option) => `
        <option value="${option.value}"${option.value === presetParam.value ? " selected" : ""}>${option.label}</option>`).join("")}
      </select>
    </div>` : "";

  // Faders extra (parámetros con kind: "slider"): se dibujan igual que el "mix",
  // pero con su propio rango y su propia unidad. Si es un fader LOG (Rate), el
  // valor inicial se muestra en Hz/kHz con un máximo por defecto (se corrige al
  // crear el AudioContext).
  const sliders = sliderParams.map((p) => {
    const display = p.log
      ? hzLabel(BITCRUSHER_RATE_MIN * Math.pow(LOG_RATE_MAX_FALLBACK / BITCRUSHER_RATE_MIN, Number(p.value)))
      : formatParamValue(p, p.value);
    return `
    <div class="mix-row">
      <span>${p.label}</span>
      <span class="mix-value" data-value="${p.id}">${display}</span>
    </div>
    <div class="mix-wrap" data-no-drag>
      <input class="slider" type="range" data-param="${p.id}"
             min="${p.min}" max="${p.max}" step="${p.step}"
             value="${p.value}" style="--fill: ${fillPercent(p, p.value)}%"
             aria-label="${slot.name}: ${p.label}" ${editable}>
    </div>`;
  }).join("");

  // Un campo numérico: se escribe a mano o se sube/baja con las flechitas.
  const numbers = numberParams.map((p) => `
    <div class="number-row">
      <span>${p.label}</span>
      <input class="fx-number" type="number" data-param="${p.id}"
             min="${p.min}" max="${p.max}" step="${p.step}" value="${p.value}"
             aria-label="${slot.name}: ${p.label}" ${editable}>
    </div>`).join("");

  const mix = mixParam ? `
    <div class="mix-row">
      <span>${mixParam.label}</span>
      <span class="mix-value" data-value="${mixParam.id}">${formatParamValue(mixParam, mixParam.value)}</span>
    </div>
    <div class="mix-wrap" data-no-drag>
      <input class="slider" type="range" data-param="${mixParam.id}"
             min="${mixParam.min}" max="${mixParam.max}" step="${mixParam.step}"
             value="${mixParam.value}" style="--fill: ${mixParam.value}%"
             aria-label="${slot.name}: ${mixParam.label}" ${editable}>
    </div>` : "";

  return `
    <div class="fx-title">${slot.name}</div>
    <p class="fx-summary">${slot.summary}</p>
    ${presetSelect}
    ${knobs ? `<div class="knob-grid">${knobs}</div>` : ""}
    ${selects}
    ${sliders}
    ${numbers}
    ${mix}
    ${slot.available ? "" : `<p class="fx-lock">Se activa en la etapa ${slot.stage}</p>`}`;
}

/**
 * Conecta los controles de un nodo con su objeto de efecto:
 * cada perilla, cada lista, cada campo y cada fader llaman a setParam().
 */
function wireEffectControls(el, slot, instance) {
  // Guardamos, por cada parámetro, una forma de FIJAR su control desde afuera.
  // Lo usa el selector de presets para "espejar" los valores elegidos.
  const controls = {};

  for (const param of slot.params) {
    if (!isKnob(param)) continue;                     // el "mix", el "select" y el "slider" se arman aparte
    const mount = el.querySelector(`[data-knob="${param.id}"]`);
    const readout = el.querySelector(`[data-value="${param.id}"]`);
    const knob = createKnob({
      min: param.min,
      max: param.max,
      step: param.step,
      value: param.value,
      label: `${slot.name}: ${param.label}`,
      onChange: (value) => {
        readout.textContent = customParamDisplay(instance, param, value);
        instance.setParam(param.id, value);
      },
    });
    mount.replaceWith(knob.el);                       // el hueco se cambia por la perilla
    controls[param.id] = { set: (v) => knob.setValue(v) };
  }

  // Listas desplegables (por ejemplo el "Tipo" de la Distortion). El valor que
  // se manda es el texto de la opción elegida ("soft", "hard", "fold").
  for (const param of slot.params.filter((p) => p.kind === "select")) {
    const select = el.querySelector(`select[data-param="${param.id}"]`);
    if (!select) continue;
    select.addEventListener("change", () => instance.setParam(param.id, select.value));
    controls[param.id] = { set: (v) => { select.value = v; } };
  }

  // Campos numéricos (por ejemplo el "BPM" del Beat Repeater).
  for (const param of slot.params.filter((p) => p.kind === "number")) {
    const field = el.querySelector(`input[type="number"][data-param="${param.id}"]`);
    if (!field) continue;

    // Mientras escribe: solo avisamos si el número ya es válido (si no, escribir
    // "1" camino a "120" mandaría un BPM imposible).
    field.addEventListener("input", () => {
      const value = Number(field.value);
      if (!Number.isFinite(value)) return;
      if (value < param.min || value > param.max) return;
      instance.setParam(param.id, value);
    });

    // Al salir del campo (o apretar Enter): corregimos lo que quedó fuera de rango.
    field.addEventListener("change", () => {
      const value = Number(field.value);
      if (!Number.isFinite(value)) {
        field.value = String(param.value);
        return;
      }
      const fixed = Math.min(param.max, Math.max(param.min, value));
      field.value = String(fixed);
      instance.setParam(param.id, fixed);
    });
    controls[param.id] = { set: (v) => { field.value = String(v); } };
  }

  // Faders extra (kind: "slider"): igual que el "mix" pero con su propio rango.
  for (const param of slot.params.filter((p) => p.kind === "slider")) {
    const fader = el.querySelector(`input[data-param="${param.id}"]`);
    if (!fader) continue;
    const readout = el.querySelector(`[data-value="${param.id}"]`);
    enableFader(fader);   // arrastre horizontal: sube/baja el fader
    fader.addEventListener("input", () => {
      const pos = Number(fader.value);
      // En un fader LOG (Rate), la posición 0..1 se convierte a Hz con el efecto.
      const value = param.log ? instance.valueFromSlider(param.id, pos) : pos;
      readout.textContent = customParamDisplay(instance, param, value);
      fader.style.setProperty("--fill", `${fillPercent(param, pos)}%`);
      instance.setParam(param.id, value);
    });
    controls[param.id] = {
      set: (v) => {
        const pos = param.log ? instance.positionFromValue(param.id, v) : v;
        fader.value = String(pos);
        fader.style.setProperty("--fill", `${fillPercent(param, pos)}%`);
      },
    };
  }

  const mixParam = slot.params.find((p) => p.id === "mix");
  const slider = el.querySelector('input[data-param="mix"]');
  if (mixParam && slider) {
    const readout = el.querySelector('[data-value="mix"]');
    enableFader(slider);   // arrastre horizontal: sube/baja el fader
    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      readout.textContent = formatParamValue(mixParam, value);
      slider.style.setProperty("--fill", `${value}%`); // pinta la parte verde del slider
      instance.setParam("mix", value);
    });
    controls["mix"] = {
      set: (v) => {
        slider.value = String(v);
        slider.style.setProperty("--fill", `${v}%`);
      },
    };
  }

  return controls;
}

/**
 * Liga el selector de presets (si el efecto tiene uno) con el objeto del efecto.
 * - Al ELEGIR un preset, el efecto manda todos los valores nuevos y esta función
 *   "espeja" la tarjeta (mueve perillas y faders al valor del preset).
 * - Al MOVER cualquier control a mano, el efecto marca "custom" y esta función
 *   pone el selector en "Personalizado".
 */
function wirePresetSelector(el, slot, instance, controls) {
  const presetParam = slot.params.find((p) => p.id === "preset");
  if (!presetParam) return;
  const select = el.querySelector('select[data-param="preset"]');
  if (!select) return;

  const syncUi = () => {
    // Espejamos todos los controles visibles con los valores del efecto.
    for (const param of slot.params) {
      if (param.id === "preset") continue;
      const value = instance.values[param.id];
      if (value === undefined) continue;
      const control = controls[param.id];
      if (control) control.set(value);
      const readout = el.querySelector(`[data-value="${param.id}"]`);
      if (readout) readout.textContent = customParamDisplay(instance, param, value);
    }
    // El selector muestra el preset elegido (o "Personalizado" tras un ajuste
    // manual). Por seguridad solo lo cambiamos si es una opción válida.
    if (Array.from(select.options).some((option) => option.value === instance.presetId)) {
      select.value = instance.presetId;
    }
  };
  instance.onUiSync = syncUi;
  // Cuando el efecto crea su AudioContext, el fader Rate (log) puede mostrar el
  // máximo real (44.1 kHz / 48 kHz): re-espejamos la tarjeta en ese momento.
  instance.onReady = () => syncUi();
}
/**
 * Conecta los controles de la Grabadora con su objeto (start / stop / download),
 * dibuja la onda en la pantalla y maneja el modo de recorte (botón "cut").
 */
let recorderLive = null; // { instance, wave, counter } para que frame() dibuje en vivo

function wireRecorderControls(el, instance) {
  const btnRecord = el.querySelector(".btn-record");
  const btnDownload = el.querySelector(".btn-download");
  const btnDownloadPack = el.querySelector(".btn-download-pack");
  const btnCut = el.querySelector(".btn-cut");
  const btnSlice = el.querySelector(".btn-slice");
  const btnClick = el.querySelector(".btn-click");
  const btnZoomIn = el.querySelector(".btn-zoom[data-zoom='1']");
  const btnZoomOut = el.querySelector(".btn-zoom[data-zoom='-1']");
  const counter = el.querySelector(".rec-time");
  const screen = el.querySelector(".rec-screen");
  const sliceSlider = el.querySelector('input[data-param="slice-sensitivity"]');
  const sliceValue = el.querySelector('[data-value="slice-sensitivity"]');

  const wave = new RecorderWaveView(screen);
  let cutActive = false;    // ¿el modo de recorte está encendido?
  let trim = null;          // { start, end } en fracciones 0..1 de la grabación
  let sliceActive = false;  // ¿el modo de slice está encendido?
  let clickActive = false;  // ¿el modo "click" (resaltar / pre-escucha / dejar solo) está encendido?
  let sliceSensitivity = Number(sliceSlider.value); // 0..100
  let slices = null;        // límites de los slices en fracciones 0..1 (incluye inicio y fin)
  let sliceReqId = 0;       // token para descartar análisis viejos si cambió a mitad de camino
  let markerDrag = null;    // marcador de slice que estamos arrastrando: { index }

  recorderLive = { instance, wave, counter };

  /**
   * Fuerza el RECÁLCULO automático de los slices (auto-detección). Se usa solo
   * cuando corresponde "resetearlos": al cambiar la sensibilidad, al cambiar el
   * recorte, o la primera vez que se muestran. NO conserva los movimientos manuales.
   */
  async function recomputeSlices() {
    // Si no hay ningún modo activo, no hay nada que calcular ni que mostrar.
    if (!sliceActive && !clickActive) return;
    if (!instance.hasRecording() || instance.recordingSeconds <= 0) return;

    // Cada recálculo lleva un número: si el usuario cambia algo a mitad de camino,
    // el resultado "viejo" se descarta (no pisa al nuevo).
    const reqId = ++sliceReqId;

    // Región: si hay un recorte activo y válido, se calcula dentro de él;
    // si no, sobre toda la grabación.
    const region = cutActive && trim && trim.end > trim.start ? trim : null;
    const startFraction = region ? region.start : 0;
    const endFraction = region ? region.end : 1;
    const total = instance.recordingSeconds;

    // 1) La curva de energía se calcula UNA sola vez por grabación (queda cacheada).
    const analysis = await instance.ensureSliceAnalysis();
    if (reqId !== sliceReqId) return;   // ya no es la llamada más nueva
    if (!analysis) {
      slices = null;
      wave.setSlices(null);
      wave.draw();
      return;
    }

    // 2) La selección de picos es barata: se repite cada vez que se mueve la sensibilidad.
    const boundaries = instance.computeSlices(
      startFraction * total,
      endFraction * total,
      sliceSensitivity,
    );
    if (reqId !== sliceReqId) return;

    slices = boundaries.map((seconds) => (total > 0 ? seconds / total : 0));
    wave.setSlices(slices);
    wave.draw();
    refresh();
  }

  /**
   * Actualiza la VISIBILIDAD de los marcadores según los modos activos y decide
   * si hace falta calcularlos. Si ya existen (aunque se hayan movido a mano),
   * los conserva tal cual: solo los recomputa si todavía no hay slices.
   */
  function syncSlices() {
    if (!sliceActive && !clickActive) {
      // Escondemos los marcadores PERO conservamos los límites ya movidos.
      wave.setSlices(null);
      wave.setHoverSlice(null);
      wave.draw();
      refresh();
      return;
    }
    if (!instance.hasRecording() || instance.recordingSeconds <= 0) return;
    if (slices && slices.length >= 2) {
      // Ya hay slices (posiblemente movidos a mano): los mostramos sin tocarlos.
      wave.setSlices(slices);
      wave.draw();
      refresh();
      return;
    }
    recomputeSlices(); // primera vez: los calculamos desde cero
  }

  function refresh() {
    counter.textContent = `${instance.elapsedSeconds().toFixed(1)} s`;
    btnCut.disabled = instance.recording; // no se recorta mientras se graba
    btnCut.classList.toggle("is-active", cutActive);
    btnCut.setAttribute("aria-pressed", String(cutActive));

    // El slice solo se habilita cuando la grabación YA terminó.
    btnSlice.disabled = instance.recording || !instance.hasRecording();
    btnSlice.classList.toggle("is-active", sliceActive);
    btnSlice.setAttribute("aria-pressed", String(sliceActive));

    // El modo "click" necesita una grabación terminada, igual que el slice.
    btnClick.disabled = instance.recording || !instance.hasRecording();
    btnClick.classList.toggle("is-active", clickActive);
    btnClick.setAttribute("aria-pressed", String(clickActive));

    // El zoom solo existe cuando la toma ya terminó y hay algo para mirar.
    const canZoom = !instance.recording && instance.hasRecording();
    btnZoomIn.disabled = !canZoom || wave.zoom >= RECORDER_MAX_ZOOM;
    btnZoomOut.disabled = !canZoom || wave.zoom <= 1;

    if (instance.recording) {
      btnRecord.classList.add("is-recording");
      btnRecord.textContent = "■ Parar";
      btnRecord.setAttribute("aria-label", "Parar la grabación");
    } else {
      btnRecord.classList.remove("is-recording");
      btnRecord.textContent = "● Grabar";
      btnRecord.setAttribute("aria-label", "Empezar a grabar");

      // Al terminar, redibujamos la pantalla con los picos EXACTOS de la toma.
      // (una sola vez por grabación: exactPeaks queda null hasta ese momento)
      if (instance.hasRecording() && !wave.exactPeaks) {
        const width = screen.getBoundingClientRect().width || 480;
        // Más columnas = más detalle para cuando hagamos zoom.
        const columns = Math.max(64, Math.floor(width * 4));
        const peaks = instance.getPeaks(columns);
        if (peaks) wave.setExact(peaks, columns);
      }
    }

    btnDownload.disabled = !instance.hasRecording();
    // El pack se habilita solo cuando hay slices activos ya calculados.
    btnDownloadPack.disabled = !(sliceActive && slices && slices.length >= 2);
    wave.draw();
  }

  btnRecord.addEventListener("click", () => {
    if (instance.recording) {
      instance.stop();
      setStatus("Grabación detenida.");
    } else if (instance.start()) {
      trim = null;            // la selección anterior ya no vale para esta toma
      sliceActive = false;    // los slices viejos tampoco valen para la toma nueva
      clickActive = false;    // ni el modo click
      wave.setClickActive(false);
      wave.setHoverSlice(null);
      slices = null;
      wave.reset();           // borramos la onda vieja y dibujamos en vivo
      setStatus("Grabando la salida procesada…");
    } else {
      setStatus("La grabadora todavía no está lista (cargá un sample primero).");
    }
    refresh();
  });

  btnCut.addEventListener("click", () => {
    cutActive = !cutActive;
    wave.setCutActive(cutActive);
    if (!cutActive) setStatus("Modo de recorte apagado: se descargará la grabación completa.");
    else setStatus("Modo de recorte encendido: arrastrá sobre la onda para elegir inicio y fin.");
    recomputeSlices(); // si hay slices activos, se adaptan a la nueva situación del recorte
    refresh();
  });

  // Zoom de la onda: "+" acerca, "−" aleja. Se centra en la selección actual
  // (si no la hay, mantiene el centro que estaba mirando).
  btnZoomIn.addEventListener("click", () => {
    const focus = trim ? (trim.start + trim.end) / 2 : null;
    if (wave.zoomStep(2, focus)) {
      wave.draw();
      setStatus(`Zoom de la onda: ${wave.zoom}×.`);
    }
    refresh();
  });

  btnZoomOut.addEventListener("click", () => {
    const focus = trim ? (trim.start + trim.end) / 2 : null;
    if (wave.zoomStep(0.5, focus)) {
      wave.draw();
      setStatus(wave.zoom <= 1 ? "Zoom: vista completa." : `Zoom de la onda: ${wave.zoom}×.`);
    }
    refresh();
  });

  // --- Mover los marcadores de slice (clic sobre un marcador y arrastre) ---
  // Se registra ANTES que el selector de recorte: si el clic cae justo sobre un
  // marcador, nos quedamos con ese arrastre y el recorte no arranca.
  function markerPointerDown(event) {
    if (event.button !== 0) return;
    if (!(sliceActive && !clickActive && !instance.recording)) return; // solo en modo slice
    if (!slices || slices.length < 3) return;
    const rect = screen.getBoundingClientRect();
    if (!rect.width) return;
    const screenFraction = (event.clientX - rect.left) / rect.width;
    const index = wave.markerAt(screenFraction);
    if (index < 0) return;
    event.preventDefault();
    event.stopImmediatePropagation(); // que el selector de recorte no arranque
    try { screen.setPointerCapture(event.pointerId); } catch { /* puntero ya libre */ }
    markerDrag = { index };
  }
  function markerPointerMove(event) {
    if (!markerDrag) return;
    const rect = screen.getBoundingClientRect();
    if (!rect.width) return;
    const screenFraction = (event.clientX - rect.left) / rect.width;
    const fraction = wave.screenToSample(screenFraction);
    const i = markerDrag.index;
    // El marcador queda entre sus dos vecinos, sin cruzarse con ellos.
    slices[i] = Math.min(slices[i + 1], Math.max(slices[i - 1], fraction));
    wave.setSlices(slices);
    wave.draw();
  }
  function markerPointerUp(event) {
    if (!markerDrag) return;
    markerDrag = null;
    try { screen.releasePointerCapture(event.pointerId); } catch { /* ya liberado */ }
    setStatus("Marcador movido.");
    refresh();
  }
  screen.addEventListener("pointerdown", markerPointerDown); // ← antes que el selector
  screen.addEventListener("pointermove", markerPointerMove);
  screen.addEventListener("pointerup", markerPointerUp);
  screen.addEventListener("pointercancel", markerPointerUp);

  // Cursor "dedo" cuando el mouse pasa justo sobre un marcador (solo en modo
  // slice, que es cuando los marcadores se pueden arrastrar): así se nota de un
  // vistazo que son agarrables.
  screen.addEventListener("pointermove", (event) => {
    const canGrabMarker = sliceActive && !clickActive && !instance.recording;
    if (!canGrabMarker) {
      screen.style.cursor = ""; // vuelve al crosshair que trae .rec-screen
      return;
    }
    const rect = screen.getBoundingClientRect();
    if (!rect.width) { screen.style.cursor = ""; return; }
    const screenFraction = (event.clientX - rect.left) / rect.width;
    screen.style.cursor = wave.markerAt(screenFraction) >= 0 ? "pointer" : "";
  });

  // --- Modo "click": resaltar / pre-escuchar / dejar solo un slice ---

  // Al pasar el mouse, resaltamos levemente el slice que está debajo.
  screen.addEventListener("pointermove", (event) => {
    if (!clickActive || instance.recording) {
      if (wave.hoverSlice != null) { wave.setHoverSlice(null); wave.draw(); }
      return;
    }
    const rect = screen.getBoundingClientRect();
    if (!rect.width) return;
    const screenFraction = (event.clientX - rect.left) / rect.width;
    const fraction = wave.screenToSample(screenFraction);
    const index = wave.sliceIndexAt(fraction);
    if (index !== wave.hoverSlice) {
      wave.setHoverSlice(index);
      wave.draw();
    }
  });
  screen.addEventListener("pointerleave", () => {
    if (wave.hoverSlice != null) { wave.setHoverSlice(null); wave.draw(); }
    screen.style.cursor = ""; // al salir, el cursor vuelve al crosshair de la pantalla
  });

  // Pre-escucha del slice MANTENIENDO el botón derecho apretado: suena al
  // apretar y se corta al soltarlo.

  /** Devuelve el índice del slice que está bajo el cursor, o −1. */
  function auditionSliceAt(event) {
    if (!clickActive || instance.recording || !slices || slices.length < 2) return -1;
    const rect = screen.getBoundingClientRect();
    if (!rect.width) return -1;
    const screenFraction = (event.clientX - rect.left) / rect.width;
    const fraction = wave.screenToSample(screenFraction);
    return wave.sliceIndexAt(fraction);
  }

  screen.addEventListener("pointerdown", (event) => {
    if (event.button !== 2) return; // solo nos interesa el botón derecho
    const index = auditionSliceAt(event);
    if (index < 0) return;
    event.preventDefault();
    // Capturamos el puntero para que el "soltar" se reciba aunque el dedo se
    // salga del canvas.
    try { screen.setPointerCapture(event.pointerId); } catch { /* puntero ya libre */ }
    const total = instance.recordingSeconds;
    const start = slices[index] * total;
    const end = slices[index + 1] * total;
    if (instance.audition(start, end)) {
      setStatus(`Pre-escucha del slice ${index + 1} (${formatTime(start)} → ${formatTime(end)}). Soltá el botón para cortar.`);
    }
  });

  screen.addEventListener("pointerup", (event) => {
    if (event.button !== 2) return; // soltar el izquierdo no corta la pre-escucha
    instance.stopAudition();
    try { screen.releasePointerCapture(event.pointerId); } catch { /* ya liberado */ }
  });
  // Si el puntero se cancela (se salió de la pantalla, gesto raro, etc.),
  // cortamos la pre-escucha sí o sí para no dejar audio sonando "colgado".
  screen.addEventListener("pointercancel", (event) => {
    instance.stopAudition();
    try { screen.releasePointerCapture(event.pointerId); } catch { /* ya liberado */ }
  });

  // En el modo click, el botón derecho queda reservado para la pre-escucha:
  // evitamos que el navegador muestre su menú contextual.
  screen.addEventListener("contextmenu", (event) => {
    if (!clickActive) return;
    event.preventDefault();
  });

  // Doble clic = borrar el resto de la grabación y dejar solo ese slice.
  screen.addEventListener("dblclick", (event) => {
    if (!clickActive || instance.recording || !slices || slices.length < 2) return;
    const rect = screen.getBoundingClientRect();
    if (!rect.width) return;
    const screenFraction = (event.clientX - rect.left) / rect.width;
    const fraction = wave.screenToSample(screenFraction);
    const index = wave.sliceIndexAt(fraction);
    if (index < 0) return;
    const total = instance.recordingSeconds;
    const start = slices[index] * total;
    const end = slices[index + 1] * total;

    if (!instance.cropToSlice(start, end)) {
      setStatus("No se pudo recortar la grabación.");
      return;
    }

    // La grabación quedó recortada: reseteamos la vista y la volvemos a dibujar.
    trim = null;
    wave.setTrim(null, null);
    wave.reset();

    const rectAfter = screen.getBoundingClientRect();
    const width = rectAfter.width || 480;
    const columns = Math.max(64, Math.floor(width * 4));
    const peaks = instance.getPeaks(columns);
    if (peaks) wave.setExact(peaks, columns);

    wave.setHoverSlice(null);
    slices = null;                    // la grabación cambió: forzamos un recálculo
    recomputeSlices(); // vuelve a calcular los slices sobre la grabación acortada
    setStatus(`Se dejó solo el slice ${index + 1} (${formatTime(start)} → ${formatTime(end)}).`);
    refresh();
  });

  // Elegir el recorte arrastrando sobre la pantalla (misma lógica que el loop).
  createRangeSelector(screen, {
    canStart: () => cutActive && !instance.recording && instance.recordingSeconds > 0,
    onPreview: (start, end) => {
      // El selector da fracciones de PANTALLA; con el zoom las pasamos a
      // fracciones del total de la grabación.
      const s = wave.screenToSample(start);
      const e = wave.screenToSample(end);
      trim = { start: s, end: e };
      wave.setTrim(s, e);
      wave.draw();
    },
    onCommit: (start, end) => {
      const s = wave.screenToSample(start);
      const e = wave.screenToSample(end);
      trim = { start: s, end: e };
      wave.setTrim(s, e);
      wave.draw();
      setStatus(`Recorte de ${formatTime(s * instance.recordingSeconds)} a ` +
        `${formatTime(e * instance.recordingSeconds)}.`);
      recomputeSlices(); // los slices se recalculan recién cuando la sección ya quedó elegida
    },
    onClick: () => {
      trim = null;                    // un clic solo limpia la selección
      wave.setTrim(null, null);
      wave.draw();
      setStatus("Selección de recorte limpia.");
      recomputeSlices(); // sin región: los slices vuelven a cubrir toda la grabación
    },
  });

  btnDownload.addEventListener("click", async () => {
    if (!instance.hasRecording()) {
      setStatus("No hay nada grabado todavía.");
      return;
    }

    // Solo recortamos si el modo está encendido Y hay una selección válida.
    const range = cutActive && trim && trim.end > trim.start
      ? { start: trim.start * instance.recordingSeconds, end: trim.end * instance.recordingSeconds }
      : null;

    btnDownload.disabled = true;
    const ok = await instance.download(range);
    btnDownload.disabled = !instance.hasRecording();

    if (!ok) {
      setStatus("No se pudo descargar la grabación.");
    } else if (range) {
      setStatus(`Recorte (${formatTime(range.start)} → ${formatTime(range.end)}) descargado como WAV · PCM 16 bits.`);
    } else {
      setStatus("Grabación completa descargada como WAV · PCM 16 bits.");
    }
  });

  // --- Slice: botón interruptor + fader de sensibilidad ---

  // El fader de sensibilidad usa EXACTAMENTE el mismo fader que el resto de la app
  // (js/slider.js, arrastre horizontal). No duplicamos código.
  enableFader(sliceSlider);
  sliceSlider.addEventListener("input", () => {
    sliceSensitivity = Number(sliceSlider.value);
    sliceValue.textContent = String(sliceSensitivity);
    sliceSlider.style.setProperty("--fill", `${sliceSensitivity}%`); // pinta la parte verde
    if (sliceActive || clickActive) recomputeSlices(); // al mover la sensibilidad, los slices se vuelven a calcular (y los movimientos manuales se descartan)
  });

  // Botón "slice": interruptor que muestra u oculta los marcadores de corte.
  btnSlice.addEventListener("click", () => {
    sliceActive = !sliceActive;
    // Mostramos u ocultamos los marcadores SIN recalcularlos: si ya habían sido
    // movidos a mano, quedan donde estaban.
    syncSlices();
    setStatus(sliceActive ? "Modo slice encendido." : "Modo slice apagado.");
    refresh();
  });

  // Botón "click": pre-escucha (botón derecho) y "dejar solo" (doble clic).
  btnClick.addEventListener("click", () => {
    clickActive = !clickActive;
    wave.setClickActive(clickActive);
    if (!clickActive) wave.setHoverSlice(null);
    syncSlices(); // asegura que haya slices para recorrer (conserva los que ya estaban)
    setStatus(clickActive
      ? "Modo click encendido: pasá sobre un slice para resaltarlo · mantené el botón derecho para pre-escuchar · doble clic para dejar solo ese slice."
      : "Modo click apagado.");
    refresh();
  });

  // "Descargar pack": cada slice como un WAV separado (slice1.wav, slice2.wav, ...).
  btnDownloadPack.addEventListener("click", async () => {
    if (!(sliceActive && slices && slices.length >= 2)) {
      setStatus("No hay slices activos para descargar.");
      return;
    }
    const total = instance.recordingSeconds;
    const boundaries = slices.map((fraction) => fraction * total);

    btnDownloadPack.disabled = true;
    const count = await instance.downloadPack(boundaries);
    btnDownloadPack.disabled = !(sliceActive && slices && slices.length >= 2);

    if (count > 0) {
      const plural = count === 1 ? "" : "s";
      setStatus(`Pack descargado: ${count} slice${plural} (slice1.wav … slice${count}.wav).`);
    } else {
      setStatus("No se pudo descargar el pack.");
    }
  });

  instance.onChange = refresh;
  refresh();
}

/* ---------- 3b) Barra lateral y creación de nodos ---------- */

// Abreviaciones de cada efecto para la paleta (cuando lleguen los iconos, se
// reemplazan acá sin tocar el resto). Son cortas para que entren en la esferita.
const PALETTE_ABBR = {
  "frequency-shift": "FS",
  "distortion": "DST",
  "bin-scrambler": "BIN",
  "beat-repeater": "BR",
  "flanger": "FLG",
  "recorder": "REC",
  "spectral-gate": "SG",
  "multiband-ott": "OTT",
  "bitcrusher": "BIT",
};

// Texto del panel "Info": la descripción que antes vivía en el encabezado,
// ahora queda en una sección de la barra lateral.
const INFO_LINES = [
  "Arrastrá el fondo para recorrer el espacio · Rueda del mouse para acercar · Arrastrá de un puerto ◯ a otro nodo para conectarlos · Arrastrá un cable al aire para desconectarlo · Clic sobre un cable también lo borra.",
  "Sobre la forma de onda: un clic salta a esa posición y un arrastre marca el loop (se enciende solo) · El analizador se arrastra como cualquier nodo y se pliega con el botón ◀ · La Grabadora solo escucha y descarga un WAV.",
  "Recorrido de la señal: sample → efectos → volumen → salida. El analizador mira justo antes de la salida.",
  "Selección múltiple: botón derecho (rectángulo) o Shift + clic para elegir varios nodos, y Supr para borrarlos juntos.",
];

// Los contenedores de la barra lateral. "Nodos visuales" es etapa futura
// (items: null). "Efectos" lista todo el catálogo (EFFECT_SLOTS), "Presets" se
// dibuja en renderPresetsContent y "Info" en renderInfoContent.
const PALETTE_CATS = [
  { id: "visuals", abbr: "N.V.", label: "Nodos visuales", items: null },
  { id: "effects", abbr: "N.E.", label: "Nodos de efectos", items: EFFECT_SLOTS },
  { id: "presets", abbr: "Pre", label: "Presets", items: null },
  { id: "info", abbr: "¿?", label: "Info", items: null },
];

// Cuántas copias ya creamos de cada efecto. Sirve para darle a cada copia nueva
// un id ÚNICO: la primera vez queda "distortion", la segunda "distortion-2", ...
const nodeCounters = new Map();

/** Devuelve un id único para una copia nueva de un efecto. */
function nextNodeId(slot) {
  const count = (nodeCounters.get(slot.id) ?? 0) + 1;
  nodeCounters.set(slot.id, count);
  return count === 1 ? slot.id : `${slot.id}-${count}`;
}

/**
 * Crea UNA copia de un efecto y la pone en el lienzo en (x, y) —coordenadas de
 * mundo (el punto exacto donde se soltó el mouse). Se puede llamar infinitas
 * veces: cada llamada genera un nodo nuevo, con su propia instancia de audio y
 * un id único. Por eso "agarrar" un efecto no lo quita de la paleta.
 */
function spawnEffect(slot, x, y, opts = {}) {
  const EffectClass = EFFECT_CLASSES[slot.id];
  const instance = EffectClass ? new EffectClass() : null;
  if (instance) engine.addEffect(instance);   // lo registra en el grafo de audio

  const diameter = nodeDiameter(slot);
  const el = document.createElement("div");
  el.className = "fx-node is-off";
  el.innerHTML = effectNodeHTML(slot);
  el.style.width = `${diameter}px`;
  el.style.height = `${diameter}px`;
  els.world.appendChild(el);

  const id = nextNodeId(slot);
  // Guardamos el id ÚNICO de esta copia en la instancia: el motor de audio lo
  // usa para encontrar la salida de ESTE nodo cuando la Grabadora cuelga de él.
  // (reemplaza a `this.id`, que es el id del TIPO y se repite en cada copia).
  if (instance) instance.nodeId = id;
  board.addNode(id, el, {
    x,
    y,
    rx: diameter / 2,
    ry: diameter / 2,
    // El elemento se centra con translate(-50%,-50%), así que su centro cae
    // en la mitad de su propia caja (esto es lo que usan los puertos).
    localCenter: { x: diameter / 2, y: diameter / 2 },
    label: slot.name,
    locked: false,
    stage: slot.stage,
    deletable: true,       // los efectos se pueden borrar con Supr
    // Los nodos "tap" (la Grabadora) no tienen salida: solo escuchan.
    canOutput: slot.tap !== true,
  });

  // La Grabadora se arma a mano; el resto usa el armado genérico de controles.
  // Guardamos `controls` para poder espejar los valores al cargar un preset.
  let controls = null;
  if (instance && slot.ui === "recorder") wireRecorderControls(el, instance);
  else if (instance) {
    controls = wireEffectControls(el, slot, instance);
    wirePresetSelector(el, slot, instance, controls);
  }

  effectNodes.set(id, { instance, slot, el, controls });

  // Efecto de "crecer velozmente" al aparecer: una animación corta de CSS.
  el.classList.add("just-spawned");
  el.addEventListener("animationend", () => el.classList.remove("just-spawned"), { once: true });

  applyChain();   // rearma la cadena (el nodo nuevo queda apagado hasta conectarlo)
  if (!opts.silent) setStatus(`${slot.name} agregado. Arrastrá su puerto de salida ◯ para conectarlo.`);

  return id;
}

/** Crea los nodos que vienen por defecto en el lienzo. Solo la Grabadora. */
function buildEffectNodes() {
  const recorder = EFFECT_SLOTS.find((slot) => slot.id === "recorder");
  if (recorder) spawnEffect(recorder, recorder.home.x, recorder.home.y);
}

/* --- Barra lateral: las tres esferas-contenedor y su panel de contenido --- */

let palettePanel = null;          // el panel que aparece a la derecha de la barra
let paletteCatButtons = new Map(); // id del contenedor → su botón-esfera
let activePaletteCat = null;      // qué contenedor está abierto ahora (null = ninguno)
let paletteDrag = null;           // { slot, ghost } mientras arrastramos un nodo nuevo

/** Abreviación de respaldo por si un efecto no está en PALETTE_ABBR. */
function abbrevFromName(name) {
  const words = name.trim().split(/\s+/);
  if (words.length > 1) return words.map((word) => word[0]).join("").toUpperCase();
  return name.replace(/[aeiouáéíóú]/gi, "").slice(0, 4).toUpperCase() || name.slice(0, 3).toUpperCase();
}

/** Arma la barra lateral dentro de #palette y conecta sus interacciones. */
function buildPalette() {
  const bar = document.createElement("div");
  bar.className = "palette-bar";

  palettePanel = document.createElement("div");
  palettePanel.className = "palette-panel";

  for (const cat of PALETTE_CATS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-cat";
    btn.textContent = cat.abbr;
    btn.title = cat.label;
    btn.setAttribute("aria-label", cat.label);
    btn.addEventListener("click", () => setPaletteCat(cat.id));
    bar.appendChild(btn);
    paletteCatButtons.set(cat.id, btn);
  }

  els.palette.appendChild(bar);
  els.palette.appendChild(palettePanel);
}

/** Muestra u oculta el panel de un contenedor (un clic en la esfera lo alterna). */
function setPaletteCat(id) {
  const cat = PALETTE_CATS.find((candidate) => candidate.id === id);
  if (!cat) return;

  // Tocar la misma esfera cierra el panel; tocar otra lo cambia.
  activePaletteCat = activePaletteCat === id ? null : id;

  for (const [catId, btn] of paletteCatButtons) {
    btn.classList.toggle("is-active", catId === activePaletteCat);
  }

  palettePanel.classList.toggle("is-open", !!activePaletteCat);
  renderPalettePanel(cat);
}

/** Rellena el panel: título del contenedor + sus items (o el panel de presets). */
function renderPalettePanel(cat) {
  palettePanel.innerHTML = "";

  const title = document.createElement("p");
  title.className = "palette-title";
  title.textContent = cat.label;
  palettePanel.appendChild(title);

  if (cat.id === "presets") {
    renderPresetsContent();
    return;
  }

  if (cat.id === "info") {
    renderInfoContent();
    return;
  }

  if (cat.items) {
    for (const slot of cat.items) {
      palettePanel.appendChild(buildPaletteItem(slot));
    }
  }
}

/** Rellena el panel "Info" con las instrucciones de uso. */
function renderInfoContent() {
  const box = document.createElement("div");
  box.className = "info-panel";
  for (const line of INFO_LINES) {
    const p = document.createElement("p");
    p.className = "info-line";
    p.textContent = line;
    box.appendChild(p);
  }
  palettePanel.appendChild(box);
}

/** Un chip pequeño y arrastrable que representa un efecto del catálogo. */
function buildPaletteItem(slot) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "palette-item";
  item.textContent = PALETTE_ABBR[slot.id] ?? abbrevFromName(slot.name);
  item.title = `${slot.name}: ${slot.summary}`;
  item.setAttribute("draggable", "false");

  // Se MANTIENE pulsado el botón izquierdo: el 'fantasma' acompaña al mouse
  // hasta que se suelta sobre el lienzo (ver onPaletteUp).
  item.addEventListener("pointerdown", (event) => startPaletteDrag(event, slot, item));

  return item;
}

/** Comienza el arrastre de un efecto: crea el fantasma y empieza a escuchar el mouse. */
function startPaletteDrag(event, slot, item) {
  if (event.button !== 0) return;   // solo el botón izquierdo
  event.preventDefault();

  const ghost = document.createElement("div");
  ghost.className = "palette-ghost";
  ghost.textContent = item.textContent;
  document.body.appendChild(ghost);

  // Aparece chico y crece velozmente (la clase is-grown dispara la transición).
  requestAnimationFrame(() => ghost.classList.add("is-grown"));

  paletteDrag = { slot, ghost };
  movePaletteGhost(event.clientX, event.clientY);

  window.addEventListener("pointermove", onPaletteMove);
  window.addEventListener("pointerup", onPaletteUp);
  window.addEventListener("pointercancel", onPaletteUp);
}

/** Mueve el fantasma para que siga al mouse (fixed + translate = centrado). */
function movePaletteGhost(clientX, clientY) {
  if (!paletteDrag) return;
  paletteDrag.ghost.style.left = `${clientX}px`;
  paletteDrag.ghost.style.top = `${clientY}px`;
}

function onPaletteMove(event) {
  movePaletteGhost(event.clientX, event.clientY);
}

/** Se suelta el click: si fue sobre el lienzo, creamos el nodo ahí. */
function onPaletteUp(event) {
  if (!paletteDrag) return;
  const { slot, ghost } = paletteDrag;

  window.removeEventListener("pointermove", onPaletteMove);
  window.removeEventListener("pointerup", onPaletteUp);
  window.removeEventListener("pointercancel", onPaletteUp);

  paletteDrag = null;
  ghost.remove();

  // #board es el lienzo. Si el mouse quedó sobre la propia paleta (u otro lugar
  // fijo), no creamos nada: hace falta soltarlo sobre el espacio de nodos.
  const target = event.target;
  const overBoard = target && (target.id === "board" || target.closest("#board"));
  if (!overBoard) {
    setStatus("Soltá el nodo sobre el lienzo (no sobre la paleta).");
    return;
  }

  // De pantalla a mundo: patch-board conoce el paneo y el zoom actuales.
  const world = board.screenToWorld(event.clientX, event.clientY);
  spawnEffect(slot, world.x, world.y);
}

/* ---------- 4) La cadena de audio sigue a los cables del tablero ---------- */

/**
 * Se llama cada vez que cambian los cables. Pregunta al tablero qué nodos
 * cuelgan del nodo principal, en orden, y le dice al motor que cablee eso.
 * ESTA es la regla del patch: un efecto suena solo si está conectado.
 */
function applyChain() {
  const chainIds = board.chainFromMain();
  const chain = [];

  for (const id of chainIds) {
    const node = effectNodes.get(id);
    if (node && node.instance) chain.push(node.instance);
  }

  engine.setChain(chain);

  // Los nodos "tap" (la Grabadora) no entran en la cadena: si tienen un cable de
  // entrada, escuchan la salida del nodo del que cuelgan.
  const taps = [];

  for (const [id, node] of effectNodes) {
    const active = node.instance !== null && chain.includes(node.instance);
    node.el.classList.toggle("is-on", active);
    node.el.classList.toggle("is-off", !active);

    if (!node.instance) continue;

    if (node.slot.tap) {
      const wire = board.inputOf(id);
      const tapActive = Boolean(wire);
      node.el.classList.toggle("is-on", tapActive);
      node.el.classList.toggle("is-off", !tapActive);
      if (tapActive) taps.push({ from: wire.from, effect: node.instance });
    } else {
      node.instance.setEnabled(active);
    }
  }

  engine.setTaps(taps);

  if (chain.length === 0) {
    setStatus("Ningún efecto conectado: se escucha el sample tal cual.");
    return;
  }
  const names = chainIds.map((id) => effectNodes.get(id).slot.name).join(" → ");
  setStatus(`Cadena activa: UR SAMPLE → ${names}`);
}

/**
 * Saca un nodo de efecto del tablero y del motor de audio. NO recablea la cadena
 * (eso lo hace quien llame). La usa la tecla Supr para borrar el nodo seleccionado.
 */
function removeEffectNodeById(id) {
  const entry = effectNodes.get(id);
  if (!entry) return;

  const { instance, slot } = entry;
  if (instance) engine.removeEffect(instance);
  board.removeNode(id);
  effectNodes.delete(id);

  if (slot.id === "recorder" && recorderLive && recorderLive.instance === instance) {
    recorderLive = null;
  }
}

/**
 * Borra los nodos de EFECTO seleccionados (tecla Supr). El nodo principal y el
 * analizador no están en `effectNodes`, así que quedan protegidos.
 */
function deleteSelectedNode() {
  const ids = board.getSelectedIds().filter((id) => effectNodes.has(id));
  if (ids.length === 0) return;

  const names = ids.map((id) => effectNodes.get(id).slot.name);
  for (const id of ids) removeEffectNodeById(id);
  applyChain();

  if (names.length === 1) setStatus(`${names[0]} eliminado.`);
  else setStatus(`${names.length} nodos eliminados.`);
}

// El tablero nos avisa cuando cambia un cable o cuando hay algo que decir.
board.onChange = applyChain;
board.onMessage = setStatus;

// Tecla Supr (Delete) → borra el nodo seleccionado. Solo nos frenamos si el foco
// está en un campo de texto DE VERDAD (input de texto, textarea o contenteditable):
// así, la tecla borra el nodo aunque el foco haya quedado en una perilla, un fader
// o un botón (el clic en el cuerpo del nodo hace preventDefault y no siempre
// devuelve el foco al fondo).
window.addEventListener("keydown", (event) => {
  if (event.key !== "Delete") return;

  // Si hay una ventanita abierta (nombre/confirmación de presets), no borramos
  // nodos: la tecla Supr se la dejamos a esa ventana.
  if (document.querySelector(".modal-overlay")) return;

  const active = document.activeElement;
  const isEditingText =
    active &&
    ((active.tagName === "INPUT" && active.type !== "range" && active.type !== "checkbox" && active.type !== "radio") ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable);
  if (isEditingText) return;

  deleteSelectedNode();
});

/* ---------- 4b) Presets de cadenas (guardar / cargar / exportar) ---------- */

/**
 * Ventanita genérica: sirve para pedir un nombre y para confirmar. `input` true
 * muestra un campo de texto; si es false, solo OK / Cancelar. Devuelve por
 * `onSubmit` el texto ingresado (o true / null si canceló).
 */
function showPresetModal({ title, message = "", input = false, initial = "", okText = "OK", onSubmit }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const box = document.createElement("div");
  box.className = "modal-box";

  const heading = document.createElement("p");
  heading.className = "modal-title";
  heading.textContent = title;
  box.appendChild(heading);

  if (message) {
    const text = document.createElement("p");
    text.className = "modal-message";
    text.textContent = message;
    box.appendChild(text);
  }

  const field = input ? document.createElement("input") : null;
  if (field) {
    field.className = "modal-input";
    field.type = "text";
    field.value = initial;
    box.appendChild(field);
  }

  const buttons = document.createElement("div");
  buttons.className = "modal-buttons";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "modal-cancel";
  cancel.textContent = "Cancelar";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "modal-ok";
  ok.textContent = okText;
  buttons.appendChild(cancel);
  buttons.appendChild(ok);
  box.appendChild(buttons);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  /** Cierra y entrega el resultado (null = canceló). */
  function close(result) {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
    onSubmit(result);
  }

  function onKey(event) {
    if (event.key === "Escape") close(null);
    else if (event.key === "Enter") close(field ? field.value : true);
  }

  cancel.addEventListener("click", () => close(null));
  ok.addEventListener("click", () => close(field ? field.value : true));
  overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) close(null); });
  window.addEventListener("keydown", onKey);

  if (field) field.focus();
}

/** Nombre de preset sin repetir: "Nombre", "Nombre (2)", "Nombre (3)", ... */
function uniquePresetName(base, excludeId = null) {
  const taken = new Set();
  for (const p of FACTORY_PRESETS) taken.add(p.name);
  for (const p of userPresets) if (p.id !== excludeId) taken.add(p.name);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`)) i += 1;
  return `${base} (${i})`;
}

/** Describe la cadena ACTUAL en el formato de presets (tipos, parámetros, orden y posición). */
function captureCurrentChain() {
  const chain = [];
  for (const id of board.chainFromMain()) {
    const entry = effectNodes.get(id);
    if (!entry || !entry.instance) continue;
    const node = board.getNode(id);
    const data = {
      type: entry.slot.id,
      params: { ...(entry.instance.values || {}) },
      x: node ? node.x : 0,
      y: node ? node.y : 0,
    };
    if (entry.instance.presetId) data.presetId = entry.instance.presetId;
    if (entry.instance.internal && Object.keys(entry.instance.internal).length) {
      data.internal = { ...entry.instance.internal };
    }
    chain.push(data);
  }
  return chain;
}

/** Espeja los valores de una instancia en los controles de su tarjeta. */
function mirrorCard(entry) {
  const { instance, slot, el, controls } = entry;
  if (!instance || !controls) return;

  for (const param of slot.params) {
    if (param.id === "preset") continue;
    const value = instance.values[param.id];
    if (value === undefined) continue;
    if (controls[param.id]) controls[param.id].set(value);
    const readout = el.querySelector(`[data-value="${param.id}"]`);
    if (readout) readout.textContent = customParamDisplay(instance, param, value);
  }

  const select = el.querySelector('select[data-param="preset"]');
  if (select && instance.presetId) {
    if (Array.from(select.options).some((option) => option.value === instance.presetId)) {
      select.value = instance.presetId;
    }
  }
}

/** Aplica los valores de un nodo guardado a una instancia recién creada. */
function applyChainNodeData(entry, data) {
  if (!entry || !entry.instance) return;
  const { instance, slot } = entry;

  const hasPreset = slot.params.some((p) => p.id === "preset");

  // 1) Si hay un preset interno (no "custom"), lo aplicamos: pone values + internal.
  if (hasPreset && data.presetId && data.presetId !== "custom" && typeof instance.applyPreset === "function") {
    instance.applyPreset(data.presetId);
  }

  // 2) Parámetros visibles guardados.
  if (data.params) {
    for (const [id, value] of Object.entries(data.params)) {
      if (id === "preset") continue;
      instance.setParam(id, value);
    }
  }

  // 3) Parámetros internos ocultos (p. ej. up/down/inv del OTT).
  if (data.internal && instance.internal) {
    instance.internal = { ...instance.internal, ...data.internal };
    if (typeof instance._pushAll === "function") instance._pushAll();
  }

  // 4) Restaurar el presetId si el ajuste manual lo dejó en "custom".
  if (hasPreset && data.presetId) instance.presetId = data.presetId;

  mirrorCard(entry);
}

/**
 * Carga un preset AGREGANDO sus nodos al lienzo, sin borrar los que ya hay
 * (por ejemplo la Grabadora o una cadena previa). Los nodos del preset se
 * conectan en serie a partir de "main".
 */
function applyPresetChain(preset) {
  const known = EFFECT_SLOTS.map((s) => s.id).filter((id) => EFFECT_CLASSES[id]);
  const filtered = filterChainByKnownTypes(preset.chain, known);

  const ids = [];
  filtered.chain.forEach((node, index) => {
    const slot = EFFECT_SLOTS.find((s) => s.id === node.type);
    if (!slot) return;
    const x = Number.isFinite(node.x) ? node.x : 720 + index * 480;
    const y = Number.isFinite(node.y) ? node.y : 0;
    const id = spawnEffect(slot, x, y, { silent: true });
    ids.push(id);
    applyChainNodeData(effectNodes.get(id), node);
  });

  if (ids.length) board.connect("main", ids[0]);
  for (let i = 1; i < ids.length; i += 1) board.connect(ids[i - 1], ids[i]);
  applyChain();

  if (filtered.skipped.length) {
    setStatus(`Preset "${preset.name}" cargado. Se omitieron efectos que ya no existen: ${filtered.skipped.join(", ")}.`);
  } else {
    setStatus(`Preset "${preset.name}" cargado.`);
  }
}

/** Vuelve a dibujar el panel de presets, pero solo si está abierto. */
function renderPresetsIfOpen() {
  if (activePaletteCat === "presets") {
    const cat = PALETTE_CATS.find((c) => c.id === "presets");
    if (cat) renderPalettePanel(cat);
  }
}

function presetActionButton(glyph, title, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "preset-action";
  btn.textContent = glyph;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.addEventListener("click", onClick);
  return btn;
}

function presetMiniButton(glyph, title, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "preset-mini";
  btn.textContent = glyph;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.addEventListener("click", onClick);
  return btn;
}

function buildPresetRow(preset) {
  const row = document.createElement("div");
  row.className = "preset-row";

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "preset-chip" + (preset.factory ? " is-factory" : "");
  chip.textContent = preset.name;
  chip.title = preset.factory
    ? `${preset.name} (preset de fábrica)`
    : `${preset.name} · creado el ${new Date(preset.createdAt).toLocaleDateString()}`;
  chip.addEventListener("click", () => applyPresetChain(preset));
  row.appendChild(chip);

  if (!preset.factory) {
    row.appendChild(presetMiniButton("✎", "Renombrar", () => promptRenamePreset(preset)));
    row.appendChild(presetMiniButton("×", "Borrar", () => confirmDeletePreset(preset)));
  }
  return row;
}

/** Rellena el panel de la categoría "Patrones": acciones + lista de presets. */
function renderPresetsContent() {
  const actions = document.createElement("div");
  actions.className = "preset-actions";
  actions.appendChild(presetActionButton("＋", "Guardar la cadena actual", promptSavePreset));
  actions.appendChild(presetActionButton("⭳", "Exportar presets (.json)", exportUserPresets));
  actions.appendChild(presetActionButton("⭱", "Importar presets (.json)", importPresetsFromFile));
  palettePanel.appendChild(actions);

  const all = [...FACTORY_PRESETS, ...userPresets];
  if (!all.length) {
    const empty = document.createElement("p");
    empty.className = "preset-empty";
    empty.textContent = "Todavía no hay presets.";
    palettePanel.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "preset-list";
  for (const preset of all) list.appendChild(buildPresetRow(preset));
  palettePanel.appendChild(list);
}

/** Pide almacenamiento persistente (mejor esfuerzo). Ver explicación en AGENTS/sumario. */
function requestPersistentStorage() {
  if (persistRequested) return;
  persistRequested = true;
  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => { /* el navegador puede negarlo */ });
    }
  } catch { /* mejor esfuerzo */ }
}

function promptSavePreset() {
  const chain = captureCurrentChain();
  if (!chain.length) {
    setStatus("Conectá al menos un efecto antes de guardar un preset.");
    return;
  }
  showPresetModal({
    title: "Guardar preset",
    message: "Nombre de la cadena:",
    input: true,
    placeholder: "Mi preset",
    okText: "Guardar",
    onSubmit: (value) => {
      if (value == null) return; // canceló
      const name = String(value).trim();
      if (!name) { setStatus("El nombre no puede estar vacío."); return; }

      const finalName = uniquePresetName(name, null);
      const preset = { id: makeUserId(), name: finalName, factory: false, createdAt: Date.now(), chain };

      if (storeBlocked) {
        userPresets = userPresets.concat(preset);
        renderPresetsIfOpen();
        setStatus("No se pudo guardar en este navegador. El preset queda solo para esta sesión.");
        return;
      }

      const result = persistAddPreset(presetStorage, preset);
      if (result.ok) {
        userPresets = result.presets;
        requestPersistentStorage();
        setStatus(`Preset "${finalName}" guardado.`);
      } else {
        userPresets = userPresets.concat(preset);
        setStatus("No se pudo guardar en este navegador. El preset queda solo para esta sesión.");
      }
      renderPresetsIfOpen();
    },
  });
}

function promptRenamePreset(preset) {
  showPresetModal({
    title: "Renombrar preset",
    message: "Nuevo nombre:",
    input: true,
    initial: preset.name,
    okText: "Renombrar",
    onSubmit: (value) => {
      if (value == null) return;
      const name = String(value).trim();
      if (!name) { setStatus("El nombre no puede estar vacío."); return; }

      const finalName = uniquePresetName(name, preset.id);

      if (storeBlocked) {
        userPresets = userPresets.map((p) => (p.id === preset.id ? { ...p, name: finalName } : p));
        renderPresetsIfOpen();
        setStatus("No se pudo guardar en este navegador.");
        return;
      }

      const result = persistRenamePreset(presetStorage, preset.id, finalName);
      if (result.ok) {
        userPresets = result.presets;
        setStatus(`Renombrado a "${finalName}".`);
      } else {
        setStatus("No se pudo guardar en este navegador.");
      }
      renderPresetsIfOpen();
    },
  });
}

function confirmDeletePreset(preset) {
  showPresetModal({
    title: "Borrar preset",
    message: `¿Borrar "${preset.name}"? Esta acción no se puede deshacer.`,
    okText: "Borrar",
    onSubmit: (ok) => {
      if (!ok) return;

      if (storeBlocked) {
        userPresets = userPresets.filter((p) => p.id !== preset.id);
        renderPresetsIfOpen();
        setStatus("No se pudo guardar en este navegador.");
        return;
      }

      const result = persistRemovePreset(presetStorage, preset.id);
      if (result.ok) {
        userPresets = result.presets;
        setStatus(`Preset "${preset.name}" borrado.`);
      } else {
        userPresets = userPresets.filter((p) => p.id !== preset.id);
        setStatus("No se pudo guardar en este navegador.");
      }
      renderPresetsIfOpen();
    },
  });
}

function exportUserPresets() {
  if (!userPresets.length) {
    setStatus("No hay presets del usuario para exportar.");
    return;
  }
  const payload = { version: FORMAT_VERSION, presets: userPresets };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "samplecast-presets.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Exportados ${userPresets.length} presets en un archivo .json.`);
}

function importPresetsFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseImportPayload(String(reader.result));
      if (!parsed.ok) { setStatus(`No se pudo importar: ${parsed.reason}.`); return; }
      if (!parsed.presets.length) { setStatus("El archivo no contiene presets válidos."); return; }

      if (storeBlocked) {
        for (const preset of parsed.presets) {
          if (!userPresets.some((existing) => existing.id === preset.id)) userPresets.push(preset);
        }
        renderPresetsIfOpen();
        setStatus("No se pudo guardar en este navegador. Los presets quedan solo para esta sesión.");
        return;
      }

      const result = persistImportPresets(presetStorage, parsed.presets);
      if (!result.ok) { setStatus("No se pudo guardar en este navegador."); return; }
      userPresets = result.presets;
      requestPersistentStorage();
      renderPresetsIfOpen();
      setStatus(`Importados ${result.added} presets (de ${parsed.presets.length} del archivo).`);
    };
    reader.onerror = () => setStatus("No se pudo leer el archivo.");
    reader.readAsText(file);
  });
  input.click();
}

// Cuando OTRA pestaña guarda o borra, el navegador nos avisa y refrescamos la
// lista. (Este evento NO dispara en la pestaña que hizo el cambio.)
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) {
    userPresets = readUserPresets(presetStorage);
    renderPresetsIfOpen();
  }
});
/* ---------- 5) Funciones auxiliares ---------- */

/** Convierte segundos en texto "m:ss.d" (ej: 83.4 → "1:23.4"). */
function formatTime(seconds) {
  const tenths = Math.floor(seconds * 10);      // trabajamos en décimas para evitar errores de redondeo
  const minutes = Math.floor(tenths / 600);
  const secs = (tenths % 600) / 10;
  return `${minutes}:${secs.toFixed(1).padStart(4, "0")}`;
}

/**
 * Avisa de forma amigable si el navegador no soporta Web Audio o AudioWorklet,
 * en vez de dejar la app rota. Las funciones opcionales (showDirectoryPicker,
 * MediaRecorder) no se usan en esta app, así que no hay que avisar por ellas.
 */
function checkBrowserSupport() {
  const el = els.compatWarning;
  if (!el) return;

  const hasAudioContext = Boolean(window.AudioContext || window.webkitAudioContext);
  const hasWorklet = typeof window.AudioWorkletNode === "function";

  if (!hasAudioContext) {
    el.hidden = false;
    el.textContent = "Tu navegador no soporta Web Audio API. samplecast necesita un navegador moderno (Chrome, Edge, Firefox o Safari actualizado).";
    return;
  }

  if (!hasWorklet) {
    el.hidden = false;
    el.textContent = "Tu navegador no soporta AudioWorklet: samplecast funciona, pero los efectos espectrales y el Beat Repeater no estarán disponibles.";
  }
}

function setStatus(text) {
  els.status.textContent = text;
}

/** El botón de reproducir cambia su dibujo y su texto según el estado. */
function updatePlayButton() {
  const playing = transport.isPlaying;
  els.btnPlay.dataset.state = playing ? "pause" : "play";   // el CSS muestra una u otra flecha
  els.btnPlay.title = playing ? "Pausar" : "Reproducir";
  els.btnPlay.setAttribute("aria-label", els.btnPlay.title);
}

/* ---------- 6) Eventos de la interfaz ---------- */

// La flecha para arriba (cargar sample) "clickea" al input de archivo oculto
els.btnLoad.addEventListener("click", () => els.fileInput.click());

// Cuando el usuario elige un archivo. Flujo completo:
//   change → engine.loadFile() → (ensureContext, decodificar, transport.setBuffer) → actualizar pantalla
els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files[0];
  if (!file) return;

  setStatus("Decodificando audio…");
  try {
    const info = await engine.loadFile(file); // `await` = esperá a que termine antes de seguir
    waveform.setBuffer(info.buffer);

    els.name.textContent = info.name;
    els.duration.textContent = `${formatTime(info.duration)} · ${info.channels === 1 ? "mono" : "estéreo"} · ${info.sampleRate} Hz`;

    // Habilitamos los controles que necesitan un sample
    els.btnPlay.disabled = false;
    els.btnRestart.disabled = false;
    els.loopEnabled.disabled = false;
    els.waveCanvas.classList.add("is-seekable");

    updatePlayButton();
    setStatus("Sample listo. Apretá Reproducir, o arrastrá sobre la onda para marcar el loop.");
  } catch (error) {
    console.error(error);
    setStatus("No se pudo leer ese archivo. Probá con WAV, MP3 u OGG.");
  } finally {
    els.fileInput.value = ""; // permite volver a elegir el mismo archivo después
  }
});

els.btnPlay.addEventListener("click", async () => {
  if (transport.isPlaying) transport.pause();
  else await transport.play();
  updatePlayButton();
});

els.btnRestart.addEventListener("click", () => {
  transport.restart();
});

/* ---------- Selección del loop arrastrando sobre la forma de onda ---------- */

// Mientras arrastramos, guardamos acá la selección en curso (fracciones 0..1).
// El bucle de dibujo la lee para mostrar la franja en vivo.
let selection = null;

// Usamos la MISMA lógica de "arrastrar sobre un canvas" que el recorte de la
// Grabadora (js/range-selector.js): solo cambian los callbacks.
createRangeSelector(els.waveCanvas, {
  canStart: () => transport.getDuration() > 0,

  // Al apoyar el mouse marcamos el INICIO: si está sonando, salta ahí
  // (aunque venía reproduciendo en otro momento del sample).
  onStart: (fraction) => {
    if (transport.isPlaying) transport.seek(fraction * transport.getDuration());
  },

  // Mientras arrastramos: actualizamos la franja que dibuja frame().
  onPreview: (start, end) => {
    selection = { from: start, to: end };
  },

  // Soltamos sin mover: fue un clic → saltar a esa posición.
  onClick: (fraction) => {
    transport.seek(fraction * transport.getDuration());
    setStatus(`Saltaste a ${formatTime(fraction * transport.getDuration())}.`);
  },

  // Soltamos tras arrastrar: marcamos el loop (en cualquier dirección).
  onCommit: (start, end) => {
    selection = null;
    const duration = transport.getDuration();
    transport.setLoopRegion(start * duration, end * duration);

    // El playhead salta al inicio del loop recién marcado (si está sonando).
    if (transport.isPlaying) transport.seek(start * duration);

    // Elegir una región ENCIENDE el loop si estaba apagado.
    if (!transport.loop.enabled) {
      transport.setLoopEnabled(true);
      els.loopEnabled.checked = true;
    }
    setStatus(`Loop de ${formatTime(transport.loop.start)} a ${formatTime(transport.loop.end)} ` +
      `(${(transport.loop.end - transport.loop.start).toFixed(2)} s).`);
  },

  onCancel: () => {
    selection = null;
  },
});

// Loop: checkbox activado/desactivado
els.loopEnabled.addEventListener("change", () => {
  transport.setLoopEnabled(els.loopEnabled.checked);
  setStatus(els.loopEnabled.checked
    ? `Loop activado (${formatTime(transport.loop.start)} → ${formatTime(transport.loop.end)}).`
    : "Loop desactivado.");
});

// Cuando el sample termina solo, el transporte nos avisa y actualizamos el botón.
// (Asignamos una función a la propiedad onEnded: eso es un "callback".)
transport.onEnded = () => {
  updatePlayButton();
  setStatus("Fin del sample.");
};

els.volume.addEventListener("input", () => {
  const value = Number(els.volume.value);
  els.volumeOut.textContent = value;
  els.volume.style.setProperty("--fill", `${value}%`);
  engine.setVolume(value / 100);            // el motor trabaja de 0 a 1
});

// Volver al nodo principal (botón de la esquina inferior derecha)
els.btnRecenter.addEventListener("click", () => {
  board.centerOn("main");
  // Un resplandor verde para que veas dónde quedó
  els.nodeMain.classList.add("is-spotlight");
  setTimeout(() => els.nodeMain.classList.remove("is-spotlight"), 900);
  setStatus("Volviste al nodo principal.");
});

/* ---------- 7) Arranque y bucle de animación ---------- */

buildPalette();                        // barra lateral con los contenedores de nodos
buildEffectNodes();                    // nodos por defecto: el sample y la Grabadora
board.centerOn("main", { animate: false }); // al abrir, el nodo principal queda en el centro
applyChain();                          // sin cables: el audio va directo a la salida

// Compatibilidad y versión: aviso amigable si falta soporte + número de versión.
checkBrowserSupport();
els.appVersion.textContent = `v${APP_VERSION}`;

// requestAnimationFrame le pide al navegador: "llamame antes de pintar el próximo cuadro".
// Lo pedimos al PRINCIPIO de frame(): así, aunque algo falle mientras dibujamos,
// el próximo cuadro ya está agendado y la interfaz no se congela.
const _drawErrors = new Set(); // etiquetas de errores ya avisados (para no spamear)

/** Ejecuta una pieza de dibujo por separado; si falla, lo anota UNA sola vez. */
function drawSafe(label, fn) {
  try {
    fn();
  } catch (error) {
    if (!_drawErrors.has(label)) {
      _drawErrors.add(label);
      console.error(`Error al dibujar ${label}:`, error);
    }
  }
}

// frame() solo LEE el estado (posición, loop) y dibuja. No decide nada sobre la reproducción.
function frame() {
  requestAnimationFrame(frame); // ← primero: el bucle no se corta ante un error

  const duration = transport.getDuration();
  const position = transport.getPosition(); // ← la única fuente de verdad de la posición

  // La franja del loop que dibujamos sobre la onda:
  //   - si estamos arrastrando, la selección en curso (para verla en vivo);
  //   - si el loop está activo, la región guardada en el transporte;
  //   - si no, nada.
  const loop = transport.loop;
  let loopRegion = null;
  if (selection) {
    loopRegion = {
      start: Math.min(selection.from, selection.to),
      end: Math.max(selection.from, selection.to),
    };
  } else if (duration > 0 && loop.enabled) {
    loopRegion = { start: loop.start / duration, end: loop.end / duration };
  }

  // Cada cosa se dibuja protegida por separado: si una falla, las otras siguen.
  drawSafe("la forma de onda", () => {
    waveform.render(duration > 0 ? position / duration : 0, loopRegion);
  });
  drawSafe("el espectro", () => {
    if (spectrumVisible) spectrum.draw();   // plegado no hay nada que dibujar
  });
  els.time.textContent = `${formatTime(position)} / ${formatTime(duration)}`;
  drawSafe("los cables", () => board.update());

  // Grabadora: la onda se dibuja EN VIVO mientras se graba (una columna por cuadro).
  if (recorderLive && recorderLive.instance.recording) {
    drawSafe("la onda de la grabadora", () => {
      recorderLive.wave.capture(recorderLive.instance.analyser);
      recorderLive.counter.textContent = `${recorderLive.instance.elapsedSeconds().toFixed(1)} s`;
      recorderLive.wave.draw();
    });
  }
}
requestAnimationFrame(frame);