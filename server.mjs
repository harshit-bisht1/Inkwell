/* Inkwell helper server.
 * Serves the wallpaper page + videos from its own folder, and exposes the live
 * battery level at /battery.json (via `pmset`) so the RPG bar can read it inside
 * Plash — WebKit blocks both the Battery API and file:// fetches.
 *
 * Run:   node server.mjs     (usually via the launchd agent — see install.sh)
 * Point Plash at:  http://localhost:8787/index.html
 * No dependencies. Binds to localhost only.
 */
import http from "node:http";
import { stat, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
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

  // list the videos the user dropped in assets/ (drives the auto-playlist)
  if (path === "/videos.json") {
    const vids = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);
    let files = [];
    try { files = (await readdir(join(ROOT, "assets"))).filter((f) => vids.has(extname(f).toLowerCase())); } catch {}
    files.sort();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(files));
  }

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
