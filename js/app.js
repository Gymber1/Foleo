(() => {
  "use strict";

  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const $ = (id) => document.getElementById(id);
  const CM = 72 / 2.54; // puntos por centímetro
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
    colorBorde: "#000000",
    fondo: false,
    colorFondo: "#ffffff",
    relleno: 4,
  };

  let cfg = cargarAjustes();

  // Estado de los documentos
  const archivos = []; // { nombre, tipo, bytes, doc, paginas }
  let srcDoc = null; // documento (unido) que se muestra en la vista previa
  let numPaginas = 0;
  let paginaActual = 0;
  let resultadoUrl = null;
  let ocupado = false;

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

  function formatearNumero(n) {
    if (cfg.estilo === "romano-may") return Formato.romano(n);
    if (cfg.estilo === "romano-min") return Formato.romano(n).toLowerCase();
    return String(n).padStart(Math.round(num(cfg.digitos, 1, 1, 8)), "0");
  }

  function textoFolio(n, plan, idx) {
    let letras = Formato.aLetras(n);
    if (cfg.letrasCaso === "may") letras = letras.toUpperCase();
    else if (cfg.letrasCaso === "cap") letras = letras.charAt(0).toUpperCase() + letras.slice(1);
    const vars = {
      n: formatearNumero(n),
      letras,
      total: formatearNumero(Math.max(plan.ultimo, plan.primero)),
      pag: String(idx + 1),
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
      let elegida = orden.find((k) => def.variantes[k]) || Object.keys(def.variantes)[0];
      falsaNegrita = b && !elegida.includes("b");
      falsaCursiva = i && !elegida.includes("i");
      const fd = def.variantes[elegida];
      bytes = await bytesDe(`sys:${fd.postscriptName}`, async () => (await fd.blob()).arrayBuffer());
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
    const asc = font.heightAtSize(s, { descender: false });
    const desc = Math.max(0, font.heightAtSize(s) - asc) * 0.6;
    const anchos = lineas.map((t) => font.widthOfTextAtSize(t, s));
    const cw = Math.max(...anchos) + (fx.falsaCursiva ? s * 0.15 : 0);
    const ch = asc + desc + (lineas.length - 1) * salto;

    const caja = cfg.caja;
    const hayCaja = caja !== "ninguna" || cfg.fondo;
    const pad = hayCaja ? num(cfg.relleno, 4, 0, 50) : 0;
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
    const grosor = num(cfg.grosor, 1, 0.1, 20);
    const conBorde = caja !== "ninguna";

    // Recuadro / fondo
    if (hayCaja) {
      const estilo = { opacity: op, borderOpacity: op };
      if (cfg.fondo) estilo.color = hexRgb(cfg.colorFondo);
      if (conBorde) {
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

  function foliarPagina(page, fx, plan, idx) {
    const n = plan.mapa.get(idx);
    if (n === undefined) return false;
    dibujarFolio(page, fx, textoFolio(n, plan, idx), (idx + 1) % 2 === 0);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Archivos
  // ---------------------------------------------------------------------------
  const esDocx = (f) => /\.docx$/i.test(f.name) || f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
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
    if (todos.some((f) => /\.doc$/i.test(f.name)))
      aviso("Los archivos .doc antiguos no son compatibles. Guárdalo como .docx o PDF desde Word.", "warn");
    if (!validos.length) {
      if (!todos.some((f) => /\.doc$/i.test(f.name))) aviso("Solo se aceptan archivos PDF o Word (.docx).", "err");
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
        archivos.push({ nombre: f.name, tipo, bytes, doc, paginas: doc.getPageCount() });
      } catch (e) {
        console.error(e);
        aviso(`No se pudo leer "${f.name}": ${e.message || e}`, "err", 8000);
      }
    }
    cargando(false);
    await reconstruir();
  }

  async function unirDocumentos() {
    const unido = await PDFDocument.create();
    for (const a of archivos) {
      const paginas = await unido.copyPages(a.doc, a.doc.getPageIndices());
      paginas.forEach((p) => unido.addPage(p));
    }
    return unido;
  }

  async function reconstruir() {
    ocultarResultado();
    if (!archivos.length) {
      srcDoc = null;
      numPaginas = 0;
      paginaActual = 0;
    } else {
      cargando(true, "Preparando vista previa…");
      srcDoc = archivos.length === 1 ? archivos[0].doc : await unirDocumentos();
      numPaginas = srcDoc.getPageCount();
      paginaActual = Math.min(paginaActual, numPaginas - 1);
    }
    pintarArchivos();
    actualizarUI();
    await actualizarVista();
  }

  function pintarArchivos() {
    const ul = $("listaArchivos");
    ul.innerHTML = "";
    archivos.forEach((a, i) => {
      const li = document.createElement("li");
      const tag = document.createElement("span");
      tag.className = `ftag ${a.tipo}`;
      tag.textContent = a.tipo === "docx" ? "W" : "PDF";
      const nombre = document.createElement("span");
      nombre.className = "fname";
      nombre.textContent = a.nombre;
      nombre.title = a.nombre;
      const meta = document.createElement("span");
      meta.className = "fmeta";
      meta.textContent = `${a.paginas} pág.`;
      li.append(tag, nombre, meta);
      const botones = [
        ["↑", "Subir", i === 0, () => mover(i, -1)],
        ["↓", "Bajar", i === archivos.length - 1, () => mover(i, 1)],
        ["✕", "Quitar", false, () => quitar(i)],
      ];
      for (const [txt, titulo, desactivado, fn] of botones) {
        if (archivos.length === 1 && txt !== "✕") continue;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "mini";
        b.textContent = txt;
        b.title = titulo;
        b.disabled = desactivado;
        b.addEventListener("click", fn);
        li.append(b);
      }
      ul.append(li);
    });
    $("btnQuitarTodo").hidden = archivos.length < 2;
    $("btnAgregar").textContent = archivos.length ? "＋ Agregar más" : "＋ Agregar PDF o Word";
    $("hintArchivos").hidden = archivos.length > 0;
  }

  function mover(i, d) {
    const j = i + d;
    if (j < 0 || j >= archivos.length) return;
    [archivos[i], archivos[j]] = [archivos[j], archivos[i]];
    reconstruir();
  }

  function quitar(i) {
    archivos.splice(i, 1);
    reconstruir();
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
    $("dropzone").hidden = hayDoc;
    $("canvasWrap").hidden = !hayDoc;
    $("barraVista").hidden = !hayDoc;
    $("hintVista").hidden = !hayDoc;
    if (!hayDoc) {
      cargando(false);
      return;
    }

    const plan = planFoliado(numPaginas);
    const n = plan.mapa.get(paginaActual);
    const badge = $("badgeFolio");
    badge.className = n === undefined ? "badge off" : "badge";
    badge.textContent = n === undefined ? "Sin folio" : `Folio: ${textoFolio(n, plan, paginaActual).join(" ")}`;
    $("inPagina").value = paginaActual + 1;
    $("inPagina").max = numPaginas;
    $("totalPaginas").textContent = numPaginas;
    $("btnPrev").disabled = paginaActual <= 0;
    $("btnNext").disabled = paginaActual >= numPaginas - 1;
    pintarMarcador();

    try {
      const doc = await PDFDocument.create();
      const [pag] = await doc.copyPages(srcDoc, [paginaActual]);
      doc.addPage(pag);
      if (n !== undefined) {
        const fx = await obtenerFuente(doc);
        foliarPagina(pag, fx, plan, paginaActual);
      }
      const bytes = await doc.save();
      if (turno !== turnoVista) return;

      const tarea = pdfjsLib.getDocument({ data: bytes });
      const pdf = await tarea.promise;
      const p = await pdf.getPage(1);
      const base = p.getViewport({ scale: 1 });
      const stage = $("stage");
      const anchoDisp = stage.clientWidth - 36;
      const altoDisp = window.innerWidth > 900 ? window.innerHeight - 190 : window.innerHeight * 0.7;
      const escala = Math.max(0.1, Math.min(anchoDisp / base.width, altoDisp / base.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const vp = p.getViewport({ scale: escala * dpr });
      const tmp = document.createElement("canvas");
      tmp.width = Math.floor(vp.width);
      tmp.height = Math.floor(vp.height);
      await p.render({ canvasContext: tmp.getContext("2d"), viewport: vp }).promise;
      pdf.destroy();
      if (turno !== turnoVista) return;

      const lienzo = $("lienzo");
      lienzo.width = tmp.width;
      lienzo.height = tmp.height;
      lienzo.style.width = `${tmp.width / dpr}px`;
      lienzo.style.height = `${tmp.height / dpr}px`;
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
    if (cfg.espejo && (paginaActual + 1) % 2 === 0) x = 100 - x;
    mk.style.left = `${x}%`;
    mk.style.top = `${num(cfg.customY, 50, 0, 100)}%`;
    mk.hidden = false;
  }

  function irA(p) {
    if (!numPaginas) return;
    const nueva = Math.max(0, Math.min(numPaginas - 1, p));
    if (nueva === paginaActual) {
      $("inPagina").value = paginaActual + 1;
      return;
    }
    paginaActual = nueva;
    actualizarVista();
  }

  // Clic / arrastre sobre la página para colocar el folio
  function configurarArrastre() {
    const lienzo = $("lienzo");
    let arrastrando = false;
    const colocar = (ev) => {
      const r = lienzo.getBoundingClientRect();
      let x = ((ev.clientX - r.left) / r.width) * 100;
      const y = ((ev.clientY - r.top) / r.height) * 100;
      if (cfg.espejo && (paginaActual + 1) % 2 === 0) x = 100 - x;
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

  // ---------------------------------------------------------------------------
  // Generar el PDF final
  // ---------------------------------------------------------------------------
  const pausa = () => new Promise((r) => setTimeout(r, 0));

  async function foliar() {
    if (!archivos.length || ocupado) return;
    ocupado = true;
    ocultarResultado();
    const boton = $("btnFoliar");
    boton.disabled = true;
    $("progreso").hidden = false;
    progreso(0, "Preparando…");
    try {
      const doc =
        archivos.length === 1 ? (await cargarPdf(archivos[0].bytes)).doc : await unirDocumentos();
      const total = doc.getPageCount();
      const plan = planFoliado(total);
      if (!plan.cantidad) throw new Error("Con estos ajustes no hay ninguna página para foliar.");
      const fx = await obtenerFuente(doc);
      const paginas = doc.getPages();
      let hechas = 0;
      for (const idx of plan.mapa.keys()) {
        foliarPagina(paginas[idx], fx, plan, idx);
        hechas++;
        if (hechas % 20 === 0 || hechas === plan.cantidad) {
          progreso((hechas / plan.cantidad) * 90, `Foliando página ${hechas} de ${plan.cantidad}`);
          await pausa();
        }
      }
      progreso(94, "Guardando PDF…");
      await pausa();
      const bytes = await doc.save();
      const blob = new Blob([bytes], { type: "application/pdf" });
      resultadoUrl = URL.createObjectURL(blob);

      const base = archivos[0].nombre.replace(/\.(pdf|docx)$/i, "");
      const nombre = `${base}${archivos.length > 1 ? "_unido" : ""}_foliado.pdf`;
      $("btnDescargar").href = resultadoUrl;
      $("btnDescargar").download = nombre;
      $("btnAbrir").href = resultadoUrl;
      $("resNombre").textContent = nombre;
      const [a, b] = cfg.orden === "inverso" ? [plan.ultimo, plan.primero] : [plan.primero, plan.ultimo];
      $("resDetalle").textContent =
        `${plan.cantidad} de ${total} páginas foliadas (${formatearNumero(a)} → ${formatearNumero(b)}) · ${tamanoLegible(blob.size)}`;
      progreso(100, "¡Listo!");
      $("resultado").hidden = false;
      setTimeout(() => ($("progreso").hidden = true), 600);
    } catch (e) {
      console.error(e);
      $("progreso").hidden = true;
      aviso(mensajeError(e), "err", 8000);
    } finally {
      ocupado = false;
      boton.disabled = !archivos.length;
    }
  }

  function progreso(pct, txt) {
    $("progresoFill").style.width = `${pct}%`;
    $("progresoTxt").textContent = txt;
  }

  function ocultarResultado() {
    $("resultado").hidden = true;
    if (resultadoUrl) {
      URL.revokeObjectURL(resultadoUrl);
      resultadoUrl = null;
    }
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

  function cambio(soloVista = false) {
    guardarAjustes();
    ocultarResultado();
    actualizarUI(soloVista);
    programarVista();
  }

  function actualizarUI(soloVista = false) {
    if (!soloVista) escribirControles();
    else {
      // Solo refrescar los campos de posición libre durante el arrastre
      document.querySelectorAll('[data-cfg="customX"],[data-cfg="customY"]').forEach((el) => (el.value = cfg[el.dataset.cfg]));
    }

    document.querySelectorAll("[data-toggle]").forEach((b) => {
      const on = !!cfg[b.dataset.toggle];
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on);
    });
    document.querySelectorAll("[data-alinear]").forEach((b) => b.classList.toggle("on", b.dataset.alinear === cfg.alineacion));
    document.querySelectorAll("[data-caja]").forEach((b) => b.classList.toggle("on", b.dataset.caja === cfg.caja));
    document.querySelectorAll("[data-pos]").forEach((b) => {
      const on = b.dataset.pos === cfg.posicion;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", on);
    });
    const libre = cfg.posicion === "custom";
    $("camposLibre").hidden = !libre;
    $("camposMargen").hidden = libre;
    $("hintPos").textContent = libre
      ? "Haz clic o arrastra sobre la vista previa para mover el folio."
      : "Elige una de las 9 posiciones o usa la posición libre para colocarlo donde quieras.";
    document.querySelector(".color-a").style.setProperty("--swatch", cfg.color);
    $("outOpacidad").textContent = `${num(cfg.opacidad, 100)}%`;

    // Fuente seleccionada
    const def = buscarFuente(cfg.fuente);
    Fuentes.cargarCss(def);
    const lab = $("fpLabel");
    lab.textContent = def.nombre;
    lab.style.fontFamily = def.css;
    lab.style.fontWeight = cfg.negrita ? "700" : "400";
    lab.style.fontStyle = cfg.cursiva ? "italic" : "normal";
    let nota = "";
    if (def.web && ((cfg.negrita && !def.negrita) || (cfg.cursiva && !def.cursiva)))
      nota = `${def.nombre} no tiene ${cfg.negrita && !def.negrita ? "negrita" : "cursiva"} propia; se simula.`;
    else if (def.subida && (cfg.negrita || cfg.cursiva)) nota = "En fuentes subidas la negrita y cursiva se simulan.";
    else if (def.web) nota = "Se descarga una sola vez y se incrusta en el PDF.";
    $("notaFuente").textContent = nota;

    // Resumen del plan
    const total = numPaginas || 0;
    const res = $("resumenPlan");
    $("inDesde").max = total || "";
    $("inHasta").max = total || "";
    if (!total) {
      res.className = "summary";
      res.textContent =
        cfg.orden === "inverso"
          ? "La última página llevará el número inicial y se contará hacia atrás hasta la primera."
          : "La primera página llevará el número inicial y se contará hacia adelante.";
    } else {
      const plan = planFoliado(total);
      if (!plan.cantidad) {
        res.className = "summary warn";
        res.textContent = "Con estos ajustes no se foliará ninguna página.";
      } else {
        res.className = "summary";
        const [ini, fin] = cfg.orden === "inverso" ? [plan.ultimo, plan.primero] : [plan.primero, plan.ultimo];
        res.textContent =
          `Se foliarán ${plan.cantidad} de ${total} páginas (de la pág. ${plan.desde} a la ${plan.hasta}). ` +
          `La pág. ${plan.desde} lleva el folio ${formatearNumero(ini)} y la última foliada el ${formatearNumero(fin)}.`;
      }
    }

    // Ejemplo del texto
    const planEj = total ? planFoliado(total) : { primero: num(cfg.inicio, 1), ultimo: num(cfg.inicio, 1) + 19 };
    const nEj = Math.round(num(cfg.inicio, 1, 0));
    $("ejemplo").textContent = textoFolio(nEj, planEj, 0).join("\n") || "(vacío)";

    const plan = total ? planFoliado(total) : null;
    $("btnFoliar").disabled = !archivos.length || ocupado || (plan && !plan.cantidad);
    $("btnFoliar").textContent = plan && plan.cantidad ? `Foliar ${plan.cantidad} páginas y generar PDF` : "Foliar y generar PDF";
  }

  function enlazarControles() {
    document.querySelectorAll("[data-cfg]").forEach((el) => {
      const ev = el.tagName === "SELECT" || el.type === "radio" || el.type === "checkbox" || el.type === "color" ? "change" : "input";
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
    document.querySelectorAll("[data-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        cfg[b.dataset.toggle] = !cfg[b.dataset.toggle];
        cambio();
      })
    );
    document.querySelectorAll("[data-alinear]").forEach((b) =>
      b.addEventListener("click", () => {
        cfg.alineacion = b.dataset.alinear;
        cambio();
      })
    );
    document.querySelectorAll("[data-caja]").forEach((b) =>
      b.addEventListener("click", () => {
        cfg.caja = b.dataset.caja;
        cambio();
      })
    );
    document.querySelectorAll("[data-pos]").forEach((b) =>
      b.addEventListener("click", () => {
        cfg.posicion = b.dataset.pos;
        cambio();
      })
    );
    $("selPlantilla").addEventListener("change", (e) => {
      if (!e.target.value) return;
      cfg.plantilla = e.target.value;
      e.target.value = "";
      cambio();
    });
    document.querySelectorAll("[data-ins]").forEach((b) =>
      b.addEventListener("click", () => {
        const ta = $("inPlantilla");
        const ins = b.dataset.ins;
        const i = ta.selectionStart ?? ta.value.length;
        const j = ta.selectionEnd ?? ta.value.length;
        ta.value = ta.value.slice(0, i) + ins + ta.value.slice(j);
        ta.focus();
        ta.setSelectionRange(i + ins.length, i + ins.length);
        cfg.plantilla = ta.value;
        cambio();
      })
    );
    $("btnReset").addEventListener("click", () => {
      cfg = { ...DEFAULTS };
      cambio();
      aviso("Ajustes restablecidos.", "ok");
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
      buscar.focus();
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
      const todas = [...Fuentes.lista, ...fuentesUsuario];
      const grupos = {};
      for (const f of todas) {
        const texto = `${f.nombre} ${f.nota || ""}`.toLowerCase();
        if (q && !texto.includes(q)) continue;
        (grupos[f.grupo] = grupos[f.grupo] || []).push(f);
      }
      const ordenGrupos = ["mias", "std", "word", "sans", "serif", "mono", "deco"];
      let hay = false;
      for (const g of ordenGrupos) {
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
        v.className = "hint";
        v.style.padding = "8px";
        v.textContent = "No se encontró esa fuente. Puedes subirla o usar las de tu PC.";
        listaEl.append(v);
      }
    }

    btn.addEventListener("click", () => (pop.hidden ? abrir() : cerrar()));
    buscar.addEventListener("input", pintar);
    buscar.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cerrar();
      if (e.key === "Enter") {
        const primero = listaEl.querySelector(".fp-item");
        if (primero) primero.click();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!pop.hidden && !$("fontpicker").contains(e.target)) cerrar();
    });

    // Subir una fuente propia
    $("btnSubirFuente").addEventListener("click", () => $("inputFuente").click());
    $("inputFuente").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        const bytes = await f.arrayBuffer();
        const info = fontkit.create(new Uint8Array(bytes));
        if (!info || typeof info.layout !== "function") throw new Error("formato no compatible (usa .ttf u .otf)");
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
    $("dropzone").addEventListener("click", abrir);
    $("dropzone").addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && abrir());
    $("btnAgregar").addEventListener("click", abrir);
    $("btnQuitarTodo").addEventListener("click", () => {
      archivos.length = 0;
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
    $("inPagina").addEventListener("change", (e) => irA(parseInt(e.target.value, 10) - 1 || 0));
    document.addEventListener("keydown", (e) => {
      if (!srcDoc || e.target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") irA(paginaActual - 1);
      if (e.key === "ArrowRight") irA(paginaActual + 1);
    });
    let anchoPrevio = window.innerWidth;
    window.addEventListener("resize", () => {
      if (Math.abs(window.innerWidth - anchoPrevio) < 40) return;
      anchoPrevio = window.innerWidth;
      programarVista();
    });
  }

  function configurarPestanas() {
    const botones = document.querySelectorAll("[data-tab]");
    const mostrar = (id) => {
      botones.forEach((b) => {
        const on = b.dataset.tab === id;
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", on);
      });
      document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== id));
      try {
        localStorage.setItem("foleo.pestana", id);
      } catch (e) {}
    };
    botones.forEach((b) => b.addEventListener("click", () => mostrar(b.dataset.tab)));
    let inicial = "num";
    try {
      inicial = localStorage.getItem("foleo.pestana") || "num";
    } catch (e) {}
    mostrar(document.querySelector(`[data-tab="${inicial}"]`) ? inicial : "num");
  }

  function configurarTema() {
    $("btnTema").addEventListener("click", () => {
      const actual =
        document.documentElement.dataset.theme ||
        (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
      const nuevo = actual === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = nuevo;
      try {
        localStorage.setItem("foleo.tema", nuevo);
      } catch (e) {}
    });
  }

  // ---------------------------------------------------------------------------
  enlazarControles();
  configurarSelectorFuentes();
  configurarArchivos();
  configurarNavegacion();
  configurarArrastre();
  configurarTema();
  configurarPestanas();
  $("btnFoliar").addEventListener("click", foliar);
  actualizarUI();
  actualizarVista();
})();
