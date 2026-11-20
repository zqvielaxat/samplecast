# Sample Lab

Un laboratorio de audio que corre **100 % en el navegador**. Cargás un sample, lo
hacés sonar y lo pasás por una cadena de efectos que armás **arrastrando cables**
en un tablero infinito, como un patch bay real.

No hay instalación, ni frameworks, ni backend, ni paso de compilación: es HTML,
CSS y JavaScript puro (Web Audio API + Canvas 2D).

> ⚠️ Para usar la app hace falta **un servidor local** (los `AudioWorklet` no
> funcionan abriendo `index.html` con doble clic / `file://`). Ver más abajo.

---

## La interfaz

- **Tablero infinito**: un espacio con grilla que se recorre arrastrando el fondo
  y se acerca/aleja con la rueda del mouse. Botón para volver al centro.
- **Nodo principal ("UR SAMPLE")**: la píldora con la **forma de onda** (un clic
  salta a esa posición; un **arrastre marca el loop**, que se enciende solo), los
  controles de **transporte** (reproducir, reiniciar, loop), el **volumen** y los
  datos del archivo.
- **Nodos de efectos**: tarjetas redondas con perillas, listas desplegables,
  faders y dos **puertos** (entrada ◯ arriba-izquierda, salida abajo-derecha).
- **Cables**: arrastrá de un puerto a otro nodo para conectar; **arrastrá un
  cable al aire para desconectarlo** (o hacé clic sobre él).
- **Analizador de espectro**: un nodo más, que se arrastra y se pliega en una
  pestaña horizontal con el botón ◀.
- **HUD**: la barra de estado (arriba) cuenta qué está pasando y qué cadena está
  activa.

> 🖼️ *(Capturas pendientes: podés agregarlas con `![descripción](ruta/imagen.png)`.)*

---

## Funciones

- Cargar **WAV / MP3 / OGG** (mono o estéreo, de cualquier duración).
- Transporte: reproducir, pausar, reiniciar, saltar, **loop** por arrastre sobre
  la onda (al marcar el inicio, la reproducción salta ahí).
- Volumen general (fader estilo Ableton: clic, arrastre horizontal/vertical,
  rueda y doble clic para el valor por defecto).
- Analizador FFT en tiempo real, movible y plegable.
- **Grabadora**: graba lo que le llega y lo descarga como **WAV**.
- Cadena de efectos arbitraria (el orden lo definen los cables).

---

## Efectos

| Efecto | Qué hace | Parámetros |
|---|---|---|
| **Freq Shift** | Corre todas las frecuencias una cantidad fija de Hz → sonido metálico. | Desplazamiento (Hz), Dry/Wet |
| **Distortion** | Aplasta la onda muestra por muestra (dominio del tiempo) → armónicos nuevos. | Drive, Tipo (soft/hard/wavefolder), Tono, Nivel (dB), Dry/Wet |
| **Binscrambler** | Reordena los "bins" de la FFT → texturas glitchy. | Intensidad, Velocidad, Dry/Wet |
| **Spectral Gate** | Apaga las frecuencias débiles (una puerta de ruido por frecuencia). | Umbral (dBFS), Intensidad, Dry/Wet |
| **Beat Repeater** | Congela el último fragmento y lo repite en bucle (stutter). | Paso (ms), Gate, Decay, Dry/Wet |
| **Grabadora** | Nodo solo-entrada: graba y descarga un WAV (no corta la señal). | Grabar / Parar / Descargar |
---

## Cómo ejecutarlo en local

Necesitás un servidor local (no sirve abrir `index.html` con doble clic). Cualquiera
de estas opciones anda:

```bash
python -m http.server 8000
# o con Node
npx serve .
```

Después abrí **http://localhost:8000** en el navegador.

**¿Por qué no sirve `file://`?** Los efectos que usan `AudioWorklet` se cargan
como módulos que el navegador solo permite servir desde un **origen seguro**
(`http://localhost` lo es). Si abrís el archivo directo, esos efectos avisan por
consola y la app sigue andando (la Distortion, que usa nodos nativos, funciona).

## Navegadores soportados

- **Chrome / Edge 90+** (completo, recomendado).
- **Firefox 90+** (completo).
- **Safari 14.1+** (Web Audio API + AudioWorklet; probar la descarga del WAV).

## Formato de exportación del audio

La Grabadora descarga un **WAV de 16 bits PCM**, **canales intercalados**, a la
frecuencia de muestreo del `AudioContext` y con los mismos canales que la entrada.
Ese WAV se puede volver a cargar en Sample Lab con "Cargar sample".

---

## Cómo publicarlo con GitHub Pages

1. Subí el proyecto a GitHub. **`index.html` debe quedar en la raíz** del repo
   (o en `docs/`): `css/` y `js/` al lado.
2. **Settings → Pages → Deploy from a branch** → rama `main`, carpeta `/ (root)`.
3. Las rutas ya son **relativas** (`css/style.css`, `import.meta.url`), así que
   funciona igual en un subdirectorio o en la raíz del dominio.
4. Los `AudioWorklet` necesitan **HTTPS** (GitHub Pages ya lo da).

---

## Estructura de archivos

```
index.html              esqueleto (sin lógica)
css/style.css           estilos
js/
  main.js               interfaz
  audio-engine.js       grafo + escuchas
  transport.js          reproducción y loop
  patch-board.js        nodos, cables, vista
  visualizer.js         onda y espectro
  knob.js / slider.js   controles
  wav.js                codificador WAV
  effects/
    registry.js         catálogo
    frequency-shift.js  (+ processor)
    distortion.js
    bin-scrambler.js    (+ processor)
    spectral-gate.js    (+ processor)
    beat-repeater.js    (+ processor)
    recorder.js         (+ processor)
```

## Limitaciones conocidas

- El **zoom** es con la rueda del mouse; no hay gesto de pellizco táctil.
- El **Beat Repeater** no se sincroniza al tempo del sample ni a la posición
  del transporte (arranca cuando lo conectás).
- La **Grabadora** tiene un tope de **60 s** por toma y graba antes del volumen.
- La **Distortion** usa `oversample="4x"`: menos aliasing, más CPU.
