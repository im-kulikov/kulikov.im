// Mobile menu. Progressive enhancement: without JS the menu simply stays visible (see custom.css, `.js`).
const toggle = document.getElementById("nav-toggle");
const menu = document.getElementById("nav-menu");

if (toggle && menu) {
  const set = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    menu.toggleAttribute("data-open", open);
  };
  const isOpen = () => toggle.getAttribute("aria-expanded") === "true";

  toggle.addEventListener("click", () => set(!isOpen()));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) {
      set(false);
      toggle.focus();
    }
  });
  window.matchMedia("(min-width: 1024px)").addEventListener("change", (e) => e.matches && set(false));
}

// Remember the language the visitor picked (read by the inline script in <head> on the home page).
document.querySelectorAll(".lang-switch a").forEach((a) =>
  a.addEventListener("click", () => {
    try {
      localStorage.setItem("lang", a.dataset.lang);
    } catch {}
  })
);
