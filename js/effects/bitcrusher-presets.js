/* =========================================================
   bitcrusher-presets.js — DATOS de los presets del Bitcrusher

   Igual que los del Multiband OTT: solo DATOS (una lista), sin lógica. La
   lógica la hace bitcrusher.js, que lee esta lista cuando elegís un preset.

   CÓMO AGREGAR UN PRESET NUEVO
   ----------------------------
   1) Copiá un objeto de abajo y pegalo en la lista.
   2) Cambiá `id` (texto único) y `name` (lo que se ve en la tarjeta).
   3) Poné estos 4 valores visibles:
        bits   1..16        (16 = sin cuantizar)
        rate   en Hz, > 0   (192000 = "al máximo", se ajusta a la frecuencia real)
        out    -24..24 dB
        mix    0..100 %
   El selector muestra una opción por preset (en este orden) más "Personalizado".

   IMPORTANTE SOBRE EL VOLUMEN: el bitcrusher no SUMA ganancia (solo recorta
   bits/rate), así que los presets no cambian el volumen general de golpe. Solo
   "Destruido" lleva un leve -3 dB para suavizar el borde áspero de tan pocos
   niveles.
   ========================================================= */

export const BITCRUSHER_PRESETS = [
  {
    id: "neutro",
    name: "Neutro",
    // Transparente: 16 bits (sin cuantizar audible) y rate al máximo.
    // 192000 es un "truco" que significa "al máximo": como supera a cualquier
    // frecuencia de muestreo real (44.1k / 48k), el efecto lo frena al máximo.
    params: { bits: 16, rate: 192000, out: 0, mix: 100 },
  },
  {
    id: "lofi-suave",
    name: "Lo-fi suave",
    // Aspereza leve: bajar a 12 bits y un rate alto (32 kHz) "envejece" sin romper.
    params: { bits: 12, rate: 32000, out: 0, mix: 100 },
  },
  {
    id: "sampler-12bits",
    name: "Sampler vintage 12 bits",
    // Carácter de los samplers de los 80/90: 12 bits y ~26 kHz (AKAI/SP1200).
    params: { bits: 12, rate: 26000, out: 0, mix: 100 },
  },
  {
    id: "retro-8bits",
    name: "Retro 8 bits",
    // Sonido de consola vieja: 8 bits y 22050 Hz (la mitad de 44.1 kHz).
    params: { bits: 8, rate: 22050, out: 0, mix: 100 },
  },
  {
    id: "radio-telefono",
    name: "Radio / teléfono",
    // Ancho de banda muy reducido: pocos bits y 8 kHz, como una llamada/AM.
    params: { bits: 6, rate: 8000, out: 0, mix: 100 },
  },
  {
    id: "destruido",
    name: "Destruido",
    // Extremo: 3 bits y 1500 Hz. El -3 dB de salida suaviza el filo tan áspero.
    params: { bits: 3, rate: 1500, out: -3, mix: 100 },
  },
];