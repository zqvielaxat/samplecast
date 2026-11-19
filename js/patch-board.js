/* =========================================================
   patch-board.js — el "espacio infinito" donde viven los nodos

   Este archivo NO sabe nada de audio. Solo sabe de:
     - un MUNDO infinito que se puede recorrer (paneo) y acercar (zoom),
     - NODOS ubicados en coordenadas del mundo,
     - CABLES que conectan la salida de un nodo con la entrada de otro.

   CÓMO SE LOGRA QUE SEA INFINITO
   ------------------------------
   Hay dos capas:

     #board          → la ventana. Nunca se mueve. Recibe los clics del fondo.
     #board-world    → el mundo. Tiene una transformación CSS:
                            translate(view.x, view.y) scale(view.scale)
                       Los nodos están ubicados adentro con left/top en píxeles
                       de mundo, así que se mueven y se agrandan todos juntos.

   La cuenta que convierte mundo → pantalla (y al revés) es:
        pantalla = mundo * scale + view        mundo = (pantalla - view) / scale
   Es la MISMA cuenta que hace el navegador con el transform, por eso los
   cables dibujados a mano coinciden exactamente con los nodos.

   Los cables se dibujan en un <canvas> pegado a la pantalla (no dentro del
   mundo): así el grosor no cambia con el zoom y la línea queda nítida.

   REGLA DE ESTE ARCHIVO: los cables salen SIEMPRE de un puerto de salida y
   llegan al NODO destino (no hace falta apuntarle al puerto con precisión).
   Como es una cadena "en serie", cada nodo tiene una sola entrada y una sola
   salida: al conectar algo que ya estaba conectado, el cable viejo se reemplaza.
   ========================================================= */

// Límites del zoom y tolerancias del mouse (en píxeles de pantalla)
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.6;
const CLICK_TOLERANCE = 4;   // menos de esto = clic; más = arrastre
const WIRE_HIT = 11;         // distancia máxima para "tocar" un cable y borrarlo

// Todo lo que es un CONTROL dentro de un nodo: si el arrastre empieza ahí, el
// tablero no hace nada (lo deja trabajar al slider, a la perilla, al botón...).
// OJO: los <canvas> NO están en la lista a propósito, porque el analizador se
// arrastra agarrándolo de su gráfico. El canvas de la forma de onda, que sí es
// un control (se selecciona el loop ahí), lleva data-no-drag en el HTML.
const CONTROL_SELECTOR = "input, button, select, textarea, label, .knob, [data-no-drag]";

/** Convierte grados a radianes (Math usa radianes). */
const deg = (d) => (d * Math.PI) / 180;

/** Achica el tamaño del canvas a la ventana teniendo en cuenta la densidad de píxeles. */
function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const pxW = Math.max(1, Math.round(rect.width * dpr));
  const pxH = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;   // cambiar width/height borra el canvas
    canvas.height = pxH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // de acá en adelante dibujamos en píxeles CSS
  return { ctx, width: rect.width, height: rect.height };
}

/** Distancia de un punto a un segmento (para saber si el clic tocó un cable). */
function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  // Proyección del punto sobre la recta, recortada a 0..1 para quedarnos dentro del segmento
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export class PatchBoard {
  constructor({ board, world, wires }) {
    this.boardEl = board;      // la ventana
    this.worldEl = world;      // el mundo
    this.canvas = wires;       // capa de cables
    this.ctx = wires.getContext("2d");

    // Estado de la vista. Arranca un poco alejado (scale 0.75) para que se vean
    // el nodo principal y los efectos de alrededor.
    this.view = { x: 0, y: 0, scale: 0.75 };

    this.nodes = new Map();    // id → nodo
    this.wires = [];           // [{ from, to }]  (from = salida, to = entrada)
    this.drag = null;          // arrastre en curso: nodo, paneo o cable
    this.pointer = { x: 0, y: 0 };  // última posición del mouse, en pantalla
    this.dirty = true;         // ¿hay que redibujar los cables?
    this.tween = null;         // animación de la vista (la usa centerOn)

    this.onChange = null;      // main.js: "cambiaron las conexiones"
    this.onMessage = null;     // main.js: "mostrá este texto en la barra de estado"
    this.selected = new Set(); // ids de los nodos seleccionados (varios a la vez)
    this.selectRect = null;    // rectángulo de selección en curso (botón derecho)

    this._bindEvents();
    this.applyView();
  }

  /* ---------------- Nodos ---------------- */

  /**
   * Registra un nodo. `el` es su elemento HTML.
   * Opciones:
   *   x, y            → centro del nodo, en coordenadas del mundo
   *   rx, ry          → semi-anchos de la forma (círculo: rx = ry = radio).
   *                     Se usan para saber dónde apoyar los puertos sobre el borde.
   *   localCenter     → dónde cae el centro DENTRO del elemento (0,0 si el
   *                     elemento ya está centrado en su origen, como el nodo principal)
   *   canInput/Output → si tiene puerto de entrada y/o de salida
   *   angles          → ángulo "en reposo" de cada puerto, en grados
   *   draggable       → si se puede arrastrar (por defecto sí)
   *   locked / stage  → nodo de una etapa futura: no acepta conexiones
   */
  addNode(id, el, options = {}) {
    const node = {
      id,
      el,
      label: options.label ?? id,
      x: options.x ?? 0,
      y: options.y ?? 0,
      rx: options.rx ?? 60,
      ry: options.ry ?? 60,
      localCenter: options.localCenter ?? { x: 0, y: 0 },
      angles: options.angles ?? {},
      draggable: options.draggable !== false,
      locked: Boolean(options.locked),
      stage: options.stage ?? null,
      // Solo los nodos de efectos se pueden borrar: el principal y el analizador
      // quedan protegidos porque nunca marcan esta bandera.
      deletable: options.deletable === true,
      ports: { in: null, out: null },
    };

    el.dataset.node = id;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;

    if (options.canInput !== false) node.ports.in = this._createPort(node, "in");
    if (options.canOutput !== false) node.ports.out = this._createPort(node, "out");

    this.nodes.set(id, node);
    this.updatePorts();
    return node;
  }

  getNode(id) {
    return this.nodes.get(id) ?? null;
  }

  /** ¿Este nodo se puede seleccionar? Solo los efectos (borrables y movibles en grupo). */
  isSelectable(id) {
    const node = this.nodes.get(id);
    return Boolean(node && node.deletable);
  }

  /** Refresca la marquita visual de selección de un nodo según el conjunto. */
  _syncSelectionClass(id) {
    const node = this.nodes.get(id);
    if (node) node.el.classList.toggle("is-selected", this.selected.has(id));
  }

  /** Ids seleccionados (main.js lo usa para borrar todo el grupo con Supr). */
  getSelectedIds() {
    return [...this.selected];
  }

  /**
   * Selección ÚNICA: deja seleccionado solo `id` (o nada si es null / inválido).
   * El Shift+clic se maneja aparte con toggleSelect.
   */
  select(id) {
    for (const selId of this.selected) {
      if (selId === id) continue;
      const node = this.nodes.get(selId);
      if (node) node.el.classList.remove("is-selected");
    }
    this.selected.clear();

    if (id != null && this.isSelectable(id)) {
      this.selected.add(id);
      this._syncSelectionClass(id);
    }
    return this.selected.has(id) ? id : null;
  }

  /** Shift + clic: agrega o quita UN nodo, sin tocar a los demás. */
  toggleSelect(id) {
    if (id == null || !this.isSelectable(id)) return false;
    if (this.selected.has(id)) {
      this.selected.delete(id);
      this._syncSelectionClass(id);
      return false;
    }
    this.selected.add(id);
    this._syncSelectionClass(id);
    return true;
  }

  /** Quita TODA la selección (clic en el fondo). */
  clearSelection() {
    for (const selId of this.selected) {
      const node = this.nodes.get(selId);
      if (node) node.el.classList.remove("is-selected");
    }
    this.selected.clear();
  }

  /** Reemplaza la selección por los ids dados (la usa el rectángulo de selección). */
  setSelected(ids) {
    for (const selId of this.selected) {
      const node = this.nodes.get(selId);
      if (node) node.el.classList.remove("is-selected");
    }
    this.selected.clear();
    for (const id of ids) {
      if (this.isSelectable(id)) this.selected.add(id);
    }
    for (const id of this.selected) this._syncSelectionClass(id);
  }

  /**
   * Borra un nodo del tablero: saca sus cables, su elemento HTML y su registro.
   * NO llama a onChange a propósito: quien borra (main.js) rearma la cadena de
   * audio después, para hacerlo en el orden correcto.
   */
  removeNode(id) {
    const node = this.nodes.get(id);
    if (!node) return false;

    // 1) Fuera los cables que entran o salen de este nodo.
    this.wires = this.wires.filter((wire) => wire.from !== id && wire.to !== id);

    // 2) Fuera el elemento del DOM.
    node.el.remove();

    // 3) Fuera del registro del tablero.
    this.nodes.delete(id);

    // 4) Lo sacamos de la selección (si estaba seleccionado).
    this.selected.delete(id);

    this.updatePorts();
    this.dirty = true;
    return true;
  }

  /** Crea el circulito del puerto y lo mete dentro del elemento del nodo. */
  _createPort(node, kind) {
    const port = document.createElement("span");
    port.className = `port port-${kind}`;
    port.dataset.node = node.id;
    port.dataset.port = kind;
    node.el.appendChild(port);
    return port;
  }

  /* ---------------- Puertos ---------------- */

  /** Radio de la elipse (o círculo) en una dirección dada. */
  _shapeRadius(node, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return (node.rx * node.ry) / Math.hypot(node.ry * cos, node.rx * sin);
  }

  /**
   * Hacia dónde apunta un puerto. Es SIEMPRE el mismo lugar del nodo: por
   * defecto la entrada a la izquierda (180°) y la salida a la derecha (0°).
   * Los dos ángulos caen sobre el eje horizontal, así que ambos puertos quedan
   * a la MISMA ALTURA que el centro del nodo (ni más arriba ni más abajo).
   *
   * Antes el puerto "miraba" al nodo vecino, para que el cable tocara el borde
   * justo en dirección al otro nodo. El problema: al arrastrar un nodo, los
   * puertos de sus VECINOS giraban alrededor del círculo siguiendo al mouse, así
   * que los puntos de conexión se movían y costaba agarrarlos. Ahora quedan
   * clavados en su lugar y el cable simplemente sale y entra por ahí.
   */
  _portAngle(node, kind) {
    const fallback = kind === "in" ? 180 : 0;
    return deg(node.angles[kind] ?? fallback);
  }

  /** Posición de un puerto en coordenadas del mundo. */
  portWorldPosition(node, kind) {
    const angle = this._portAngle(node, kind);
    const r = this._shapeRadius(node, angle);
    return { x: node.x + r * Math.cos(angle), y: node.y + r * Math.sin(angle) };
  }

  /** Coloca cada puerto sobre el borde de su nodo. Se llama cuando algo se mueve o se conecta. */
  updatePorts() {
    for (const node of this.nodes.values()) {
      for (const kind of ["in", "out"]) {
        const port = node.ports[kind];
        if (!port) continue;
        const angle = this._portAngle(node, kind);
        const r = this._shapeRadius(node, angle);
        port.style.left = `${node.localCenter.x + r * Math.cos(angle)}px`;
        port.style.top = `${node.localCenter.y + r * Math.sin(angle)}px`;
      }
    }
  }

  /* ---------------- Vista (paneo y zoom) ---------------- */

  worldToScreen(x, y) {
    return { x: x * this.view.scale + this.view.x, y: y * this.view.scale + this.view.y };
  }

  screenToWorld(x, y) {
    return { x: (x - this.view.x) / this.view.scale, y: (y - this.view.y) / this.view.scale };
  }

  /** Aplica la vista al mundo y a la grilla del fondo. */
  applyView() {
    const { x, y, scale } = this.view;
    this.worldEl.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    // La grilla acompaña el paneo y el zoom: da la sensación de espacio sin fin.
    this.boardEl.style.backgroundPosition = `${x}px ${y}px`;
    this.boardEl.style.backgroundSize = `${30 * scale}px ${30 * scale}px`;
    this.dirty = true;
  }

  /**
   * Deja un nodo en el centro de la pantalla, con una animación suave.
   * Despejamos la fórmula: queremos pantallaCentro = nodo * scale + view,
   * entonces view = pantallaCentro - nodo * scale.
   */
  centerOn(id, { animate = true } = {}) {
    const node = this.nodes.get(id);
    if (!node) return;
    const rect = this.boardEl.getBoundingClientRect();
    const scale = this.view.scale;
    const target = {
      x: rect.width / 2 - node.x * scale,
      y: rect.height / 2 - node.y * scale,
      scale,
    };

    if (!animate) {
      this.view = target;
      this.applyView();
      return;
    }
    this.tween = { from: { ...this.view }, to: target, start: performance.now(), duration: 420 };
  }

  /* ---------------- Cables ---------------- */

  /** El cable que SALE de un nodo (recordá: en serie hay uno solo). */
  outputOf(id) {
    return this.wires.find((wire) => wire.from === id) ?? null;
  }

  /** El cable que LLEGA a un nodo. */
  inputOf(id) {
    return this.wires.find((wire) => wire.to === id) ?? null;
  }

  /** Manda un mensaje a la barra de estado (main.js decide qué hacer con él). */
  _say(text) {
    if (this.onMessage) this.onMessage(text);
    return false;
  }

  /**
   * Conecta la salida de `fromId` con la entrada de `toId`.
   * Devuelve true si se conectó. Antes de conectar revisa que tenga sentido.
   */
  connect(fromId, toId) {
    const from = this.nodes.get(fromId);
    const to = this.nodes.get(toId);

    if (!from || !to) return false;
    if (fromId === toId) return this._say("Un nodo no se puede conectar consigo mismo.");
    if (!from.ports.out) return this._say(`${from.label} no tiene salida.`);
    if (!to.ports.in) return this._say(`${to.label} no tiene entrada.`);
    if (to.locked) return this._say(`${to.label} se activa en la etapa ${to.stage}.`);

    // Antes de comprobar nada, sacamos los cables viejos: en serie, un nodo
    // tiene una sola entrada y una sola salida. Así "reconectar" = reemplazar.
    const previousOut = this.outputOf(fromId);
    const previousIn = this.inputOf(toId);
    if (previousOut) this._removeWire(previousOut);
    if (previousIn) this._removeWire(previousIn);

    if (this._createsCycle(fromId, toId)) {
      // Deshicimos un cable al pedo: lo restauramos para no dejar la cadena peor que antes.
      if (previousOut) this.wires.push(previousOut);
      if (previousIn) this.wires.push(previousIn);
      return this._say("Ese cable armaría un círculo: la señal no puede volver hacia atrás.");
    }

    this.wires.push({ from: fromId, to: toId });
    this._afterChange();
    return true;
  }

  /** ¿Conectar from→to haría un círculo? Se camina la cadena hacia adelante. */
  _createsCycle(fromId, toId) {
    const visited = new Set();
    let current = toId;
    while (current) {
      if (current === fromId) return true;    // volvimos al que empezó: es un círculo
      if (visited.has(current)) return true;  // por las dudas
      visited.add(current);
      const wire = this.outputOf(current);
      current = wire ? wire.to : null;
    }
    return false;
  }

  /** Saca un cable de la lista (sin avisar todavía). */
  _removeWire(wire) {
    const index = this.wires.indexOf(wire);
    if (index >= 0) this.wires.splice(index, 1);
  }

  /** Borra un cable y avisa que la cadena cambió. */
  removeWire(wire) {
    this._removeWire(wire);
    this._afterChange();
    return true;
  }

  /**
   * Devuelve los ids de los efectos que forman la cadena, en orden:
   * se arranca en el nodo principal y se sigue el cable hasta que se corta.
   * Ejemplo: main → bin-scrambler → freq-shift  ⇒  ["bin-scrambler", "freq-shift"]
   *
   * Los nodos SIN salida (la Grabadora) se SALTAN: son "oídos" que escuchan,
   * no eslabones de la cadena. Por eso la caminata termina al encontrarlos.
   */
  chainFromMain() {
    const chain = [];
    const visited = new Set(["main"]);
    let current = "main";
    while (true) {
      const wire = this.outputOf(current);
      if (!wire || visited.has(wire.to)) break;
      visited.add(wire.to);

      const next = this.nodes.get(wire.to);
      if (!next || !next.ports.out) break;   // nodo tap: la cadena termina acá

      chain.push(wire.to);
      current = wire.to;
    }
    return chain;
  }

  /** Después de cualquier cambio: reubicar puertos, redibujar y avisar. */
  _afterChange() {
    this.updatePorts();
    this.dirty = true;
    if (this.onChange) this.onChange();
  }

  /** Busca el cable que pasa cerca de un punto de la pantalla (para borrarlo con un clic). */
  wireAt(screenX, screenY) {
    const point = { x: screenX, y: screenY };
    for (const wire of this.wires) {
      const a = this._screenPort(wire.from, "out");
      const b = this._screenPort(wire.to, "in");
      if (!a || !b) continue;
      if (distanceToSegment(point, a, b) <= WIRE_HIT) return wire;
    }
    return null;
  }

  /** Posición en pantalla de un puerto (atajo para dibujar). */
  _screenPort(nodeId, kind) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    const world = this.portWorldPosition(node, kind);
    return this.worldToScreen(world.x, world.y);
  }

  /* ---------------- Dibujo de los cables ---------------- */

  /** Dibuja todos los cables (y el cable "elástico" mientras arrastramos uno nuevo). */
  render() {
    const { ctx, width, height } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = "round";

    for (const wire of this.wires) {
      const a = this._screenPort(wire.from, "out");
      const b = this._screenPort(wire.to, "in");
      if (!a || !b) continue;
      ctx.setLineDash([]);
      ctx.strokeStyle = "#16161a";
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Cable que estamos por conectar: sale del puerto y sigue al mouse
    if (this.drag && this.drag.type === "link") {
      const a = this._screenPort(this.drag.fromId, "out");
      if (a) {
        ctx.strokeStyle = "#17e33c";
        ctx.lineWidth = 2.4;
        ctx.setLineDash([7, 6]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(this.pointer.x, this.pointer.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Rectángulo de selección (botón derecho): marco punteado translúcido.
    if (this.selectRect) {
      const x = Math.min(this.selectRect.x0, this.selectRect.x1);
      const y = Math.min(this.selectRect.y0, this.selectRect.y1);
      const w = Math.abs(this.selectRect.x1 - this.selectRect.x0);
      const h = Math.abs(this.selectRect.y1 - this.selectRect.y0);
      ctx.fillStyle = "rgba(23, 227, 60, 0.10)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#17e33c";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  }

  /**
   * Se llama UNA vez por cuadro desde main.js (el bucle de animación).
   * Solo redibuja si algo cambió: así no gastamos trabajo al pedo.
   */
  update() {
    if (this.tween) this._stepTween();
    if (this.dirty) {
      this.render();
      this.dirty = false;
    }
  }

  /** Avanza la animación de la vista (ease-out: rápido al principio, suave al final). */
  _stepTween() {
    const t = Math.min(1, (performance.now() - this.tween.start) / this.tween.duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const { from, to } = this.tween;
    this.view.x = from.x + (to.x - from.x) * eased;
    this.view.y = from.y + (to.y - from.y) * eased;
    this.applyView();
    if (t >= 1) this.tween = null;
  }

  /* ---------------- Interacción ---------------- */

  _bindEvents() {
    const el = this.boardEl;
    el.addEventListener("pointerdown", (event) => this._onPointerDown(event));
    el.addEventListener("pointermove", (event) => this._onPointerMove(event));
    el.addEventListener("pointerup", (event) => this._onPointerUp(event));
    el.addEventListener("pointercancel", (event) => this._onPointerUp(event));
    // wheel con passive:false para poder frenar el scroll/zoom del navegador
    el.addEventListener("wheel", (event) => this._onWheel(event), { passive: false });
    window.addEventListener("resize", () => { this.dirty = true; });
    // El botón derecho lo usamos para la selección rectangular: no queremos
    // que aparezca el menú contextual del navegador.
    el.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  /** Devuelve el id del nodo que está justo debajo de un punto de la pantalla. */
  _nodeIdAt(x, y) {
    const element = document.elementFromPoint(x, y);
    return element?.closest?.("[data-node]")?.dataset.node ?? null;
  }

  _onPointerDown(event) {
    this.pointer = { x: event.clientX, y: event.clientY };

    // Botón DERECHO: arrastrar dibuja la selección rectangular. Shift + arrastre
    // suma a lo ya elegido. El menú contextual se anula en _bindEvents.
    if (event.button === 2) {
      event.preventDefault();
      this._capture(event);
      this.drag = {
        type: "select",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        shift: event.shiftKey,
      };
      this.selectRect = {
        x0: event.clientX,
        y0: event.clientY,
        x1: event.clientX,
        y1: event.clientY,
      };
      this.dirty = true;
      return;
    }

    // 1) ¿Tocamos un puerto? → empezamos a tender (o a mover) un cable
    const port = event.target.closest?.(".port");
    if (port) {
      event.preventDefault();
      this._capture(event);

      const nodeId = port.dataset.node;
      const kind = port.classList.contains("port-in") ? "in" : "out";

      // Si este puerto ya tenía un cable, lo "desenchufamos" para moverlo:
      // lo sacamos de la lista (deja de dibujarse) y lo guardamos por si el
      // destino del arrastre no sirve y hay que devolverlo.
      const wire = kind === "in" ? this.inputOf(nodeId) : this.outputOf(nodeId);
      if (wire) this._removeWire(wire);

      // De qué nodo sale el cable elástico:
      //   - de un puerto de SALIDA → de este mismo nodo;
      //   - de un puerto de ENTRADA que tenía cable → del ORIGEN de ese cable
      //     (es como sacar la ficha y llevarla a otro lado);
      //   - de un puerto de ENTRADA sin cable → de este nodo (comportamiento de antes).
      const fromId = kind === "in" && wire ? wire.from : nodeId;

      this.drag = {
        type: "link",
        fromId,
        pointerId: event.pointerId,
        detached: wire ?? null,   // el cable que sacamos, si sacamos alguno
      };
      this.dirty = true;
      return;
    }

    const nodeEl = event.target.closest?.("[data-node]");
    const onControl = event.target.closest?.(CONTROL_SELECTOR);

    // 2) ¿Tocamos un control (slider, perilla, botón, la forma de onda)? → no hacemos
    //    nada. Si siguiéramos, le robaríamos el arrastre al control.
    if (onControl) return;

    // 3) ¿Tocamos el cuerpo de un nodo? → seleccionamos y/o arrastramos.
    if (nodeEl) {
      const node = this.nodes.get(nodeEl.dataset.node);
      if (node) {
        // Shift + clic = agregar/quitar este nodo de la selección, sin arrastrar.
        if (event.shiftKey) {
          event.preventDefault();
          this.toggleSelect(node.id);
          return;
        }
        // Clic normal: si el nodo ya estaba en una selección múltiple, la
        // mantenemos y movemos TODO el grupo; si no, lo dejamos solo a él.
        if (!(this.selected.size > 1 && this.selected.has(node.id))) {
          this.select(node.id);
        }
        if (node.draggable) {
          event.preventDefault();
          this._capture(event);
          // Posiciones iniciales de CADA nodo del grupo, para moverlos juntos.
          const items = [];
          for (const id of this.selected) {
            const n = this.nodes.get(id);
            if (n && n.draggable) items.push({ id, x0: n.x, y0: n.y });
          }
          if (items.length === 0) items.push({ id: node.id, x0: node.x, y0: node.y });
          this.drag = {
            type: "node",
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            items,
            moved: false,
          };
          return;
        }
      }
    }

    // 4) Fondo → paneo (y un clic sin Shift quita la selección).
    if (!event.shiftKey) this.clearSelection();
    event.preventDefault();
    this._capture(event);
    this.drag = {
      type: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: this.view.x,
      viewY: this.view.y,
      moved: false,
    };
    this.boardEl.classList.add("is-panning");
  }

  /** Le pide al navegador que nos mande TODOS los movimientos del mouse hasta que lo suelten. */
  _capture(event) {
    try {
      this.boardEl.setPointerCapture(event.pointerId);
    } catch {
      // El puntero ya se soltó (o es un evento de prueba): seguimos igual.
    }
  }

  _onPointerMove(event) {
    this.pointer = { x: event.clientX, y: event.clientY };
    if (!this.drag) return;

    // --- Paneo: movemos la vista con el mouse ---
    if (this.drag.type === "pan") {
      const dx = event.clientX - this.drag.startX;
      const dy = event.clientY - this.drag.startY;
      if (Math.hypot(dx, dy) > CLICK_TOLERANCE) this.drag.moved = true;
      this.view.x = this.drag.viewX + dx;
      this.view.y = this.drag.viewY + dy;
      this.applyView();
      return;
    }

    // --- Arrastre de nodo(s): movemos todo el grupo seleccionado a la vez ---
    if (this.drag.type === "node") {
      const dxScreen = event.clientX - this.drag.startX;
      const dyScreen = event.clientY - this.drag.startY;
      if (Math.hypot(dxScreen, dyScreen) > CLICK_TOLERANCE) this.drag.moved = true;
      const dxWorld = dxScreen / this.view.scale; // dividimos por el zoom
      const dyWorld = dyScreen / this.view.scale;
      for (const item of this.drag.items) {
        const node = this.nodes.get(item.id);
        if (!node) continue;
        node.x = item.x0 + dxWorld;
        node.y = item.y0 + dyWorld;
        node.el.style.left = `${node.x}px`;
        node.el.style.top = `${node.y}px`;
      }
      this.updatePorts();
      this.dirty = true;
      return;
    }

    // --- Selección rectangular en curso: actualizamos la esquina del marco ---
    if (this.drag.type === "select") {
      if (!this.selectRect) return;
      this.selectRect.x1 = event.clientX;
      this.selectRect.y1 = event.clientY;
      this.dirty = true;
      return;
    }

    // --- Cable en el aire: resaltamos el nodo que está debajo del mouse ---
    if (this.drag.type === "link") {
      this._highlightTarget(this._nodeIdAt(event.clientX, event.clientY));
      this.dirty = true;
    }
  }

  _onPointerUp(event) {
    const drag = this.drag;
    this.drag = null;
    this.boardEl.classList.remove("is-panning");
    if (!drag) return;
    try { this.boardEl.releasePointerCapture(event.pointerId); } catch { /* ya se liberó */ }

    // Soltamos la selección rectangular: elegimos qué nodos quedan adentro.
    if (drag.type === "select") {
      this._finishRectSelection(drag);
      this.dirty = true;
      return;
    }

    // Clic sin arrastre sobre el fondo: ¿tocó un cable? Entonces lo borramos.
    if (drag.type === "pan" && !drag.moved) {
      const wire = this.wireAt(event.clientX, event.clientY);
      if (wire) this.removeWire(wire);
    }

    // Soltamos el cable: conectamos con el nodo que esté debajo del mouse.
    if (drag.type === "link") {
      const targetId = this._nodeIdAt(event.clientX, event.clientY);
      this._highlightTarget(null);

      if (targetId) {
        const ok = this.connect(drag.fromId, targetId);
        // Si el destino era inválido (mismo nodo, círculo, sin puerto) y
        // habíamos desenchufado un cable viejo, lo devolvemos.
        if (!ok && drag.detached) this.wires.push(drag.detached);
      }
      // Avisamos el cambio siempre: si se soltó en el aire, la conexión quedó
      // desconectada (ese es el gesto para "desenchufar"); si se conectó o se
      // restauró, idem. connect() ya avisó por su cuenta, repetirlo no molesta.
      this._afterChange();
      this.dirty = true;
    }
  }

  /** Termina la selección rectangular: elige los nodos con centro dentro del marco. */
  _finishRectSelection(drag) {
    const rect = this.selectRect;
    this.selectRect = null;
    if (!rect) return;

    const x0 = Math.min(rect.x0, rect.x1);
    const x1 = Math.max(rect.x0, rect.x1);
    const y0 = Math.min(rect.y0, rect.y1);
    const y1 = Math.max(rect.y0, rect.y1);

    // Fue un clic derecho sin arrastrar (marco casi nulo): no elegimos nada.
    if (x1 - x0 < 3 && y1 - y0 < 3) {
      if (!drag.shift) this.clearSelection();
      return;
    }

    const ids = [];
    for (const node of this.nodes.values()) {
      if (!node.deletable) continue;
      const p = this.worldToScreen(node.x, node.y);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) ids.push(node.id);
    }

    if (drag.shift) {
      // Shift = sumar al grupo actual.
      for (const id of ids) {
        if (this.isSelectable(id)) this.selected.add(id);
      }
      for (const id of this.selected) this._syncSelectionClass(id);
    } else {
      this.setSelected(ids);
    }
  }

  /** Pinta el puerto de entrada del nodo que está debajo del mouse mientras llevamos un cable. */
  _highlightTarget(nodeId) {
    for (const node of this.nodes.values()) {
      if (!node.ports.in) continue;
      const isTarget = nodeId !== null && node.id === nodeId && node.id !== this.drag?.fromId;
      node.ports.in.classList.toggle("is-target", isTarget);
    }
  }

  _onWheel(event) {
    // Si el mouse está sobre un control (un fader, una perilla, un botón), la
    // rueda es del control: no hacemos zoom (el fader la usa para moverse).
    if (event.target.closest?.(CONTROL_SELECTOR)) return;

    event.preventDefault();
    // Guardamos qué punto del mundo está bajo el cursor antes de cambiar el zoom
    const before = this.screenToWorld(event.clientX, event.clientY);
    const factor = Math.exp(-event.deltaY * 0.0016);
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.view.scale * factor));
    this.view.scale = scale;
    // Volvemos a ubicar la vista para que ESE punto siga bajo el cursor:
    //   mundo = (pantalla - view) / scale   ⇒   view = pantalla - mundo * scale
    this.view.x = event.clientX - before.x * scale;
    this.view.y = event.clientY - before.y * scale;
    this.applyView();
  }
}