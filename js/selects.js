/* Desplegables con el mismo estilo del selector de fuentes.
 * El <select> original sigue siendo la fuente de verdad (valor, eventos "change");
 * encima se muestra un botón y, al abrirlo, una lista flotante propia.
 */
window.Selects = (() => {
  const abiertos = new Set();
  let flotar = null; // función de posicionamiento que entrega app.js

  function cerrarTodos(excepto) {
    for (const c of [...abiertos]) if (c !== excepto) c.cerrar();
  }

  function mejorar(sel) {
    if (sel._cs) return;
    const wrap = sel.closest(".select") || sel.parentElement;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cs-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    const lab = sel.getAttribute("aria-label");
    if (lab) btn.setAttribute("aria-label", lab);
    const txt = document.createElement("span");
    btn.append(txt);
    wrap.insertBefore(btn, sel);
    sel.classList.add("cs-nativo");
    sel.tabIndex = -1;
    sel.setAttribute("aria-hidden", "true");

    const pop = document.createElement("div");
    pop.className = "cs-pop";
    pop.setAttribute("role", "listbox");
    pop.hidden = true;
    document.body.append(pop);

    const control = {
      refrescar() {
        const op = sel.selectedOptions[0];
        txt.textContent = op ? op.text : "";
        btn.title = op ? op.text : "";
      },
      abrir() {
        cerrarTodos(control);
        pop.innerHTML = "";
        [...sel.options].forEach((op) => {
          const it = document.createElement("button");
          it.type = "button";
          it.className = "cs-item" + (op.selected ? " sel" : "");
          it.setAttribute("role", "option");
          it.setAttribute("aria-selected", String(op.selected));
          it.dataset.valor = op.value;
          const t = document.createElement("span");
          t.textContent = op.text;
          it.append(t);
          it.addEventListener("click", () => {
            if (sel.value !== op.value) {
              sel.value = op.value;
              sel.dispatchEvent(new Event("change", { bubbles: true }));
            }
            control.refrescar();
            control.cerrar();
            btn.focus();
          });
          pop.append(it);
        });
        pop.style.minWidth = `${btn.offsetWidth}px`;
        pop.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        wrap.classList.add("abierto");
        abiertos.add(control);
        if (flotar) flotar(pop, btn);
        const actual = pop.querySelector(".sel") || pop.firstElementChild;
        if (actual) {
          actual.focus({ preventScroll: true });
          actual.scrollIntoView({ block: "nearest" });
        }
      },
      cerrar() {
        if (pop.hidden) return;
        pop.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        wrap.classList.remove("abierto");
        abiertos.delete(control);
      },
      reubicar() {
        if (!pop.hidden && flotar) flotar(pop, btn);
      },
      pop,
      btn,
    };

    btn.addEventListener("click", () => (pop.hidden ? control.abrir() : control.cerrar()));
    btn.addEventListener("keydown", (e) => {
      if (["ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        control.abrir();
      }
    });
    pop.addEventListener("keydown", (e) => {
      const items = [...pop.querySelectorAll(".cs-item")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const j = Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        items[j].focus();
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        items[e.key === "Home" ? 0 : items.length - 1].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        control.cerrar();
        btn.focus();
      } else if (e.key === "Tab") {
        control.cerrar();
      }
    });
    sel.addEventListener("change", control.refrescar);
    sel._cs = control;
    control.refrescar();
  }

  function iniciar(opciones = {}) {
    flotar = opciones.flotar || null;
    document.querySelectorAll(".select select").forEach(mejorar);
    document.addEventListener("pointerdown", (e) => {
      for (const c of [...abiertos]) if (!c.pop.contains(e.target) && !c.btn.contains(e.target)) c.cerrar();
    });
    window.addEventListener("resize", () => abiertos.forEach((c) => c.reubicar()));
    document.addEventListener("scroll", (e) => abiertos.forEach((c) => !c.pop.contains(e.target) && c.reubicar()), true);
  }

  // Actualiza el texto de los botones cuando el código cambia el valor o las opciones
  function refrescar() {
    document.querySelectorAll(".select select").forEach((s) => s._cs && s._cs.refrescar());
  }

  return { iniciar, refrescar, cerrarTodos };
})();
