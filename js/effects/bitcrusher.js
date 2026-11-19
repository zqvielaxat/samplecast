/* =========================================================
   effects/bitcrusher.js — Bitcrusher: el "envoltorio"

   Este archivo es el que conoce la interfaz (main.js): le ofrece setParam() y
   setEnabled(). Por dentro arma el grafo y carga el procesador
   (bitcrusher-processor.js), que hace las cuentas muestra por muestra.

   GRAFO DEL EFECTO (es un efecto de dominio TEMPORAL, sin FFT):

      input ─┬─► dryGain ────────────────────────► output
              └─► [procesador] ──► outGain ──► wetGain ──► output

   COMO ESTE EFECTO NO AGREGA NINGÚN RETARDO, el seco y el húmedo quedan ALINEADOS
   en el tiempo: no hace falta el "dryDelay" de los efectos espectrales. El cruce
   Dry/Wet usa POTENCIA CONSTANTE (seno/coseno) para no tener saltos de volumen.

   LA ESCALA LOGARÍTMICA DEL FADER "Rate"
   --------------------------------------
   El fader Rate va de 500 Hz (abajo) a la frecuencia de muestreo del contexto
   (arriba). En la tarjeta el fader avanza de 0 a 1 EN LÍNEA RECTA, pero el efecto
   convierte esa posición a frecuencia con una curva EXPONENCIAL:

       Hz = 500 · (máximo / 500)^posición

   ¿Por qué exponencial y no lineal? Porque el oído percibe los cambios de
   frecuencia de forma PROPORCIONAL: de 500 a 1000 Hz se siente el MISMO "salto"
   que de 8000 a 16000 Hz. Con una escala lineal, la mitad izquierda del fader
   estaría apretada en los graves y la derecha vacía. Con la curva exponencial,
   cada tramo igual de recorrido del dedo cambia la frecuencia en un PORCENTAJE
   igual: es la sensación "natural" de un control de frecuencia.
   ========================================================= */

import { BITCRUSHER_PRESETS } from "./bitcrusher-presets.js";
import { applyPresetValues, markPresetCustom } from "./presets.js";

// El procesador se carga con addModule(); la ruta es relativa a ESTE archivo.
const PROCESSOR_URL = new URL("./bitcrusher-processor.js", import.meta.url).href;

// Frecuencia MÍNIMA del fader Rate (Hz).
export const RATE_MIN = 500;
// Máximo de "muestra" cuando todavía no hay AudioContext (para mostrar el fader).
const RATE_MAX_FALLBACK = 48000;

/** dB → ganancia lineal (0 dB = x1). */
function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/** Formatea una frecuencia para mostrarla: "800 Hz", "8 kHz", "13.5 kHz". */
export function hzLabel(hz) {
  hz = Math.max(0, Math.round(hz));
  if (hz >= 1000) {
    const kHz = hz / 1000;
    const text = kHz % 1 === 0 ? String(kHz) : kHz.toFixed(1);
    return `${text} kHz`;
  }
  return `${hz} Hz`;
}
export class BitcrusherEffect {
  constructor() {
    this.id = "bitcrusher";

    // Nodos del grafo (null hasta que exista el AudioContext → attach).
    this.input = null;
    this.output = null;
    this.dryGain = null;
    this.wetGain = null;
    this.outGain = null;
    this.processor = null;

    this.ctx = null;
    this.ready = false;
    this.readyPromise = null;
    this.enabled = true;

    // Valores visibles (coinciden con el preset "Neutro"). `rate` está en Hz y
    // 192000 quiere decir "al máximo" (se frena a la frecuencia real del contexto).
    this.values = { bits: 16, rate: 192000, out: 0, mix: 100 };
    this.internal = {};          // este efecto no usa parámetros ocultos

    this.presetId = "neutro";
    this.onUiSync = null;        // main.js: "cambió un valor, espejá la tarjeta"
    this.onReady = null;         // main.js: "ya existe el contexto, actualizá el fader Rate"
  }

  /* ---------------- Ciclo de vida ---------------- */

  attach(ctx) {
    if (this.input) return; // ya estaba armado
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.outGain = ctx.createGain();

    // Camino seco: pasa derecho (no hay retardo que alinear).
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Camino húmedo: el procesador se crea en loadProcessor; mientras tanto el
    // wet queda mudo y el dry deja pasar todo.
    this.outGain.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.applyMix(true);
    this._pushOut(true); // Out no depende del worklet: se puede fijar ya

    // Cargar el procesador es asincrónico.
    this.readyPromise = this.loadProcessor();

    // Ya existe el contexto: avisamos a la interfaz para que el fader Rate (log)
    // muestre el máximo real (44.1 kHz / 48 kHz, según el contexto).
    if (this.onReady) this.onReady();
  }

  /** Descarga el módulo del AudioWorklet y crea el nodo procesador. */
  async loadProcessor() {
    try {
      await this.ctx.audioWorklet.addModule(PROCESSOR_URL);

      this.processor = new AudioWorkletNode(this.ctx, "bitcrusher");
      this.input.connect(this.processor);
      this.processor.connect(this.outGain);

      this.ready = true;
      this._pushAll(true); // envía bits/rate al worklet y re-aplica el mix
    } catch (error) {
      // Si falla, el efecto queda como un simple "pasar la señal".
      console.error("No se pudo cargar el procesador del Bitcrusher:", error);
      console.info("Tip: los AudioWorklet no funcionan abriendo index.html con file:// ; usá un servidor local.");
    }
  }
/* ---------------- Fader Rate: escala logarítmica ---------------- */

  /** Rango del fader Rate: de RATE_MIN al máximo real del contexto. */
  rateBounds() {
    return { min: RATE_MIN, max: this.ctx ? this.ctx.sampleRate : RATE_MAX_FALLBACK };
  }

  /** Recorta una frecuencia a [RATE_MIN, máximo real]. */
  clampRate(hz) {
    const { min, max } = this.rateBounds();
    return Math.min(max, Math.max(min, hz));
  }

  /** Posición del fader (0..1) → frecuencia en Hz (curva exponencial/logarítmica). */
  rateHz(position) {
    const { min, max } = this.rateBounds();
    const p = position < 0 ? 0 : position > 1 ? 1 : position;
    return min * Math.pow(max / min, p);
  }

  /** Frecuencia en Hz → posición del fader (0..1). */
  rateToPosition(hz) {
    const { min, max } = this.rateBounds();
    const hz2 = this.clampRate(hz);
    return Math.log(hz2 / min) / Math.log(max / min);
  }

  /* ---------------- Envío de valores a los nodos ---------------- */

  _pushBits(immediate = false) {
    if (!this.processor) return;
    const param = this.processor.parameters.get("bits");
    if (!param) return;
    if (immediate) param.value = this.values.bits;
    else param.setTargetAtTime(this.values.bits, this.ctx.currentTime, 0.02);
  }

  _pushRate(immediate = false) {
    if (!this.processor) return;
    const param = this.processor.parameters.get("rate");
    if (!param) return;
    const hz = this.clampRate(this.values.rate);
    if (immediate) param.value = hz;
    else param.setTargetAtTime(hz, this.ctx.currentTime, 0.02);
  }

  _pushOut(immediate = false) {
    if (!this.outGain) return;
    const gain = dbToGain(this.values.out);
    if (immediate) this.outGain.gain.value = gain;
    else this.outGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  _pushAll(immediate = false) {
    this._pushBits(immediate);
    this._pushRate(immediate);
    this._pushOut(immediate);
    this.applyMix(immediate);
  }

  /* ---------------- Controles de la interfaz ---------------- */

  /** Cambia un parámetro por su id. "preset" aplica un preset completo. */
  setParam(id, value) {
    if (id === "preset") {
      this.applyPreset(value);
      return;
    }
    if (!(id in this.values)) return;
    this.values[id] = value;
    markPresetCustom(this); // un ajuste manual sale del preset elegido

    if (id === "bits") this._pushBits();
    else if (id === "rate") this._pushRate();
    else if (id === "out") this._pushOut();
    else if (id === "mix") this.applyMix();

    if (this.onUiSync) this.onUiSync();
  }

  /** Aplica un preset completo (reutiliza el helper compartido con el OTT). */
  applyPreset(id) {
    const preset = applyPresetValues(this, BITCRUSHER_PRESETS, id, {});
    if (!preset) return;
    this._pushAll();
    if (this.onUiSync) this.onUiSync();
  }

  /** Prende o apaga el efecto. main.js lo llama al conectar/desconectar el nodo. */
  setEnabled(on) {
    this.enabled = Boolean(on);
    this.applyMix();
  }

  /**
   * Dry/Wet con POTENCIA CONSTANTE (seno/coseno): sin el "hueco" de −3 dB del
   * cruce lineal. Como no hay retardo, seco y húmedo están alineados.
   */
  applyMix(immediate = false) {
    if (!this.dryGain) return;

    const active = this.enabled && this.ready;
    const angle = (this.values.mix / 100) * (Math.PI / 2);
    const wet = active ? Math.sin(angle) : 0;
    const dry = active ? Math.cos(angle) : 1;

    if (immediate) {
      this.dryGain.gain.value = dry;
      this.wetGain.gain.value = wet;
      return;
    }
    const now = this.ctx.currentTime;
    this.dryGain.gain.setTargetAtTime(dry, now, 0.01);
    this.wetGain.gain.setTargetAtTime(wet, now, 0.01);
  }

  /* ---------------- Ayudas para la tarjeta (main.js) ---------------- */

  /** Convierte la posición de un fader al valor real del efecto. */
  valueFromSlider(id, position) {
    if (id === "rate") return this.rateHz(position);
    return position;
  }

  /** Convierte el valor real del efecto a la posición de su fader. */
  positionFromValue(id, value) {
    if (id === "rate") return this.rateToPosition(value);
    return value;
  }

  /** Texto del valor a mostrar; null = usar el formato genérico. */
  readoutFor(id, value) {
    if (id === "rate") return hzLabel(this.clampRate(value));
    return null;
  }
}