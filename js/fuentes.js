/* Catálogo de fuentes disponibles para el folio.
 * - "std": fuentes estándar del PDF (no se descargan).
 * - Resto: fuentes libres servidas por Fontsource (jsDelivr) en formato TTF.
 */
window.Fuentes = (() => {
  const GRUPOS = {
    std: "Estándar del PDF (sin descarga)",
    word: "Equivalentes a las de Word",
    sans: "Sans serif",
    serif: "Serif",
    mono: "Monoespaciadas",
    deco: "Manuscritas y decorativas",
    mias: "Tus fuentes",
  };

  const lista = [
    {
      id: "std-helvetica",
      nombre: "Helvetica",
      nota: "≈ Arial",
      grupo: "std",
      css: "Helvetica, Arial, sans-serif",
      std: { n: "Helvetica", b: "HelveticaBold", i: "HelveticaOblique", bi: "HelveticaBoldOblique" },
    },
    {
      id: "std-times",
      nombre: "Times Roman",
      nota: "≈ Times New Roman",
      grupo: "std",
      css: '"Times New Roman", Times, serif',
      std: { n: "TimesRoman", b: "TimesRomanBold", i: "TimesRomanItalic", bi: "TimesRomanBoldItalic" },
    },
    {
      id: "std-courier",
      nombre: "Courier",
      nota: "≈ Courier New",
      grupo: "std",
      css: '"Courier New", Courier, monospace',
      std: { n: "Courier", b: "CourierBold", i: "CourierOblique", bi: "CourierBoldOblique" },
    },
  ];

  // [id de Fontsource, nombre, grupo, tiene negrita, tiene cursiva, nota]
  const web = [
    ["arimo", "Arimo", "word", 1, 1, "= Arial"],
    ["carlito", "Carlito", "word", 1, 1, "= Calibri"],
    ["caladea", "Caladea", "word", 1, 1, "= Cambria"],
    ["tinos", "Tinos", "word", 1, 1, "= Times New Roman"],
    ["cousine", "Cousine", "word", 1, 1, "= Courier New"],
    ["comic-neue", "Comic Neue", "word", 1, 1, "≈ Comic Sans"],
    ["roboto", "Roboto", "sans", 1, 1],
    ["open-sans", "Open Sans", "sans", 1, 1],
    ["lato", "Lato", "sans", 1, 1],
    ["montserrat", "Montserrat", "sans", 1, 1],
    ["poppins", "Poppins", "sans", 1, 1],
    ["raleway", "Raleway", "sans", 1, 1],
    ["source-sans-3", "Source Sans 3", "sans", 1, 1],
    ["noto-sans", "Noto Sans", "sans", 1, 1],
    ["nunito", "Nunito", "sans", 1, 1],
    ["ubuntu", "Ubuntu", "sans", 1, 1],
    ["pt-sans", "PT Sans", "sans", 1, 1],
    ["oswald", "Oswald", "sans", 1, 0],
    ["bebas-neue", "Bebas Neue", "sans", 0, 0],
    ["anton", "Anton", "sans", 0, 0],
    ["merriweather", "Merriweather", "serif", 1, 1],
    ["playfair-display", "Playfair Display", "serif", 1, 1],
    ["noto-serif", "Noto Serif", "serif", 1, 1],
    ["eb-garamond", "EB Garamond", "serif", 1, 1, "≈ Garamond"],
    ["libre-baskerville", "Libre Baskerville", "serif", 1, 1, "≈ Baskerville"],
    ["lora", "Lora", "serif", 1, 1],
    ["pt-serif", "PT Serif", "serif", 1, 1],
    ["crimson-text", "Crimson Text", "serif", 1, 1],
    ["cormorant-garamond", "Cormorant Garamond", "serif", 1, 1],
    ["courier-prime", "Courier Prime", "mono", 1, 1],
    ["roboto-mono", "Roboto Mono", "mono", 1, 1],
    ["inconsolata", "Inconsolata", "mono", 1, 0],
    ["dancing-script", "Dancing Script", "deco", 1, 0],
    ["pacifico", "Pacifico", "deco", 0, 0],
    ["great-vibes", "Great Vibes", "deco", 0, 0],
    ["special-elite", "Special Elite", "deco", 0, 0, "máquina de escribir"],
  ];
  for (const [id, nombre, grupo, b, i, nota] of web) {
    lista.push({ id, nombre, grupo, nota, web: true, negrita: !!b, cursiva: !!i, css: `"FS-${id}", sans-serif` });
  }

  const url = (id, peso, estilo) =>
    `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${peso}-${estilo}.ttf`;

  // Carga (una vez) la fuente web en el navegador para mostrarla en el selector.
  const cargadas = new Set();
  function cargarCss(def) {
    if (!def || !def.web || cargadas.has(def.id) || !("FontFace" in window)) return;
    cargadas.add(def.id);
    const ff = new FontFace(`FS-${def.id}`, `url(${url(def.id, 400, "normal")})`);
    ff.load()
      .then((f) => document.fonts.add(f))
      .catch(() => cargadas.delete(def.id));
  }

  return { GRUPOS, lista, url, cargarCss };
})();
