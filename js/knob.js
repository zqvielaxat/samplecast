/* =========================================================
   knob.js — la perilla (control giratorio) de los nodos de efectos

   Una perilla es un control que se gira. Con el mouse NO la giramos en círculo
   (es incómodo): la convención de los programas de audio es arrastrar hacia
   ARRIBA para subir el valor y hacia ABAJO para bajarlo (se mueve en el eje Y).
   El dibujo de la rayita acompaña el valor para que se vea de un vistazo dónde
   está parada.

   EL CÁLCULO ES INCREMENTAL: en cada movimiento medimos cuánto se movió el mouse
   DESDE EL EVENTO ANTERIOR y lo sumamos al valor actual. Así, si te pasás del
   máximo o del mínimo, el sobrante no se acumula: al invertir la dirección, la
   perilla reacciona de inmediato.

   Recorrer todo el rango lleva ~DRAG_TRAVEL píxeles de movimiento vertical, así
   que se puede ajustar con precisión. Con Shift, el mismo movimiento produce un
   cambio más chico (ajuste fino).

   Usamos Pointer Events con setPointerCapture y escuchamos el movimiento en
   window: el arrastre no se corta aunque el cursor salga de la perilla o de la
   pantalla, y funciona en pantallas táctiles. El elemento tiene role="slider":
   para el navegador (y un lector de pantalla) es un control de verdad, con sus
   flechas, Home y End.
   ========================================================= */

// Cuánto gira la rayita, en grados, hacia cada lado (el total es 280°)
const ANGLE_RANGE = 140;
// Píxeles de arrastre vertical necesarios para recorrer todo el rango
const DRAG_TRAVEL = 190;
// Con Shift, cuántas veces más hay que mover el mouse para el mismo cambio.
const FINE_FACTOR = 6;

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
    // Capturamos el puntero: en pantallas táctiles el arrastre sigue aunque el
    // dedo se salga de la perilla. Para el mouse, además escuchamos en window.
    try { el.setPointerCapture(event.pointerId); } catch { /* puntero ya liberado */ }
    // Guardamos solo la última altura: el cálculo es incremental (ver onMove).
    drag = { pointerId: event.pointerId, lastY: event.clientY };
  });

  const onMove = (event) => {
    if (!drag) return;
    // Cuánto se movió VERTICALMENTE desde el evento anterior.
    const dy = drag.lastY - event.clientY;               // positivo = el mouse subió
    drag.lastY = event.clientY;
    if (dy === 0) return;
    // dy / travel es la FRACCIÓN del rango que avanzamos. Con Shift, más fino.
    const travel = event.shiftKey ? DRAG_TRAVEL * FINE_FACTOR : DRAG_TRAVEL;
    setValue(current + (dy / travel) * (max - min));
  };

  const endDrag = (event) => {
    if (!drag) return;
    const pointerId = drag.pointerId;
    drag = null;
    try { el.releasePointerCapture(pointerId); } catch { /* ya se liberó */ }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

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