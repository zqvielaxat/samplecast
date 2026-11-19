# samplecast

Un laboratorio de audio que corre **100 % en el navegador**. Cargás un sample, lo
reproducís y lo pasás por una cadena de efectos que armás **arrastrando cables**
en un tablero infinito, como un patch bay real. También grabás el resultado y lo
descargás como WAV.

Está pensado para quien quiera **jugar y aprender** con audio sin instalar nada:
músicos, curiosos, estudiantes. No hay frameworks, ni backend, ni paso de
compilación: es HTML, CSS y JavaScript puro (Web Audio API + Canvas 2D).

> ▶ **Probalo acá:** _(enlace de la versión publicada — se completa al final)_

## Funciones

- **Cargar** WAV / MP3 / OGG (mono o estéreo) y reproducirlo con transporte
  (play, pausa, reiniciar, saltar) y control de **volumen**.
- **Loop por arrastre** sobre la forma de onda.
- **Grabadora**: graba lo que le llega, lo muestra como onda y lo **descarga como WAV**.
- **Recorte (cut)**: elegís inicio y fin sobre la grabación y descargás solo ese trozo.
- **Slices**: detección automática de cortes (ataques) para partir la grabación y
  **descargar un pack** de WAV (uno por slice).
- **Cadena de efectos** conectable con cables: Freq Shift, Distortion, Binscrambler,
  Spectral Gate, Beat Repeater, Flanger, Multiband OTT y Bitcrusher.
- **Presets**: cadenas listas (de fábrica) y presets propios guardados **en tu navegador**.
- **Espacio infinito** con zoom/paneo y **analizador de espectro** en tiempo real.

## La interfaz

- **Nodo principal "UR SAMPLE"**: la píldora con la forma de onda (clic = saltar,
  arrastre = marcar loop) y los controles de transporte y volumen.
- **Nodos de efectos**: tarjetas redondas con perillas, listas y faders, con un
  puerto de entrada (◯) y uno de salida.
- **Cables**: arrastrá de un puerto a otro nodo para conectar; arrastrá al aire o
  hacé clic sobre un cable para desconectarlo.
- **Barra lateral**: catálogo de efectos, **presets** (fábrica + los tuyos) y **Info**.
- **Selección múltiple**: con el **botón derecho** (rectángulo) o **Shift + clic**,
  para mover o borrar varios nodos juntos (tecla **Supr**).

## Navegadores soportados

- **Chrome / Edge** (completo, recomendado).
- **Firefox** (completo).
- **Safari 14.1+** (Web Audio + AudioWorklet; probar la descarga de WAV).

## Limitaciones conocidas

- Los **presets propios se guardan en el navegador** (`localStorage`): no se
  sincronizan entre dispositivos. Se pueden **exportar/importar** como `.json`.
- La **descarga del "pack" de slices** son varios WAV individuales; el navegador
  puede pedir permiso por cada descarga.
- El **zoom** se hace con la rueda del mouse (no hay gesto de pellizco táctil).
- El **Beat Repeater** no se sincroniza al tempo ni a la posición del transporte.
- La **Grabadora** tiene un tope de 60 s por toma.

## Formato de exportación

La Grabadora descarga un **WAV de 16 bits PCM**, canales intercalados, a la
frecuencia de muestreo del `AudioContext`. Ese WAV se puede volver a cargar con
"Cargar sample".

## Cómo ejecutarlo en local

Hace falta un **servidor local** (los módulos JS y los `AudioWorklet` no se cargan
abriendo `index.html` con doble clic / `file://`):

```bash
python -m http.server 8000
# o con Node
npx serve .
```

Después abrí `http://localhost:8000`.

## Cómo publicarlo con GitHub Pages

1. Subí el proyecto a GitHub. **`index.html` debe quedar en la raíz** del repo.
2. **Settings → Pages → Deploy from a branch** → rama `main`, carpeta `/ (root)`.
3. Las rutas ya son relativas y los `AudioWorklet` usan `import.meta.url`, así que
   funciona igual bajo un subdirectorio o en la raíz del dominio.

## Privacidad

Los archivos de audio **se procesan completamente en tu navegador**: no se suben a
ningún servidor. No hay cuentas, ni seguimiento, ni analítica.

## Licencia

**MIT** — ver el archivo [`LICENSE`](LICENSE). Podés usar, modificar y redistribuir
libremente manteniendo el aviso de copyright.