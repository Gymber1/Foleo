# Foleo Pro · Foliar PDF

Herramienta web para **foliar (numerar) documentos PDF y Word** directamente en el navegador.
Los archivos se procesan en tu equipo y no se suben a ningún servidor.

👉 **Úsala aquí:** https://gymber1.github.io/Foleo/

## Funciones

**Numeración**
- Orden: de la última página a la primera (foliado inverso) o de la primera a la última.
- Rango: foliar desde la página X hasta la página Y.
- Número inicial configurable.
- Solo páginas impares (anverso), solo pares o todas.
- Excluir páginas sueltas o rangos (`2, 5-7`).

**Texto del folio**
- Números arábigos, letras (A, B, C…) o romanos (I, II… / i, ii…), con ceros a la izquierda (01, 001…).
- Plantillas: `Folio {n}`, `Pág. {n} de {total}`, número en letras (`{letras}` → "veintiuno"),
  fecha (`{fecha}`), nombre del documento (`{doc}`) y varias líneas.

**Fuente (como en Word)**
- Más de 35 fuentes, incluidas equivalentes a Arial, Calibri, Cambria, Times New Roman y Courier New.
- Tamaño, **negrita**, *cursiva*, subrayado, color, opacidad, alineación e interlineado.
- Puedes subir tu propia fuente (.ttf/.otf) o usar las instaladas en tu PC (Chrome/Edge).

**Posición**
- Vista previa con zoom y navegación por páginas.
- 9 posiciones predefinidas con márgenes en cm, o posición libre haciendo clic/arrastrando sobre la vista previa.
- Rotación del texto (0°, 90°, 180°, 270°) y modo espejo para impresión a doble cara.
- Respeta páginas rotadas y recortadas.

**Recuadro**
- Rectángulo, rectángulo redondeado u óvalo, con grosor y color de borde, fondo de color y espacio interior.

**Archivos**
- PDF y Word (.docx). Varios archivos se unen en el orden elegido y se folian como uno solo.
- Vista previa en vivo de cada página tal como quedará.

> Los .docx se convierten a PDF dentro del navegador como imágenes. Para máxima calidad y texto
> seleccionable, exporta primero el Word a PDF (Archivo › Guardar como › PDF).

**Interfaz**
- Tema claro y oscuro, ayuda (?) en cada opción y diseño adaptado a laptops de 1366×768 y a móviles.

## Tecnología

HTML, CSS y JavaScript sin compilación. Usa [pdf-lib](https://pdf-lib.js.org/) para modificar el PDF,
[pdf.js](https://mozilla.github.io/pdf.js/) para la vista previa, fuentes de [Fontsource](https://fontsource.org/)
y [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) + html2canvas para los archivos de Word.

## Uso local

Abre `index.html` en el navegador (necesita internet para cargar las librerías y fuentes).
