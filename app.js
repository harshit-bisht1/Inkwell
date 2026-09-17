/* Inkwell — colored manga halftone + ink wallpaper for Plash.
 *
 * The look is a WebGL shader (HalftoneGL): real halftone whose DOT SIZE tracks
 * brightness, in color, with Sobel ink outlines. One instance drives the
 * fullscreen "halftone" view; one per panel drives the "manga page" view.
 *
 * Efficiency:
 *   - STATIC by default — each source loads a video and freezes its first frame
 *     (rendered once, then paused): ~zero GPU/decode. Toggle live with `l`.
 *   - LIVE renders only on real video frames (requestVideoFrameCallback), and
 *     everything pauses when the wallpaper is hidden/covered.
 *   - 720p assets (build-assets.sh) shrink decode + memory; ?dpr= caps resolution.
 *
 * Params: ?mode=halftone|panel &live=0|1 &panels=full|lite &dpr=2
 *         &dots=6 &angle=15 &ink=0|1 &color=0|1 &work=25 &break=5 &rpg=0|1
 * Keys: h/p mode · m cycle · l live/static · i ink · c color · n/b next · space focus · 0 reset · . skip · r rpg
 */

// The playlist is discovered from the assets/ folder at boot (see discover()).
let PLAYLIST = [];
let track = 0;

const $ = (s) => document.querySelector(s);
const setAll = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
const video = $("#video");
const demo = $("#demo");
const params = new URLSearchParams(location.search);
const saved = (k, d) => localStorage.getItem("inkwell:" + k) ?? d;
const save = (k, v) => localStorage.setItem("inkwell:" + k, v);
// render scale — cap with ?dpr= (1 = lightest, 2 = sharpest). Lower saves GPU/battery.
const DPR = Math.min(+(params.get("dpr") || saved("dpr", 2)), devicePixelRatio || 1);

let mode = params.get("mode") || saved("mode", "halftone");
let live = (params.get("live") ?? saved("live", 0)) != 0;   // STATIC by default

/* live shader parameters (shared by all instances) */
const P = {
  dot: +(params.get("dots") || saved("dots", 6)),
  angle: (+(params.get("angle") || saved("angle", 15))) * Math.PI / 180,
  ink: (params.get("ink") ?? saved("ink", 1)) != 0,
  color: (params.get("color") ?? saved("color", 1)) != 0,
  contrast: 1.18,
  paper: [0.965, 0.94, 0.886],
};
document.documentElement.style.setProperty("--dot", P.dot + "px");
document.documentElement.style.setProperty("--angle", P.angle + "rad");

/* videos live in assets/ and are referenced by their exact filename */
const srcOf = (name) => "assets/" + encodeURIComponent(name);

/* =====================================================================
   HalftoneGL — draws one video/canvas/image source as colored halftone + ink.
   ===================================================================== */
const VERT = `attribute vec2 aPos; varying vec2 vUV;
void main(){ vUV = aPos*0.5 + 0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

const FRAG = `precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uRes, uTexRes;
uniform float uDot, uAngle, uInk, uColor, uContrast;
uniform vec3 uPaper;
vec2 coverUV(vec2 uv){
  float cA = uRes.x/uRes.y, tA = uTexRes.x/uTexRes.y;
  vec2 s = vec2(1.0), o = vec2(0.0);
  if(tA > cA){ s.x = cA/tA; o.x = (1.0-s.x)*0.5; }
  else       { s.y = tA/cA; o.y = (1.0-s.y)*0.5; }
  return uv*s + o;
}
vec3 samp(vec2 uv){ return texture2D(uTex, clamp(coverUV(uv),0.0,1.0)).rgb; }
float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
void main(){
  vec3 col = samp(vUV);
  col = (col - 0.5) * uContrast + 0.5;
  float g = luma(col);
  col = mix(vec3(g), clamp(col,0.0,1.0), uColor);
  float a = uAngle;
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec2 cellUV = fract(rot * (vUV*uRes) / uDot) - 0.5;
  float d = length(cellUV) * 2.0;
  float radius = sqrt(clamp(1.0 - g, 0.0, 1.0)) * 1.38;
  float aa = 1.6 / uDot;
  float dotMask = smoothstep(radius + aa, radius - aa, d);
  vec3 outc = mix(uPaper, col, dotMask);
  if(uInk > 0.5){
    vec2 t = 1.4 / uTexRes;
    float l = luma(samp(vUV + vec2(-t.x,0.0))), r = luma(samp(vUV + vec2(t.x,0.0)));
    float u = luma(samp(vUV + vec2(0.0,-t.y))), dn = luma(samp(vUV + vec2(0.0,t.y)));
    float e = clamp(sqrt((r-l)*(r-l) + (dn-u)*(dn-u)) * 4.0, 0.0, 1.0);
    outc *= (1.0 - smoothstep(0.35, 0.7, e));
  }
  gl_FragColor = vec4(outc, 1.0);
}`;

function makeGL(canvas) {
  const gl = canvas.getContext("webgl", { antialias: false, depth: false, alpha: false });
  if (!gl) return null;
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const U = (n) => gl.getUniformLocation(prog, n);
  const u = { res: U("uRes"), texRes: U("uTexRes"), dot: U("uDot"), angle: U("uAngle"),
              ink: U("uInk"), color: U("uColor"), contrast: U("uContrast"), paper: U("uPaper") };
  return function render(src, sw, sh2) {
    const w = Math.round(canvas.clientWidth * DPR), h = Math.round(canvas.clientHeight * DPR);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src); } catch { return; }
    gl.uniform2f(u.res, w, h);
    gl.uniform2f(u.texRes, sw, sh2);
    gl.uniform1f(u.dot, Math.max(2, P.dot * DPR));
    gl.uniform1f(u.angle, P.angle);
    gl.uniform1f(u.ink, P.ink ? 1 : 0);
    gl.uniform1f(u.color, P.color ? 1 : 0);
    gl.uniform1f(u.contrast, P.contrast);
    gl.uniform3fv(u.paper, P.paper);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
}

/* ---------- status ---------- */
const statusEl = $("#status");
function status(msg, sub) {
  if (!msg) { statusEl.classList.remove("show"); return; }
  statusEl.innerHTML = msg + (sub ? "<small>" + sub + "</small>" : "");
  statusEl.classList.add("show");
}

/* ---------- render each source only on a NEW video frame (rVFC) ---------- */
function driveVideo(vid, render) {
  if (vid.requestVideoFrameCallback) {
    const step = () => { if (!document.hidden) render(); vid.requestVideoFrameCallback(step); };
    vid.requestVideoFrameCallback(step);
  } else {
    let last = 0;
    const step = (t) => {
      requestAnimationFrame(step);
      if (document.hidden || vid.paused || vid.readyState < 2 || t - last < 33) return;
      last = t; render();
    };
    requestAnimationFrame(step);
  }
}

/* =====================================================================
   SOURCES — a gl canvas fed by a <video>. In STATIC we render the first
   frame once and leave the video paused; in LIVE we play + render per frame.
   ===================================================================== */
const glMain = makeGL($("#glMain"));
let usingDemo = false, triedDemo = false;

function renderSource(s) {
  if (s === mainSrc && usingDemo) return;
  const v = s.vid;
  if (s.gl && v.videoWidth) s.gl(v, v.videoWidth, v.videoHeight);
}
function loadSource(s, name) {
  s.name = name;
  s.vid.src = srcOf(name); s.vid.load();
}
function attachSource(s) {
  s.vid._src = s;
  s.vid.addEventListener("loadeddata", () => renderSource(s));   // freeze / first frame
  s.vid.addEventListener("error", () => onSourceFail(s));
  driveVideo(s.vid, () => renderSource(s));      // fires only while playing (live)
}
function onSourceFail(s) {
  if (s === mainSrc) {
    if (track < PLAYLIST.length - 1) { status("Skipping unreadable clip…"); playTrack(track + 1); }
    else if (!triedDemo) { triedDemo = true; status("No videos could load — demo footage.", "Check the folder / run install.sh"); useDemo(); }
  } else if (++s.tries <= PLAYLIST.length) {
    s.idx = (s.idx + videoPanels.length) % PLAYLIST.length; loadSource(s, PLAYLIST[s.idx]);
  }
}

const mainSrc = { vid: video, gl: glMain, name: null, tries: 0 };
attachSource(mainSrc);

function playTrack(i) {
  track = (i + PLAYLIST.length) % PLAYLIST.length;
  usingDemo = false; demo.hidden = true; video.hidden = false;
  mainSrc.tries = 0; loadSource(mainSrc, PLAYLIST[track]); save("track", track);
  applyPlayback();
}

/* demo footage — only when no videos load at all */
function useDemo() {
  usingDemo = true; video.hidden = true; demo.hidden = false; startDemo();
}
function startDemo() {
  const ctx = demo.getContext("2d");
  const W = (demo.width = 960), H = (demo.height = 540);
  const blobs = Array.from({ length: 5 }, (_, i) => ({
    x: Math.random()*W, y: Math.random()*H, r: 120 + i*40,
    vx: (Math.random()-.5)*1.2, vy: (Math.random()-.5)*1.2,
    c: ["#ff5252","#ffd740","#40c4ff","#69f0ae","#e040fb"][i],
  }));
  (function loop() {
    ctx.fillStyle = "#141018"; ctx.fillRect(0,0,W,H);
    for (const b of blobs) {
      b.x += b.vx; b.y += b.vy;
      if (b.x<0||b.x>W) b.vx*=-1; if (b.y<0||b.y>H) b.vy*=-1;
      const g = ctx.createRadialGradient(b.x,b.y,0,b.x,b.y,b.r);
      g.addColorStop(0,b.c); g.addColorStop(1,"transparent");
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(b.x,b.y,b.r,0,Math.PI*2); ctx.fill();
    }
    const t = Date.now()/1000;
    ctx.fillStyle="#fff"; ctx.save();
    ctx.translate(W/2+Math.sin(t)*200, H/2+Math.cos(t*.7)*120); ctx.rotate(t*.4);
    ctx.fillRect(-70,-70,140,140); ctx.restore();
    if (usingDemo) requestAnimationFrame(loop);
  })();
}
let demoLast = 0;
(function demoFrame(t) {
  requestAnimationFrame(demoFrame);
  if (!usingDemo || document.hidden || mode === "panel" || !glMain || t - demoLast < 40) return;
  demoLast = t; if (demo.width) glMain(demo, demo.width, demo.height);
})(0);

/* =====================================================================
   MANGA PAGE — each panel its own wallpaper source; one clock panel.
   ===================================================================== */
const LAYOUT_FULL = [
  { area: "1/1/3/5", type: "video", spd: true },
  { area: "1/5/3/7", type: "clock" },
  { area: "3/1/5/3", type: "video" },
  { area: "3/3/5/5", type: "video" },
  { area: "3/5/7/7", type: "video", spd: true },
  { area: "5/1/7/3", type: "video" },
  { area: "5/3/7/5", type: "video" },
];
const LAYOUT_LITE = [                                  // 3 videos + clock — lighter
  { area: "1/1/4/4", type: "video", spd: true },
  { area: "1/4/4/7", type: "clock" },
  { area: "4/1/7/4", type: "video" },
  { area: "4/4/7/7", type: "video", spd: true },
];
const LAYOUT = (params.get("panels") || saved("panels", "full")) === "lite" ? LAYOUT_LITE : LAYOUT_FULL;

const page = $("#page");
const panels = LAYOUT.map((def) => {
  const el = document.createElement("div");
  el.className = "mpanel " + def.type + (def.spd ? " spd" : "");
  el.style.gridArea = def.area;
  if (def.type === "clock") {
    el.classList.add("paper-tone"); el.append(buildStatus()); page.append(el);
    return { el, type: "clock" };
  }
  const vid = document.createElement("video");
  vid.className = "decoder"; vid.muted = true; vid.loop = true;
  vid.playsInline = true; vid.setAttribute("playsinline", "");
  const cvs = document.createElement("canvas"); cvs.className = "gl";
  el.append(vid, cvs);
  if (def.spd) { const l = document.createElement("div"); l.className = "lines"; el.append(l); }
  page.append(el);
  const p = { el, type: "video", vid, gl: makeGL(cvs), idx: 0, tries: 0, name: null };
  attachSource(p);
  return p;
});
const videoPanels = panels.filter((p) => p.type === "video");

let panelOffset = Number(saved("offset", 0));
let panelsLoaded = false;
function loadPanelVideos() {
  panelsLoaded = true;
  videoPanels.forEach((p, i) => {
    p.tries = 0;
    p.idx = ((panelOffset + i) % PLAYLIST.length + PLAYLIST.length) % PLAYLIST.length;
    loadSource(p, PLAYLIST[p.idx]);
  });
  applyPlayback();
}
// only load the 6 panel videos the first time you open panel mode (saves RAM/decode)
function ensurePanels() { if (!panelsLoaded) loadPanelVideos(); }

// pause everything when hidden/covered; resume on show
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { video.pause(); videoPanels.forEach((p) => p.vid.pause()); }
  else applyPlayback();
});

/* ---------- clock ---------- */
function tick() {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  setAll(".st-time", (e) => (e.textContent = time));
  setAll(".st-date", (e) => (e.textContent = date));
}
tick(); setInterval(tick, 10_000);

/* =====================================================================
   STATUS BLOCK + RPG (HP = battery, MP = Pomodoro)
   ===================================================================== */
function buildStatus() {
  const w = document.createElement("div");
  w.className = "statusblock";
  w.innerHTML =
    '<div class="st-time">--:--</div>' +
    '<div class="st-date"></div>' +
    '<div class="st-bars">' +
      '<div class="st-row"><span class="st-tag hp">HP</span><div class="st-bar"><i class="st-hp"></i></div><span class="st-num st-hpnum">--</span></div>' +
      '<div class="st-row mp-row" title="Focus timer — Space: start/pause"><span class="st-tag mp">MP</span><div class="st-bar"><i class="st-mp"></i></div><span class="st-num st-mpnum">--</span></div>' +
    '</div>';
  return w;
}
$("#statusCard").append(buildStatus());

let serverBattery = null, battery = null;
if (navigator.getBattery) navigator.getBattery().then((b) => {
  battery = b;
  ["levelchange", "chargingchange"].forEach((ev) => b.addEventListener(ev, updateRPG));
  updateRPG();
});
async function pollBattery() {
  try {
    const r = await fetch("battery.json", { cache: "no-store" });
    if (r.ok) { const b = await r.json(); if (b && b.level != null) { serverBattery = b; updateRPG(); } }
  } catch {}
}
pollBattery(); setInterval(pollBattery, 30000);

const clamp = (v) => Math.max(0, Math.min(100, v));
function hpColor(v) { return v > 50 ? "#2ea043" : v > 20 ? "#e3a008" : "#d7263d"; }

const POMO = { work: (+(params.get("work") || 25)) * 60, brk: (+(params.get("break") || 5)) * 60 };
const dur = (ph) => (ph === "work" ? POMO.work : POMO.brk);
let pomo;
try { pomo = JSON.parse(localStorage.getItem("inkwell:pomo")); } catch {}
if (!pomo) pomo = { running: false, phase: "work", remain: POMO.work, endsAt: 0 };
function pomoSave() { save("pomo", JSON.stringify(pomo)); }
function pomoRemain() { return pomo.running ? Math.max(0, (pomo.endsAt - Date.now()) / 1000) : pomo.remain; }
function pomoAdvanceIfDone() {
  if (pomo.running && pomo.endsAt - Date.now() <= 0) {
    pomo.phase = pomo.phase === "work" ? "break" : "work";
    pomo.endsAt = Date.now() + dur(pomo.phase) * 1000; pomoSave();
  }
}
function pomoToggle() {
  if (pomo.running) { pomo.remain = pomoRemain(); pomo.running = false; }
  else { pomo.endsAt = Date.now() + (pomo.remain || dur(pomo.phase)) * 1000; pomo.running = true; }
  pomoSave(); updateRPG();
}
function pomoReset() { pomo = { running: false, phase: "work", remain: POMO.work, endsAt: 0 }; pomoSave(); updateRPG(); }
function pomoSkip() {
  pomo.phase = pomo.phase === "work" ? "break" : "work";
  pomo.remain = dur(pomo.phase);
  if (pomo.running) pomo.endsAt = Date.now() + pomo.remain * 1000;
  pomoSave(); updateRPG();
}
function updateRPG() {
  let hp, tag;
  if (serverBattery && serverBattery.level != null) { hp = serverBattery.level; tag = serverBattery.charging ? "CHG" : "HP"; }
  else if (battery) { hp = battery.level * 100; tag = battery.charging ? "CHG" : "HP"; }
  else { hp = (1 - (Date.now() / 1000 / (25 * 60)) % 1) * 100; tag = "FOC"; }
  pomoAdvanceIfDone();
  const remain = pomoRemain();
  const working = pomo.phase === "work";
  const mp = remain / dur(pomo.phase) * 100;
  const mtag = !pomo.running ? "PAU" : working ? "WRK" : "BRK";
  const mnum = Math.floor(remain / 60) + ":" + String(Math.floor(remain % 60)).padStart(2, "0");
  setAll(".st-tag.hp", (e) => (e.textContent = tag));
  setAll(".st-hpnum", (e) => (e.textContent = Math.round(hp)));
  setAll(".st-hp", (e) => { e.style.width = clamp(hp) + "%"; e.style.background = hpColor(hp); });
  setAll(".st-tag.mp", (e) => (e.textContent = mtag));
  setAll(".st-mpnum", (e) => (e.textContent = mnum));
  setAll(".st-mp", (e) => { e.style.width = clamp(mp) + "%"; e.style.background = working ? "#1f5fae" : "#2ea043"; e.style.opacity = pomo.running ? "1" : ".45"; });
  setAll("#pomoToggle", (e) => (e.textContent = pomo.running ? "⏸ Focus" : "▶ Focus"));
}
updateRPG(); setInterval(updateRPG, 1000);

let rpgOn = (params.get("rpg") ?? saved("rpg", 1)) != 0;
function setRPG(on) { rpgOn = on; save("rpg", on ? 1 : 0); document.body.classList.toggle("hide-rpg", !on); }

/* ---------- mode + playback ---------- */
function setMode(m) {
  mode = m;
  document.body.classList.remove("mode-halftone", "mode-panel");
  document.body.classList.add("mode-" + m);
  save("mode", m);
  document.querySelectorAll(".hud button[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  if (m === "panel") ensurePanels();
  applyPlayback();
}
function applyPlayback() {
  const activeVids = mode === "panel" ? videoPanels.map((p) => p.vid) : [video];
  const idleVids = mode === "panel" ? [video] : videoPanels.map((p) => p.vid);
  idleVids.forEach((v) => v && !v.paused && v.pause());
  if (live && !document.hidden && !usingDemo) {
    Promise.allSettled(activeVids.filter(Boolean).map((v) => v.play())).then((rs) => {
      const blocked = rs.some((r) => r.status === "rejected");
      status(blocked ? "▶ Click to start" : null, blocked ? "browser blocked autoplay" : "");
    });
  } else {                                   // static (or hidden): freeze current frame
    activeVids.forEach((v) => { if (v) { if (!v.paused) v.pause(); if (v._src) renderSource(v._src); } });
    status(null);
  }
}

/* ---------- inputs ---------- */
function setInk(on)   { P.ink = on;   save("ink", on ? 1 : 0);   $("#inkToggle").checked = on; refreshStatic(); }
function setColor(on) { P.color = on; save("color", on ? 1 : 0); $("#satToggle").checked = on; refreshStatic(); }
function setDot(px)   { P.dot = +px;  save("dots", px); document.documentElement.style.setProperty("--dot", px + "px"); refreshStatic(); }
function setLive(on)  { live = on; save("live", on ? 1 : 0); const b = $("#liveToggle"); if (b) b.classList.toggle("active", on); applyPlayback(); }
// when static, re-render once so shader-param changes are visible immediately
function refreshStatic() {
  if (live) return;
  const active = mode === "panel" ? videoPanels : [mainSrc];
  active.forEach((s) => renderSource(s));
}

addEventListener("keydown", (e) => {
  if (e.key === "h") setMode("halftone");
  else if (e.key === "p") setMode("panel");
  else if (e.key === "m") setMode(mode === "halftone" ? "panel" : "halftone");
  else if (e.key === "l") setLive(!live);
  else if (e.key === "i") setInk(!P.ink);
  else if (e.key === "c") setColor(!P.color);
  else if (e.key === "r") setRPG(!rpgOn);
  else if (e.key === "n") nextVideo(1);
  else if (e.key === "b") nextVideo(-1);
  else if (e.key === " ") { e.preventDefault(); pomoToggle(); }
  else if (e.key === "0") pomoReset();
  else if (e.key === ".") pomoSkip();
});
addEventListener("click", (e) => { if (e.target.closest(".mp-row")) pomoToggle(); });
function nextVideo(dir) {
  if (mode === "panel") { panelOffset += dir * videoPanels.length; save("offset", panelOffset); loadPanelVideos(); }
  else playTrack(track + dir);
}
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith("video")) {
    usingDemo = false; mainSrc.name = null;
    video.hidden = false; demo.hidden = true;
    video.src = URL.createObjectURL(f); video.load();
    setMode("halftone"); setLive(true);
  }
});
statusEl.addEventListener("click", () => { applyPlayback(); status(null); });
document.querySelectorAll(".hud button[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("#dot").value = P.dot;
$("#dot").addEventListener("input", (e) => setDot(e.target.value));
$("#inkToggle").checked = P.ink;
$("#inkToggle").addEventListener("change", (e) => setInk(e.target.checked));
$("#satToggle").checked = P.color;
$("#satToggle").addEventListener("change", (e) => setColor(e.target.checked));
if ($("#liveToggle")) $("#liveToggle").addEventListener("click", () => setLive(!live));
$("#pomoToggle").addEventListener("click", pomoToggle);
$("#pomoReset").addEventListener("click", pomoReset);

/* ---------- boot ----------
 * Discover the videos in assets/ (top N) via the helper's listing endpoint.
 * With no videos (or no helper), show demo footage + a hint. */
const MAX_VIDEOS = 24;
async function discover() {
  try {
    const r = await fetch("videos.json", { cache: "no-store" });
    if (r.ok) { const l = await r.json(); if (Array.isArray(l) && l.length) return l.slice(0, MAX_VIDEOS); }
  } catch {}
  return [];
}
(async function boot() {
  PLAYLIST = await discover();
  const srcParam = params.get("video");
  if (srcParam) { mainSrc.name = null; video.src = srcParam; video.load(); }
  else if (PLAYLIST.length) playTrack(Number(saved("track", 0)));
  else { status("Drop videos into the assets/ folder, then reload.", "showing demo footage"); useDemo(); }
  setMode(mode);
  setRPG(rpgOn);
  setLive(live);
})();
