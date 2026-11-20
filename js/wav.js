/* =========================================================
   wav.js — codificador WAV (16 bits PCM)

   Convierte una lista de canales (Float32Array, valores entre −1 y 1) en un
   archivo WAV listo para descargar. Es el mismo formato que entienden todos los
   reproductores y que Sample Lab puede volver a cargar con "Cargar sample".

   FORMATO DEL WAV
   ---------------
   Un WAV es una cabecera de 44 bytes seguida de los datos de audio crudos.
   La cabecera tiene tres pedazos:
     - "RIFF"  → identifica el contenedor
     - "fmt "  → describe el audio (PCM, canales, frecuencia, bits por muestra)
     - "data"  → los bytes de audio, CANALES INTERCALADOS (muestra0-izq,
                 muestra0-der, muestra1-izq, ...)
   Guardamos 16 bits por muestra (int16) porque es lo estándar y pesa la mitad
   que el float de 32 bits.
   ========================================================= */

/** Escribe una cadena ASCII (4 letras) en el DataView. */
function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * channels = [Float32Array, ...] (uno por canal, todos del mismo largo).
 * sampleRate = frecuencia de muestreo (Hz), por ejemplo 48000.
 * Devuelve un Blob con tipo audio/wav.
 */
export function encodeWav(channels, sampleRate) {
  const channelCount = channels.length;
  const frameCount = channelCount > 0 ? channels[0].length : 0;
  const bytesPerSample = 2;                                       // 16 bits
  const dataSize = frameCount * channelCount * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);                        // tamaño total (todo menos los primeros 8 bytes)
  writeString(view, 8, "WAVE");

  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);                                  // tamaño de este bloque
  view.setUint16(20, 1, true);                                   // 1 = PCM (sin compresión)
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true); // bytes por segundo
  view.setUint16(32, channelCount * bytesPerSample, true);       // bytes por "cuadro" (una muestra de todos los canales)
  view.setUint16(34, 16, true);                                  // bits por muestra

  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Intercalamos los canales y pasamos de float (−1..1) a int16, con recorte.
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let ch = 0; ch < channelCount; ch++) {
      let sample = channels[ch][frame];
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);                        // little-endian
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}
