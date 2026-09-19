# Inkwell

Turns your live wallpapers into **colored manga art** — real screentone halftone,
ink outlines, and an RPG-style status panel — as a page you point
[Plash](https://sindresorhus.com/plash) at. Static by default, so it sips power;
the control bar stays hidden until you press `?`.

What you get, one page:

- **Halftone** — your footage rendered fullscreen as color halftone (dot size grows
  in shadows, shrinks in highlights) with Sobel ink outlines. A WebGL shader, not a
  CSS dot overlay.
- **Panel** — a manga *page*: several bordered panels, each playing a *different*
  wallpaper, plus speed lines and a **status** panel.
- **Status panel** — clock + an **HP** gauge (your real **battery**, via the helper)
  and an **MP** gauge that **cycles through passive analytics** with one key: **RAM
  used** (default) and a **Pomodoro** timer, extensible to more. The clock block has
  an always-on **day↔night theme** (warm paper by day → dark indigo by night, with a
  sun/moon that arcs across it). It's the clock panel in panel mode, a small card
  top-right in halftone mode. Ink-on-paper styling.
- **Now playing + visualizer** — shows `♪ Title — Artist` from macOS Now Playing,
  and animates a bar-equalizer backdrop behind the clock while music plays (it
  pauses when you're unplugged and low on battery — see [Now playing](#now-playing)).

## Why the halftone is a shader

Real halftone varies **dot size with brightness** and keeps **color** — pure CSS
can only do a flat, uniform gray dot grid. So the whole effect (color, halftone,
ink) runs in one WebGL fragment shader per source, which is also faster than
stacking CSS/SVG layers across many panels.

## Setup

1. **Drop your videos into `assets/`** (this folder, inside the project). Any
   `.mp4` / `.webm` / `.mov`; Inkwell auto-picks the first 24 (alphabetical).
2. **Run the helper once:**
   ```bash
   ./install.sh
   ```
   A dependency-free Node server serves the page + your videos straight from this
   folder, and exposes the battery at `/battery.json` (WebKit blocks the Battery
   API and `file://` fetches, so the helper is what makes live battery work). A
   `launchd` agent keeps it running at login. Nothing is copied elsewhere.
3. **In Plash**, set the website URL to:
   ```
   http://localhost:8787/index.html                          # halftone
   http://localhost:8787/index.html?mode=panel&panels=lite   # manga page
   ```

To change wallpapers later: add/remove files in `assets/` and reload in Plash.
Remove the helper with `./uninstall.sh`.

> **Moved or renamed the project folder?** Re-run `./install.sh`. The `launchd`
> agent stores the folder's absolute path, so after a move the old path is dead and
> the page 404s with `not found` on reload. Re-running the installer repoints the
> agent at the new location. (A fresh `git clone` + `./install.sh` always works —
> the path is only stale if you move the folder *after* installing.)

Optional: shrink big/4K videos with `./build-assets.sh /path/to/raw/videos`
(needs `brew install ffmpeg`) — it writes 720p copies into `assets/`.

## Battery behavior

The HP bar uses the first source available:

1. **`/battery.json`** from the helper → real battery, works in Plash. Tag `HP` / `CHG`.
2. **`navigator.getBattery()`** → real battery, **Chrome only**.
3. **Focus fallback** → a 25-min self-draining cycle. Tag `FOC`. This is what a
   plain `file://` page in Safari/Plash shows without the helper.

## Now playing

The wallpaper shows a `♪ Title — Artist` line under HP/MP whenever something is
playing. The helper reads the system's macOS "Now Playing" info (the same thing
Control Center shows), which picks up the Spotify web player, the desktop app,
YouTube, etc. — no account or login needed. It's optional; skip it and everything
else works as before.

```bash
brew install nowplaying-cli
```

That's it — reload the wallpaper and play something. Everything stays local.

While a track is playing, the status block also animates a **bar visualizer**
behind the clock/gauges (it eases flat when paused). It's a simulated equalizer —
the wallpaper can't read the actual audio stream (that lives in another app), so
the bars react to play/pause and swell with the music's presence rather than to
its exact frequencies. It only animates while something plays and while the
wallpaper is visible, and it **pauses automatically when you're unplugged and
under 50% battery**, so it's idle-cheap.

Uses the private macOS MediaRemote framework via `nowplaying-cli`; Apple has
restricted this on some recent macOS versions, so if `nowplaying-cli get title`
returns nothing on your OS, this feature won't work (and the line just stays
hidden — no errors).

## Efficiency (running it all day)

Inkwell is built to sip power:

- **Static by default.** Each source loads a video and **freezes its first frame**
  (rendered once, then paused) — essentially **zero** GPU/decode. Press **l** (or the
  **Live** button) to animate, press again to freeze. So most of the day it's a still
  manga wallpaper; you turn on motion only when you want it.
- **Live renders only on real video frames** (not your display's refresh rate) and
  **everything pauses when the wallpaper is hidden/covered**.
- **720p assets** — `./build-assets.sh /path/to/raw/videos` (needs
  `brew install ffmpeg`) writes lightweight 720p/30fps copies into `assets/`; or just
  drop already-small videos into `assets/` directly. Large 4K clips are wasteful at
  panel size.
- **`?panels=lite`** — a 3-video manga page instead of 6, for lower drain in live
  panel mode.
- **`?dpr=1.5`** (or `1`) — render at lower resolution to save GPU. `2` is sharpest.

Rough cost: static ≈ nothing · live halftone ≈ one normal live wallpaper · live
full panel ≈ 6 (use lite / 720p / plug in). No permanent impact on the Mac.

## Controls

The control bar is **hidden by default** so the wallpaper stays clean — press **?**
(or the **/** key) to show or hide it. Everything is also driven by the keys below,
so you rarely need the bar at all.

URL params (reliable in Plash): `mode=halftone|panel`, `live=0|1`, `panels=full|lite`,
`first=<text>` (pin the first clip whose filename contains this), `dpr=2`,
`video=<url>`, `dots=3..16`, `angle=15`, `ink=0|1`, `color=0|1`, `work=25`,
`break=5`, `rpg=0|1`, `hud=0|1` (start with the control bar shown),
`np=0|1` (now-playing line + music visualizer; `0` = plain clock block).

**Now playing + visualizer, on or off.** The song line and the bar visualizer are
one toggle — press **v** (or the **♪ Viz** button in the hidden control bar), or pin
it in the URL. Add the **same `first=<your-clip>`** to both so your chosen default
wallpaper shows either way (`first` matches part of a filename in `assets/`):

```
http://localhost:8787/index.html?mode=halftone&live=0&first=ultra-instinct-goku&np=1   # song line + bar visualizer
http://localhost:8787/index.html?mode=halftone&live=0&first=ultra-instinct-goku&np=0   # plain clock block, no song / no bars
```

(Swap `ultra-instinct-goku` for any part of a filename in `assets/` to pin a
different default wallpaper — keep it the same in both URLs.)

Because Plash remembers your last state, the URL is how you pin a fixed default —
e.g. always open on a static Goku halftone with a plain clock:
`…/index.html?mode=halftone&live=0&first=ultra-instinct-goku&np=0`

Hover for a control bar, or use keys:

| Key   | Action                    |
| ----- | ------------------------- |
| h/p   | halftone / panel mode     |
| m     | cycle mode                |
| l     | live video / static frame |
| i     | ink outlines on/off       |
| c     | color / B&W               |
| r     | status bar on/off         |
| g     | cycle the MP gauge (RAM ↔ Pomodoro ↔ …) |
| v     | now-playing line + visualizer on/off (off = plain clock) |
| ?     | show / hide the control bar (hidden by default) |
| n/b   | next / previous wallpaper (panel mode rolls the whole set) |
| space | Pomodoro start / pause *(only when the Pomodoro gauge is showing)* |
| 0     | Pomodoro reset *(Pomodoro gauge)* |
| .     | Pomodoro skip phase *(Pomodoro gauge)* |

The **MP gauge cycles** through passive analytics with **g** — **RAM used** (the
default, read via the helper) and a **Pomodoro** timer (25/5, set with
`?work=25&break=5`). Adding a new analytic to the `GAUGES` array in `app.js` makes
it part of the same cycle automatically. When the Pomodoro is showing, Space/`.`/`0`
(or the hover **Focus** button) control it; its state persists across reloads.

**Interacting inside Plash:** a wallpaper isn't clickable by default — toggle
**Plash → Browsing Mode** (menu-bar icon) to let the keys and hover buttons work,
then toggle it back off. Drag a video file onto the page to preview it.

## Files

- `index.html` / `style.css` — layout, panels, gutters, status panel, HUD.
- `app.js` — WebGL halftone/ink shader, source handling, modes, gauges, day/night theme.
- `server.mjs` — local helper (serves the folder + `/battery.json`, `/stats.json`, `/videos.json`, `/nowplaying.json`).
- `install.sh` / `uninstall.sh` — start/stop the helper (launchd agent).
- `build-assets.sh` — optional 720p transcodes into `assets/` (needs ffmpeg).
- `assets/` — your videos (auto-discovered, first 24 alphabetically).

Edit `LAYOUT` in `app.js` to rearrange panels or move the clock.

## License

**All rights reserved.** © 2026 Harshit Bisht.
