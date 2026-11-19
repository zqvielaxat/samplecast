/* =========================================================
   slider.js — faders (barras deslizantes) estilo Ableton Live

   El fader se controla SOLO con el movimiento HORIZONTAL del mouse:

     - Clic sobre el fader y mover hacia la DERECHA  → sube el valor.
     - Mover hacia la IZQUIERDA                      → baja el valor.
     - El movimiento VERTICAL se ignora por completo.

   Imaginá una línea horizontal con el 100 % a la derecha y el 0 % a la
   izquierda: el fader recorre esa escala según cuánto te movés hacia los
   costados. Al hacer clic el valor NO salta a la posición del cursor: arranca
   del valor que ya tenía y solo cambia cuando movés.

   EL CÁLCULO ES INCREMENTAL: en cada movimiento medimos cuánto se movió el mouse
   DESDE EL EVENTO ANTERIOR (no desde el clic) y lo sumamos al valor actual. Así,
   si seguís empujando más allá del 100 o del 0, ese "sobrante" no se acumula:
   apenas invertís la dirección, el valor empieza a cambiar de inmediato (porque
   siempre partimos del valor que ya está limitado por el control).

   Recorrer todo el rango lleva ~DRAG_TRAVEL píxeles de recorrido horizontal, así
   que un movimiento chico NO dispara el valor al extremo: se puede regular con
   precisión entre valores intermedios. La escala se convierte al rango de cada
   control (no todos van de 0 a 100), y el valor siempre queda dentro de su
   mínimo y máximo.

   Usamos Pointer Events con setPointerCapture (indispensable para pantallas
   táctiles) y, ADEMÁS, escuchamos el movimiento y el soltado en window: así el
   arrastre no se corta jamás, ni siquiera si el cursor se sale del fader, se va
   de la pantalla o el navegador no llega a capturar el puntero.

   Extras: Shift = ajuste fino · doble clic = valor por defecto · rueda = pasos ·
   flechas del teclado = funcionan nativas (el input conserva el foco).

   OJO: el contenedor del fader debe llevar data-no-drag (lo pone main.js), para
   que agarrar cerca de la barra NO arrastre el nodo entero.
   ========================================================= */

// Píxeles de recorrido HORIZONTAL necesarios para ir de mínimo a máximo.
// Más grande = hay que mover más el mouse (ajuste más controlado/preciso).
const DRAG_TRAVEL = 200;

// Con Shift, cuántas veces más hay que mover el mouse para el mismo cambio.
const FINE_FACTOR = 6;

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

  /** Cambia el valor y avisa a quien escuche el evento "input" (main.js). */
  function setValue(value) {
    if (value === Number(input.value)) return;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  let drag = null;

  const startDrag = (event) => {
    if (input.disabled) return;
    event.preventDefault(); // nosotros manejamos el arrastre, no el navegador
    input.focus();          // para que sigan andando las flechas del teclado

    // Capturamos el puntero: de acá en adelante los eventos de movimiento y de
    // soltado llegan A ESTE elemento, aunque el cursor se salga de la barra o
    // llegue al borde de la pantalla (y también en pantallas táctiles).
    try {
      input.setPointerCapture(event.pointerId);
    } catch {
      // El puntero ya se soltó (o es un evento de prueba): seguimos igual.
    }

    // Guardamos solo la última posición HORIZONTAL del mouse. El valor actual se
    // lee del propio input en cada movimiento (eso hace el cálculo "incremental").
    drag = { pointerId: event.pointerId, lastX: event.clientX };
  };

  const onMove = (event) => {
    if (!drag) return;
    const { min, max, step } = range();

    // Cuánto se movió HORIZONTALMENTE desde el evento anterior.
    const dx = event.clientX - drag.lastX; // positivo = derecha, negativo = izquierda
    drag.lastX = event.clientX;
    if (dx === 0) return;

    // dx / travel es la FRACCIÓN del rango que avanzamos en este movimiento.
    // Multiplicada por (max - min) convierte ese recorrido a la escala del
    // control (que no siempre va de 0 a 100). Con Shift, el mismo movimiento
    // produce un cambio más chico: ajuste fino.
    const travel = event.shiftKey ? DRAG_TRAVEL * FINE_FACTOR : DRAG_TRAVEL;
    const next = Number(input.value) + (dx / travel) * (max - min);

    setValue(snap(next, { min, max, step }));
  };

  const endDrag = (event) => {
    if (!drag) return;
    const pointerId = drag.pointerId;
    drag = null;
    try {
      input.releasePointerCapture(pointerId);
    } catch { /* ya se liberó */ }
  };

  // El "clic" se escucha en el input; el movimiento y el soltado, en window. Así
  // el arrastre sigue aunque el cursor salga de la barra o de la pantalla. Cada
  // fader registra su listener, pero solo actúa el que está siendo arrastrado
  // (el único con `drag` distinto de null).
  input.addEventListener("pointerdown", startDrag);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

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

