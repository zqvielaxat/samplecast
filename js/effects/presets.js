/* =========================================================
   effects/presets.js — helpers COMPARTIDOS del mecanismo de presets

   Tanto el Multiband OTT como el Bitcrusher usan el MISMO mecanismo de presets:
     - El selector de la tarjeta es un parámetro `id: "preset"` en registry.js.
     - main.js ya sabe "espejar" la tarjeta (wirePresetSelector) cuando cambia de
       valor, y marcar "Personalizado" cuando movés un control a mano.
   Este archivo junta las piezas que repetiría cada efecto, para NO duplicarlas:
     - buildPresetOptions(): arma la lista del <select> (presets + "Personalizado").
     - applyPresetValues(): busca un preset y vuelca sus valores en el efecto.
     - markPresetCustom(): marca el selector como "Personalizado" tras un ajuste manual.
   ========================================================= */

// Valor que se muestra cuando movés un control y salís del preset elegido.
export const CUSTOM_PRESET = "custom";

/** lista de opciones del <select> de presets: una por preset + "Personalizado". */
export function buildPresetOptions(presets) {
  return [
    ...presets.map((preset) => ({ value: preset.id, label: preset.name })),
    { value: CUSTOM_PRESET, label: "Personalizado" },
  ];
}

/**
 * Aplica un preset a un efecto: copia `params` a `effect.values`, junta los
 * parámetros internos (si el preset los trae) sobre `internalDefaults`, y deja
 * `effect.presetId` apuntando al preset elegido. Devuelve el preset o null.
 */
export function applyPresetValues(effect, presets, id, internalDefaults = {}) {
  const preset = presets.find((item) => item.id === id);
  if (!preset) return null;
  effect.values = { ...preset.params };
  effect.internal = { ...internalDefaults, ...(preset.internal || {}) };
  effect.presetId = preset.id;
  return preset;
}

/** Marca el selector como "Personalizado" (el usuario tocó un control). */
export function markPresetCustom(effect) {
  effect.presetId = CUSTOM_PRESET;
}