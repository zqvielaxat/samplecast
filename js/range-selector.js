/* =========================================================
   range-selector.js — elegir un rango arrastrando sobre un <canvas>

   Es un pedacito de lógica COMPARTIDA por dos pantallas:
     - la forma de onda del sample (para marcar el LOOP),
     - la pantalla de la Grabadora (para elegir el RECORTE).

   QUÉ HACE: convierte la posición horizontal del mouse en una fracción (0 a 1),
   distingue un "clic" de un "arrastre" y va avisando con callbacks lo que pasa.

   CÓMO SE USA
   -----------
   createRangeSelector(canvas, {
     canStart:  () => boolean,       // ¿hay algo para seleccionar ahora?
     minPixels: 5,                   // menos de esto = clic; más = arrastre
     onStart:   (fraction) => {},    // al apoyar el mouse (opcional)
     onPreview: (start, end) => {},  // mientras se arrastra (start < end)
     onCommit:  (start, end) => {},  // al soltar, después de arrastrar
     onClick:   (fraction) => {},    // al soltar sin moverse (clic)
     onCancel:  () => {},            // si el arrastre se cancela (opcional)
   })

   Se captura el puntero con setPointerCapture: el arrastre sigue aunque el
   cursor se salga del canvas.
   ========================================================= */

export function createRangeSelector(canvas, options = {}) {
  const { canStart, minPixels = 5, onStart, onPreview, onCommit, onClick, onCancel } = options;

  let drag = null; // { from, to, moved, width }

  /** Fracción horizontal (0 a 1) de la posición del mouse dentro del canvas. */
  function fractionAt(event) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return null;
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  function onDown(event) {
    // Solo el botón PRINCIPAL puede empezar una selección. Así el clic derecho
    // (pre-escucha en la Grabadora) o el botón del medio no inician un arrastre
    // por accidente.
    if (event.button !== 0) return;
    if (typeof canStart === "function" && !canStart()) return;
    event.preventDefault();
    try { canvas.setPointerCapture(event.pointerId); } catch { /* puntero ya liberado */ }

    const fraction = fractionAt(event);
    if (fraction === null) return;

    drag = {
      from: fraction,
      to: fraction,
      moved: false,
      width: canvas.getBoundingClientRect().width,
    };

    if (onStart) onStart(fraction);
  }

  function onMove(event) {
    if (!drag) return;
    const fraction = fractionAt(event);
    if (fraction === null) return;
    if (Math.abs(fraction - drag.from) * drag.width > minPixels) drag.moved = true;
    drag.to = fraction;
    if (onPreview) onPreview(Math.min(drag.from, drag.to), Math.max(drag.from, drag.to));
  }

  function onUp(event) {
    if (!drag) return;
    const { from, to, moved } = drag;
    drag = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* ya se liberó */ }

    if (!moved) {
      if (onClick) onClick(from);
    } else if (onCommit) {
      onCommit(Math.min(from, to), Math.max(from, to));
    }
  }

  function onCancelEvent() {
    drag = null;
    if (onCancel) onCancel();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancelEvent);

  // Devuelve una función para desactivar el selector, si algún día hace falta.
  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onCancelEvent);
  };
}