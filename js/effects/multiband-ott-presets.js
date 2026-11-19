/* =========================================================
   multiband-ott-presets.js — DATOS de los presets del Multiband OTT

   Acá viven SOLO datos (una lista). No hay lógica: la lógica la hace
   multiband-ott.js, que lee esta lista cuando el usuario elige un preset.

   CÓMO AGREGAR UN PRESET NUEVO
   ----------------------------
   1) Copiá cualquiera de los objetos de abajo y pegalo en la lista.
   2) Cambiá su `id` (un texto único, sin espacios) y su `name` (lo que se ve).
   3) En `params` poné los 7 controles visibles con estos rangos:
        depth  0..100   (%)
        time   0..100   (%)
        low    -12..12  (dB)
        mid    -12..12  (dB)
        high   -12..12  (dB)
        out    -24..24  (dB)
        mix    0..100   (%)
   4) En `internal` podés ajustar los controles OCULTOS (no aparecen en la
      tarjeta, pero el preset los usa):
        up     0..4     multiplica la compresión ascendente (1 = normal)
        down   0..4     multiplica la compresión descendente (1 = normal)
        inv    0 | 1    1 = activa la "dinámica invertida"
      Si no ponés `internal`, el efecto usa up=1, down=1, inv=0.

   El selector de la tarjeta muestra una opción por cada preset (por el orden de
   esta lista) más una opción final "Personalizado" que aparece sola cuando movés
   cualquier control a mano.
   ========================================================= */

export const MULTIBAND_OTT_PRESETS = [
  {
    id: "neutro",
    name: "Neutro",
    // Criterio: no cambiar el sonido de forma audible. Depth 0 anula la
    // compresión; las ganancias por banda y la salida quedan en 0.
    params: { depth: 0, time: 50, low: 0, mid: 0, high: 0, out: 0, mix: 100 },
    internal: { up: 1, down: 1, inv: 0 },
  },
  {
    id: "ott-clasico",
    name: "OTT clásico",
    // Criterio: denso y brillante. Graves y agudos arriba, medios apenas
    // recortados (el "scoop" característico). Out -4 compensa la energía extra
    // que sube la compresión ascendente para no saltar de volumen vs. Neutro.
    params: { depth: 65, time: 50, low: 6, mid: -2, high: 6, out: -4, mix: 100 },
    internal: { up: 1, down: 1, inv: 0 },
  },
  {
    id: "filoso",
    name: "Filoso",
    // Criterio: muy poca dinámica (Depth alto) + agudos muy presentes + tiempos
    // rápidos (Time bajo). Out -6 compensa la llegada de agudos.
    params: { depth: 90, time: 15, low: 2, mid: 0, high: 8, out: -6, mix: 100 },
    internal: { up: 1, down: 1, inv: 0 },
  },
  {
    id: "levantar-suave",
    name: "Levantar lo suave",
    // Criterio: compresión ASCENDENTE fuerte (up 2.5) y DESCENDENTE leve
    // (down 0.6): suben los detalles y las colas de bajo volumen. Out -6 porque
    // subir lo suave también sube el nivel general.
    params: { depth: 70, time: 40, low: 3, mid: 3, high: 4, out: -6, mix: 100 },
    internal: { up: 2.5, down: 0.6, inv: 0 },
  },
  {
    id: "dinamica-invertida",
    name: "Dinámica invertida",
    // Criterio: lo fuerte pasa a sonar MÁS BAJO que lo suave (inv 1 = espejo).
    // Out +6 levanta el nivel general (el espejo tiende a dejarlo bajo) y el
    // limitador de salida frena cualquier pico que se pase de 0 dBFS.
    // Límites de seguridad de este preset: la ganancia por banda se recorta a
    // ±36 dB (INV_MAX_DB en el procesador), así la inversión cubre ~36 dB de
    // dinámica y lo que queda fuera se "achata" en vez de explotar.
    params: { depth: 100, time: 30, low: 0, mid: 0, high: 0, out: 6, mix: 100 },
    internal: { up: 1, down: 1, inv: 1 },
  },
  {
    id: "brillante",
    name: "Brillante",
    // Criterio: realza agudos y reduce medios para un sonido aireado. Compresión
    // moderada (Depth 50) para que no aplaste el brillo.
    params: { depth: 50, time: 45, low: 0, mid: -4, high: 8, out: -2, mix: 100 },
    internal: { up: 1, down: 1, inv: 0 },
  },
  {
    id: "oscuro",
    name: "Oscuro",
    // Criterio: reduce agudos y realza graves para un sonido cálido.
    params: { depth: 50, time: 45, low: 7, mid: -1, high: -6, out: -1, mix: 100 },
    internal: { up: 1, down: 1, inv: 0 },
  },
  {
    id: "suave-glue",
    name: "Suave (glue)",
    // Criterio: compresión LEVE (Depth 30) y LENTA (Time 80) que "pega" el
    // sonido sin cambiarle el carácter. Out -2 por la pequeña subida del RMS.
    params: { depth: 30, time: 80, low: 0, mid: 0, high: 0, out: -2, mix: 100 },
    internal: { up: 1, down: 1, inv: 0 },
  },
];