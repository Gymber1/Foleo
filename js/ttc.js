/* Colecciones TrueType (.ttc): Windows guarda varias fuentes en un solo archivo
 * (p. ej. cambria.ttc = Cambria + Cambria Math). pdf-lib solo sabe incrustar una
 * fuente suelta, así que aquí se extrae la fuente pedida como un .ttf/.otf independiente.
 */
(function (raiz) {
  const TTCF = 0x74746366; // 'ttcf'

  function esColeccion(buffer) {
    return buffer.byteLength > 12 && new DataView(buffer).getUint32(0) === TTCF;
  }

  // indice: posición de la fuente dentro de la colección
  function extraer(buffer, indice = 0) {
    if (!esColeccion(buffer)) return buffer;
    const dv = new DataView(buffer);
    const cantidad = dv.getUint32(8);
    if (indice < 0 || indice >= cantidad) indice = 0;
    const inicio = dv.getUint32(12 + 4 * indice);
    const numTablas = dv.getUint16(inicio + 4);
    const cabecera = 12 + 16 * numTablas;

    const tablas = [];
    let total = cabecera;
    for (let t = 0; t < numTablas; t++) {
      const registro = inicio + 12 + 16 * t;
      const offset = dv.getUint32(registro + 8);
      const largo = dv.getUint32(registro + 12);
      tablas.push({ registro, offset, largo });
      total += (largo + 3) & ~3; // cada tabla alineada a 4 bytes
    }

    const salida = new Uint8Array(total);
    const sdv = new DataView(salida.buffer);
    salida.set(new Uint8Array(buffer, inicio, 12), 0);
    let pos = cabecera;
    tablas.forEach(({ registro, offset, largo }, t) => {
      salida.set(new Uint8Array(buffer, registro, 16), 12 + 16 * t);
      sdv.setUint32(12 + 16 * t + 8, pos);
      salida.set(new Uint8Array(buffer, offset, largo), pos);
      pos += (largo + 3) & ~3;
    });
    return salida.buffer;
  }

  raiz.TTC = { esColeccion, extraer };
})(typeof window !== "undefined" ? window : globalThis);
