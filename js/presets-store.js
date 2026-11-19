/* =========================================================
   presets-store.js — guardado de PRESETS DE CADENAS (localStorage)

   Este archivo NO toca el DOM ni el audio: solo lee/escribe datos y los valida.
   Toda la lógica recibe un objeto `storage` (en el navegador es localStorage; en
   los tests es un almacén en memoria), así se puede probar sin navegador.

   FORMATO GUARDADO (una sola clave):
       "samplecast:presets"  →  { version: 1, presets: [ {id, name, factory, createdAt, chain}, ... ] }

   `chain` describe una cadena de efectos EN SERIE (el ORDEN es la conexión):
       chain: [
         { type: "bitcrusher", params: {bits:1.5, rate:12000, ...}, presetId?: "custom", internal?: {...}, x: 720, y: 0 },
         ...
       ]
   O sea: main → chain[0] → chain[1] → ... → salida. `x`/`y` son las posiciones
   relativas de cada nodo dentro del mundo.

   Los presets de FÁBRICA NO se guardan acá: viven en FACTORY_PRESETS (código).
   Lo que se guarda en localStorage son SOLO los presets del usuario.
   ========================================================= */

// Prefijo propio + versión del formato.
// - El prefijo evita chocar con otras claves del mismo dominio (localStorage se
//   comparte entre TODAS las páginas del sitio).
// - La versión permite migrar el formato en el futuro sin romper lo ya guardado.
export const STORAGE_KEY = "samplecast:presets";
export const FORMAT_VERSION = 1;

/* =========================================================
   PRESETS DE FÁBRICA (los 3 iniciales, definidos en código)
   ========================================================= */

export const FACTORY_PRESETS = [
  {
    id: "factory:noisero",
    name: "noisero",
    factory: true,
    createdAt: 0,
    chain: [
      {
        type: "bitcrusher",
        presetId: "custom",
        params: { bits: 1.5, rate: 12000, out: 0, mix: 100 },
        x: 720, y: 0,
      },
      {
        type: "multiband-ott",
        presetId: "filoso",
        params: { depth: 90, time: 15, low: 2, mid: 0, high: 8, out: -6, mix: 100 },
        internal: { up: 1, down: 1, inv: 0 },
        x: 1160, y: 0,
      },
      {
        type: "distortion",
        params: { drive: 100, type: "fold", tone: 100, level: 6, mix: 100 },
        x: 1600, y: 0,
      },
    ],
  },
  {
    id: "factory:alien01",
    name: "alien01",
    factory: true,
    createdAt: 0,
    chain: [
      {
        type: "spectral-gate",
        params: { threshold: -36, amount: 100, mix: 100 },
        x: 720, y: 0,
      },
      {
        type: "flanger",
        params: { rate: 0.05, depth: 2.5, feedback: 62, mix: 100 },
        x: 1160, y: 0,
      },
      {
        type: "frequency-shift",
        params: { shift: 500, mix: 36 },
        x: 1600, y: 0,
      },
      {
        type: "multiband-ott",
        presetId: "dinamica-invertida",
        params: { depth: 100, time: 30, low: 0, mid: 0, high: 0, out: 6, mix: 100 },
        internal: { up: 1, down: 1, inv: 1 },
        x: 2040, y: 0,
      },
    ],
  },
  {
    id: "factory:Alien02",
    name: "Alien02",
    factory: true,
    createdAt: 0,
    chain: [
      {
        type: "bin-scrambler",
        params: { amount: 100, rate: 51, mix: 41 },
        x: 720, y: 0,
      },
      {
        type: "flanger",
        params: { rate: 0.05, depth: 0, feedback: 100, mix: 100 },
        x: 1160, y: 0,
      },
      {
        type: "multiband-ott",
        presetId: "suave-glue",
        params: { depth: 30, time: 80, low: 0, mid: 0, high: 0, out: -2, mix: 100 },
        internal: { up: 1, down: 1, inv: 0 },
        x: 1600, y: 0,
      },
    ],
  },
];

/* =========================================================
   Utilidades internas
   ========================================================= */

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Convierte a número (o un respaldo si no lo es). */
function cleanNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

let _warnedRead = false;   // para avisar UNA sola vez por sesión
let _warnedWrite = false;

/** Avisa en consola una sola vez: evita spamear si el problema se repite. */
function warnOnce(kind, message) {
  if (kind === "read" && _warnedRead) return;
  if (kind === "write" && _warnedWrite) return;
  if (kind === "read") _warnedRead = true;
  else _warnedWrite = true;
  console.warn(message);
}

/* =========================================================
   Migración por versión
   =========================================================
   Sirve para que, si mañana cambia el formato guardado, la app pueda leer datos
   viejos y convertirlos sin que el usuario pierda nada. Hoy hay UNA sola versión,
   así que el bucle no hace nada; cuando exista la v2 se agrega acá el paso
   "v1 → v2" y el bucle lo aplica automáticamente. */

function migratePayload(payload, header = "") {
  if (!isPlainObject(payload)) throw new Error(header + "estructura inválida");

  let { version, presets } = payload;
  if (typeof version !== "number") throw new Error(header + "sin versión de formato");
  if (version > FORMAT_VERSION) throw new Error(header + "formato más nuevo del que entendemos");

  while (version < FORMAT_VERSION) {
    // Paso de una versión a la siguiente. Hoy no hay migraciones reales:
    // en el futuro acá se haría presets = migrarDe(version, presets).
    version += 1;
  }
  return { version, presets: Array.isArray(presets) ? presets : [] };
}

/**
 * Convierte un preset crudo (leído del storage o de un archivo) en un preset
 * limpio y seguro, o devuelve null si la estructura NO es válida. NUNCA lanza.
 */
function sanitizeUserPreset(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (!Array.isArray(raw.chain) || raw.chain.length === 0) return null;

  const chain = [];
  for (const node of raw.chain) {
    if (!isPlainObject(node)) return null;
    if (typeof node.type !== "string" || !node.type) return null;

    const clean = {
      type: node.type,
      params: isPlainObject(node.params) ? { ...node.params } : {},
      x: cleanNumber(node.x, 0),
      y: cleanNumber(node.y, 0),
    };
    if (typeof node.presetId === "string") clean.presetId = node.presetId;
    if (isPlainObject(node.internal)) clean.internal = { ...node.internal };
    chain.push(clean);
  }

  return {
    id: raw.id,
    name: raw.name.trim(),
    factory: false,              // lo guardado es SIEMPRE del usuario
    createdAt: cleanNumber(raw.createdAt, 0),
    chain,
  };
}

/* =========================================================
   Lectura
   ========================================================= */

/**
 * Lee y valida los presets del usuario. Si el JSON está corrupto o la estructura
 * es inesperada, NO lanza y NO borra nada: devuelve [] (sin presets de usuario)
 * y avisa en consola una sola vez. La app sigue con los de fábrica.
 */
export function readUserPresets(storage) {
  try {
    const text = storage.getItem(STORAGE_KEY);
    if (text == null) return [];   // no hay nada guardado todavía

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      warnOnce("read", "samplecast:presets → JSON corrupto: se ignoran los presets guardados.");
      return [];
    }

    const migrated = migratePayload(payload, "samplecast:presets → ");

    const presets = [];
    for (const raw of migrated.presets) {
      const clean = sanitizeUserPreset(raw);
      if (clean) presets.push(clean);
    }

    if (presets.length !== migrated.presets.length) {
      warnOnce("read", "samplecast:presets → se ignoraron presets con estructura inválida.");
    }
    return presets;
  } catch (error) {
    warnOnce("read", `samplecast:presets → no se pudo leer (${error && error.message ? error.message : error}).`);
    return [];
  }
}

/* =========================================================
   Escritura
   ========================================================= */

/** Escribe la lista completa. Devuelve false si el navegador no lo permite. */
export function writeUserPresets(storage, presets) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: FORMAT_VERSION, presets }));
    return true;
  } catch (error) {
    warnOnce("write", "samplecast:presets → no se pudo guardar (¿modo privado, cuota llena o permisos?).");
    return false;
  }
}

/* =========================================================
   Operaciones persistentes
   =========================================================
   Antes de ESCRIBIR, todas vuelven a LEER lo guardado y combinan el cambio,
   para no pisar lo que haya agregado Otra pestaña abierta al mismo tiempo. */

export function persistAddPreset(storage, preset) {
  const current = readUserPresets(storage);
  const list = current.filter((p) => p.id !== preset.id);
  list.push(preset);
  const ok = writeUserPresets(storage, list);
  return { ok, presets: ok ? list : null };
}

export function persistRemovePreset(storage, id) {
  const current = readUserPresets(storage);
  const list = current.filter((p) => p.id !== id);
  const ok = writeUserPresets(storage, list);
  return { ok, presets: ok ? list : null };
}

export function persistRenamePreset(storage, id, name) {
  const current = readUserPresets(storage);
  const list = current.map((p) => (p.id === id ? { ...p, name } : p));
  const ok = writeUserPresets(storage, list);
  return { ok, presets: ok ? list : null };
}

/** Suma presets (de un archivo) a los que ya hay. No borra nada existente. */
export function persistImportPresets(storage, incoming) {
  const current = readUserPresets(storage);
  const merged = [...current];
  let added = 0;
  for (const preset of incoming) {
    if (merged.some((existing) => existing.id === preset.id)) continue; // ya estaba
    merged.push(preset);
    added += 1;
  }
  const ok = writeUserPresets(storage, merged);
  return { ok, presets: ok ? merged : null, added };
}

/* =========================================================
   Exportar / importar (archivo .json)
   ========================================================= */

/**
 * Interpreta el contenido de un archivo importado. Acepta tanto el formato
 * completo ({ version, presets }) como una lista suelta ([...]).
 * Devuelve { ok, presets } o { ok:false, reason } si no es válido.
 */
export function parseImportPayload(text) {
  try {
    const parsed = JSON.parse(text);

    let rawPresets;
    if (Array.isArray(parsed)) rawPresets = parsed;
    else rawPresets = migratePayload(parsed).presets;

    const presets = [];
    for (const raw of rawPresets) {
      const clean = sanitizeUserPreset(raw);
      if (clean) presets.push(clean);
    }
    return { ok: true, presets };
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : "archivo inválido" };
  }
}

/* =========================================================
   Ayudas varias
   ========================================================= */

/**
 * Filtra una cadena dejando SOLO los tipos de nodo conocidos. Devuelve además la
 * lista de tipos omitidos (porque ya no existen), para avisar en la interfaz sin
 * romper el resto de la cadena.
 */
export function filterChainByKnownTypes(chain, knownTypes = []) {
  const known = new Set(knownTypes);
  const kept = [];
  const skipped = [];
  for (const node of chain || []) {
    if (node && typeof node.type === "string" && known.has(node.type)) kept.push(node);
    else skipped.push(node && node.type ? node.type : "(desconocido)");
  }
  return { chain: kept, skipped };
}

/** Un id único para presets nuevos del usuario. */
export function makeUserId() {
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Un localStorage simulado (solo en memoria). Sirve de respaldo cuando el
 * navegador bloquea localStorage y para las pruebas automáticas sin navegador.
 */
export function createMemoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}