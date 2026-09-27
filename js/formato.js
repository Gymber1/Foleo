/* Utilidades de formato: números en letras (español), romanos y rangos de páginas. */
window.Formato = (() => {
  const UNI = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];
  const DIEZ_A_29 = [
    "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve",
    "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete",
    "veintiocho", "veintinueve",
  ];
  const DEC = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
  const CEN = [
    "", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos",
    "ochocientos", "novecientos",
  ];

  function menorMil(n) {
    if (n === 100) return "cien";
    const c = Math.floor(n / 100);
    const r = n % 100;
    const partes = [];
    if (c) partes.push(CEN[c]);
    if (r) {
      if (r < 10) partes.push(UNI[r]);
      else if (r < 30) partes.push(DIEZ_A_29[r - 10]);
      else {
        const d = Math.floor(r / 10);
        const u = r % 10;
        partes.push(u ? `${DEC[d]} y ${UNI[u]}` : DEC[d]);
      }
    }
    return partes.join(" ");
  }

  // "uno" delante de "mil"/"millones" se apocopa: veintiún mil, treinta y un mil
  const apocopar = (t) => t.replace(/veintiuno$/, "veintiún").replace(/uno$/, "un");

  function aLetras(num) {
    let n = Math.floor(Math.abs(num));
    if (n === 0) return "cero";
    if (n >= 1e9) return String(n);
    const partes = [];
    const millones = Math.floor(n / 1e6);
    n %= 1e6;
    const miles = Math.floor(n / 1000);
    const resto = n % 1000;
    if (millones === 1) partes.push("un millón");
    else if (millones > 1) partes.push(`${apocopar(menorMil(millones))} millones`);
    if (miles === 1) partes.push("mil");
    else if (miles > 1) partes.push(`${apocopar(menorMil(miles))} mil`);
    if (resto) partes.push(menorMil(resto));
    return partes.join(" ");
  }

  function romano(n) {
    if (n <= 0 || n > 3999) return String(n);
    const tabla = [
      [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
      [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
    ];
    let s = "";
    for (const [v, r] of tabla) {
      while (n >= v) {
        s += r;
        n -= v;
      }
    }
    return s;
  }

  // 1 -> A, 26 -> Z, 27 -> AA (como las columnas de Excel)
  function alfabetico(n) {
    if (n <= 0) return String(n);
    let s = "";
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // "2, 5-7, 10" -> Set{2,5,6,7,10} (páginas 1-based, limitadas a [1, max])
  function parseRangos(texto, max) {
    const set = new Set();
    for (const trozo of String(texto || "").split(/[,;\s]+/)) {
      if (!trozo) continue;
      const m = trozo.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      let a = parseInt(m[1], 10);
      let b = m[2] ? parseInt(m[2], 10) : a;
      if (a > b) [a, b] = [b, a];
      for (let p = Math.max(1, a); p <= Math.min(max, b); p++) set.add(p);
    }
    return set;
  }

  return { aLetras, romano, alfabetico, parseRangos };
})();
