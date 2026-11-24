# samplecast

samplecast es un laboratorio donde podes cargar samples y atravez de cadenas nodales de efectos al estilo
patch bay velozmente crear variaciones y transmutar a nuevos sonidos. Seleccionar y slicear lo que quierasy donde quieras y descargargarlo como un sample pack.
subís -> experimentas -> sliceás -> descargas.

Está pensado como una herramienta practica e intuitiva para quienes quieran probar nuevos métodos de **creación de sonidos propios** y enriquecer sus librerías de samples. 
NO HACE FALTA INSTALAR NADA! :
 No hay frameworks, ni backend, ni paso de
compilación: es HTML, CSS y JavaScript puro (Web Audio API + Canvas 2D). Corre todo en la web

> ▶ **Probalo acá:** https://zqvielaxat.github.io/samplecast/

## Funciones


- **Efectos disponibles por el momento** : Freq Shift, Distortion, Binscrambler,
  Spectral Gate, Beat Repeater, Flanger, Multiband OTT y Bitcrusher.

## Codigo libre

- Samplecast es una herramienta de codigo libre pensada para seguir evolucionando y mutando a nuevas formas. el proximo paso es implementar nodos y funciones que trabajen con modelos de ia. Seguramente puedas ayudar! Tus ideas son bienvenidas para que el proyecto siga creciendo . ദ്ദി(˵ •̀ ᴗ - ˵ ) 
- el codigo esta todo comentado con explicaciones de la forma mas didactica posible, para que desarrolladores de todos los niveles puedar comprender la totalidad de sus funciones

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

## Privacidad

Los archivos de audio **se procesan completamente en tu navegador**: no se suben a
ningún servidor. No hay cuentas, ni seguimiento, ni analítica.

## Licencia

**MIT** — ver el archivo [`LICENSE`](LICENSE). Podés usar, modificar y redistribuir
libremente manteniendo el aviso de copyright.
