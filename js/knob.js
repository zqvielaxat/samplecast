/* =========================================================
   knob.js — la perilla (control giratorio) de los nodos de efectos

   Una perilla es un control que se gira. Con el mouse NO la giramos en círculo
   (es incómodo): la convención de los programas de audio es arrastrar hacia
   ARRIBA para subir el valor y hacia ABAJO para bajarlo. El dibujo de la rayita
   acompaña el valor para que se vea de un vistazo dónde está parada.

   Detalles que hacen que se sienta bien:
     - El arrastre es "relativo": guardamos el valor al empezar y calculamos
       cuánto cambió. Así no importa dónde la agarraste dentro de la perilla.
     - Igual que la de un equipo de audio real, recorre todo el rango en unos
       190 píxeles de movimiento: se puede ajustar con precisión.
     - El elemento tiene role="slider": para el navegador (y para un lector de
       pantalla) es un control de verdad, con sus flechas, Home y End.
   ========================================================= */

// Cuánto gira la rayita, en grados, hacia cada lado (el total es 280°)
const ANGLE_RANGE = 140;
// Píxeles de arrastre vertical necesarios para recorrer todo el rango
const DRAG_TRAVEL = 190;

/**
 * Crea una perilla.
 *   min, max, step → rango y precisión (igual que un <input type="range">)
 *   value          → valor inicial (y al que vuelve con doble clic)
 *   label          → nombre accesible ("Desplazamiento (Hz)")
 *   onChange(v)    → se llama cada vez que el valor cambia
 *   disabled       → si está bloqueada (etapa futura)
 * Devuelve { el, setValue, getValue }.
 */
export function createKnob({ min, max, step = 1, value, label = "", onChange = () => {}, disabled = false }) {
  const el = document.createElement("div");
  el.className = "knob";
  el.tabIndex = 0;
  el.dataset.noDrag = "";        // el tablero no debe arrastrar el nodo cuando agarramos la perilla
  el.setAttribute("role", "slider");
  el.setAttribute("aria-label", label);
  el.setAttribute("aria-valuemin", String(min));
  el.setAttribute("aria-valuemax", String(max));

  const indicator = document.createElement("span");
  indicator.className = "knob-indicator";
  el.appendChild(indicator);

  let current = snap(value);
  let drag = null;

  /** Redondea al paso y recorta al rango (no se puede pasar del máximo). */
  function snap(valueToSnap) {
    const steps = Math.round(valueToSnap / step);
    return Math.min(max, Math.max(min, steps * step));
  }

  /** Redibuja la rayita según el valor actual. */
  function refresh() {
    const range = max - min || 1;
    const fraction = (current - min) / range;                  // 0 = mínimo, 1 = máximo
    const angle = (fraction - 0.5) * 2 * ANGLE_RANGE;          // centrado: 0° = medio
    indicator.style.transform = `rotate(${angle}deg)`;
    el.setAttribute("aria-valuenow", String(current));
  }

  /** Cambia el valor. notify=false sirve para fijarlo sin avisar a nadie. */
  function setValue(next, notify = true) {
    const snapped = snap(next);
    if (snapped === current) {
      refresh();
      return;
    }
    current = snapped;
    refresh();
    if (notify) onChange(current);
  }

  /* ---------- Arrastrar con el mouse (o el dedo) ---------- */
  el.addEventListener("pointerdown", (event) => {
    if (disabled) return;
    event.preventDefault();
    try { el.setPointerCapture(event.pointerId); } catch { /* puntero ya liberado */ }
    // Guardamos el punto de partida: el movimiento será relativo a esto.
    drag = { startY: event.clientY, startValue: current };
  });

  el.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const movedUp = drag.startY - event.clientY;               // positivo = el mouse subió
    const fraction = movedUp / DRAG_TRAVEL;                    // cuánto del rango recorrimos
    setValue(drag.startValue + fraction * (max - min));
  });

  const endDrag = () => { drag = null; };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);

  /* ---------- Teclado (sin mouse también se puede) ---------- */
  el.addEventListener("keydown", (event) => {
    if (disabled) return;
    const jump = event.shiftKey ? step * 10 : step;            // Shift = pasos grandes
    if (event.key === "ArrowUp" || event.key === "ArrowRight") setValue(current + jump);
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") setValue(current - jump);
    else if (event.key === "Home") setValue(min);
    else if (event.key === "End") setValue(max);
    else return;
    event.preventDefault();
  });

  // Doble clic = volver al valor con el que nació la perilla
  el.addEventListener("dblclick", () => setValue(value));

  if (disabled) {
    el.classList.add("is-disabled");
    el.setAttribute("aria-disabled", "true");
    el.tabIndex = -1;
  }

  refresh();

  return {
    el,
    setValue: (next) => setValue(next, false),
    getValue: () => current,
  };
}