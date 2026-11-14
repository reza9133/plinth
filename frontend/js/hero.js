// CSS-3D hero: a pedestal built from six-faced boxes that turns slowly, with a parallax tilt that follows the pointer.
const mk = (w, h, d, y, cls, key) => {
  const b = document.createElement("div"); b.className = "bx " + cls;
  Object.assign(b.style, { width: w + "px", height: h + "px", left: -w / 2 + "px", top: y - h / 2 + "px" });
  const f = (cw, ch, css, extra = "") => { const i = document.createElement("i"); Object.assign(i.style, { width: cw + "px", height: ch + "px" }); i.style.cssText += css; if (extra) i.className = extra; b.append(i); };
  f(w, h, `transform:translateZ(${d / 2}px)`, key ? "key" : ""); f(w, h, `transform:rotateY(180deg) translateZ(${d / 2}px)`, key ? "key" : "");
  f(d, h, `left:${(w - d) / 2}px;transform:rotateY(90deg) translateZ(${w / 2}px)`, key ? "key" : ""); f(d, h, `left:${(w - d) / 2}px;transform:rotateY(-90deg) translateZ(${w / 2}px)`, key ? "key" : "");
  f(w, d, `top:${(h - d) / 2}px;transform:rotateX(90deg) translateZ(${h / 2}px)`); f(w, d, `top:${(h - d) / 2}px;transform:rotateX(-90deg) translateZ(${h / 2}px)`);
  return b;
};
const rig = document.querySelector(".rig");
if (rig) {
  rig.append(mk(300, 34, 300, 140, "base"), mk(170, 170, 170, 38, "stem", true), mk(230, 30, 230, -62, "cap"));
  const st = document.querySelector(".stage"), tilt = st.querySelector(".tilt");
  st.addEventListener("pointermove", (e) => { const r = st.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5; tilt.style.transform = `rotateY(${x * 14}deg) rotateX(${-y * 10}deg)`; });
  st.addEventListener("pointerleave", () => (tilt.style.transform = ""));
}
