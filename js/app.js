(() => {
  "use strict";

  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const $ = (id) => document.getElementById(id);
  const CM = 72 / 2.54; // puntos por centímetro
  const A4_ANCHO = 595.28; // para la página simulada
  const CLAVE = "foleo.ajustes.v1";

  const DEFAULTS = {
    orden: "inverso",
    desde: 1,
    hasta: "",
    inicio: 1,
    filtro: "todas",
    excluir: "",
    estilo: "arabigo",
    digitos: 2,
    plantilla: "{n}",
    letrasCaso: "min",
    fuente: "std-helvetica",
    tamano: 12,
    negrita: false,
    cursiva: false,
    subrayado: false,
    color: "#000000",
    alineacion: "auto",
    opacidad: 100,
    interlineado: 1.15,
    posicion: "tr",
    margenX: 1.4,
    margenY: 0.8,
    customX: 90,
    customY: 5,
    rotTexto: 0,
    espejo: false,
    caja: "ninguna",
    grosor: 1,
    colorBorde: "#6366f1",
    fondo: false,
    colorFondo: "#ffffff",
    relleno: 6,
    modoVarios: "junto", // "junto" = un solo PDF, "separado" = cada documento con su numeración
  };

  let cfg = cargarAjustes();

  // Estado de los documentos
  const archivos = []; // { nombre, tipo, bytes, doc, paginas }
  let srcDoc = null; // documento (unido) que se muestra en la vista previa
  let numPaginas = 0;
  let paginaActual = 0; // índice global (sobre todos los documentos seleccionados)
  let docVista = -1; // -1 = todos; si no, índice del documento que se está viendo
  let resultadoUrls = [];
  let ocupado = false;
  let zoom = 1;
  const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 2.5, 3];

  // Fuentes del usuario (subidas o del sistema)
  const fuentesUsuario = [];
  let contadorSubidas = 0;

  // ---------------------------------------------------------------------------
  // Ajustes
  // ---------------------------------------------------------------------------
  function cargarAjustes() {
    let guardado = {};
    try {
      guardado = JSON.parse(localStorage.getItem(CLAVE) || "{}") || {};
    } catch (e) {}
    const c = { ...DEFAULTS, ...guardado };
    // Las fuentes subidas / del sistema no sobreviven a una recarga
    if (!Fuentes.lista.some((f) => f.id === c.fuente)) c.fuente = DEFAULTS.fuente;
    return c;
  }

  function guardarAjustes() {
    try {
      localStorage.setItem(CLAVE, JSON.stringify(cfg));
    } catch (e) {}
  }

  const num = (v, def, min = -Infinity, max = Infinity) => {
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };

  // ---------------------------------------------------------------------------
  // Plan de foliado: qué página recibe qué número
  // ---------------------------------------------------------------------------
  function planFoliado(total) {
    const desde = Math.round(num(cfg.desde, 1, 1, Math.max(1, total)));
    const hasta = cfg.hasta === "" ? total : Math.round(num(cfg.hasta, total, desde, total));
    const excluidas = Formato.parseRangos(cfg.excluir, total);
    const inicio = Math.round(num(cfg.inicio, 1, 0));
    const seleccion = [];
    for (let p = desde; p <= hasta; p++) {
      if (cfg.filtro === "impares" && p % 2 === 0) continue;
      if (cfg.filtro === "pares" && p % 2 === 1) continue;
      if (excluidas.has(p)) continue;
      seleccion.push(p - 1);
    }
    const n = seleccion.length;
    const mapa = new Map();
    seleccion.forEach((idx, k) => mapa.set(idx, inicio + (cfg.orden === "inverso" ? n - 1 - k : k)));
    return { mapa, cantidad: n, primero: inicio, ultimo: inicio + n - 1, desde, hasta };
  }

  const sinExtension = (nombre) => nombre.replace(/\.(pdf|docx)$/i, "");
  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
  const paginasDe = (grupo) => grupo.reduce((t, a) => t + a.paginas, 0);

  // Modo efectivo con varios documentos: "junto" (un PDF), "grupos" (grupos armados por el usuario)
  // o "separado" (uno por documento)
  let numGrupos = 2; // cantidad de grupos en el modo «Grupos»
  let grupoVista = 1; // grupo abierto en la ventana «Ver documentos»
  const modo = () => {
    if (archivos.length > 1 && cfg.modoVarios === "grupos") return "grupos";
    return activos().length > 1 ? cfg.modoVarios || "junto" : "junto";
  };
  const porSeparado = () => modo() !== "junto"; // hay más de una numeración
  const enGrupo = (a) => a.grupo >= 1 && a.grupo <= numGrupos;
  const sinGrupo = () => archivos.filter((a) => !enGrupo(a));

  // Documentos repartidos en grupos; cada grupo tiene su propia numeración y su propio PDF.
  // En «grupos» cada documento pertenece al grupo que eligió el usuario (los grupos vacíos se omiten).
  function grupos() {
    const m = modo();
    if (m === "grupos") {
      const res = [];
      for (let k = 1; k <= numGrupos; k++) {
        const g = archivos.filter((a) => a.grupo === k);
        if (g.length) {
          g.id = k;
          res.push(g);
        }
      }
      return res;
    }
    const lista = activos();
    if (!lista.length) return [];
    if (m === "separado") return lista.map((a) => [a]);
    return [lista];
  }

  // Documentos en el orden en que se muestran en la vista previa (agrupados si hay grupos)
  const ordenVista = () => (porSeparado() ? grupos().flat() : activos());

  // Nombre que se usa para {doc} y para el archivo de salida de un grupo
  const nombreGrupo = (grupo) => (grupo.length ? sinExtension(grupo[0].nombre) : "documento");

  // "Grupo 1 (5 documentos), Grupo 2 (5 documentos)"
  function describirGrupos() {
    return grupos()
      .map((g) => `Grupo ${g.id || 1} (${plural(g.length, "documento", "documentos")})`)
      .join(", ");
  }

  // Plan sobre las páginas de la vista previa (documentos seleccionados, uno tras otro):
  // cada grupo cuenta desde el número inicial.
  function planGlobal() {
    const unidos = !porSeparado();
    const tramos = [];
    let inicio = 0;
    grupos().forEach((g, k) => {
      const pags = unidos ? numPaginas : paginasDe(g);
      tramos.push({ inicio, plan: planFoliado(pags), nombre: unidos ? nombreDoc() : nombreGrupo(g), id: g.id || k + 1 });
      inicio += pags;
    });
    if (!tramos.length) tramos.push({ inicio: 0, plan: planFoliado(numPaginas), nombre: nombreDoc() });
    return {
      cantidad: tramos.reduce((t, x) => t + x.plan.cantidad, 0),
      documentos: tramos.length,
      planes: tramos.map((x) => x.plan),
      info: (g) => {
        let k = tramos.length - 1;
        while (k > 0 && g < tramos[k].inicio) k--;
        const t = tramos[k];
        const local = g - t.inicio;
        return t.plan.mapa.has(local)
          ? { n: t.plan.mapa.get(local), plan: t.plan, local, nombre: t.nombre, doc: k, grupo: t.id }
          : null;
      },
    };
  }

  function formatearNumero(n) {
    switch (cfg.estilo) {
      case "romano-may": return Formato.romano(n);
      case "romano-min": return Formato.romano(n).toLowerCase();
      case "alfa-may": return Formato.alfabetico(n);
      case "alfa-min": return Formato.alfabetico(n).toLowerCase();
      default: return String(n).padStart(Math.round(num(cfg.digitos, 1, 1, 8)), "0");
    }
  }

  const hoy = () => new Date().toLocaleDateString("es", { day: "2-digit", month: "2-digit", year: "numeric" });
  const activos = () => archivos.filter((a) => a.activo);
  const nombreDoc = () => {
    const a = activos()[0] || archivos[0];
    return a ? a.nombre.replace(/\.(pdf|docx)$/i, "") : "documento";
  };

  function textoFolio(n, plan, idx, nombre = nombreDoc()) {
    let letras = Formato.aLetras(n);
    if (cfg.letrasCaso === "may") letras = letras.toUpperCase();
    else if (cfg.letrasCaso === "cap") letras = letras.charAt(0).toUpperCase() + letras.slice(1);
    const vars = {
      n: formatearNumero(n),
      letras,
      total: formatearNumero(Math.max(plan.ultimo, plan.primero)),
      pag: String(idx + 1),
      fecha: hoy(),
      doc: nombre,
    };
    const lineas = String(cfg.plantilla || "")
      .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+$/, ""));
    while (lineas.length && !lineas[lineas.length - 1]) lineas.pop();
    return lineas;
  }

  // ---------------------------------------------------------------------------
  // Fuentes: obtener la fuente embebida para un documento
  // ---------------------------------------------------------------------------
  const cacheBytes = new Map();
  function bytesDe(clave, cargar) {
    if (!cacheBytes.has(clave)) {
      const p = cargar().catch((e) => {
        cacheBytes.delete(clave);
        throw e;
      });
      cacheBytes.set(clave, p);
    }
    return cacheBytes.get(clave);
  }

  const buscarFuente = (id) =>
    Fuentes.lista.find((f) => f.id === id) || fuentesUsuario.find((f) => f.id === id) || Fuentes.lista[0];

  // Si el archivo es una colección (.ttc), devuelve solo la fuente pedida (o la primera)
  function fuenteSuelta(buffer, postscriptName) {
    if (!TTC.esColeccion(buffer)) return buffer;
    let indice = 0;
    try {
      const i = fontkit.create(new Uint8Array(buffer)).fonts.findIndex((f) => f.postscriptName === postscriptName);
      if (i >= 0) indice = i;
    } catch (e) {}
    return TTC.extraer(buffer, indice);
  }

  // Igual que obtenerFuente, pero si la fuente no se puede usar se recurre a Helvetica y se avisa
  const fuentesConFallo = new Set();
  async function obtenerFuenteSegura(doc) {
    try {
      return await obtenerFuente(doc);
    } catch (e) {
      console.error(e);
      const def = buscarFuente(cfg.fuente);
      if (!fuentesConFallo.has(def.id)) {
        fuentesConFallo.add(def.id);
        aviso(`La fuente "${def.nombre}" no se pudo usar en el PDF; se usará Helvetica. Prueba con otra fuente.`, "warn", 9000);
      }
      const variante = (cfg.negrita ? "b" : "") + (cfg.cursiva ? "i" : "") || "n";
      const std = Fuentes.lista[0].std[variante];
      return { font: await doc.embedFont(StandardFonts[std]), falsaNegrita: false, falsaCursiva: false };
    }
  }

  async function obtenerFuente(doc) {
    const def = buscarFuente(cfg.fuente);
    const b = !!cfg.negrita;
    const i = !!cfg.cursiva;
    const variante = (b ? "b" : "") + (i ? "i" : "") || "n";

    if (def.std) {
      return { font: await doc.embedFont(StandardFonts[def.std[variante]]), falsaNegrita: false, falsaCursiva: false };
    }

    let bytes;
    let falsaNegrita = false;
    let falsaCursiva = false;
    if (def.web) {
      const usaB = b && def.negrita;
      const usaI = i && def.cursiva;
      falsaNegrita = b && !usaB;
      falsaCursiva = i && !usaI;
      const url = Fuentes.url(def.id, usaB ? 700 : 400, usaI ? "italic" : "normal");
      bytes = await bytesDe(url, async () => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`No se pudo descargar la fuente ${def.nombre}`);
        return r.arrayBuffer();
      });
    } else if (def.sistema) {
      const orden = { n: ["n"], b: ["b", "n"], i: ["i", "n"], bi: ["bi", "b", "i", "n"] }[variante];
      const elegida = orden.find((k) => def.variantes[k]) || Object.keys(def.variantes)[0];
      falsaNegrita = b && !elegida.includes("b");
      falsaCursiva = i && !elegida.includes("i");
      const fd = def.variantes[elegida];
      bytes = await bytesDe(`sys:${fd.postscriptName}`, async () =>
        fuenteSuelta(await (await fd.blob()).arrayBuffer(), fd.postscriptName)
      );
    } else {
      bytes = def.bytes;
      falsaNegrita = b;
      falsaCursiva = i;
    }

    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(bytes, { subset: bytes.byteLength > 1500000 });
    return { font, falsaNegrita, falsaCursiva };
  }

  // ---------------------------------------------------------------------------
  // Dibujo del folio sobre una página
  // ---------------------------------------------------------------------------
  const hexRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    const v = m ? parseInt(m[1], 16) : 0;
    return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
  };

  function dibujarFolio(page, fx, lineas, esPar) {
    if (!lineas.length) return;
    const { font } = fx;
    const s = num(cfg.tamano, 12, 4, 200);
    const salto = s * num(cfg.interlineado, 1.15, 0.8, 3);
    // Se limitan las métricas: algunas fuentes (p. ej. Cambria Math) declaran alturas enormes
    const asc = Math.min(font.heightAtSize(s, { descender: false }), s * 1.05);
    const desc = Math.min(Math.max(0, font.heightAtSize(s) - font.heightAtSize(s, { descender: false })), s * 0.35) * 0.6;
    const anchos = lineas.map((t) => font.widthOfTextAtSize(t, s));
    const cw = Math.max(...anchos) + (fx.falsaCursiva ? s * 0.15 : 0);
    const ch = asc + desc + (lineas.length - 1) * salto;

    const caja = cfg.caja;
    const hayCaja = caja !== "ninguna";
    const pad = hayCaja ? num(cfg.relleno, 6, 0, 50) : 0;
    const k = caja === "elipse" ? Math.SQRT2 : 1;
    const W = cw * k + 2 * pad;
    const H = ch * k + 2 * pad;
    const ox = (W - cw) / 2;
    const oy = (H - ch) / 2;

    // Página tal como se ve (considerando /Rotate y CropBox)
    const rot = (((Math.round(page.getRotation().angle / 90) * 90) % 360) + 360) % 360;
    const box = page.getCropBox();
    const vw = rot % 180 === 0 ? box.width : box.height;
    const vh = rot % 180 === 0 ? box.height : box.width;
    const tr = [0, 90, 180, 270].includes(cfg.rotTexto) ? cfg.rotTexto : 0;
    const bw = tr % 180 === 0 ? W : H;
    const bh = tr % 180 === 0 ? H : W;

    // Posición del bloque (coordenadas visuales, origen arriba-izquierda)
    const espejo = cfg.espejo && esPar;
    let bx;
    let by;
    let horiz = "c";
    if (cfg.posicion === "custom") {
      let cx = num(cfg.customX, 50, 0, 100) / 100;
      if (espejo) cx = 1 - cx;
      bx = cx * vw - bw / 2;
      by = (num(cfg.customY, 50, 0, 100) / 100) * vh - bh / 2;
    } else {
      const v = cfg.posicion[0];
      horiz = cfg.posicion[1];
      if (espejo) horiz = { l: "r", r: "l", c: "c" }[horiz];
      const mx = num(cfg.margenX, 1, 0) * CM;
      const my = num(cfg.margenY, 1, 0) * CM;
      bx = horiz === "l" ? mx : horiz === "r" ? vw - mx - bw : (vw - bw) / 2;
      by = v === "t" ? my : v === "b" ? vh - my - bh : (vh - bh) / 2;
    }

    // Local (x a la derecha del texto, y hacia arriba) -> visual -> PDF
    const origen = { 0: [bx, by + bh], 90: [bx + bw, by + bh], 180: [bx + bw, by], 270: [bx, by] }[tr];
    const aVisual = (lx, ly) => {
      switch (tr) {
        case 90: return [origen[0] - ly, origen[1] - lx];
        case 180: return [origen[0] - lx, origen[1] + ly];
        case 270: return [origen[0] + ly, origen[1] + lx];
        default: return [origen[0] + lx, origen[1] - ly];
      }
    };
    const { x: x0, y: y0, width: w, height: h } = box;
    const aPdf = (vx, vy) => {
      switch (rot) {
        case 90: return [x0 + vy, y0 + vx];
        case 180: return [x0 + w - vx, y0 + vy];
        case 270: return [x0 + w - vy, y0 + h - vx];
        default: return [x0 + vx, y0 + h - vy];
      }
    };
    const P = (lx, ly) => {
      const [x, y] = aPdf(...aVisual(lx, ly));
      return { x, y };
    };
    const angulo = (rot + tr) % 360;
    const rotate = degrees(angulo);

    const op = num(cfg.opacidad, 100, 5, 100) / 100;
    const color = hexRgb(cfg.color);
    const grosor = num(cfg.grosor, 1, 0, 20);

    // Recuadro / fondo
    if (hayCaja && (cfg.fondo || grosor > 0)) {
      const estilo = { opacity: op, borderOpacity: op };
      if (cfg.fondo) estilo.color = hexRgb(cfg.colorFondo);
      if (grosor > 0) {
        estilo.borderColor = hexRgb(cfg.colorBorde);
        estilo.borderWidth = grosor;
      }
      if (caja === "elipse") {
        const c = P(W / 2, H / 2);
        const girado = angulo % 180 !== 0;
        page.drawEllipse({ x: c.x, y: c.y, xScale: (girado ? H : W) / 2, yScale: (girado ? W : H) / 2, ...estilo });
      } else if (caja === "redondeado") {
        const r = Math.min(W, H) * 0.3;
        const ruta =
          `M ${r} 0 H ${W - r} A ${r} ${r} 0 0 1 ${W} ${r} V ${H - r} A ${r} ${r} 0 0 1 ${W - r} ${H} ` +
          `H ${r} A ${r} ${r} 0 0 1 0 ${H - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
        const o = P(0, H); // el trazado SVG empieza arriba-izquierda
        page.drawSvgPath(ruta, { x: o.x, y: o.y, rotate, ...estilo });
      } else {
        const o = P(0, 0);
        page.drawRectangle({ x: o.x, y: o.y, width: W, height: H, rotate, ...estilo });
      }
    }

    // Texto
    let alin = cfg.alineacion;
    if (alin === "auto") alin = horiz === "l" ? "izq" : horiz === "r" ? "der" : "centro";
    const desplazamientos = fx.falsaNegrita ? [0, s * 0.018, s * 0.036] : [0];
    lineas.forEach((t, i) => {
      const extra = cw - anchos[i];
      const lx = ox + (alin === "izq" ? 0 : alin === "der" ? extra : extra / 2);
      const ly = oy + ch - asc - i * salto;
      for (const d of desplazamientos) {
        const p = P(lx + d, ly);
        page.drawText(t, {
          x: p.x,
          y: p.y,
          size: s,
          font,
          color,
          opacity: op,
          rotate,
          ySkew: fx.falsaCursiva ? degrees(12) : undefined,
        });
      }
      if (cfg.subrayado && t) {
        const yy = ly - s * 0.12;
        const a = P(lx, yy);
        const b = P(lx + anchos[i] + (fx.falsaNegrita ? s * 0.036 : 0), yy);
        page.drawLine({ start: a, end: b, thickness: Math.max(0.4, s * 0.06), color, opacity: op });
      }
    });
  }

  function foliarPagina(page, fx, info) {
    if (!info) return false;
    dibujarFolio(page, fx, textoFolio(info.n, info.plan, info.local, info.nombre), (info.local + 1) % 2 === 0);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Archivos
  // ---------------------------------------------------------------------------
  const esDocx = (f) =>
    /\.docx$/i.test(f.name) || f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const esPdf = (f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";

  async function cargarPdf(bytes) {
    try {
      return { doc: await PDFDocument.load(bytes, { updateMetadata: false }), cifrado: false };
    } catch (e) {
      if (!/encrypt/i.test(e.message || "")) throw e;
      return { doc: await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }), cifrado: true };
    }
  }

  async function agregarArchivos(lista) {
    const todos = [...lista];
    const validos = todos.filter((f) => esPdf(f) || esDocx(f));
    const hayDoc = todos.some((f) => /\.doc$/i.test(f.name));
    if (hayDoc) aviso("Los archivos .doc antiguos no son compatibles. Guárdalo como .docx o PDF desde Word.", "warn");
    if (!validos.length) {
      if (!hayDoc) aviso("Solo se aceptan archivos PDF o Word (.docx).", "err");
      return;
    }
    ocultarResultado();
    for (const f of validos) {
      try {
        let bytes = await f.arrayBuffer();
        let tipo = "pdf";
        if (esDocx(f)) {
          tipo = "docx";
          cargando(true, "Preparando Word…");
          bytes = await Word.aPdf(bytes, (t) => cargando(true, t));
          aviso(
            `"${f.name}" se convirtió a PDF en tu navegador. Para máxima nitidez y texto seleccionable, exporta el Word a PDF (Archivo › Guardar como › PDF) y súbelo.`,
            "warn",
            9000
          );
        } else {
          cargando(true, `Leyendo ${f.name}…`);
        }
        const { doc, cifrado } = await cargarPdf(bytes);
        if (cifrado) aviso(`"${f.name}" está protegido; el PDF foliado podría no abrirse correctamente.`, "warn", 8000);
        archivos.push({ nombre: f.name, tipo, bytes, doc, paginas: doc.getPageCount(), activo: true, grupo: modo() === "grupos" ? grupoVista : 1 });
      } catch (e) {
        console.error(e);
        aviso(`No se pudo leer "${f.name}": ${e.message || e}`, "err", 8000);
      }
    }
    cargando(false);
    await reconstruir();
  }

  async function unirDocumentos(lista = activos()) {
    const unido = await PDFDocument.create();
    for (const a of lista) {
      const paginas = await unido.copyPages(a.doc, a.doc.getPageIndices());
      paginas.forEach((p) => unido.addPage(p));
    }
    return unido;
  }

  async function reconstruir() {
    ocultarResultado();
    const lista = ordenVista();
    if (!lista.length) {
      srcDoc = null;
      numPaginas = 0;
      paginaActual = 0;
    } else {
      cargando(true, "Preparando vista previa…");
      srcDoc = lista.length === 1 ? lista[0].doc : await unirDocumentos(lista);
      numPaginas = srcDoc.getPageCount();
      if (docVista >= lista.length || lista.length < 2) docVista = -1;
      const r = rangoVista();
      paginaActual = Math.min(Math.max(paginaActual, r.ini), r.fin - 1);
    }
    pintarArchivos();
    pintarSelectorDoc();
    actualizarUI();
    await actualizarVista();
  }

  const icono = (nombre) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "i");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${nombre}`);
    svg.append(use);
    return svg;
  };


  // Fila de un documento. En el modal lleva asa para arrastrar, casilla, número de orden y flechas.
  function filaDocumento(a, i, enModal) {
    const li = document.createElement("li");
    const enGrupos = enModal && modo() === "grupos";
    li.classList.toggle("inactivo", enGrupos ? !enGrupo(a) : !a.activo);
    li.classList.toggle("en-grupo", enGrupos && a.grupo === grupoVista);
    if (enModal) {
      li.draggable = true;
      li.dataset.idx = i;
      const asa = document.createElement("span");
      asa.className = "grip";
      asa.title = "Arrastra para cambiar el orden";
      asa.append(icono("grip"));
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "doc-check";
      chk.checked = enGrupos ? a.grupo === grupoVista : a.activo;
      chk.title = enGrupos ? `Incluir en el Grupo ${grupoVista}` : "Incluir en el foliado";
      chk.setAttribute("aria-label", `${chk.title}: ${a.nombre}`);
      chk.addEventListener("change", () => {
        if (enGrupos) {
          a.grupo = chk.checked ? grupoVista : 0;
          reconstruir();
          return;
        }
        if (!chk.checked && activos().length === 1) {
          chk.checked = true;
          aviso("Debe quedar al menos un documento seleccionado.", "warn");
          return;
        }
        a.activo = chk.checked;
        reconstruir();
      });
      const orden = document.createElement("span");
      orden.className = "orden";
      orden.textContent = i + 1;
      li.append(asa, chk, orden);
    }
    const tag = document.createElement("span");
    tag.className = `ftag ${a.tipo}`;
    tag.textContent = a.tipo === "docx" ? "DOCX" : "PDF";
    const nombre = document.createElement("span");
    nombre.className = "fname";
    nombre.textContent = a.nombre;
    nombre.title = a.nombre;
    const meta = document.createElement("span");
    meta.className = "fmeta";
    meta.textContent = `${a.paginas} pág.`;
    li.append(tag, nombre);
    if (enGrupos && a.grupo !== grupoVista) {
      const chip = document.createElement("span");
      chip.className = "gchip" + (enGrupo(a) ? "" : " libre");
      chip.textContent = enGrupo(a) ? `En Grupo ${a.grupo}` : "Sin grupo";
      li.append(chip);
    }
    li.append(meta);
    const botones = enModal
      ? [
          ["arrow-up", "Subir", i === 0, () => mover(i, -1)],
          ["arrow-down", "Bajar", i === archivos.length - 1, () => mover(i, 1)],
          ["x", "Quitar", false, () => quitar(i)],
        ]
      : [["x", "Quitar", false, () => quitar(i)]];
    for (const [ic, titulo, desactivado, fn] of botones) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mini";
      b.title = titulo;
      b.setAttribute("aria-label", `${titulo} ${a.nombre}`);
      b.disabled = desactivado;
      b.append(icono(ic));
      b.addEventListener("click", fn);
      li.append(b);
    }
    return li;
  }

  function pintarArchivos() {
    const varios = archivos.length > 1;
    const lista = activos();
    const paginasSel = lista.reduce((t, a) => t + a.paginas, 0);

    // Tarjeta: una fila si hay un documento; un resumen con botón si hay varios
    const ul = $("listaArchivos");
    ul.innerHTML = "";
    if (archivos.length === 1) ul.append(filaDocumento(archivos[0], 0, false));
    $("resumenDocs").hidden = !varios;
    if (varios) {
      $("resumenTitulo").textContent = plural(archivos.length, "documento", "documentos");
      const gs = grupos();
      $("resumenDetalle").textContent = modo() === "grupos"
        ? `${plural(gs.length, "grupo", "grupos")} · ${plural(paginasDe(gs.flat()), "página", "páginas")}`
        : lista.length === archivos.length
          ? `${plural(paginasSel, "página", "páginas")} en total`
          : `${lista.length} de ${archivos.length} seleccionados · ${plural(paginasSel, "página", "páginas")}`;
    }
    document.querySelector(".upload-card").classList.toggle("con-archivos", archivos.length > 0);

    // Modal
    const ulm = $("listaModal");
    ulm.innerHTML = "";
    const enGrupos = modo() === "grupos";
    archivos.forEach((a, i) => ulm.append(filaDocumento(a, i, true)));
    $("barraGrupos").hidden = !enGrupos;
    if (enGrupos) pintarBarraGrupos();
    $("modalDesc").textContent = enGrupos
      ? "Entra a cada grupo y marca sus documentos. Cada grupo se folia con su propia numeración y sale como un PDF."
      : "Arrastra o usa las flechas para cambiar el orden. Desmarca los que no quieras foliar.";
    $("modalTitulo").textContent = `Documentos (${archivos.length})`;
    if (enGrupos) {
      const asignados = archivos.filter(enGrupo);
      $("modalTotal").textContent =
        `${asignados.length} de ${archivos.length} en grupos · ${plural(paginasDe(asignados), "página", "páginas")}`;
    } else {
      $("modalTotal").textContent = `${lista.length} de ${archivos.length} seleccionados · ${plural(paginasSel, "página", "páginas")}`;
    }
    if (!varios && !$("modalDocs").hidden) cerrarModal();
  }

  // Barra de grupos del modal: cantidad, pestañas y ayuda del grupo abierto
  function pintarBarraGrupos() {
    grupoVista = Math.min(Math.max(1, grupoVista), numGrupos);
    $("numGrupos").textContent = numGrupos;
    $("btnMenosGrupo").disabled = numGrupos <= 1;
    $("btnMasGrupo").disabled = numGrupos >= 30;
    const tabs = $("gtabs");
    tabs.innerHTML = "";
    for (let k = 1; k <= numGrupos; k++) {
      const docs = archivos.filter((a) => a.grupo === k);
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(k === grupoVista));
      b.className = "gtab" + (k === grupoVista ? " on" : "") + (docs.length ? "" : " vacio");
      b.title = docs.length ? `${plural(docs.length, "documento", "documentos")} · ${paginasDe(docs)} pág.` : "Grupo vacío";
      const t = document.createElement("span");
      t.textContent = `Grupo ${k}`;
      const c = document.createElement("small");
      c.textContent = docs.length;
      b.append(t, c);
      b.addEventListener("click", () => {
        grupoVista = k;
        pintarArchivos();
      });
      tabs.append(b);
    }
    const libres = sinGrupo().length;
    const actual = archivos.filter((a) => a.grupo === grupoVista);
    $("hintGrupo").textContent =
      `Marca los documentos del Grupo ${grupoVista}` +
      (actual.length ? ` (${plural(actual.length, "documento", "documentos")}, ${paginasDe(actual)} pág.).` : ".") +
      (libres ? ` ${plural(libres, "documento sin grupo", "documentos sin grupo")}: no se foliarán.` : "");
    $("hintGrupo").classList.toggle("warn", libres > 0);
  }

  function cambiarNumGrupos(n) {
    n = Math.max(1, Math.min(30, n));
    if (n === numGrupos) return;
    const quedan = archivos.filter((a) => a.grupo > n);
    quedan.forEach((a) => (a.grupo = 0));
    numGrupos = n;
    if (grupoVista > n) grupoVista = n;
    if (quedan.length) aviso(`${plural(quedan.length, "documento quedó", "documentos quedaron")} sin grupo.`, "warn");
    reconstruir();
  }

  // Reparte todos los documentos, en orden y por partes iguales, entre los grupos
  function repartirEnOrden() {
    const n = archivos.length;
    archivos.forEach((a, i) => (a.grupo = Math.floor((i * numGrupos) / n) + 1));
    aviso(`Documentos repartidos: ${describirGrupos()}.`, "ok");
    reconstruir();
  }

  function mover(i, d) {
    moverA(i, i + d);
  }

  function moverA(desde, hasta) {
    if (desde === hasta || hasta < 0 || hasta >= archivos.length) return;
    const [a] = archivos.splice(desde, 1);
    archivos.splice(hasta, 0, a);
    reconstruir();
  }

  function quitar(i) {
    archivos.splice(i, 1);
    if (archivos.length && !activos().length) archivos.forEach((a) => (a.activo = true));
    reconstruir();
  }

  // Modal "Ver documentos"
  function abrirModal() {
    pintarArchivos();
    $("modalDocs").hidden = false;
    document.body.classList.add("modal-abierto");
    $("btnModalListo").focus();
  }

  function cerrarModal() {
    if ($("modalDocs").hidden) return;
    $("modalDocs").hidden = true;
    document.body.classList.remove("modal-abierto");
    if (archivos.length > 1) $("btnVerDocs").focus();
  }

  function configurarModal() {
    const modal = $("modalDocs");
    $("btnVerDocs").addEventListener("click", abrirModal);
    $("btnCerrarModal").addEventListener("click", cerrarModal);
    $("btnModalListo").addEventListener("click", cerrarModal);
    $("btnModalAgregar").addEventListener("click", () => $("inputArchivo").click());
    $("btnMasGrupo").addEventListener("click", () => cambiarNumGrupos(numGrupos + 1));
    $("btnMenosGrupo").addEventListener("click", () => cambiarNumGrupos(numGrupos - 1));
    $("btnRepartir").addEventListener("click", repartirEnOrden);
    // Pulsar «Grupos» (aunque ya esté elegido) abre la ventana para armarlos
    document.querySelectorAll('input[name="modoVarios"][value="grupos"]').forEach((r) =>
      r.addEventListener("click", () => {
        const yaEraGrupos = cfg.modoVarios === "grupos";
        // se espera a que el cambio de modo se aplique antes de pintar la ventana
        setTimeout(() => {
          if ($("modalDocs").hidden) abrirModal();
          if (!yaEraGrupos) aviso("Elige cuántos grupos quieres y marca los documentos de cada uno.", "info", 7000);
        }, 0);
      })
    );
    document.querySelectorAll('input[data-cfg="modoVarios"]').forEach((r) =>
      r.addEventListener("change", () => {
        if (!$("modalDocs").hidden) pintarArchivos();
      })
    );
    modal.addEventListener("pointerdown", (e) => e.target === modal && cerrarModal());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) cerrarModal();
    });

    // Arrastrar y soltar para ordenar
    const ul = $("listaModal");
    let origen = null;
    const limpiar = () => ul.querySelectorAll("li").forEach((li) => li.classList.remove("antes", "despues", "moviendo"));
    ul.addEventListener("dragstart", (e) => {
      const li = e.target.closest("li[data-idx]");
      if (!li) return;
      origen = Number(li.dataset.idx);
      li.classList.add("moviendo");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(origen));
    });
    ul.addEventListener("dragover", (e) => {
      if (origen === null) return;
      const li = e.target.closest("li[data-idx]");
      if (!li) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const arriba = e.clientY < r.top + r.height / 2;
      ul.querySelectorAll("li").forEach((x) => x.classList.remove("antes", "despues"));
      li.classList.add(arriba ? "antes" : "despues");
    });
    ul.addEventListener("drop", (e) => {
      if (origen === null) return;
      e.preventDefault();
      const li = e.target.closest("li[data-idx]");
      const o = origen;
      origen = null;
      limpiar();
      if (!li) return;
      const r = li.getBoundingClientRect();
      let destino = Number(li.dataset.idx) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
      if (destino > o) destino--;
      moverA(o, destino);
    });
    ul.addEventListener("dragend", () => {
      origen = null;
      limpiar();
    });
  }

  // ---------------------------------------------------------------------------
  // Vista previa (se genera el PDF real de la página y se renderiza con pdf.js)
  // ---------------------------------------------------------------------------
  let turnoVista = 0;
  let temporizador = null;
  function programarVista() {
    clearTimeout(temporizador);
    temporizador = setTimeout(actualizarVista, 160);
  }

  async function actualizarVista() {
    const turno = ++turnoVista;
    const hayDoc = !!srcDoc;
    $("vacio").hidden = hayDoc;
    $("canvasWrap").hidden = !hayDoc;
    $("navPaginas").hidden = !hayDoc;
    if (!hayDoc) {
      cargando(false);
      return;
    }

    const info = planGlobal().info(paginaActual);
    const badge = $("badgeFolio");
    badge.className = info ? "badge" : "badge off";
    const texto = info ? textoFolio(info.n, info.plan, info.local, info.nombre).join(" ") : "Sin folio";
    const etiqueta = modo() === "grupos" ? `Grupo ${info && info.grupo}` : `Doc ${info && info.doc + 1}`;
    badge.textContent = porSeparado() && info ? `${etiqueta} · ${texto}` : texto;
    badge.title = info && porSeparado() ? `${info.nombre}: ${texto}` : texto;
    const rv = rangoVista();
    $("inPagina").value = paginaActual - rv.ini + 1;
    $("inPagina").max = rv.fin - rv.ini;
    $("totalPaginas").textContent = rv.fin - rv.ini;
    $("btnPrev").disabled = paginaActual <= rv.ini;
    $("btnNext").disabled = paginaActual >= rv.fin - 1;
    pintarMarcador();

    try {
      const doc = await PDFDocument.create();
      const [pag] = await doc.copyPages(srcDoc, [paginaActual]);
      doc.addPage(pag);
      if (info) {
        const fx = await obtenerFuenteSegura(doc);
        foliarPagina(pag, fx, info);
      }
      const bytes = await doc.save();
      if (turno !== turnoVista) return;

      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      const p = await pdf.getPage(1);
      const base = p.getViewport({ scale: 1 });
      const stage = $("stage");
      const grande = window.matchMedia("(min-width: 1024px)").matches;
      const anchoDisp = stage.clientWidth - 64;
      const altoDisp = grande ? stage.clientHeight - 64 : window.innerHeight * 0.8 - 120;
      const ajuste = Math.max(0.1, Math.min(anchoDisp / base.width, altoDisp / base.height));
      const escala = ajuste * zoom;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const vp = p.getViewport({ scale: Math.min(escala * dpr, 8) });
      const tmp = document.createElement("canvas");
      tmp.width = Math.floor(vp.width);
      tmp.height = Math.floor(vp.height);
      await p.render({ canvasContext: tmp.getContext("2d"), viewport: vp }).promise;
      pdf.destroy();
      if (turno !== turnoVista) return;

      const lienzo = $("lienzo");
      lienzo.width = tmp.width;
      lienzo.height = tmp.height;
      lienzo.style.width = `${base.width * escala}px`;
      lienzo.style.height = `${base.height * escala}px`;
      lienzo.getContext("2d").drawImage(tmp, 0, 0);
      pintarMarcador();
    } catch (e) {
      console.error(e);
      if (turno === turnoVista) aviso(mensajeError(e), "err", 6000);
    } finally {
      if (turno === turnoVista) cargando(false);
    }
  }

  function mensajeError(e) {
    const m = (e && e.message) || String(e);
    if (/WinAnsi cannot encode/i.test(m))
      return "La fuente estándar no admite algún carácter del texto. Elige otra fuente (p. ej. Arimo o Roboto).";
    return `Error: ${m}`;
  }

  function pintarMarcador() {
    const mk = $("marcador");
    if (cfg.posicion !== "custom" || !srcDoc) {
      mk.hidden = true;
      return;
    }
    let x = num(cfg.customX, 50, 0, 100);
    if (cfg.espejo && (paginaLocal() + 1) % 2 === 0) x = 100 - x;
    mk.style.left = `${x}%`;
    mk.style.top = `${num(cfg.customY, 50, 0, 100)}%`;
    mk.hidden = false;
  }

  // Número de página dentro de su propio documento (cuenta para el modo espejo al foliar por separado)
  function paginaLocal() {
    if (!porSeparado()) return paginaActual;
    let g = paginaActual;
    for (const grupo of grupos()) {
      const pags = paginasDe(grupo);
      if (g < pags) return g;
      g -= pags;
    }
    return paginaActual;
  }

  // Páginas que se recorren en la vista previa: todas o solo las del documento elegido
  function rangoVista() {
    const lista = ordenVista();
    if (docVista < 0 || docVista >= lista.length) return { ini: 0, fin: numPaginas };
    let ini = 0;
    for (let k = 0; k < docVista; k++) ini += lista[k].paginas;
    return { ini, fin: ini + lista[docVista].paginas };
  }

  function pintarSelectorDoc() {
    const lista = ordenVista();
    const sel = $("selDoc");
    $("selDocWrap").hidden = lista.length < 2;
    sel.innerHTML = "";
    const todos = new Option(`Todos los documentos (${lista.length})`, "-1");
    sel.append(todos);
    lista.forEach((a, k) => sel.append(new Option(`${k + 1}. ${a.nombre}`, String(k))));
    sel.value = String(docVista);
    sel.title = docVista < 0 ? "Viendo todos los documentos" : `Viendo solo: ${lista[docVista].nombre}`;
    Selects.refrescar();
  }

  function irA(p) {
    if (!numPaginas) return;
    const r = rangoVista();
    const nueva = Math.max(r.ini, Math.min(r.fin - 1, p));
    if (nueva === paginaActual) {
      $("inPagina").value = paginaActual - r.ini + 1;
      return;
    }
    paginaActual = nueva;
    actualizarVista();
  }

  function cambiarZoom(dir) {
    if (dir === 0) zoom = 1;
    else {
      let i = ZOOMS.findIndex((z) => z >= zoom - 1e-6);
      if (i < 0) i = ZOOMS.length - 1;
      i = Math.max(0, Math.min(ZOOMS.length - 1, i + dir));
      zoom = ZOOMS[i];
    }
    $("zoomValor").textContent = `${Math.round(zoom * 100)}%`;
    $("btnZoomMenos").disabled = zoom <= ZOOMS[0];
    $("btnZoomMas").disabled = zoom >= ZOOMS[ZOOMS.length - 1];
    if (srcDoc) actualizarVista();
  }

  // Clic / arrastre sobre la página para colocar el folio
  function configurarArrastre() {
    const lienzo = $("lienzo");
    let arrastrando = false;
    const colocar = (ev) => {
      const r = lienzo.getBoundingClientRect();
      let x = ((ev.clientX - r.left) / r.width) * 100;
      const y = ((ev.clientY - r.top) / r.height) * 100;
      if (cfg.espejo && (paginaLocal() + 1) % 2 === 0) x = 100 - x;
      cfg.posicion = "custom";
      cfg.customX = Math.round(Math.min(100, Math.max(0, x)) * 10) / 10;
      cfg.customY = Math.round(Math.min(100, Math.max(0, y)) * 10) / 10;
      cambio(true);
    };
    lienzo.addEventListener("pointerdown", (ev) => {
      arrastrando = true;
      $("canvasWrap").classList.add("arrastrando");
      lienzo.setPointerCapture(ev.pointerId);
      colocar(ev);
    });
    lienzo.addEventListener("pointermove", (ev) => arrastrando && colocar(ev));
    const fin = () => {
      arrastrando = false;
      $("canvasWrap").classList.remove("arrastrando");
    };
    lienzo.addEventListener("pointerup", fin);
    lienzo.addEventListener("pointercancel", fin);
  }

  // Folio simulado sobre la página vacía (sin documento cargado)
  function pintarFolioSimulado() {
    const el = $("folioSimulado");
    const lineas = textoFolio(Math.round(num(cfg.inicio, 1, 0)), { primero: 1, ultimo: 20 }, 0);
    el.textContent = lineas.join("\n");
    el.hidden = !lineas.length;
    const u = (pt) => `${(pt / A4_ANCHO) * 100}cqw`; // puntos -> ancho de la página simulada
    const def = buscarFuente(cfg.fuente);
    const caja = cfg.caja;
    const hayCaja = caja !== "ninguna";
    const grosor = num(cfg.grosor, 1, 0, 20);
    Object.assign(el.style, {
      fontFamily: def.css,
      fontSize: u(num(cfg.tamano, 12, 4, 200)),
      fontWeight: cfg.negrita ? "700" : "400",
      fontStyle: cfg.cursiva ? "italic" : "normal",
      textDecoration: cfg.subrayado ? "underline" : "none",
      color: cfg.color,
      opacity: num(cfg.opacidad, 100) / 100,
      lineHeight: String(num(cfg.interlineado, 1.15)),
      padding: hayCaja ? u(num(cfg.relleno, 6, 0, 50) * (caja === "elipse" ? 1.6 : 1)) : "0",
      border: hayCaja && grosor > 0 ? `${u(grosor)} solid ${cfg.colorBorde}` : "none",
      borderRadius: caja === "redondeado" ? "0.6em" : caja === "elipse" ? "50%" : "0",
      background: hayCaja && cfg.fondo ? cfg.colorFondo : "transparent",
      top: "auto",
      bottom: "auto",
      left: "auto",
      right: "auto",
    });
    let alin = cfg.alineacion;
    const tr = num(cfg.rotTexto, 0);
    const giro = tr ? ` rotate(${-tr}deg)` : "";
    if (cfg.posicion === "custom") {
      el.style.left = `${num(cfg.customX, 50, 0, 100)}%`;
      el.style.top = `${num(cfg.customY, 50, 0, 100)}%`;
      el.style.transform = `translate(-50%, -50%)${giro}`;
      if (alin === "auto") alin = "centro";
    } else {
      const [v, h] = cfg.posicion;
      const mx = u(num(cfg.margenX, 1, 0) * CM);
      const my = u(num(cfg.margenY, 1, 0) * CM);
      let tx = "0";
      let ty = "0";
      if (h === "l") el.style.left = mx;
      else if (h === "r") el.style.right = mx;
      else {
        el.style.left = "50%";
        tx = "-50%";
      }
      if (v === "t") el.style.top = my;
      else if (v === "b") el.style.bottom = my;
      else {
        el.style.top = "50%";
        ty = "-50%";
      }
      el.style.transform = `translate(${tx}, ${ty})${giro}`;
      if (alin === "auto") alin = h === "l" ? "izq" : h === "r" ? "der" : "centro";
    }
    el.style.transformOrigin = "center";
    el.style.textAlign = { izq: "left", der: "right", centro: "center" }[alin];
  }

  // ---------------------------------------------------------------------------
  // Generar el PDF final
  // ---------------------------------------------------------------------------
  const pausa = () => new Promise((r) => setTimeout(r, 0));

  // Folia un documento cargado y devuelve el PDF resultante como Blob
  async function foliarDocumento(doc, plan, nombre, avance) {
    const fx = await obtenerFuenteSegura(doc);
    const paginas = doc.getPages();
    let hechas = 0;
    for (const [idx, n] of plan.mapa) {
      foliarPagina(paginas[idx], fx, { n, plan, local: idx, nombre });
      hechas++;
      if (hechas % 20 === 0 || hechas === plan.cantidad) {
        avance(hechas);
        await pausa();
      }
    }
    return new Blob([await doc.save()], { type: "application/pdf" });
  }

  let jszip = null;
  function cargarJSZip() {
    if (window.JSZip) return Promise.resolve();
    if (!jszip) {
      jszip = new Promise((ok, mal) => {
        const sc = document.createElement("script");
        sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
        sc.onload = ok;
        sc.onerror = () => {
          jszip = null;
          mal(new Error("No se pudo cargar el compresor ZIP"));
        };
        document.head.append(sc);
      });
    }
    return jszip;
  }

  function mostrarResultado({ titulo, detalle, url, nombre, abrir, lista }) {
    $("btnDescargar").href = url;
    $("btnDescargar").download = nombre;
    $("btnDescargar").lastChild.textContent = lista ? " Descargar todos (ZIP)" : " Descargar";
    $("btnAbrir").hidden = !abrir;
    if (abrir) $("btnAbrir").href = abrir;
    $("resNombre").textContent = titulo;
    $("resDetalle").textContent = detalle;
    const ul = $("resLista");
    ul.innerHTML = "";
    ul.hidden = !lista;
    for (const r of lista || []) {
      const li = document.createElement("li");
      const nom = document.createElement("span");
      nom.className = "fname";
      nom.textContent = r.nombre;
      nom.title = r.nombre;
      const info = document.createElement("small");
      info.textContent = `${r.cantidad} pág. · ${tamanoLegible(r.blob.size)}`;
      const a = document.createElement("a");
      a.href = r.url;
      a.download = r.nombre;
      a.title = `Descargar ${r.nombre}`;
      a.setAttribute("aria-label", `Descargar ${r.nombre}`);
      a.append(icono("download"));
      li.append(nom, info, a);
      ul.append(li);
    }
    progreso(100, "¡Listo!");
    $("resultado").hidden = false;
    $("resultado").scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => ($("progreso").hidden = true), 600);
  }

  async function foliar() {
    if (!archivos.length || ocupado) return;
    ocupado = true;
    ocultarResultado();
    const boton = $("btnFoliar");
    boton.disabled = true;
    $("progreso").hidden = false;
    progreso(0, "Preparando…");
    try {
      const lista = activos();
      if (porSeparado()) {
        // Cada grupo (o documento) con su propia numeración y su propio PDF
        const gs = grupos();
        const enGrupos = modo() === "grupos";
        const planes = gs.map((g) => planFoliado(paginasDe(g)));
        const total = planes.reduce((t, x) => t + x.cantidad, 0);
        if (!total) throw new Error("Con estos ajustes no hay ninguna página para foliar.");
        const resultados = [];
        let previas = 0;
        for (let k = 0; k < gs.length; k++) {
          const g = gs[k];
          const nombre = nombreGrupo(g);
          const doc = g.length === 1 ? (await cargarPdf(g[0].bytes)).doc : await unirDocumentos(g);
          const que = enGrupos ? `Grupo ${g.id} (${k + 1} de ${gs.length})` : `Documento ${k + 1} de ${gs.length}`;
          const blob = planes[k].cantidad
            ? await foliarDocumento(doc, planes[k], nombre, (h) =>
                progreso(((previas + h) / total) * 88, `${que}: página ${h} de ${planes[k].cantidad}`)
              )
            : new Blob([await doc.save()], { type: "application/pdf" });
          previas += planes[k].cantidad;
          const url = URL.createObjectURL(blob);
          resultadoUrls.push(url);
          const archivo = enGrupos ? `grupo${g.id}_${nombre}_foliado.pdf` : `${nombre}_foliado.pdf`;
          resultados.push({ nombre: archivo, blob, url, cantidad: planes[k].cantidad });
        }
        progreso(92, "Creando ZIP…");
        await cargarJSZip();
        const zip = new JSZip();
        const usados = new Set();
        for (const r of resultados) {
          let n = r.nombre;
          for (let c = 2; usados.has(n); c++) n = r.nombre.replace(/_foliado\.pdf$/, `_${c}_foliado.pdf`);
          usados.add(n);
          zip.file(n, r.blob);
        }
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const zipUrl = URL.createObjectURL(zipBlob);
        resultadoUrls.push(zipUrl);
        mostrarResultado({
          titulo: enGrupos ? `${resultados.length} grupos foliados` : `${resultados.length} PDF foliados por separado`,
          detalle: `${total} páginas foliadas · ZIP de ${tamanoLegible(zipBlob.size)}`,
          url: zipUrl,
          nombre: enGrupos ? "grupos_foliados.zip" : "documentos_foliados.zip",
          abrir: null,
          lista: resultados,
        });
        return;
      }

      const doc = lista.length === 1 ? (await cargarPdf(lista[0].bytes)).doc : await unirDocumentos(lista);
      const total = doc.getPageCount();
      const plan = planFoliado(total);
      if (!plan.cantidad) throw new Error("Con estos ajustes no hay ninguna página para foliar.");
      const blob = await foliarDocumento(doc, plan, nombreDoc(), (h) =>
        progreso((h / plan.cantidad) * 90, `Foliando página ${h} de ${plan.cantidad}`)
      );
      const url = URL.createObjectURL(blob);
      resultadoUrls.push(url);
      const nombre = `${nombreDoc()}${lista.length > 1 ? "_unido" : ""}_foliado.pdf`;
      const [a, b] = cfg.orden === "inverso" ? [plan.ultimo, plan.primero] : [plan.primero, plan.ultimo];
      mostrarResultado({
        titulo: nombre,
        detalle: `${plan.cantidad} de ${total} páginas foliadas (${formatearNumero(a)} → ${formatearNumero(b)}) · ${tamanoLegible(blob.size)}`,
        url,
        nombre,
        abrir: url,
        lista: null,
      });
    } catch (e) {
      console.error(e);
      $("progreso").hidden = true;
      aviso(mensajeError(e), "err", 8000);
    } finally {
      ocupado = false;
      actualizarBoton();
    }
  }

  function progreso(pct, txt) {
    $("progresoFill").style.width = `${pct}%`;
    $("progresoTxt").textContent = txt;
  }

  function ocultarResultado() {
    $("resultado").hidden = true;
    resultadoUrls.forEach((u) => URL.revokeObjectURL(u));
    resultadoUrls = [];
  }

  const tamanoLegible = (b) =>
    b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;

  // ---------------------------------------------------------------------------
  // Interfaz: enlazar controles con cfg
  // ---------------------------------------------------------------------------
  function leerControl(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number" || el.type === "range" || el.dataset.num) {
      if (el.value === "") return "";
      const v = parseFloat(el.value);
      return Number.isFinite(v) ? v : "";
    }
    return el.value;
  }

  function escribirControles() {
    document.querySelectorAll("[data-cfg]").forEach((el) => {
      const v = cfg[el.dataset.cfg];
      if (el.type === "radio") el.checked = el.value === v;
      else if (el.type === "checkbox") el.checked = !!v;
      else if (document.activeElement !== el) el.value = v;
    });
  }

  function cambio(soloPosicion = false) {
    guardarAjustes();
    ocultarResultado();
    actualizarUI(soloPosicion);
    programarVista();
  }

  function actualizarBoton() {
    const plan = numPaginas ? planGlobal() : null;
    $("btnFoliar").disabled = !archivos.length || ocupado || (plan && !plan.cantidad);
    let txt = "Foliar Documentos";
    if (plan && plan.cantidad) {
      if (modo() === "grupos") txt = `Foliar ${plural(plan.documentos, "Grupo", "Grupos")}`;
      else if (modo() === "separado") txt = `Foliar ${plan.documentos} Documentos`;
      else txt = `Foliar ${plan.cantidad} ${plan.cantidad === 1 ? "Página" : "Páginas"}`;
    }
    $("btnFoliarTxt").textContent = txt;
  }

  function actualizarUI(soloPosicion = false) {
    if (!soloPosicion) escribirControles();
    else {
      // Durante el arrastre solo se refrescan los campos de posición libre
      document
        .querySelectorAll('[data-cfg="customX"],[data-cfg="customY"]')
        .forEach((el) => (el.value = cfg[el.dataset.cfg]));
    }

    const marcar = (sel, fn) => document.querySelectorAll(sel).forEach((b) => b.classList.toggle("on", fn(b)));
    marcar("[data-toggle]", (b) => !!cfg[b.dataset.toggle]);
    marcar("[data-alinear]", (b) => b.dataset.alinear === cfg.alineacion);
    marcar("[data-caja]", (b) => b.dataset.caja === cfg.caja);
    marcar("[data-pos]", (b) => b.dataset.pos === cfg.posicion);

    const libre = cfg.posicion === "custom";
    $("camposLibre").hidden = !libre;
    $("camposMargen").hidden = libre;
    document.querySelector(".color-a").style.setProperty("--swatch", cfg.color);
    $("outOpacidad").textContent = `${num(cfg.opacidad, 100)}%`;

    // Diseño
    $("opcionesCaja").classList.toggle("off", cfg.caja === "ninguna");
    $("hexBorde").textContent = String(cfg.colorBorde).toUpperCase();
    $("hexFondo").textContent = String(cfg.colorFondo).toUpperCase();
    $("btnFondo").textContent = cfg.fondo ? "Activado" : "Desactivado";
    $("btnFondo").classList.toggle("on", !!cfg.fondo);
    $("campoFondo").classList.toggle("off", !cfg.fondo);
    document.querySelector('[data-cfg="colorFondo"]').disabled = !cfg.fondo;

    // Orden
    $("infoOrden").textContent =
      cfg.orden === "inverso"
        ? "Comienza en la última página del documento y cuenta regresivamente hacia la primera."
        : "Comienza en la primera página del documento y cuenta progresivamente hacia la última.";

    // Fuente seleccionada
    const def = buscarFuente(cfg.fuente);
    Fuentes.cargarCss(def);
    const lab = $("fpLabel");
    lab.textContent = def.nombre;
    lab.style.fontFamily = def.css;
    let nota = "Con los ajustes actuales";
    if (def.web && ((cfg.negrita && !def.negrita) || (cfg.cursiva && !def.cursiva)))
      nota = `${def.nombre} no tiene ${cfg.negrita && !def.negrita ? "negrita" : "cursiva"} propia; se simula`;
    else if (def.subida && (cfg.negrita || cfg.cursiva)) nota = "Negrita/cursiva simuladas en fuentes subidas";
    $("notaFuente").textContent = nota;

    // Resumen del plan
    const total = numPaginas || 0;
    const res = $("resumenPlan");
    $("inDesde").max = total && !porSeparado() ? total : "";
    $("inHasta").max = total && !porSeparado() ? total : "";
    const varios = activos().length > 1 || (archivos.length > 1 && cfg.modoVarios === "grupos");
    $("modoVarios").hidden = !varios;
    document.querySelector(".upload-card").classList.toggle("varios", varios);
    if (total && porSeparado()) {
      const pg = planGlobal();
      res.className = pg.cantidad ? "plan" : "plan warn";
      if (!pg.cantidad) res.textContent = "Con estos ajustes no se foliará ninguna página.";
      else if (modo() === "grupos")
        res.textContent =
          `Por grupos: ${describirGrupos()}. Cada grupo empieza su propia numeración y se descarga como un PDF. ` +
          `Los ajustes de páginas se aplican a cada grupo.` +
          (sinGrupo().length
            ? ` ${plural(sinGrupo().length, "documento está sin grupo y no se foliará", "documentos están sin grupo y no se foliarán")}.`
            : "");
      else
        res.textContent =
          `Por separado: se foliarán ${pg.cantidad} páginas en ${pg.documentos} documentos. Cada documento lleva su propia numeración ` +
          `y los ajustes de páginas (desde, hasta, excluir) se aplican a cada uno.`;
    } else if (!total) {
      res.className = "plan";
      res.textContent = "";
    } else {
      const plan = planFoliado(total);
      if (!plan.cantidad) {
        res.className = "plan warn";
        res.textContent = "Con estos ajustes no se foliará ninguna página.";
      } else {
        res.className = "plan";
        const [ini, fin] = cfg.orden === "inverso" ? [plan.ultimo, plan.primero] : [plan.primero, plan.ultimo];
        res.textContent =
          `Se foliarán ${plan.cantidad} de ${total} páginas (pág. ${plan.desde} a ${plan.hasta}): ` +
          `la pág. ${plan.desde} lleva el folio ${formatearNumero(ini)} y la última foliada el ${formatearNumero(fin)}.`;
      }
    }

    // Vista previa de la fuente
    const planEj = total ? planGlobal().planes[0] : { primero: 1, ultimo: 20 };
    const ej = $("ejemplo");
    ej.textContent = textoFolio(Math.round(num(cfg.inicio, 1, 0)), planEj, 0).join("\n") || "—";
    Object.assign(ej.style, {
      fontFamily: def.css,
      fontWeight: cfg.negrita ? "700" : "500",
      fontStyle: cfg.cursiva ? "italic" : "normal",
      textDecoration: cfg.subrayado ? "underline" : "none",
    });

    pintarFolioSimulado();
    actualizarBoton();
    Selects.refrescar();
  }

  function enlazarControles() {
    document.querySelectorAll("[data-cfg]").forEach((el) => {
      const ev =
        el.tagName === "SELECT" || el.type === "radio" || el.type === "checkbox" || el.type === "color" ? "change" : "input";
      el.addEventListener(ev, () => {
        if (el.type === "radio" && !el.checked) return;
        cfg[el.dataset.cfg] = leerControl(el);
        cambio();
      });
      if (el.type === "color") {
        el.addEventListener("input", () => {
          cfg[el.dataset.cfg] = el.value;
          cambio();
        });
      }
    });
    const clic = (sel, fn) => document.querySelectorAll(sel).forEach((b) => b.addEventListener("click", () => fn(b)));
    clic("[data-toggle]", (b) => {
      cfg[b.dataset.toggle] = !cfg[b.dataset.toggle];
      cambio();
    });
    clic("[data-alinear]", (b) => {
      cfg.alineacion = b.dataset.alinear;
      cambio();
    });
    clic("[data-caja]", (b) => {
      cfg.caja = b.dataset.caja;
      cambio();
    });
    clic("[data-pos]", (b) => {
      cfg.posicion = b.dataset.pos;
      cambio();
    });
    $("btnFondo").addEventListener("click", () => {
      cfg.fondo = !cfg.fondo;
      cambio();
    });

    // Plantillas
    const menu = $("menuPlantillas");
    const btnMenu = $("btnPlantillas");
    const cerrarMenu = () => {
      menu.hidden = true;
      btnMenu.setAttribute("aria-expanded", "false");
    };
    btnMenu.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      btnMenu.setAttribute("aria-expanded", String(!menu.hidden));
      if (!menu.hidden) flotar(menu, btnMenu, "der");
    });
    const reubicarMenu = () => !menu.hidden && flotar(menu, btnMenu, "der");
    window.addEventListener("resize", reubicarMenu);
    document.addEventListener("scroll", reubicarMenu, true);
    clic("[data-plantilla]", (b) => {
      cfg.plantilla = b.dataset.plantilla;
      cerrarMenu();
      cambio();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !btnMenu.contains(e.target)) cerrarMenu();
    });

    clic("[data-ins]", (b) => {
      const ta = $("inPlantilla");
      const ins = b.dataset.ins;
      const i = ta.selectionStart ?? ta.value.length;
      const j = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, i) + ins + ta.value.slice(j);
      ta.focus();
      ta.setSelectionRange(i + ins.length, i + ins.length);
      cfg.plantilla = ta.value;
      cambio();
    });

    $("btnReset").addEventListener("click", () => {
      cfg = { ...DEFAULTS };
      cambio();
      aviso("Ajustes restablecidos a los valores por defecto.", "ok");
    });
  }

  // ---------------------------------------------------------------------------
  // Selector de fuentes estilo Word
  // ---------------------------------------------------------------------------
  function configurarSelectorFuentes() {
    const btn = $("fpBtn");
    const pop = $("fpPop");
    const buscar = $("fpBuscar");
    const listaEl = $("fpLista");

    const abrir = () => {
      pop.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      Fuentes.lista.forEach(Fuentes.cargarCss);
      buscar.value = "";
      pintar();
      flotar(pop, btn);
      buscar.focus({ preventScroll: true });
      const sel = listaEl.querySelector(".sel");
      if (sel) sel.scrollIntoView({ block: "center" });
    };
    const cerrar = () => {
      pop.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    };

    function pintar() {
      const q = buscar.value.trim().toLowerCase();
      listaEl.innerHTML = "";
      const grupos = {};
      for (const f of [...Fuentes.lista, ...fuentesUsuario]) {
        if (q && !`${f.nombre} ${f.nota || ""}`.toLowerCase().includes(q)) continue;
        (grupos[f.grupo] = grupos[f.grupo] || []).push(f);
      }
      let hay = false;
      for (const g of ["mias", "std", "word", "sans", "serif", "mono", "deco"]) {
        if (!grupos[g]) continue;
        hay = true;
        const h = document.createElement("div");
        h.className = "fp-group";
        h.textContent = Fuentes.GRUPOS[g];
        listaEl.append(h);
        for (const f of grupos[g]) {
          const it = document.createElement("button");
          it.type = "button";
          it.className = "fp-item" + (f.id === cfg.fuente ? " sel" : "");
          it.setAttribute("role", "option");
          it.style.fontFamily = f.css;
          it.textContent = f.nombre;
          if (f.nota) {
            const sm = document.createElement("small");
            sm.textContent = f.nota;
            it.append(sm);
          }
          it.addEventListener("click", () => {
            cfg.fuente = f.id;
            cerrar();
            cambio();
          });
          listaEl.append(it);
        }
      }
      if (!hay) {
        const v = document.createElement("div");
        v.className = "fp-empty";
        v.textContent = "No se encontró esa fuente. Puedes subirla o usar las de tu PC.";
        listaEl.append(v);
      }
    }

    btn.addEventListener("click", () => (pop.hidden ? abrir() : cerrar()));
    const reubicar = (e) => {
      if (pop.hidden || (e && e.target instanceof Node && pop.contains(e.target))) return;
      flotar(pop, btn);
    };
    window.addEventListener("resize", reubicar);
    document.addEventListener("scroll", reubicar, true);
    buscar.addEventListener("input", pintar);
    buscar.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cerrar();
      if (e.key === "Enter") {
        const primero = listaEl.querySelector(".fp-item");
        if (primero) primero.click();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) cerrar();
    });

    // Subir una fuente propia
    $("btnSubirFuente").addEventListener("click", () => $("inputFuente").click());
    $("inputFuente").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        const bytes = fuenteSuelta(await f.arrayBuffer());
        const info = fontkit.create(new Uint8Array(bytes));
        if (!info || typeof info.layout !== "function") throw new Error("formato no compatible (usa .ttf, .otf o .ttc)");
        const id = `subida-${++contadorSubidas}`;
        const familia = `FU-${contadorSubidas}`;
        const ff = new FontFace(familia, bytes.slice(0));
        document.fonts.add(await ff.load());
        fuentesUsuario.push({
          id,
          nombre: info.familyName || f.name.replace(/\.(ttf|otf)$/i, ""),
          nota: "subida",
          grupo: "mias",
          subida: true,
          bytes,
          css: `"${familia}", sans-serif`,
        });
        cfg.fuente = id;
        cerrar();
        cambio();
        aviso(`Fuente "${info.familyName || f.name}" lista para usar.`, "ok");
      } catch (err) {
        aviso(`No se pudo usar esa fuente: ${err.message}`, "err", 7000);
      }
    });

    // Fuentes instaladas en el equipo (Chrome / Edge)
    $("btnFuentesPC").addEventListener("click", async () => {
      if (!("queryLocalFonts" in window)) {
        aviso(
          "Tu navegador no permite leer las fuentes instaladas. Usa Chrome o Edge, o sube el archivo .ttf (en Windows están en C:\\Windows\\Fonts).",
          "warn",
          9000
        );
        return;
      }
      try {
        const lista = await window.queryLocalFonts();
        if (!lista.length) throw new Error("el navegador no devolvió fuentes (revisa los permisos del sitio)");
        const familias = new Map();
        for (const fd of lista) {
          const est = (fd.style || "").toLowerCase();
          const b = /bold|negrita|black|heavy/.test(est) && !/semi|demi|light/.test(est);
          const i = /italic|oblique|cursiva/.test(est);
          const clave = (b ? "b" : "") + (i ? "i" : "") || "n";
          if (clave === "n" && !/^(regular|normal|book|roman|medium)?$/.test(est.replace(/\s+/g, ""))) continue;
          if (!familias.has(fd.family)) familias.set(fd.family, {});
          const v = familias.get(fd.family);
          const exacto = /^(regular|bold|italic|bold italic|normal)$/.test(est);
          if (!v[clave] || exacto) v[clave] = fd;
        }
        for (let i = fuentesUsuario.length - 1; i >= 0; i--) if (fuentesUsuario[i].sistema) fuentesUsuario.splice(i, 1);
        for (const [familia, variantes] of [...familias].sort((a, b) => a[0].localeCompare(b[0]))) {
          if (!Object.keys(variantes).length) continue;
          fuentesUsuario.push({
            id: `sis-${familia}`,
            nombre: familia,
            nota: "de tu PC",
            grupo: "mias",
            sistema: true,
            variantes,
            css: `"${familia}", sans-serif`,
          });
        }
        pintar();
        aviso(`Se agregaron ${familias.size} fuentes de tu equipo (arriba de la lista).`, "ok");
        listaEl.scrollTop = 0;
      } catch (err) {
        aviso(`No se pudieron leer las fuentes del equipo: ${err.message}`, "err", 7000);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Utilidades de interfaz
  // ---------------------------------------------------------------------------
  // Coloca un menú flotante junto a su botón, dentro de la ventana y sin recortarse en el panel
  function flotar(pop, ancla, alinear = "izq") {
    // Se mueve al <body>: dentro de las tarjetas (backdrop-filter) un "fixed" quedaría recortado
    if (pop.parentElement !== document.body) document.body.append(pop);
    pop.classList.add("flotante");
    const r = ancla.getBoundingClientRect();
    const m = 8;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let x = alinear === "der" ? r.right - w : r.left;
    x = Math.max(m, Math.min(window.innerWidth - w - m, x));
    let y = r.bottom + 6;
    if (y + h > window.innerHeight - m && r.top - 6 - h > m) y = r.top - 6 - h;
    y = Math.max(m, Math.min(window.innerHeight - h - m, y));
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
  }

  function aviso(texto, tipo = "info", ms = 4500) {
    const t = document.createElement("div");
    t.className = `toast ${tipo}`;
    t.textContent = texto;
    $("toasts").append(t);
    setTimeout(() => t.remove(), ms);
  }

  function cargando(si, texto) {
    $("overlay").hidden = !si;
    if (texto) $("overlayTxt").textContent = texto;
  }

  function configurarArchivos() {
    const input = $("inputArchivo");
    const abrir = () => input.click();
    for (const id of ["dropzone", "ctaVacio"]) {
      $(id).addEventListener("click", abrir);
      $(id).addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          abrir();
        }
      });
    }
    $("btnAgregar").addEventListener("click", abrir);
    $("btnQuitarTodo").addEventListener("click", () => {
      archivos.length = 0;
      cerrarModal();
      reconstruir();
    });
    input.addEventListener("change", () => {
      if (input.files.length) agregarArchivos(input.files);
      input.value = "";
    });

    let profundidad = 0;
    const tieneArchivos = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    window.addEventListener("dragenter", (e) => {
      if (!tieneArchivos(e)) return;
      e.preventDefault();
      profundidad++;
      document.body.classList.add("dragover");
    });
    window.addEventListener("dragover", (e) => tieneArchivos(e) && e.preventDefault());
    window.addEventListener("dragleave", () => {
      profundidad = Math.max(0, profundidad - 1);
      if (!profundidad) document.body.classList.remove("dragover");
    });
    window.addEventListener("drop", (e) => {
      if (!tieneArchivos(e)) return;
      e.preventDefault();
      profundidad = 0;
      document.body.classList.remove("dragover");
      if (e.dataTransfer.files.length) agregarArchivos(e.dataTransfer.files);
    });
  }

  function configurarNavegacion() {
    $("btnPrev").addEventListener("click", () => irA(paginaActual - 1));
    $("btnNext").addEventListener("click", () => irA(paginaActual + 1));
    $("inPagina").addEventListener("change", (e) => irA(rangoVista().ini + (parseInt(e.target.value, 10) - 1 || 0)));
    $("selDoc").addEventListener("change", (e) => {
      docVista = Number(e.target.value);
      if (docVista >= 0) paginaActual = rangoVista().ini; // "Todos" conserva la página que se estaba viendo
      pintarSelectorDoc();
      actualizarVista();
    });
    $("btnZoomMenos").addEventListener("click", () => cambiarZoom(-1));
    $("btnZoomMas").addEventListener("click", () => cambiarZoom(1));
    $("zoomValor").addEventListener("click", () => cambiarZoom(0));
    document.addEventListener("keydown", (e) => {
      if (!srcDoc || !$("modalDocs").hidden || e.target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") irA(paginaActual - 1);
      if (e.key === "ArrowRight") irA(paginaActual + 1);
    });
    let tamPrevio = `${window.innerWidth}x${window.innerHeight}`;
    window.addEventListener("resize", () => {
      const t = `${window.innerWidth}x${window.innerHeight}`;
      if (t === tamPrevio) return;
      tamPrevio = t;
      if (srcDoc) programarVista();
    });
  }

  function configurarPestanas() {
    const botones = document.querySelectorAll("[data-tab]");
    const mostrar = (id) => {
      botones.forEach((b) => {
        const on = b.dataset.tab === id;
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", String(on));
      });
      document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== id));
      try {
        localStorage.setItem("foleo.pestana2", id);
      } catch (e) {}
    };
    botones.forEach((b) => b.addEventListener("click", () => mostrar(b.dataset.tab)));
    let inicial = "basico";
    try {
      inicial = localStorage.getItem("foleo.pestana2") || "basico";
    } catch (e) {}
    mostrar(document.querySelector(`[data-tab="${inicial}"]`) ? inicial : "basico");
  }

  // Botones "?" de ayuda: texto al pasar el mouse y aviso al hacer clic (útil en pantallas táctiles)
  function configurarAyudas() {
    document.querySelectorAll("[data-ayuda]").forEach((el) => (el.title = el.dataset.ayuda));
    const mostrar = (e) => {
      const el = e.target.closest("[data-ayuda]");
      if (!el) return;
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll(".toast.ayuda").forEach((t) => t.remove());
      aviso(el.dataset.ayuda, "info ayuda", 9000);
    };
    document.addEventListener("click", mostrar, true);
    document.addEventListener("keydown", mostrar, true);
  }

  function configurarTema() {
    $("btnTema").addEventListener("click", () => {
      const nuevo = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = nuevo;
      try {
        localStorage.setItem("foleo.tema", nuevo);
      } catch (e) {}
    });
  }

  // ---------------------------------------------------------------------------
  Selects.iniciar({ flotar });
  enlazarControles();
  configurarSelectorFuentes();
  configurarArchivos();
  configurarNavegacion();
  configurarArrastre();
  configurarTema();
  configurarPestanas();
  configurarAyudas();
  configurarModal();
  $("btnFoliar").addEventListener("click", foliar);
  actualizarUI();
  actualizarVista();
  if (document.fonts) document.fonts.addEventListener("loadingdone", pintarFolioSimulado);
})();
