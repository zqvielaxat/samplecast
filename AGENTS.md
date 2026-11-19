# AGENTS.md — reglas de samplecast

Instrucciones para cualquier agente (o persona) que trabaje en este proyecto.

## Qué es
samplecast es un laboratorio de audio en el navegador: se carga un sample, se
reproduce y se pasa por una cadena de efectos que se arma arrastrando cables en
un tablero infinito. Es 100 % HTML, CSS y JavaScript puro.

## Reglas de arquitectura
- **Sin frameworks, sin backend, sin paso de compilación.** Nada de npm, bundlers
  ni `node_modules`. Todo se sirve tal cual (solo hace falta un servidor local).
- **Web Audio API** para el audio y **Canvas 2D** para los dibujos.
- Módulos ES (`import`/`export`) desde `js/main.js` (el único punto de entrada,
  cargado con `type="module"` desde `index.html`).
- Responsabilidades (no cruzar):
  - `main.js` → interfaz: une el HTML, el tablero, el motor y los efectos.
  - `audio-engine.js` → el grafo de audio y el orden de la cadena (incluye las
    *escuchas* para efectos que necesitan oír sin estar conectados).
  - `transport.js` → reproducción y loop. **Una sola fuente de verdad para la
    posición: `Transport.getPosition()`.** Nadie más calcula posiciones.
  - `patch-board.js` → el espacio infinito, los nodos, los puertos y los cables.
  - `visualizer.js` → forma de onda y espectro (solo LEE datos, nunca cambia audio).
  - `knob.js` (perillas) y `slider.js` (faders estilo Ableton) → controles.
  - `effects/registry.js` → catálogo de nodos (es la fuente de verdad de qué
    controles muestra cada tarjeta).
- **Un efecto = una entrada en `registry.js` + una clase en `js/effects/` y, si
  usa AudioWorklet, su `-processor.js`.** La URL del procesador siempre se
  resuelve con `new URL("./x-processor.js", import.meta.url)`.

## Convenciones de código
- **Comentarios en español** que expliquen CÓMO y POR QUÉ funciona cada cosa
  (es un proyecto de aprendizaje).
- **El usuario es principiante**: después de cada cambio, explicar los conceptos
  nuevos que aparecieron (en el resumen, no solo en el código).
- **Cambios incrementales.** No implementar funciones de etapas futuras sin que
  lo pidan explícitamente.
- **Nombres de archivo en minúscula** y **rutas relativas** (`./carpeta/archivo.js`).
  Nada de rutas absolutas ni que empiecen con `/`: así funciona igual en Windows,
  en un servidor Linux y en GitHub Pages (los sistemas Linux distinguen mayúsculas).
- Los nombres de parámetros del catálogo coinciden con los `id` que espera la
  clase (`values`); el `id` `"mix"` es siempre el fader Dry/Wet.
- Los cambios de parámetros en vivo se suavizan con `setTargetAtTime` (nada de
  saltos que produzcan clics); los encendidos/apagados usan fundidos cortos.

## Audio
- Los **AudioWorklet requieren un servidor local** (`http://localhost`, origen
  seguro). Abrir `index.html` con `file://` NO funciona: los efectos espectrales
  y el Beat Repeater no cargan (la consola muestra un tip con esta advertencia).
- La cadena es **en serie** y la decide el tablero. Los nodos que no tienen
  salida (por ejemplo la Grabadora) son **taps**: reciben la salida del nodo del
  que cuelgan, sin cortar la señal.
- Los efectos que necesitan escuchar el pasado (Beat Repeater) marcan
  `monitors = true` para recibir audio aunque estén fuera de la cadena.

## Antes de dar algo por terminado
- Consola del navegador **sin errores**.
- Si se tocó audio: correr el banco de pruebas headless (Chrome + OfflineAudioContext)
  que está en `%TEMP%\samplecast-check` y asegurarse de que quedan **0 fallas**.
- Verificar que no se rompió ninguna ruta relativa ni el nombre de un archivo.
