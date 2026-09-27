/* Conversión de Word (.docx) a PDF dentro del navegador.
 * Se renderiza el documento con docx-preview y cada página se captura con html2canvas.
 * El resultado es un PDF de imágenes: para máxima calidad conviene exportar a PDF desde Word.
 */
window.Word = (() => {
  const LIBS = [
    "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
    "https://cdn.jsdelivr.net/npm/docx-preview@0.3.6/dist/docx-preview.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
  ];
  let librerias = null;

  function cargarScript(src) {
    return new Promise((ok, mal) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = ok;
      s.onerror = () => mal(new Error(`No se pudo cargar ${src}`));
      document.head.appendChild(s);
    });
  }

  function cargarLibrerias() {
    if (!librerias) {
      librerias = LIBS.reduce((p, src) => p.then(() => cargarScript(src)), Promise.resolve()).catch((e) => {
        librerias = null;
        throw e;
      });
    }
    return librerias;
  }

  const PX_A_PT = 72 / 96;
  const ESCALA = 2; // ~192 ppp

  async function aPdf(arrayBuffer, alProgresar = () => {}) {
    alProgresar("Cargando conversor de Word…");
    await cargarLibrerias();

    const cont = document.createElement("div");
    cont.className = "docx-render";
    document.body.appendChild(cont);
    try {
      await window.docx.renderAsync(arrayBuffer, cont, null, {
        className: "docx",
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        useBase64URL: true,
        experimental: true,
      });
      if (document.fonts && document.fonts.ready) await document.fonts.ready;

      const secciones = [...cont.querySelectorAll("section.docx")];
      if (!secciones.length) throw new Error("El documento Word no tiene contenido.");

      const { PDFDocument } = PDFLib;
      const pdf = await PDFDocument.create();
      let n = 0;
      for (const sec of secciones) {
        n++;
        alProgresar(`Convirtiendo Word… página ${n} de ${secciones.length}`);
        const anchoPx = sec.offsetWidth;
        const altoPagPx = parseFloat(getComputedStyle(sec).minHeight) || anchoPx * 1.414;
        const lienzo = await window.html2canvas(sec, {
          scale: ESCALA,
          backgroundColor: "#ffffff",
          useCORS: true,
          logging: false,
        });
        // Si la sección ocupa más de una página (Word no guardó los saltos), se corta en trozos.
        const altoPagCanvas = Math.round(altoPagPx * ESCALA);
        const trozos = Math.max(1, Math.ceil((lienzo.height - 2) / altoPagCanvas));
        for (let t = 0; t < trozos; t++) {
          const c = document.createElement("canvas");
          c.width = lienzo.width;
          c.height = altoPagCanvas;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(lienzo, 0, -t * altoPagCanvas);
          const jpg = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.9));
          const img = await pdf.embedJpg(await jpg.arrayBuffer());
          const w = anchoPx * PX_A_PT;
          const h = altoPagPx * PX_A_PT;
          const pag = pdf.addPage([w, h]);
          pag.drawImage(img, { x: 0, y: 0, width: w, height: h });
        }
      }
      return await pdf.save();
    } finally {
      cont.remove();
    }
  }

  return { aPdf };
})();
