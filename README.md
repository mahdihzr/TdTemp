# NEON MILITIA

A complete **Mini-Militia-style 2D jetpack arena shooter** with **LAN multiplayer**,
**full touch controls for mobile**, AI bots, and zero dependencies. One Node.js
file is the server; the browser is the game — on a phone, tablet, or desktop.

```
  ███╗   ██╗███████╗ ██████╗ ███╗   ██╗
  ████╗  ██║██╔════╝██╔═══██╗████╗  ██║   N E O N
  ██╔██╗ ██║█████╗  ██║   ██║██╔██╗ ██║   M I L I T I A
  ██║╚██╗██║██╔══╝  ██║   ██║██║╚██╗██║
  ██║ ╚████║███████╗╚██████╔╝██║ ╚████║   jetpack arena
  ╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝
```

## Quick start

```bash
node server.js
```

Then open **http://localhost:3000** — that's it. No `npm install`, no build step,
no assets to download. Bots fill the arena so it's a full game solo, instantly.

### LAN party

1. One person runs `node server.js` (the console prints your LAN URL, e.g. `http://192.168.1.20:3000`).
2. Everyone else on the same network opens that URL in a browser.
3. Frag.

The server is authoritative (60 Hz simulation, 30 Hz snapshots), so there's no
host advantage and no cheating via the client. If nobody connects, the bots
happily fight each other.

> If friends can't connect, allow Node.js / port 3000 through your firewall.

### Server options

```bash
node server.js --port 3000 --map foundry --mode ffa --bots 3 --diff 1 --score 25 --time 8
```

| flag | values | meaning |
|---|---|---|
| `--map` | `foundry` `skyline` `cavern` | starting map |
| `--mode` | `ffa` `tdm` | free-for-all or team deathmatch |
| `--bots` | 0–8 | AI player count |
| `--diff` | 0–2 | bot skill: recruit / soldier / veteran |
| `--score` | 5–100 | kills to win |
| `--time` | 2–30 | round length, minutes |

The first human to join is the **host** (★) and can change all of this live
from the in-game menu (`ESC` → Host Controls).

## The game

- **Jetpack movement** — hold to fly, fuel drains and regenerates; fast-fall, and a
  **dash** with a cooldown. Rocket-jumping works (self-splash is reduced, knockback isn't).
- **6 weapons** — pistol (infinite), SMG, shotgun, rifle, sniper, rocket launcher —
  carried 3 at a time, picked up around the map, each with its own feel, recoil and tracers.
- **Grenades** that bounce and cook, **melee** with lunge knockback (boot people into the lava).
- **3 maps** — FOUNDRY (industrial, lava pit), SKYLINE (rooftops over a bottomless void),
  CAVERN (enclosed tunnels). Map hazards kill; the last person who hit you gets the credit.
- **Pickups** — weapon crates, medkits, grenade packs, on respawn timers.
- **FFA & Team Deathmatch** with score/time limits, intermission podium, and instant rematch.
- **Bots** with three skill tiers: they hunt, lead their shots, strafe, conserve fuel,
  grab medkits when hurt, swap to the right gun for the range, toss grenades, and dash away when low.
- **Killstreaks & multikills** — first blood, double/triple/mega/monster kill, sprees up to GODLIKE.
- **All the juice** — particles, gibs, screen shake, hit markers, damage numbers,
  kill feed, minimap, hit-direction arrows, low-HP heartbeat vignette, spawn protection shimmer,
  parallax skylines, animated lava… all drawn procedurally on a canvas.
- **Synth audio** — every gunshot, explosion and pickup is synthesized live with WebAudio
  (plus a lo-fi synthwave backing loop). No sound files. `M` mutes, ESC menu has sliders.
- **Chat** (`T`), **scoreboard** (`TAB`), join/leave toasts, host-configurable everything.

## Controls

### Mobile / touch (Mini-Militia-style)

The game **auto-detects touch devices** and shows full on-screen controls — no
app, just open the URL in the phone's browser and tap **DEPLOY** (it goes
fullscreen and asks for landscape).

- **Left thumbstick** — move. Push **up to fly** (jetpack), push **down** to fast-fall.
- **Right thumbstick** — aim. With **auto-fire** on (default), you shoot while you
  steer it, exactly like Mini Militia.
- Both sticks are **fixed-position** and compact, so the screen stays uncluttered.
- **Action buttons** (right side) — **NADE**, **MELEE**, **DASH**, **GRAB** (replace a
  weapon on a crate). **Tap a weapon** in the top strip to switch — that's how you
  change weapons (there's no swap button).
- **☰** (top-right) opens the menu; **≣** toggles the scoreboard.
- The **minimap is hidden** on touch by default (re-enable it in the menu).

**Fully customisable layout** — in the pause menu, tap **EDIT CONTROL LAYOUT**, then
**drag any control to move it**, and **tap one + use the slider to resize it**.
Positions and sizes are saved on the device. The menu also has **auto-fire**,
**left-handed layout**, **show-minimap**, and an **overall size** slider.

### Keyboard + mouse (desktop)

| key | action |
|---|---|
| `A` `D` | move |
| `W` / `SPACE` (hold) | jump → jetpack |
| `S` | fast-fall |
| mouse | aim · **LMB** fire |
| `SHIFT` | dash |
| `F` / **RMB** | melee |
| `G` | grenade |
| `E` | swap weapon on a crate (when carrying 3) |
| `1`–`3` / wheel | switch weapon · `Q` last weapon |
| `TAB` | scoreboard |
| `T` | chat |
| `ESC` | menu / host controls |
| `M` | mute |

Desktop and touch input coexist, so hybrid touch-laptops work with either.

## Tests

```bash
npm test
```

Boots the real server, talks real WebSocket to it, and verifies static serving,
join/welcome, 30 Hz snapshots, movement & jetpack physics, ammo consumption,
bot combat, a full kill cycle, and chat round-trip.

## How it's built

```
server.js          zero-dependency Node server:
                     · static file server
                     · RFC6455 WebSocket implementation (handshake, frames, ping/pong)
                     · authoritative simulation: physics, weapons, explosions,
                       grenades, items, bots, match flow @60 Hz, snapshots @30 Hz
public/index.html  menus, scoreboard, chat, host panel (DOM + CSS)
public/client.js   canvas renderer with snapshot interpolation, input,
                     particles/FX, HUD, minimap, WebAudio synth engine
test/smoke.js      end-to-end smoke test with its own raw WebSocket client
```

The wire protocol is documented at the top of `server.js`. Clients interpolate
~80 ms behind the newest snapshot (with light self-extrapolation for snappy feel),
which is plenty smooth on a LAN.

Works on desktop (keyboard + mouse) and phones/tablets (full touch controls).
Have fun!
