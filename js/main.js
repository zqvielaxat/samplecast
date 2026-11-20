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
import { EFFECT_SLOTS } from "./effects/registry.js";
import { FrequencyShiftEffect } from "./effects/frequency-shift.js";
import { DistortionEffect } from "./effects/distortion.js";
import { BinScramblerEffect } from "./effects/bin-scrambler.js";
import { SpectralGateEffect } from "./effects/spectral-gate.js";
import { BeatRepeaterEffect } from "./effects/beat-repeater.js";
import { RecorderEffect } from "./effects/recorder.js";

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
  dropHint: $("drop-hint"),
};

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
  angles: { out: 8 },       // su puerto de salida nace mirando a la derecha
  label: "UR SAMPLE",
});

// El volumen usa el mismo estilo de slider que los efectos (con su parte verde)
els.volume.classList.add("slider");
els.volume.style.setProperty("--fill", `${els.volume.value}%`);
enableFader(els.volume);   // clic en cualquier punto = el volumen salta ahí

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
  "recorder": RecorderEffect,
};

const effectNodes = new Map();  // id → { instance, slot, el }

/** Muestra un valor con su unidad: 100 → "100 Hz" (o "50%"). */
function formatParamValue(param, value) {
  if (param.unit === "%") return `${value}%`;
  return param.unit ? `${value} ${param.unit}` : String(value);
}

/**
 * ¿Este parámetro se dibuja como PERILLA?
 * El "mix" es un fader, y los "select" y "number" son listas y campos numéricos.
 */
function isKnob(param) {
  return param.id !== "mix" && param.kind !== "select" && param.kind !== "number";
}

/** El círculo crece un poco si el efecto tiene más perillas que mostrar. */
function nodeDiameter(slot) {
  if (slot.ui === "recorder") return 320;   // la Grabadora tiene botones, no perillas
  const knobCount = slot.params.filter(isKnob).length;
  return 280 + 42 * Math.max(0, knobCount - 1);
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
        <button class="btn-record" type="button" aria-label="Empezar a grabar">● Grabar</button>
        <span class="rec-time" aria-live="polite">0.0 s</span>
        <button class="btn-download" type="button" aria-label="Descargar sample" disabled>⬇ Descargar sample</button>
      </div>`;
  }

  const knobParams = slot.params.filter(isKnob);
  const selectParams = slot.params.filter((p) => p.kind === "select");
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
    ${knobs ? `<div class="knob-grid">${knobs}</div>` : ""}
    ${selects}
    ${numbers}
    ${mix}
    ${slot.available ? "" : `<p class="fx-lock">Se activa en la etapa ${slot.stage}</p>`}`;
}

/**
 * Conecta los controles de un nodo con su objeto de efecto:
 * cada perilla, cada lista, cada campo y cada fader llaman a setParam().
 */
function wireEffectControls(el, slot, instance) {
  for (const param of slot.params) {
    if (!isKnob(param)) continue;                     // el "mix" y el "select" se arman aparte
    const mount = el.querySelector(`[data-knob="${param.id}"]`);
    const readout = el.querySelector(`[data-value="${param.id}"]`);
    const knob = createKnob({
      min: param.min,
      max: param.max,
      step: param.step,
      value: param.value,
      label: `${slot.name}: ${param.label}`,
      onChange: (value) => {
        readout.textContent = formatParamValue(param, value);
        instance.setParam(param.id, value);
      },
    });
    mount.replaceWith(knob.el);                       // el hueco se cambia por la perilla
  }

  // Listas desplegables (por ejemplo el "Tipo" de la Distortion). El valor que
  // se manda es el texto de la opción elegida ("soft", "hard", "fold").
  for (const param of slot.params.filter((p) => p.kind === "select")) {
    const select = el.querySelector(`select[data-param="${param.id}"]`);
    if (!select) continue;
    select.addEventListener("change", () => instance.setParam(param.id, select.value));
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
  }

  const mixParam = slot.params.find((p) => p.id === "mix");
  const slider = el.querySelector('input[data-param="mix"]');
  if (mixParam && slider) {
    const readout = el.querySelector('[data-value="mix"]');
    enableFader(slider);   // clic en cualquier punto = el valor salta ahí
    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      readout.textContent = formatParamValue(mixParam, value);
      slider.style.setProperty("--fill", `${value}%`); // pinta la parte verde del slider
      instance.setParam("mix", value);
    });
  }
}

/**
 * Conecta los botones de la Grabadora con su objeto (start / stop / download) y
 * refresca la tarjeta cuando cambia el estado (grabando, parada, hay WAV).
 */
function wireRecorderControls(el, instance) {
  const btnRecord = el.querySelector(".btn-record");
  const btnDownload = el.querySelector(".btn-download");
  const counter = el.querySelector(".rec-time");

  function refresh() {
    counter.textContent = `${instance.elapsedSeconds().toFixed(1)} s`;
    if (instance.recording) {
      btnRecord.classList.add("is-recording");
      btnRecord.textContent = "■ Parar";
      btnRecord.setAttribute("aria-label", "Parar la grabación");
    } else {
      btnRecord.classList.remove("is-recording");
      btnRecord.textContent = "● Grabar";
      btnRecord.setAttribute("aria-label", "Empezar a grabar");
    }
    btnDownload.disabled = !instance.lastBlob;
  }

  btnRecord.addEventListener("click", () => {
    if (instance.recording) {
      instance.stop();
    } else if (!instance.start()) {
      setStatus("La grabadora todavía no está lista (cargá un sample primero).");
    }
    refresh();
  });

  btnDownload.addEventListener("click", () => {
    if (!instance.download()) setStatus("No hay nada grabado todavía.");
    else setStatus("Grabación descargada como WAV.");
  });

  instance.onChange = refresh;
  refresh();
}

/** Crea un nodo por cada efecto del catálogo y lo registra en el tablero. */
function buildEffectNodes() {
  for (const slot of EFFECT_SLOTS) {
    const EffectClass = slot.available ? EFFECT_CLASSES[slot.id] : null;
    const instance = EffectClass ? new EffectClass() : null;
    if (instance) engine.addEffect(instance);

    const diameter = nodeDiameter(slot);
    const el = document.createElement("div");
    el.className = `fx-node is-off${slot.available ? "" : " is-locked"}`;
    el.innerHTML = effectNodeHTML(slot);
    el.style.width = `${diameter}px`;
    el.style.height = `${diameter}px`;
    els.world.appendChild(el);

    board.addNode(slot.id, el, {
      x: slot.home.x,
      y: slot.home.y,
      rx: diameter / 2,
      ry: diameter / 2,
      // El elemento se centra con translate(-50%,-50%), así que su centro cae
      // en la mitad de su propia caja (esto es lo que usan los puertos).
      localCenter: { x: diameter / 2, y: diameter / 2 },
      label: slot.name,
      locked: !slot.available,
      stage: slot.stage,
      // Los nodos "tap" (la Grabadora) no tienen salida: solo escuchan.
      canOutput: slot.tap !== true,
    });

    if (instance && slot.ui === "recorder") wireRecorderControls(el, instance);
    else if (instance) wireEffectControls(el, slot, instance);

    effectNodes.set(slot.id, { instance, slot, el });
  }
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

// El tablero nos avisa cuando cambia un cable o cuando hay algo que decir.
board.onChange = applyChain;
board.onMessage = setStatus;

/* ---------- 5) Funciones auxiliares ---------- */

/** Convierte segundos en texto "m:ss.d" (ej: 83.4 → "1:23.4"). */
function formatTime(seconds) {
  const tenths = Math.floor(seconds * 10);      // trabajamos en décimas para evitar errores de redondeo
  const minutes = Math.floor(tenths / 600);
  const secs = (tenths % 600) / 10;
  return `${minutes}:${secs.toFixed(1).padStart(4, "0")}`;
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

// Carga un sample desde un archivo. La usan tanto el botón de subir como
// el "arrastrar y soltar": así el flujo de decodificar y actualizar la pantalla
// queda escrito UNA sola vez.
async function loadSampleFile(file) {
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

    // Ya hay sample: escondemos el cartel que decía "arrastrá tu sample acá"
    els.dropHint.classList.add("is-hidden");

    updatePlayButton();
    setStatus("Sample listo. Apretá Reproducir, o arrastrá sobre la onda para marcar el loop.");
  } catch (error) {
    console.error(error);
    setStatus("No se pudo leer ese archivo. Probá con WAV, MP3 u OGG.");
  }
}

// La flecha para arriba (cargar sample) "clickea" al input de archivo oculto
els.btnLoad.addEventListener("click", () => els.fileInput.click());

// Cuando el usuario elige un archivo con el botón. Flujo completo:
//   change → loadSampleFile() → engine.loadFile() → (ensureContext, decodificar, transport.setBuffer) → actualizar pantalla
els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files[0];
  if (!file) return;
  await loadSampleFile(file);
  els.fileInput.value = ""; // permite volver a elegir el mismo archivo después
});

// ARRASTRAR Y SOLTAR un sample desde el escritorio (o una carpeta) hasta el nodo
// principal. Por defecto el navegador, al soltar un archivo sobre la página, lo
// "abre" en la pestaña; preventDefault() deja de lado ese comportamiento y nos
// deja leerlo a nosotros con la misma función del botón de carga.
els.nodeMain.addEventListener("dragenter", (event) => {
  event.preventDefault();
  els.nodeMain.classList.add("is-dragging");       // resaltamos el nodo en verde
});

els.nodeMain.addEventListener("dragover", (event) => {
  // Sin preventDefault() el navegador NO considera este elemento una zona válida para soltar.
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";          // traemos una copia; no movemos el original
});

els.nodeMain.addEventListener("dragleave", (event) => {
  // dragleave también salta al pasar por encima de un hijo del nodo; solo quitamos
  // el resaltado cuando el cursor realmente SALE del nodo principal.
  if (!els.nodeMain.contains(event.relatedTarget)) {
    els.nodeMain.classList.remove("is-dragging");
  }
});

els.nodeMain.addEventListener("drop", (event) => {
  event.preventDefault();
  els.nodeMain.classList.remove("is-dragging");
  const file = event.dataTransfer?.files?.[0];     // tomamos el primer archivo soltado
  loadSampleFile(file);
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

/** Convierte la posición horizontal del mouse en una fracción de la onda (0 a 1). */
function waveFractionAt(event) {
  const rect = els.waveCanvas.getBoundingClientRect();
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

// PRIMER CLIC = inicio · SOLTAR = fin. Y si el mouse casi no se movió, fue un
// clic normal: entonces saltamos a esa posición (el comportamiento de antes).
els.waveCanvas.addEventListener("pointerdown", (event) => {
  if (transport.getDuration() === 0) return; // todavía no hay sample
  event.preventDefault();
  try { els.waveCanvas.setPointerCapture(event.pointerId); } catch { /* ya se liberó */ }

  const fraction = waveFractionAt(event);
  selection = { from: fraction, to: fraction, moved: false, width: els.waveCanvas.getBoundingClientRect().width };

  // Marcar el INICIO del loop ya salta la reproducción ahí (si está sonando),
  // aunque venía reproduciendo en otro momento del sample.
  if (transport.isPlaying) transport.seek(fraction * transport.getDuration());
});

els.waveCanvas.addEventListener("pointermove", (event) => {
  if (!selection) return;
  const fraction = waveFractionAt(event);
  // Consideramos que es una selección si se movió más de 5 píxeles.
  if (Math.abs(fraction - selection.from) * selection.width > 5) selection.moved = true;
  selection.to = fraction;
});

els.waveCanvas.addEventListener("pointerup", (event) => {
  if (!selection) return;
  const { from, to, moved } = selection;
  selection = null;
  try { els.waveCanvas.releasePointerCapture(event.pointerId); } catch { /* ya se liberó */ }

  const duration = transport.getDuration();
  if (!moved) {
    transport.seek(from * duration);                    // fue un clic: saltar
    setStatus(`Saltaste a ${formatTime(from * duration)}.`);
    return;
  }

  // Fue un arrastre: marcamos inicio y fin del loop (en cualquier dirección).
  const start = Math.min(from, to) * duration;
  const end = Math.max(from, to) * duration;
  transport.setLoopRegion(start, end);

  // El playhead salta al inicio del loop recién marcado (si está sonando).
  if (transport.isPlaying) transport.seek(start);

  // Elegir una región ENCIENDE el loop si estaba apagado; si ya estaba prendido,
  // solo cambia la posición (que es lo que acabamos de hacer).
  if (!transport.loop.enabled) {
    transport.setLoopEnabled(true);
    els.loopEnabled.checked = true;
  }
  setStatus(`Loop de ${formatTime(transport.loop.start)} a ${formatTime(transport.loop.end)} ` +
    `(${(transport.loop.end - transport.loop.start).toFixed(2)} s).`);
});

els.waveCanvas.addEventListener("pointercancel", () => { selection = null; });

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

buildEffectNodes();                    // un nodo por cada efecto del catálogo
board.centerOn("main", { animate: false }); // al abrir, el nodo principal queda en el centro
applyChain();                          // sin cables: el audio va directo a la salida

// requestAnimationFrame le pide al navegador: "llamame antes de pintar el próximo cuadro".
// Al volver a pedirlo dentro de la función, se forma un bucle (~60 veces por segundo).
// frame() solo LEE el estado (posición, loop) y dibuja. No decide nada sobre la reproducción.
function frame() {
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

  waveform.render(duration > 0 ? position / duration : 0, loopRegion);
  if (spectrumVisible) spectrum.draw();   // plegado no hay nada que dibujar
  els.time.textContent = `${formatTime(position)} / ${formatTime(duration)}`;
  board.update();  // redibuja los cables solo si hicieron falta

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);