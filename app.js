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
 *         &dots=6 &angle=15 &ink=0|1 &color=0|1 &work=25 &break=5 &rpg=0|1 &hud=0|1
 * Keys: h/p mode · m cycle · l live/static · g cycle MP gauge · i ink · c color
 *       · n/b next · r rpg · ? show/hide control bar (hidden by default)
 *       · space/0/. Pomodoro (when that gauge is showing)
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
    el.classList.add("paper-tone", "sky"); el.append(buildStatus()); page.append(el);
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
  else { applyPlayback(); renderNowPlaying(); }   // renderNowPlaying re-kicks the visualizer
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

/* ---------- day/night sky theme for the clock block (always on) ----------
 * The status block eases from warm paper (day) to dark indigo (night), with a
 * sun that arcs left→right and becomes a moon after sunset. Pure time math. */
const DAY_BG = [246, 240, 226], NIGHT_BG = [24, 22, 44];
const DAY_FG = [17, 17, 17], NIGHT_FG = [233, 231, 242];
let vizColor = "rgb(17,17,17)";               // theme text colour, cached for the visualizer
const mixc = (a, b, t) => "rgb(" + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",") + ")";
function daylight(h) {                       // 0 = deep night, 1 = midday
  if (h < 5 || h >= 21) return 0;
  if (h >= 8 && h < 17) return 1;
  if (h < 8) return (h - 5) / 3;             // dawn ramp 5→8
  return (21 - h) / 4;                        // dusk ramp 17→21
}
function applySky() {
  const now = new Date(), h = now.getHours() + now.getMinutes() / 60, dl = daylight(h);
  const bg = mixc(NIGHT_BG, DAY_BG, dl), fg = mixc(NIGHT_FG, DAY_FG, dl);
  vizColor = fg;                              // cache for the visualizer (avoids a per-frame style read)
  const isDay = h >= 6 && h < 19;
  const x = isDay ? (h - 6) / 13 : ((h + 24 - 19) % 24) / 11;   // 0..1 across day / night
  const y = 1 - Math.sin(Math.max(0, Math.min(1, x)) * Math.PI);
  setAll(".sky", (el) => { el.style.backgroundColor = bg; el.style.color = fg; });
  setAll(".celestial", (el) => {
    // arc across the top, grazing the clock (a little over / slightly intersecting
    // the digits); high at midday, dips a touch lower at dawn/dusk
    el.style.left = (6 + x * 84) + "%";
    el.style.top = (0.3 + y * 0.7) + "em";
    el.style.background = isDay ? "#ffd24d" : "#dfe3ef";
    el.style.boxShadow = isDay ? "0 0 1.2vmin #ffd24d99" : "inset -0.55vmin -0.2vmin 0 rgba(0,0,0,.45)";
  });
}

/* =====================================================================
   STATUS BLOCK + RPG — HP = battery, MP = cyclable gauge (RAM / Pomodoro)
   ===================================================================== */
function buildStatus() {
  const w = document.createElement("div");
  w.className = "statusblock";
  w.innerHTML =
    '<canvas class="viz"></canvas>' +
    '<div class="celestial"></div>' +
    '<div class="st-time">--:--</div>' +
    '<div class="st-date"></div>' +
    '<div class="st-bars">' +
      '<div class="st-row"><span class="st-tag hp">HP</span><div class="st-bar"><i class="st-hp"></i></div><span class="st-num st-hpnum">--</span></div>' +
      '<div class="st-row mp-row" title="MP gauge — press g to cycle (RAM / Pomodoro)"><span class="st-tag mp">MP</span><div class="st-bar"><i class="st-mp"></i></div><span class="st-num st-mpnum">--</span></div>' +
    '</div>' +
    '<div class="st-now" hidden><span class="np-ico">♪</span><span class="np-txt"></span></div>';
  return w;
}
$("#statusCard").append(buildStatus());
$("#statusCard").classList.add("sky");
applySky(); setInterval(applySky, 60_000);   // start the day/night theme (after .sky is set on both blocks)

/* =====================================================================
   MUSIC VISUALIZER — animated bar backdrop behind the clock/gauges.
   We can't read the actual audio (it plays in another app), so this is a
   layered-oscillator "EQ" that swells while music is playing and eases to
   flat when it stops. RAF only runs while it has energy (and never while the
   wallpaper is hidden), so it costs nothing when paused/idle. Colour follows
   the day/night theme via the inherited text colour.
   ===================================================================== */
function makeViz(canvas) {
  const ctx = canvas.getContext("2d");
  const BARS = 10;
  const phase = Array.from({ length: BARS }, (_, i) => i * 0.7);
  const speed = Array.from({ length: BARS }, () => 0.6 + Math.random() * 1.4);
  let amp = 0, target = 0, raf = 0, last = 0;
  function frame(t) {
    raf = 0;
    if (document.hidden) return;                       // stop when covered
    if (t - last >= 33) {                              // ~30fps
      last = t;
      // a <canvas> is a replaced element and won't stretch via inset:0, so we
      // size it explicitly from its parent block (the status block)
      const host = canvas.parentElement, cw = host.clientWidth, ch = host.clientHeight;
      if (!cw || !ch) return;                          // not rendered (wrong mode) → stop
      const w = Math.round(cw * DPR), h = Math.round(ch * DPR);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        canvas.style.width = cw + "px"; canvas.style.height = ch + "px";
      }
      amp += (target - amp) * 0.09;                    // ease toward play/pause
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = vizColor;                        // cached theme colour (set in applySky)
      ctx.globalAlpha = 0.2;                           // subtle so text stays readable
      const now = t / 1000, gap = w * 0.004, bw = (w - gap * (BARS - 1)) / BARS;
      for (let i = 0; i < BARS; i++) {
        const a = Math.sin(now * speed[i] * 3 + phase[i]) * 0.5 + 0.5;
        const b = Math.sin(now * speed[i] * 7 + phase[i] * 1.7) * 0.5 + 0.5;
        const center = Math.max(0.2, 1 - Math.abs(i / (BARS - 1) - 0.5) * 1.3);  // taller mid ("bass")
        const bh = Math.max(0, Math.min(1, (0.12 + (a * 0.6 + b * 0.4) * center) * amp)) * h * 0.92;
        ctx.fillRect(i * (bw + gap), h - bh, bw, bh);   // baseline at h = bottom of the block
      }
      ctx.globalAlpha = 1;
    }
    if (amp > 0.01 || target > 0) raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);   // fully idle → stop + clear
  }
  // starting the loop only when turning ON keeps idle truly cost-free; turning
  // OFF just lets the already-running loop ease to flat and stop on its own.
  return { set playing(v) { target = v ? 1 : 0; if (target && !raf && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } } };
}
const vizzes = [...document.querySelectorAll(".viz")].map(makeViz);
function setViz(on) { vizzes.forEach((v) => (v.playing = on)); }

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

// system stats for the passive analytics gauge (memory %, cpu %)
let serverStats = null;
async function pollStats() {
  try { const r = await fetch("stats.json", { cache: "no-store" }); if (r.ok) { serverStats = await r.json(); updateRPG(); } } catch {}
}
pollStats(); setInterval(pollStats, 5000);

// "Now playing" (via the helper's /nowplaying.json — macOS media info).
// Hidden until something is actually playing; shows "♪ Title — Artist".
let nowPlaying = null;
async function pollNowPlaying() {
  try { const r = await fetch("nowplaying.json", { cache: "no-store" }); if (r.ok) { nowPlaying = await r.json(); renderNowPlaying(); } } catch {}
}
function renderNowPlaying() {
  const on = !!(nowPlaying && nowPlaying.playing && nowPlaying.title);
  setAll(".st-now", (e) => (e.hidden = !on));
  if (on) setAll(".np-txt", (e) => (e.textContent = nowPlaying.title + (nowPlaying.artist ? " — " + nowPlaying.artist : "")));
  refreshViz();                                // swell the bar visualizer while playing (battery permitting)
}
// pause the visualizer to save power when unplugged and under 50% battery
function currentBattery() {
  if (serverBattery && serverBattery.level != null) return { level: serverBattery.level, charging: !!serverBattery.charging };
  if (battery) return { level: battery.level * 100, charging: !!battery.charging };
  return null;                                 // unknown → don't restrict
}
function vizBatteryOk() { const b = currentBattery(); return !b || b.charging || b.level >= 50; }
function refreshViz() { setViz(!!(nowPlaying && nowPlaying.playing && nowPlaying.title) && vizBatteryOk()); }
pollNowPlaying(); setInterval(pollNowPlaying, 5000);

// MP cycles through these passive analytics with one key (app default: ram).
// Add more here later and the single cycle key picks them up automatically.
const GAUGES = ["ram", "pomodoro"];
let gaugeIdx = Math.max(0, GAUGES.indexOf(saved("gauge", "ram")));
const gauge = () => GAUGES[gaugeIdx];
function cycleGauge() { gaugeIdx = (gaugeIdx + 1) % GAUGES.length; save("gauge", GAUGES[gaugeIdx]); updateRPG(); }

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
  // MP = the currently selected gauge (ram | pomodoro | …future)
  let mtag, mval, mnum, mcolor, mop = "1";
  if (gauge() === "pomodoro") {
    pomoAdvanceIfDone();
    const remain = pomoRemain(), working = pomo.phase === "work";
    mval = remain / dur(pomo.phase) * 100;
    mtag = !pomo.running ? "PAU" : working ? "WRK" : "BRK";
    mnum = Math.floor(remain / 60) + ":" + String(Math.floor(remain % 60)).padStart(2, "0");
    mcolor = working ? "#1f5fae" : "#2ea043";
    mop = pomo.running ? "1" : ".45";
  } else {                                   // ram (mana)
    const mem = serverStats ? serverStats.mem : null;
    mtag = "MP"; mval = mem == null ? 0 : mem; mnum = mem == null ? "–" : mem + "%";
    mcolor = mem == null ? "#888" : mem > 85 ? "#d7263d" : mem > 60 ? "#e3a008" : "#1f5fae";
  }
  setAll(".st-tag.hp", (e) => (e.textContent = tag));
  setAll(".st-hpnum", (e) => (e.textContent = Math.round(hp)));
  setAll(".st-hp", (e) => { e.style.width = clamp(hp) + "%"; e.style.background = hpColor(hp); });
  setAll(".st-tag.mp", (e) => (e.textContent = mtag));
  setAll(".st-mpnum", (e) => (e.textContent = mnum));
  setAll(".st-mp", (e) => { e.style.width = clamp(mval) + "%"; e.style.background = mcolor; e.style.opacity = mop; });
  setAll("#pomoToggle", (e) => (e.textContent = pomo.running ? "⏸ Focus" : "▶ Focus"));
  refreshViz();                                // re-check battery gate (plug/unplug, crossing 50%)
}
updateRPG(); setInterval(updateRPG, 1000);

let rpgOn = (params.get("rpg") ?? saved("rpg", 1)) != 0;
function setRPG(on) { rpgOn = on; save("rpg", on ? 1 : 0); document.body.classList.toggle("hide-rpg", !on); }

// control bar is hidden by default (clean wallpaper); toggle it with `?`
let hudOn = (params.get("hud") ?? saved("hud", 0)) != 0;
function setHud(on) { hudOn = on; save("hud", on ? 1 : 0); document.body.classList.toggle("show-hud", on); }

/* ---------- mode + playback ---------- */
function setMode(m) {
  mode = m;
  document.body.classList.remove("mode-halftone", "mode-panel");
  document.body.classList.add("mode-" + m);
  save("mode", m);
  document.querySelectorAll(".hud button[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  if (m === "panel") ensurePanels();
  applyPlayback();
  renderNowPlaying();                           // re-kick the visualizer on the now-visible block
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
  else if (e.key === "g") cycleGauge();                     // cycle the MP analytic
  else if (e.key === "?" || e.key === "/") setHud(!hudOn);   // show/hide the control bar
  else if (e.key === "n") nextVideo(1);
  else if (e.key === "b") nextVideo(-1);
  // Pomodoro controls act only when the Pomodoro gauge is showing
  else if (e.key === " " && gauge() === "pomodoro") { e.preventDefault(); pomoToggle(); }
  else if (e.key === "0" && gauge() === "pomodoro") pomoReset();
  else if (e.key === "." && gauge() === "pomodoro") pomoSkip();
});
addEventListener("click", (e) => { if (e.target.closest(".mp-row") && gauge() === "pomodoro") pomoToggle(); });
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
  // ?first=<substring> pins a preferred clip to the front (and starts on it)
  const first = params.get("first");
  let start = Number(saved("track", 0));
  if (first && PLAYLIST.length) {
    const i = PLAYLIST.findIndex((n) => n.toLowerCase().includes(first.toLowerCase()));
    if (i > 0) PLAYLIST.unshift(PLAYLIST.splice(i, 1)[0]);
    if (i >= 0) start = 0;
  }
  const srcParam = params.get("video");
  if (srcParam) { mainSrc.name = null; video.src = srcParam; video.load(); }
  else if (PLAYLIST.length) playTrack(start);
  else { status("Drop videos into the assets/ folder, then reload.", "showing demo footage"); useDemo(); }
  setMode(mode);
  setRPG(rpgOn);
  setLive(live);
  setHud(hudOn);
})();
