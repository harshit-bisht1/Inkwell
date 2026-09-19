/* Inkwell helper server.
 * Serves the page + videos from its own folder, and exposes small JSON endpoints
 * the wallpaper can't get on its own inside Plash (WebKit blocks the Battery API
 * and file:// fetches):
 *   /battery.json     → { level, charging }   (via `pmset`)
 *   /stats.json       → { mem, cpu }          (memory used % + CPU load %)
 *   /videos.json      → ["clip.mp4", …]       (files in assets/, drives the playlist)
 *   /nowplaying.json  → { playing, title, artist }  (via macOS Now Playing)
 *
 * Run:   node server.mjs     (usually via the launchd agent — see install.sh)
 * Point Plash at:  http://localhost:8787/index.html
 * No dependencies. Binds to localhost only.
 */
import http from "node:http";
import os from "node:os";
import { stat, readdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname, join, normalize, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));   // this project folder
const PORT = 8787;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".m4v": "video/mp4", ".ogv": "video/ogg",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml",
};

// system stats for the passive "analytics" gauge (memory used %, CPU load %)
function readStats() {
  return new Promise((resolve) => {
    execFile("/usr/bin/memory_pressure", { timeout: 3000 }, (_err, out) => {
      let mem = null;
      const m = out && out.match(/free percentage:\s*(\d+)%/i);
      if (m) mem = 100 - +m[1];
      if (mem == null) mem = Math.round((1 - os.freemem() / os.totalmem()) * 100);
      const cpu = Math.min(100, Math.round((os.loadavg()[0] / (os.cpus().length || 1)) * 100));
      resolve({ mem, cpu });
    });
  });
}

/* macOS "Now Playing" via nowplaying-cli (brew) — reads the system media info
   (whatever holds the media session: a music web player, desktop app, video,
   etc.). launchd runs with a minimal PATH, so we resolve the Homebrew binary by
   absolute path. */
const NOWPLAYING_BIN =
  ["/opt/homebrew/bin/nowplaying-cli", "/usr/local/bin/nowplaying-cli"].find((p) => existsSync(p)) || null;
function readNowPlayingOS() {
  return new Promise((resolve) => {
    if (!NOWPLAYING_BIN) return resolve(null);
    execFile(NOWPLAYING_BIN, ["get", "title", "artist", "playbackRate"], { timeout: 3000 }, (err, out) => {
      if (err || !out) return resolve(null);
      const [title, artist, rate] = out.split("\n").map((s) => s.trim());
      if (!title || title === "null") return resolve(null);
      resolve({
        playing: parseFloat(rate) > 0,
        title,
        artist: artist && artist !== "null" ? artist : "",
      });
    });
  });
}

function readBattery() {
  return new Promise((resolve) => {
    execFile("/usr/bin/pmset", ["-g", "batt"], (err, out) => {
      if (err) return resolve({ level: null, charging: false });
      const m = out.match(/(\d+)%/);
      const charging = /\b(charging|charged|finishing charge|AC Power)\b/i.test(out)
                       && !/\bdischarging\b/i.test(out);
      resolve({ level: m ? +m[1] : null, charging });
    });
  });
}

http.createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);

  if (path === "/battery.json") {
    const b = await readBattery();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(b));
  }

  if (path === "/stats.json") {
    const s = await readStats();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(s));
  }

  // list the videos the user dropped in assets/ (drives the auto-playlist)
  if (path === "/videos.json") {
    const vids = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);
    let files = [];
    try { files = (await readdir(join(ROOT, "assets"))).filter((f) => vids.has(extname(f).toLowerCase())); } catch {}
    files.sort();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(files));
  }

  // --- What's playing right now (macOS Now Playing → drives the NP line) ---
  if (path === "/nowplaying.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    const np = await readNowPlayingOS();
    if (np) return res.end(JSON.stringify({ ...np, configured: true }));
    return res.end(JSON.stringify({ playing: false, configured: !!NOWPLAYING_BIN }));
  }

  // never serve dotfiles (.git, …) over HTTP — keeps local files private
  if (path.split("/").some((seg) => seg.startsWith("."))) { res.writeHead(404); return res.end("not found"); }

  const file = normalize(join(ROOT, path === "/" ? "/index.html" : path));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403); return res.end("forbidden"); }

  let st;
  try { st = await stat(file); } catch { res.writeHead(404); return res.end("not found"); }
  const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;

  if (range && /^bytes=\d*-\d*$/.test(range)) {          // video seeking / partial
    const [s, e] = range.replace("bytes=", "").split("-");
    const start = s ? +s : 0;
    const end = e ? +e : st.size - 1;
    res.writeHead(206, {
      "content-type": type, "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${st.size}`,
      "content-length": end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": st.size });
    createReadStream(file).pipe(res);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Inkwell helper: http://localhost:${PORT}/index.html`));
