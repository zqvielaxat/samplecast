/* =========================================================
   slider.js — faders (barras deslizantes) estilo Ableton Live

   PROBLEMA: un <input type="range"> pelado se agarra mal. La barra es finita, el
   pulgar es chico y si el clic cae un poco al costado (o el mouse se sale de la
   barra mientras arrastrás), el valor no acompaña: terminás haciendo varios
   clics para ir de un extremo al otro.

   SOLUCIÓN: nos quedamos con el <input> (sigue siendo accesible y funciona con
   el teclado), pero le damos un manejo propio:

     - Clic en CUALQUIER punto de la barra → el valor salta justo ahí.
     - Arrastre HORIZONTAL → el valor sigue al mouse (absoluto, como un slider).
     - Arrastre VERTICAL   → ajuste fino relativo: subir = más, bajar = menos
       (recorrer todo el rango en ~190 píxeles de altura, como las perillas).
     - Rueda del mouse → sube/baja de a un paso.
     - Doble clic → vuelve al valor con el que nació la barra.
     - Teclado (flechas, Home, End) → funciona nativo porque el input conserva el foco.

   TRUCO CLAVE: durante el arrastre escuchamos los movimientos en `window`, NO en
   el input. Así no importa que el mouse se salga de la barra (ni del nodo): el
   arrastre sigue hasta que soltás el botón. Es lo que hace que se sienta "suelto".

   OJO: el contenedor del fader debe llevar data-no-drag (lo pone main.js), para
   que agarrar cerca de la barra NO arrastre el nodo entero.
   ========================================================= */

// Píxeles de arrastre vertical necesarios para recorrer todo el rango.
const DRAG_TRAVEL = 190;

/**
 * Hace que un <input type="range"> responda a un clic y a un arrastre fluidos.
 * Se puede llamar sobre el mismo input más de una vez sin problema.
 */
export function enableFader(input) {
  if (input.dataset.faderReady === "yes") return; // ya lo preparamos antes
  input.dataset.faderReady = "yes";

  const defaultValue = Number(input.value); // al que vuelve el doble clic

  /** min / max / step del input, ya convertidos a número. */
  function range() {
    return {
      min: Number(input.min || 0),
      max: Number(input.max || 100),
      step: Number(input.step || 1),
    };
  }

  /** Redondea al paso y recorta al rango. */
  function snap(raw, { min, max, step }) {
    return Math.min(max, Math.max(min, Math.round(raw / step) * step));
  }

  /** 0 = borde izquierdo, 1 = borde derecho (null si la barra no se ve). */
  function fractionAtX(clientX) {
    const rect = input.getBoundingClientRect();
    if (rect.width === 0) return null;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  /** Cambia el valor y avisa a quien escuche el evento "input" (main.js). */
  function setValue(value) {
    if (value === Number(input.value)) return;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  let drag = null;

  const startDrag = (event) => {
    if (input.disabled) return;
    event.preventDefault(); // nos quedamos con el arrastre nosotros
    input.focus();          // para que sigan andando las flechas del teclado

    const { min, max, step } = range();
    const fraction = fractionAtX(event.clientX);
    if (fraction === null) return;

    const startValue = min + fraction * (max - min);
    drag = {
      startX: event.clientX,
      startY: event.clientY,
      startValue,
      min,
      max,
      step,
    };

    // Un clic ya salta al punto tocado (y de ahí sigue el arrastre si no soltás).
    setValue(snap(startValue, { min, max, step }));

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  };

  const onMove = (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const { min, max, step } = drag;

    let raw;
    if (Math.abs(dx) >= Math.abs(dy)) {
      // Dominante horizontal: el valor sigue la posición del mouse (absoluto).
      const fraction = fractionAtX(event.clientX);
      if (fraction === null) return;
      raw = min + fraction * (max - min);
    } else {
      // Dominante vertical: ajuste fino relativo (arriba = más).
      raw = drag.startValue + (drag.startY - event.clientY) * (max - min) / DRAG_TRAVEL;
    }

    setValue(snap(raw, { min, max, step }));
  };

  const endDrag = () => {
    drag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
  };

  input.addEventListener("pointerdown", startDrag);

  // Rueda: un paso por "clic" (shift = pasos grandes). Evitamos que la página
  // (o el tablero) haga scroll/zoom a la vez.
  input.addEventListener("wheel", (event) => {
    event.preventDefault();
    const { min, max, step } = range();
    const jump = event.shiftKey ? step * 10 : step;
    const direction = event.deltaY < 0 ? 1 : -1;
    setValue(snap(Number(input.value) + direction * jump, { min, max, step }));
  }, { passive: false });

  // Doble clic = valor por defecto.
  input.addEventListener("dblclick", () => setValue(defaultValue));
}

