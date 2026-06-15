#!/usr/bin/env node
/*
 * NEON MILITIA — LAN arena shooter (Mini-Militia style)
 * ----------------------------------------------------
 * Zero-dependency Node.js server:
 *   - serves the browser client from /public
 *   - speaks WebSocket (RFC6455) with a built-in implementation
 *   - runs the authoritative game simulation (players, bots, bullets,
 *     grenades, pickups, match flow) at 60 Hz, broadcasting 30 Hz snapshots
 *
 * Run:   node server.js [--port 3000] [--map foundry|skyline|cavern]
 *                       [--mode ffa|tdm] [--bots 3] [--diff 0|1|2]
 *                       [--score 25] [--time 8]
 *
 * PROTOCOL (JSON text frames)
 * ---------------------------
 * client -> server:
 *   {t:'j',  name}                          join
 *   {t:'i',  l,r,u,d,f, a}                  held inputs (0/1) + aim radians
 *   {t:'act',k:'melee'|'nade'|'dash'|'use'} one-shot actions
 *   {t:'sw', i:slot}                        switch weapon slot 0..2
 *   {t:'c',  msg}                           chat
 *   {t:'h',  set:{map,mode,bots,diff,score,time,restart}}  host settings
 *   {t:'p',  c}                             ping (echo c)
 *
 * server -> client:
 *   {t:'w', id, map, mode, scoreLimit, timeLimit, roster}        welcome
 *   {t:'map', map, mode, scoreLimit, timeLimit}                  map switch
 *   {t:'r', l:[[id,name,team,bot,host]...]}                      roster
 *   {t:'s', ts, st, tl, ta, tb, p, b, n, it, e}                  snapshot
 *      p: [id,x,y,vx,vy,aim,hp,fuel,cur,flags,kills,deaths,deadT10,
 *          [[wtype,ammo]...],nades,nadeCd10,dashCd10]
 *         flags: 1 jet | 2 grounded | 4 spawn-protected | 8 dead
 *      b: [id,wtype,x,y,vx,vy]      n: [id,x,y,fuse]
 *      it: indexes of active item spawners
 *      e: events  [0,x,y,aim,wt,pid] shot   [1,x,y,r] explosion
 *                 [2,x,y,vid,sid,dmg] hit   [3,x,y] spark
 *                 [4,x,y,itype,pid] pickup  [5,pid] melee
 *                 [6,pid,x,y] spawn         [7,pid,dir] dash
 *                 [8,x,y] nade bounce       [9,pid] dry-fire
 *                 [10,x,y] death gibs
 *   {t:'k', k, v, w, sui}     kill (w: 0-5 gun, 6 nade, 7 melee, 8 lava, 9 void)
 *   {t:'c', id, msg}          chat (id -1 = server)
 *   {t:'a', msg, kind}        announcement ('info'|'streak'|'match'|'big')
 *   {t:'o', wid, wteam}       match over
 *   {t:'p', c, s}             pong
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* ============================== CLI ARGS ============================== */

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const m = /^--([a-z]+)$/.exec(argv[i]);
    if (m) { out[m[1]] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  }
  return out;
}
const ARGS = parseArgs(process.argv);

/* ============================ GAME CONSTANTS =========================== */

const TICK = 1 / 60;            // simulation step
const SNAP_EVERY = 2;           // snapshot every N ticks (30 Hz)
const PHW = 14, PHH = 23;       // player half extents
const GRAV = 1500;
const MAX_RUN = 320;
const ACCEL_GROUND = 2600, ACCEL_AIR = 1500;
const JUMP_V = -600;
const JET_THRUST = 2400, JET_MAX_UP = -480;
const FUEL_MAX = 100, FUEL_DRAIN = 40, FUEL_REGEN_GROUND = 45, FUEL_REGEN_AIR = 24, FUEL_DELAY = 0.6;
const FALL_CAP = 950, FASTFALL_CAP = 1350, FASTFALL_ACC = 1000;
const DASH_V = 660, DASH_CD = 2.2;
const MELEE_RANGE = 58, MELEE_ARC = 1.25, MELEE_DMG = 34, MELEE_KNOCK = 460, MELEE_CD = 0.55;
const NADE_V = 640, NADE_FUSE = 2.2, NADE_R = 110, NADE_DMG = 70, NADE_CD = 1.4, NADE_START = 2, NADE_MAX = 4;
const HP_MAX = 100, MED_HEAL = 55;
const RESPAWN_T = 2.6, PROT_T = 2.0;
const SELF_SPLASH = 0.55;       // self damage factor for explosions
const MAX_PLAYERS = 12;

const WEAPONS = [
  { n: 'PISTOL',  dmg: 13,  int: 0.23,  spd: 1000, spread: 0.020, ammo: -1, pick: 0,  max: -1,  pellets: 1, life: 1.00, knock: 90,  kick: 30,  auto: false, light: true },
  { n: 'SMG',     dmg: 8,   int: 0.082, spd: 1050, spread: 0.070, ammo: 45, pick: 45, max: 135, pellets: 1, life: 0.85, knock: 60,  kick: 18,  auto: true,  light: true },
  { n: 'SHOTGUN', dmg: 7.5, int: 0.95,  spd: 880,  spread: 0.150, ammo: 10, pick: 10, max: 30,  pellets: 8, life: 0.50, knock: 110, kick: 330, auto: false },
  { n: 'RIFLE',   dmg: 14,  int: 0.13,  spd: 1250, spread: 0.028, ammo: 36, pick: 36, max: 108, pellets: 1, life: 1.10, knock: 90,  kick: 45,  auto: true,  light: true },
  { n: 'SNIPER',  dmg: 72,  int: 1.35,  spd: 2200, spread: 0.002, ammo: 7,  pick: 7,  max: 21,  pellets: 1, life: 1.20, knock: 340, kick: 280, auto: false },
  { n: 'ROCKET',  dmg: 0,   int: 1.20,  spd: 580,  spread: 0.012, ammo: 5,  pick: 5,  max: 15,  pellets: 1, life: 3.00, knock: 0,   kick: 160, auto: false, rocket: true, splash: 100, sdmg: 80 },
];
// "Light" weapons are dual-wielded (akimbo) — the player holds and fires two,
// firing from both hands at once and consuming two rounds per trigger pull.

// item types: 0..5 weapon of that id, 10 medkit, 11 grenade pack
const ITEM_RESPAWN = { weapon: 12, med: 14, nades: 16 };

/* ================================ MAPS ================================= */

const MAPS = {
  foundry: {
    key: 'foundry', name: 'FOUNDRY', w: 2600, h: 1500,
    theme: { bgTop: '#0d0a14', bgBot: '#2b0f0f', plat: '#2e2438', edge: '#ff7a3c', accent: '#ffb347', parallax: 'industrial' },
    hazardName: 'the lava',
    rects: [
      [0, 0, 2600, 40], [0, 0, 40, 1500], [2560, 0, 40, 1500],
      [40, 1440, 1060, 60], [1500, 1440, 1060, 60], [1100, 1492, 400, 8],
      [240, 1180, 420, 36], [1940, 1180, 420, 36],
      [1000, 1000, 600, 40],
      [520, 810, 360, 32], [1720, 810, 360, 32],
      [930, 610, 300, 28], [1370, 610, 300, 28],
      [280, 430, 220, 28], [2100, 430, 220, 28], [1170, 330, 260, 28],
      [690, 1160, 56, 280], [1854, 1160, 56, 280],
    ],
    lava: [[1100, 1452, 400, 48]],
    voidY: 0,
    spawns: [[150, 1400], [2450, 1400], [430, 1130], [2170, 1130], [1300, 950], [700, 760], [1900, 760], [1300, 280], [390, 380], [2210, 380]],
    items: [
      [2, 450, 1146], [1, 2150, 1146],
      [3, 690, 776], [1, 1910, 776],
      [4, 1300, 296], [5, 1300, 962],
      [10, 390, 396], [10, 2210, 396], [10, 1080, 576],
      [11, 120, 1406], [11, 2480, 1406], [11, 1520, 576],
    ],
  },
  skyline: {
    key: 'skyline', name: 'SKYLINE', w: 3000, h: 1700,
    theme: { bgTop: '#050816', bgBot: '#1a1440', plat: '#1e2747', edge: '#41c7ff', accent: '#7df9ff', parallax: 'city' },
    hazardName: 'the void',
    rects: [
      [0, 0, 3000, 40], [0, 0, 40, 1700], [2960, 0, 40, 1700],
      [150, 1250, 620, 60], [1000, 1380, 500, 60], [1750, 1300, 560, 60], [2480, 1180, 420, 60],
      [480, 930, 380, 44], [1250, 1010, 460, 44], [2050, 880, 400, 44],
      [880, 660, 300, 36], [1640, 620, 300, 36], [2440, 520, 300, 36],
      [1260, 360, 280, 32],
      [60, 1080, 140, 28], [2820, 900, 140, 28],
    ],
    lava: [],
    voidY: 1700,
    spawns: [[300, 1210], [1200, 1340], [2000, 1260], [2650, 1140], [650, 890], [1450, 970], [2230, 840], [1390, 320], [1020, 620], [1780, 580]],
    items: [
      [2, 460, 1218], [1, 1250, 1348], [3, 2030, 1268], [1, 2690, 1148],
      [4, 1400, 328], [5, 1480, 978],
      [10, 660, 898], [10, 2250, 848], [10, 130, 1048],
      [11, 1030, 628], [11, 1790, 588],
    ],
  },
  cavern: {
    key: 'cavern', name: 'CAVERN', w: 2400, h: 1400,
    theme: { bgTop: '#06100c', bgBot: '#0c2018', plat: '#1c3328', edge: '#4dff9d', accent: '#9dffc7', parallax: 'cave' },
    hazardName: 'the rocks',
    rects: [
      [0, 0, 2400, 40], [0, 0, 40, 1400], [2360, 0, 40, 1400], [40, 1340, 2320, 60],
      [260, 1140, 320, 32], [820, 1060, 360, 32], [1430, 1120, 320, 32], [1950, 1020, 300, 32],
      [560, 830, 300, 28], [1180, 780, 380, 28], [1760, 720, 300, 28],
      [340, 540, 300, 28], [980, 470, 320, 28], [1620, 430, 300, 28],
      [1170, 1060, 60, 280],
      [700, 40, 70, 180], [1500, 40, 70, 220], [1900, 1240, 80, 100],
    ],
    lava: [],
    voidY: 0,
    spawns: [[150, 1300], [2250, 1300], [420, 1100], [1000, 1020], [1590, 1080], [2100, 980], [710, 790], [1370, 740], [1910, 680], [1140, 430]],
    items: [
      [2, 420, 1106], [1, 1000, 1026], [3, 1590, 1086], [1, 2100, 986],
      [5, 1370, 746], [4, 1140, 436],
      [10, 710, 796], [10, 1910, 686], [10, 1240, 1306],
      [11, 490, 506], [11, 1770, 396],
    ],
  },
};

const BOT_NAMES = ['VECTOR', 'RIPLEY', 'HAVOC', 'NOVA', 'BLITZ', 'JINX', 'TITAN', 'WRAITH', 'ONYX', 'PYRO', 'SARGE', 'REKT'];

/* =============================== HELPERS =============================== */

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rand = (a, b) => a + Math.random() * (b - a);
const dist2 = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };

// Swept segment vs AABB (slab method). Returns t in [0,1] or -1.
function segRect(x0, y0, x1, y1, rx, ry, rw, rh) {
  const dx = x1 - x0, dy = y1 - y0;
  let tmin = 0, tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (x0 < rx || x0 > rx + rw) return -1;
  } else {
    let t1 = (rx - x0) / dx, t2 = (rx + rw - x0) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dy) < 1e-9) {
    if (y0 < ry || y0 > ry + rh) return -1;
  } else {
    let t1 = (ry - y0) / dy, t2 = (ry + rh - y0) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

function losClear(map, x0, y0, x1, y1) {
  for (const r of map.rects) if (segRect(x0, y0, x1, y1, r[0], r[1], r[2], r[3]) >= 0) return false;
  return true;
}

function overlapsRect(px, py, hw, hh, r) {
  return px + hw > r[0] && px - hw < r[0] + r[2] && py + hh > r[1] && py - hh < r[1] + r[3];
}

/* ========================== WEBSOCKET (RFC6455) ========================= */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20; // 1 MiB hard cap

class WSConn {
  constructor(socket) {
    this.sock = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;       // {op, chunks}
    this.alive = true;
    this.dead = false;
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (d) => this._feed(d));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
    socket.setNoDelay(true);
  }
  _feed(d) {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    this.alive = true;
    try { this._parse(); } catch (e) { this.destroy(); }
  }
  _parse() {
    for (;;) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const hi = buf.readUInt32BE(2), lo = buf.readUInt32BE(6);
        if (hi !== 0 || lo > MAX_FRAME) { this.destroy(); return; }
        len = lo; off = 10;
      }
      if (len > MAX_FRAME) { this.destroy(); return; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        payload = Buffer.from(payload);
        const mk = buf.slice(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3];
      }
      this.buf = buf.slice(off + maskLen + len);

      if (op === 0x8) { // close
        try { this.sock.write(wsFrame(0x8, payload.slice(0, 2))); } catch (e) {}
        this.destroy();
        return;
      } else if (op === 0x9) { // ping -> pong
        try { this.sock.write(wsFrame(0xA, payload)); } catch (e) {}
      } else if (op === 0xA) { // pong
        // alive already set
      } else if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0x0) this.frag = { op, chunks: [payload] };
        else if (this.frag) this.frag.chunks.push(payload);
        else { this.destroy(); return; }
        if (fin && this.frag) {
          const msg = Buffer.concat(this.frag.chunks);
          const isText = this.frag.op === 0x1;
          this.frag = null;
          if (isText && this.onmessage) this.onmessage(msg.toString('utf8'));
        }
      } else { this.destroy(); return; }
    }
  }
  send(str) {
    if (this.dead) return;
    try { this.sock.write(wsFrame(0x1, Buffer.from(str, 'utf8'))); } catch (e) { this.destroy(); }
  }
  sendRaw(frameBuf) {
    if (this.dead) return;
    try { this.sock.write(frameBuf); } catch (e) { this.destroy(); }
  }
  ping() {
    if (this.dead) return;
    try { this.sock.write(wsFrame(0x9, Buffer.alloc(0))); } catch (e) { this.destroy(); }
  }
  destroy() {
    if (this.dead) return;
    this.dead = true;
    try { this.sock.destroy(); } catch (e) {}
    if (this.onclose) { const cb = this.onclose; this.onclose = null; cb(); }
  }
}

function wsFrame(op, payload) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  header[0] = 0x80 | op;
  return Buffer.concat([header, payload]);
}

/* ============================== GAME STATE ============================= */

const game = {
  map: null,
  mode: 'ffa',                 // 'ffa' | 'tdm'
  scoreLimit: 25,
  timeLimit: 8,                // minutes
  botTarget: 3,
  botDiff: 1,                  // 0 easy, 1 normal, 2 hard
  gravityMul: 1,               // host-adjustable gravity multiplier
  state: 0,                    // 0 playing, 1 intermission
  tl: 0,                       // time left (s) — intermission countdown when state=1
  ta: 0, tb: 0,                // team scores
  players: new Map(),          // id -> player
  bullets: [],
  nades: [],
  items: [],                   // {type,x,y,active,t}
  events: [],
  firstBlood: false,
  tick: 0,
  time: 0,
};
let nextId = 1, nextShotId = 1;

function loadMap(key) {
  const def = MAPS[key] || MAPS.foundry;
  game.map = def;
  game.items = def.items.map((it) => ({ type: it[0], x: it[1], y: it[2], active: true, t: 0 }));
  game.bullets = [];
  game.nades = [];
}

function mapPayload() {
  const m = game.map;
  return { key: m.key, name: m.name, w: m.w, h: m.h, theme: m.theme, hazardName: m.hazardName, rects: m.rects, lava: m.lava, voidY: m.voidY, items: m.items };
}

/* ------------------------------ players ------------------------------- */

function defaultWeapons() {
  return [{ t: 0, ammo: -1 }, { t: 1, ammo: WEAPONS[1].ammo }];
}

function makePlayer(name, conn, bot) {
  const p = {
    id: nextId++, name, conn: conn || null, bot: !!bot, host: false,
    team: 0, x: 0, y: 0, vx: 0, vy: 0, aim: 0,
    hp: HP_MAX, alive: false, deadT: 0.01, protT: 0,
    fuel: FUEL_MAX, fuelIdle: 0, jet: false, grounded: false,
    weapons: defaultWeapons(), cur: 1, fireT: 0,
    nades: NADE_START, nadeT: 0, dashT: 0, meleeT: 0,
    input: { l: 0, r: 0, u: 0, d: 0, f: 0, a: 0 },
    acts: { melee: false, nade: false, dash: false, use: false },
    kills: 0, deaths: 0, spree: 0, multi: 0, multiT: 0,
    lastHitBy: 0, lastHitT: -99,
    msgCount: 0, lastChatT: 0,
    brain: bot ? makeBrain() : null,
  };
  if (game.mode === 'tdm') p.team = pickTeam();
  return p;
}

function pickTeam() {
  let a = 0, b = 0;
  for (const p of game.players.values()) (p.team === 1 ? b++ : a++);
  return a <= b ? 0 : 1;
}

function spawnPlayer(p) {
  const sp = pickSpawn(p);
  p.x = sp[0]; p.y = sp[1];
  p.vx = 0; p.vy = 0;
  p.hp = HP_MAX; p.alive = true; p.deadT = 0;
  p.fuel = FUEL_MAX; p.protT = PROT_T;
  p.weapons = defaultWeapons(); p.cur = 1;
  p.nades = NADE_START; p.nadeT = 0; p.dashT = 0; p.meleeT = 0; p.fireT = 0;
  game.events.push([6, p.id, Math.round(p.x), Math.round(p.y)]);
}

function pickSpawn(p) {
  const spawns = game.map.spawns;
  let best = spawns[0], bestScore = -1;
  for (const sp of spawns) {
    let minD = 1e12;
    for (const o of game.players.values()) {
      if (o === p || !o.alive) continue;
      // teammates repel a little too, so spawns don't stack
      const w = game.mode === 'tdm' && o.team === p.team ? 0.3 : 1;
      minD = Math.min(minD, dist2(sp[0], sp[1], o.x, o.y) * w);
    }
    const score = minD * rand(0.7, 1.0);
    if (score > bestScore) { bestScore = score; best = sp; }
  }
  return best;
}

/* ------------------------------- combat -------------------------------- */

function damage(victim, dmg, attacker, wcode, kx, ky) {
  if (!victim.alive) return;
  victim.vx += kx; victim.vy += ky;
  if (victim.protT > 0) return;
  if (game.mode === 'tdm' && attacker && attacker !== victim && attacker.team === victim.team) return;
  if (game.state !== 0) return;
  victim.hp -= dmg;
  if (attacker && attacker !== victim) { victim.lastHitBy = attacker.id; victim.lastHitT = game.time; }
  game.events.push([2, Math.round(victim.x), Math.round(victim.y), victim.id, attacker ? attacker.id : 0, Math.round(dmg)]);
  if (victim.hp <= 0) kill(victim, attacker, wcode);
}

function kill(victim, attacker, wcode) {
  if (!victim.alive) return;
  victim.alive = false;
  victim.deadT = RESPAWN_T;
  victim.deaths++;
  victim.spree = 0;
  victim.multi = 0;
  game.events.push([10, Math.round(victim.x), Math.round(victim.y)]);

  // environmental death: credit whoever hit us recently
  if ((wcode === 8 || wcode === 9) && !attacker && game.time - victim.lastHitT < 5) {
    attacker = game.players.get(victim.lastHitBy) || null;
  }

  const suicide = !attacker || attacker === victim;
  if (suicide) {
    victim.kills--;
    if (game.mode === 'tdm') { if (victim.team === 0) game.ta = Math.max(0, game.ta - 1); else game.tb = Math.max(0, game.tb - 1); }
  } else {
    attacker.kills++;
    attacker.spree++;
    if (game.mode === 'tdm') { if (attacker.team === 0) game.ta++; else game.tb++; }
    if (!game.firstBlood) { game.firstBlood = true; announce(`${attacker.name} DREW FIRST BLOOD`, 'streak'); }
    if (game.time - attacker.multiT < 4) attacker.multi++; else attacker.multi = 1;
    attacker.multiT = game.time;
    const multiNames = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'MEGA KILL', 5: 'MONSTER KILL' };
    if (multiNames[Math.min(attacker.multi, 5)] && attacker.multi >= 2) announce(`${attacker.name} — ${multiNames[Math.min(attacker.multi, 5)]}!`, 'streak');
    const spreeNames = { 3: 'IS ON A SPREE', 5: 'IS ON A RAMPAGE', 8: 'IS UNSTOPPABLE', 12: 'IS GODLIKE' };
    if (spreeNames[attacker.spree]) announce(`${attacker.name} ${spreeNames[attacker.spree]} (${attacker.spree})`, 'streak');
  }
  broadcast({ t: 'k', k: attacker ? attacker.id : -1, v: victim.id, w: wcode, sui: suicide ? 1 : 0 });
  checkScoreLimit();
}

function checkScoreLimit() {
  if (game.state !== 0) return;
  if (game.mode === 'tdm') {
    if (game.ta >= game.scoreLimit || game.tb >= game.scoreLimit) endMatch();
  } else {
    for (const p of game.players.values()) if (p.kills >= game.scoreLimit) { endMatch(); return; }
  }
}

function explode(x, y, r, maxDmg, owner, wcode) {
  game.events.push([1, Math.round(x), Math.round(y), Math.round(r)]);
  for (const p of game.players.values()) {
    if (!p.alive) continue;
    const dx = p.x - x, dy = p.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const reach = r + PHH;
    if (d > reach) continue;
    const fall = clamp(1 - d / reach, 0.12, 1);
    const nx = d > 1 ? dx / d : 0, ny = d > 1 ? dy / d : -1;
    const kx = nx * 760 * fall, ky = ny * 760 * fall - 140 * fall;
    let dmg = maxDmg * fall;
    if (owner && p === owner) dmg *= SELF_SPLASH;
    else if (game.mode === 'tdm' && owner && owner.team === p.team) { continue; }
    damage(p, dmg, owner, wcode, kx, ky);
  }
}

function fireWeapon(p) {
  const w = p.weapons[p.cur];
  const spec = WEAPONS[w.t];
  if (w.ammo === 0) {
    game.events.push([9, p.id]);
    autoSwitch(p);
    p.fireT = 0.3;
    return;
  }
  // light weapons are dual-wielded: fire both hands, one round each
  let barrels = 1;
  if (spec.light) barrels = w.ammo < 0 ? 2 : Math.min(2, w.ammo);
  if (w.ammo > 0) w.ammo -= barrels;
  p.fireT = spec.int;
  p.protT = 0;
  const aim = p.aim;
  const perpX = -Math.sin(aim), perpY = Math.cos(aim);   // hand-offset direction
  for (let h = 0; h < barrels; h++) {
    const off = barrels === 2 ? (h === 0 ? -9 : 9) : 0;
    const mx = p.x + Math.cos(aim) * 24 + perpX * off;
    const my = p.y - 6 + Math.sin(aim) * 24 + perpY * off;
    for (let i = 0; i < spec.pellets; i++) {
      const a = aim + (Math.random() - 0.5) * 2 * spec.spread;
      game.bullets.push({
        id: nextShotId++, t: w.t, owner: p.id, team: p.team,
        x: mx, y: my, vx: Math.cos(a) * spec.spd, vy: Math.sin(a) * spec.spd,
        life: spec.life,
      });
    }
    game.events.push([0, Math.round(mx), Math.round(my), Math.round(aim * 100) / 100, w.t, p.id]);
  }
  // recoil kick (a touch stronger when dual-wielding)
  const kick = spec.kick * (barrels === 2 ? 1.4 : 1);
  p.vx -= Math.cos(aim) * kick;
  p.vy -= Math.sin(aim) * kick * 0.6;
  if (w.ammo === 0) autoSwitch(p);
}

function autoSwitch(p) {
  if (p.weapons[p.cur].ammo !== 0) return;
  let best = 0;
  for (let i = p.weapons.length - 1; i >= 0; i--) if (p.weapons[i].ammo !== 0) { best = i; break; }
  p.cur = best;
}

function doMelee(p) {
  if (p.meleeT > 0 || !p.alive) return;
  p.meleeT = MELEE_CD;
  p.protT = 0;
  game.events.push([5, p.id]);
  // lunge
  p.vx += Math.cos(p.aim) * 140;
  for (const o of game.players.values()) {
    if (o === p || !o.alive) continue;
    const dx = o.x - p.x, dy = o.y - p.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > MELEE_RANGE + PHW) continue;
    let da = Math.atan2(dy, dx) - p.aim;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    if (Math.abs(da) > MELEE_ARC) continue;
    const nx = d > 1 ? dx / d : Math.cos(p.aim), ny = d > 1 ? dy / d : 0;
    damage(o, MELEE_DMG, p, 7, nx * MELEE_KNOCK, ny * MELEE_KNOCK - 150);
  }
}

function throwNade(p) {
  if (p.nadeT > 0 || p.nades <= 0 || !p.alive) return;
  p.nades--;
  p.nadeT = NADE_CD;
  p.protT = 0;
  game.nades.push({
    id: nextShotId++, owner: p.id,
    x: p.x + Math.cos(p.aim) * 20, y: p.y - 8 + Math.sin(p.aim) * 20,
    vx: Math.cos(p.aim) * NADE_V + p.vx * 0.35, vy: Math.sin(p.aim) * NADE_V + p.vy * 0.35,
    fuse: NADE_FUSE,
  });
}

function doDash(p) {
  if (p.dashT > 0 || !p.alive) return;
  let dir = 0;
  if (p.input.l && !p.input.r) dir = -1;
  else if (p.input.r && !p.input.l) dir = 1;
  else dir = Math.cos(p.aim) >= 0 ? 1 : -1;
  p.dashT = DASH_CD;
  p.vx = dir * DASH_V;
  p.vy *= 0.4;
  game.events.push([7, p.id, dir]);
}

/* ------------------------------- physics ------------------------------- */

function stepPlayer(p, dt) {
  if (!p.alive) {
    p.deadT -= dt;
    if (p.deadT <= 0 && game.state === 0) spawnPlayer(p);
    return;
  }
  const inp = game.state === 0 ? p.input : { l: 0, r: 0, u: 0, d: 0, f: 0, a: p.input.a };
  p.protT = Math.max(0, p.protT - dt);
  p.fireT -= dt; p.meleeT = Math.max(0, p.meleeT - dt);
  p.nadeT = Math.max(0, p.nadeT - dt); p.dashT = Math.max(0, p.dashT - dt);
  p.aim = inp.a;

  // horizontal
  const want = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
  const accel = p.grounded ? ACCEL_GROUND : ACCEL_AIR;
  if (want !== 0) {
    if (Math.abs(p.vx) < MAX_RUN || Math.sign(p.vx) !== want) p.vx += want * accel * dt;
  } else if (p.grounded) {
    p.vx -= p.vx * Math.min(1, 9 * dt);
  } else {
    p.vx -= p.vx * Math.min(1, 0.7 * dt);
  }
  // soft cap beyond run speed (knockback decays)
  if (Math.abs(p.vx) > MAX_RUN) p.vx -= p.vx * Math.min(1, 1.6 * dt);

  // vertical: jump / jetpack
  p.jet = false;
  let usedFuel = false;
  if (inp.u) {
    if (p.grounded) {
      p.vy = JUMP_V;
      p.grounded = false;
    } else if (p.fuel > 0) {
      p.vy -= JET_THRUST * dt;
      if (p.vy < JET_MAX_UP) p.vy = JET_MAX_UP;
      p.fuel = Math.max(0, p.fuel - FUEL_DRAIN * dt);
      p.fuelIdle = 0;
      p.jet = true;
      usedFuel = true;
    }
  }
  if (!usedFuel) {
    p.fuelIdle += dt;
    if (p.fuelIdle > FUEL_DELAY) p.fuel = Math.min(FUEL_MAX, p.fuel + (p.grounded ? FUEL_REGEN_GROUND : FUEL_REGEN_AIR) * dt);
  }

  // gravity & fast fall
  p.vy += GRAV * game.gravityMul * dt;
  if (inp.d && !p.grounded) p.vy += FASTFALL_ACC * dt;
  const cap = inp.d ? FASTFALL_CAP : FALL_CAP;
  if (p.vy > cap) p.vy = cap;

  // integrate + resolve, axis separated
  const rects = game.map.rects;
  p.x += p.vx * dt;
  for (const r of rects) {
    if (!overlapsRect(p.x, p.y, PHW, PHH, r)) continue;
    if (p.vx > 0) p.x = r[0] - PHW;
    else if (p.vx < 0) p.x = r[0] + r[2] + PHW;
    p.vx = 0;
  }
  p.y += p.vy * dt;
  p.grounded = false;
  for (const r of rects) {
    if (!overlapsRect(p.x, p.y, PHW, PHH, r)) continue;
    if (p.vy >= 0 && p.y < r[1] + r[3] / 2 + PHH) { p.y = r[1] - PHH; p.vy = 0; p.grounded = true; }
    else { p.y = r[1] + r[3] + PHH; p.vy = Math.max(0, p.vy); }
  }

  // hazards
  for (const lz of game.map.lava) {
    if (overlapsRect(p.x, p.y, PHW, PHH, lz)) { kill(p, null, 8); return; }
  }
  if (game.map.voidY && p.y - PHH > game.map.voidY) { kill(p, null, 9); return; }
  // safety: out of world
  if (p.y > game.map.h + 400 || p.x < -400 || p.x > game.map.w + 400) { kill(p, null, 9); return; }

  // actions
  if (game.state === 0) {
    if (p.acts.melee) doMelee(p);
    if (p.acts.nade) throwNade(p);
    if (p.acts.dash) doDash(p);
    if (inp.f && p.fireT <= 0) fireWeapon(p);
  }
  p.acts.melee = p.acts.nade = p.acts.dash = false;
  // p.acts.use consumed in item pass
}

function stepBullets(dt) {
  const map = game.map;
  for (let i = game.bullets.length - 1; i >= 0; i--) {
    const b = game.bullets[i];
    b.life -= dt;
    const x1 = b.x + b.vx * dt, y1 = b.y + b.vy * dt;
    let bestT = 2, hitPlayer = null, hitWall = false;
    for (const r of map.rects) {
      const t = segRect(b.x, b.y, x1, y1, r[0], r[1], r[2], r[3]);
      if (t >= 0 && t < bestT) { bestT = t; hitWall = true; hitPlayer = null; }
    }
    for (const p of game.players.values()) {
      if (!p.alive || p.id === b.owner) continue;
      if (game.mode === 'tdm') {
        const owner = game.players.get(b.owner);
        if (owner && owner.team === p.team) continue;
      }
      const t = segRect(b.x, b.y, x1, y1, p.x - PHW - 3, p.y - PHH - 3, PHW * 2 + 6, PHH * 2 + 6);
      if (t >= 0 && t < bestT) { bestT = t; hitPlayer = p; hitWall = false; }
    }
    if (bestT <= 1) {
      const hx = b.x + (x1 - b.x) * bestT, hy = b.y + (y1 - b.y) * bestT;
      const spec = WEAPONS[b.t];
      const owner = game.players.get(b.owner) || null;
      if (spec.rocket) {
        explode(hx, hy, spec.splash, spec.sdmg, owner, b.t);
      } else if (hitPlayer) {
        const d = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
        damage(hitPlayer, spec.dmg, owner, b.t, (b.vx / d) * spec.knock, (b.vy / d) * spec.knock - 30);
      } else if (hitWall) {
        game.events.push([3, Math.round(hx), Math.round(hy)]);
      }
      game.bullets.splice(i, 1);
      continue;
    }
    b.x = x1; b.y = y1;
    if (b.life <= 0) {
      const spec = WEAPONS[b.t];
      if (spec.rocket) explode(b.x, b.y, spec.splash, spec.sdmg, game.players.get(b.owner) || null, b.t);
      game.bullets.splice(i, 1);
    }
  }
}

function stepNades(dt) {
  const rects = game.map.rects;
  for (let i = game.nades.length - 1; i >= 0; i--) {
    const g = game.nades[i];
    g.fuse -= dt;
    if (g.fuse <= 0) {
      explode(g.x, g.y, NADE_R, NADE_DMG, game.players.get(g.owner) || null, 6);
      game.nades.splice(i, 1);
      continue;
    }
    g.vy += GRAV * 0.9 * game.gravityMul * dt;
    const hw = 6;
    g.x += g.vx * dt;
    for (const r of rects) {
      if (!overlapsRect(g.x, g.y, hw, hw, r)) continue;
      if (g.vx > 0) g.x = r[0] - hw; else g.x = r[0] + r[2] + hw;
      if (Math.abs(g.vx) > 140) game.events.push([8, Math.round(g.x), Math.round(g.y)]);
      g.vx = -g.vx * 0.45;
    }
    g.y += g.vy * dt;
    for (const r of rects) {
      if (!overlapsRect(g.x, g.y, hw, hw, r)) continue;
      if (g.vy > 0) {
        g.y = r[1] - hw;
        if (Math.abs(g.vy) > 140) game.events.push([8, Math.round(g.x), Math.round(g.y)]);
        g.vy = Math.abs(g.vy) < 90 ? 0 : -g.vy * 0.5;
        g.vx -= g.vx * Math.min(1, 6 * dt);
      } else {
        g.y = r[1] + r[3] + hw;
        g.vy = -g.vy * 0.5;
      }
    }
    for (const lz of game.map.lava) {
      if (overlapsRect(g.x, g.y, hw, hw, lz)) { explode(g.x, g.y, NADE_R, NADE_DMG, game.players.get(g.owner) || null, 6); game.nades.splice(i, 1); break; }
    }
    if (game.map.voidY && g.y > game.map.voidY + 100) game.nades.splice(i, 1);
  }
}

function stepItems(dt) {
  for (const it of game.items) {
    if (!it.active) {
      it.t -= dt;
      if (it.t <= 0) it.active = true;
      continue;
    }
    for (const p of game.players.values()) {
      if (!p.alive) continue;
      if (Math.abs(p.x - it.x) > 34 || Math.abs(p.y - it.y) > 40) continue;
      if (takeItem(p, it)) {
        it.active = false;
        it.t = it.type === 10 ? ITEM_RESPAWN.med : it.type === 11 ? ITEM_RESPAWN.nades : ITEM_RESPAWN.weapon;
        game.events.push([4, Math.round(it.x), Math.round(it.y), it.type, p.id]);
        break;
      }
    }
  }
  for (const p of game.players.values()) p.acts.use = false;
}

function takeItem(p, it) {
  if (it.type === 10) {
    if (p.hp >= HP_MAX) return false;
    p.hp = Math.min(HP_MAX, p.hp + MED_HEAL);
    return true;
  }
  if (it.type === 11) {
    if (p.nades >= NADE_MAX) return false;
    p.nades = Math.min(NADE_MAX, p.nades + 2);
    return true;
  }
  // weapon
  const spec = WEAPONS[it.type];
  const have = p.weapons.findIndex((w) => w.t === it.type);
  if (have >= 0) {
    const w = p.weapons[have];
    if (w.ammo >= spec.max) return false;
    w.ammo = Math.min(spec.max, w.ammo + spec.pick);
    return true;
  }
  if (p.weapons.length < 3) {
    p.weapons.push({ t: it.type, ammo: spec.pick });
    p.cur = p.weapons.length - 1;
    return true;
  }
  if (p.acts.use || p.bot) {
    const slot = p.cur === 0 ? 1 : p.cur;
    p.weapons[slot] = { t: it.type, ammo: spec.pick };
    p.cur = slot;
    return true;
  }
  return false;
}

/* ------------------------------- bots ---------------------------------- */

function makeBrain() {
  return {
    thinkT: 0, target: null, wpX: 0, wpY: 0,
    strafe: 1, strafeT: 0, burstT: 0, firing: false,
    aimErr: 0.3, reactT: 0, lastX: 0, stuckT: 0, forceJetT: 0, mode: 'fight',
  };
}

function botThink(p) {
  const br = p.brain;
  const diff = game.botDiff;
  const baseErr = [0.30, 0.17, 0.08][diff];
  const react = [0.55, 0.32, 0.16][diff];

  // pick target: nearest visible enemy, else nearest enemy
  let best = null, bestD = 1e12, bestVis = null, bestVisD = 1e12;
  for (const o of game.players.values()) {
    if (o === p || !o.alive) continue;
    if (game.mode === 'tdm' && o.team === p.team) continue;
    const d = dist2(p.x, p.y, o.x, o.y);
    if (d < bestD) { bestD = d; best = o; }
    if (d < bestVisD && d < 900 * 900 && losClear(game.map, p.x, p.y - 6, o.x, o.y - 6)) { bestVisD = d; bestVis = o; }
  }
  const newTarget = bestVis || best;
  if (newTarget !== br.target) {
    br.target = newTarget;
    br.reactT = react * rand(0.7, 1.4);
    br.aimErr = baseErr * 2;
  }
  br.visible = !!bestVis && bestVis === br.target;
  br.targDist = br.target ? Math.sqrt(dist2(p.x, p.y, br.target.x, br.target.y)) : 1e9;

  // mode: heal / arm / fight
  br.mode = 'fight';
  let wp = br.target ? { x: br.target.x, y: br.target.y } : { x: game.map.w / 2, y: game.map.h / 2 };
  if (p.hp < 45) {
    const med = nearestItem(p, (it) => it.type === 10, 900);
    if (med) { br.mode = 'heal'; wp = med; }
  }
  if (br.mode === 'fight' && p.weapons.length < 3) {
    const gun = nearestItem(p, (it) => it.type <= 5 && !p.weapons.some((w) => w.t === it.type), 700);
    if (gun && (!br.target || br.targDist > 380)) { br.mode = 'arm'; wp = gun; }
  }

  // keep preferred range while fighting
  if (br.mode === 'fight' && br.target && br.visible) {
    const w = p.weapons[p.cur];
    const pref = [320, 380, 170, 420, 650, 420][w.t] || 350;
    if (br.targDist < pref * 0.55) wp = { x: p.x + (p.x - br.target.x), y: br.target.y - 40 };
    else if (br.targDist < pref * 1.4) {
      br.strafeT -= 0.15;
      if (br.strafeT <= 0) { br.strafe = -br.strafe; br.strafeT = rand(0.5, 1.3); }
      wp = { x: p.x + br.strafe * 220, y: br.target.y };
    }
  }
  br.wpX = wp.x; br.wpY = wp.y;

  // weapon choice
  if (br.target) {
    const d = br.targDist;
    let want = p.cur;
    let bestScore = -1;
    for (let i = 0; i < p.weapons.length; i++) {
      const w = p.weapons[i];
      if (w.ammo === 0) continue;
      let s = 1;
      if (w.t === 2) s = d < 260 ? 5 : 0.3;
      else if (w.t === 1) s = d < 520 ? 3 : 1;
      else if (w.t === 3) s = d < 850 ? 3.4 : 2;
      else if (w.t === 4) s = d > 480 ? 5 : 0.6;
      else if (w.t === 5) s = d > 240 && d < 760 ? 4 : 0;
      else s = 1.2;
      if (s > bestScore) { bestScore = s; want = i; }
    }
    p.cur = want;
  }

  // grenade toss
  if (br.target && br.visible && p.nades > 0 && p.nadeT <= 0 && br.targDist > 240 && br.targDist < 560 && Math.random() < 0.22) {
    p.acts.nade = true;
  }
  // dash to escape when hurt
  if (p.hp < 35 && p.dashT <= 0 && game.time - p.lastHitT < 1 && Math.random() < 0.4) p.acts.dash = true;

  // melee
  if (br.target && br.targDist < 70 && p.meleeT <= 0) p.acts.melee = true;
}

function nearestItem(p, pred, maxD) {
  let best = null, bestD = maxD * maxD;
  for (const it of game.items) {
    if (!it.active || !pred(it)) continue;
    const d = dist2(p.x, p.y, it.x, it.y);
    if (d < bestD) { bestD = d; best = it; }
  }
  return best;
}

function botSteer(p, dt) {
  const br = p.brain;
  const inp = p.input;
  br.reactT -= dt;
  br.aimErr += (([0.30, 0.17, 0.08][game.botDiff]) * 0.55 - br.aimErr) * Math.min(1, dt * 1.4);

  // movement toward waypoint
  const dx = br.wpX - p.x;
  inp.l = dx < -24 ? 1 : 0;
  inp.r = dx > 24 ? 1 : 0;

  // vertical control
  const voidMap = !!game.map.voidY;
  let up = false;
  // on void maps keep a fuel reserve for recovery
  if (br.wpY < p.y - 60 && p.fuel > (voidMap ? 30 : 8)) up = true;
  if (Math.abs(dx) > 30) {
    // wall probe — also while airborne, so bots jet over tall obstacles
    const dir = dx > 0 ? 1 : -1;
    for (const r of game.map.rects) {
      if (overlapsRect(p.x + dir * 40, p.y - 10, PHW, PHH, r)) { if (p.fuel > 4) up = true; break; }
    }
  }
  if (br.forceJetT > 0) { br.forceJetT -= dt; if (p.fuel > 2) up = true; }
  // hazard avoidance
  if (voidMap && p.y > game.map.voidY - 520 && !p.grounded) up = p.fuel > 2;
  for (const lz of game.map.lava) {
    if (p.x > lz[0] - 60 && p.x < lz[0] + lz[2] + 60 && p.y > lz[1] - 240) { up = p.fuel > 2; inp[dx > 0 ? 'r' : 'l'] = 1; }
  }
  inp.u = up ? 1 : 0;
  // never dive toward the void
  inp.d = br.wpY > p.y + 200 && !up && !(voidMap && p.y > game.map.voidY - 760) ? 1 : 0;

  // stuck detection -> burst of forced jetting + strafe flip, then dash
  if ((inp.l || inp.r) && Math.abs(p.x - br.lastX) < 1.5) br.stuckT += dt; else br.stuckT = 0;
  br.lastX = p.x;
  if (br.stuckT > 0.9) {
    br.forceJetT = 0.6;
    br.strafe = -br.strafe;
    if (br.stuckT > 1.8) { p.acts.dash = true; br.stuckT = 0; }
  }

  // aiming + firing
  const t = br.target;
  if (t && t.alive) {
    const w = p.weapons[p.cur];
    const spd = WEAPONS[w.t].spd;
    const lead = clamp(br.targDist / spd, 0, 0.7) * 0.85;
    const tx = t.x + t.vx * lead, ty = t.y + t.vy * lead - 8;
    const err = br.aimErr * (br.visible ? 1 : 2);
    p.input.a = Math.atan2(ty - p.y, tx - p.x) + (Math.random() - 0.5) * 2 * err;

    const range = [650, 540, 290, 850, 1500, 760][w.t] || 600;
    const minRange = w.t === 5 ? 220 : 0;
    let wantFire = br.visible && br.reactT <= 0 && br.targDist < range && br.targDist > minRange && game.state === 0;
    // burst pattern
    br.burstT -= dt;
    if (br.burstT <= 0) {
      br.firing = !br.firing;
      br.burstT = br.firing ? rand(0.12, 0.5) : rand(0.08, [0.45, 0.28, 0.12][game.botDiff]);
    }
    inp.f = wantFire && (br.firing || !WEAPONS[w.t].auto) ? 1 : 0;
  } else {
    inp.f = 0;
    p.input.a = Math.atan2(0, dx >= 0 ? 1 : -1);
  }
}

function maintainBots() {
  const bots = [...game.players.values()].filter((p) => p.bot);
  const humans = game.players.size - bots.length;
  let want = clamp(game.botTarget, 0, MAX_PLAYERS - humans);
  while (bots.length < want) {
    const used = new Set([...game.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || ('BOT-' + nextId);
    const b = makePlayer(name, null, true);
    game.players.set(b.id, b);
    bots.push(b);
    announce(`${b.name} joined the arena`, 'info');
    sendRoster();
  }
  while (bots.length > want) {
    const b = bots.pop();
    game.players.delete(b.id);
    announce(`${b.name} left the arena`, 'info');
    sendRoster();
  }
}

/* ---------------------------- match flow ------------------------------- */

function resetMatch() {
  game.state = 0;
  game.tl = game.timeLimit * 60;
  game.ta = 0; game.tb = 0;
  game.firstBlood = false;
  game.bullets = [];
  game.nades = [];
  for (const it of game.items) { it.active = true; it.t = 0; }
  for (const p of game.players.values()) {
    p.kills = 0; p.deaths = 0; p.spree = 0; p.multi = 0;
    spawnPlayer(p);
  }
  announce('FIGHT!', 'big');
}

function endMatch() {
  game.state = 1;
  game.tl = 9;
  game.bullets = [];
  game.nades = [];
  let wid = -1, wteam = -1;
  if (game.mode === 'tdm') {
    wteam = game.ta === game.tb ? -1 : (game.ta > game.tb ? 0 : 1);
  } else {
    const sorted = [...game.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    if (sorted.length) wid = sorted[0].id;
  }
  broadcast({ t: 'o', wid, wteam });
}

function announce(msg, kind) {
  broadcast({ t: 'a', msg, kind: kind || 'info' });
}

/* ----------------------------- main loop ------------------------------- */

function tick() {
  const dt = TICK;
  game.tick++;
  game.time += dt;

  if (game.state === 0) {
    game.tl -= dt;
    if (game.tl <= 0) { game.tl = 0; endMatch(); }
  } else {
    game.tl -= dt;
    if (game.tl <= 0) resetMatch();
  }

  for (const p of game.players.values()) {
    if (p.bot && p.alive) {
      p.brain.thinkT -= dt;
      if (p.brain.thinkT <= 0) { p.brain.thinkT = 0.15; botThink(p); }
      botSteer(p, dt);
    }
    stepPlayer(p, dt);
  }
  stepBullets(dt);
  stepNades(dt);
  stepItems(dt);

  if (game.tick % SNAP_EVERY === 0) broadcastSnapshot();
}

function buildSnapshot() {
  const p = [];
  for (const pl of game.players.values()) {
    let flags = 0;
    if (pl.jet) flags |= 1;
    if (pl.grounded) flags |= 2;
    if (pl.protT > 0) flags |= 4;
    if (!pl.alive) flags |= 8;
    p.push([
      pl.id, Math.round(pl.x), Math.round(pl.y), Math.round(pl.vx), Math.round(pl.vy),
      Math.round(pl.aim * 1000) / 1000, Math.max(0, Math.ceil(pl.hp)), Math.round(pl.fuel),
      pl.cur, flags, pl.kills, pl.deaths, pl.alive ? 0 : Math.max(0, Math.ceil(pl.deadT * 10)),
      pl.weapons.map((w) => [w.t, w.ammo]), pl.nades,
      Math.ceil(pl.nadeT * 10), Math.ceil(pl.dashT * 10),
    ]);
  }
  const b = game.bullets.map((x) => [x.id, x.t, Math.round(x.x), Math.round(x.y), Math.round(x.vx), Math.round(x.vy)]);
  const n = game.nades.map((g) => [g.id, Math.round(g.x), Math.round(g.y), Math.round(g.fuse * 100) / 100]);
  const it = [];
  for (let i = 0; i < game.items.length; i++) if (game.items[i].active) it.push(i);
  const snap = {
    t: 's', ts: Math.round(game.time * 1000), st: game.state,
    tl: Math.round(game.tl * 10) / 10, ta: game.ta, tb: game.tb,
    p, b, n, it, e: game.events,
  };
  game.events = [];
  return snap;
}

function broadcastSnapshot() {
  const frame = wsFrame(0x1, Buffer.from(JSON.stringify(buildSnapshot()), 'utf8'));
  for (const p of game.players.values()) if (p.conn) p.conn.sendRaw(frame);
}

function broadcast(obj) {
  const frame = wsFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  for (const p of game.players.values()) if (p.conn) p.conn.sendRaw(frame);
}

function sendRoster() {
  broadcast({ t: 'r', l: [...game.players.values()].map((p) => [p.id, p.name, p.team, p.bot ? 1 : 0, p.host ? 1 : 0]) });
}

/* --------------------------- net / messages ---------------------------- */

function sanitizeName(s) {
  if (typeof s !== 'string') return 'PLAYER';
  s = s.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 16);
  return s || 'PLAYER';
}

function ensureHost() {
  let host = null;
  for (const p of game.players.values()) if (!p.bot && p.host) host = p;
  if (host) return;
  for (const p of game.players.values()) {
    if (!p.bot) { p.host = true; sendRoster(); return; }
  }
}

function handleMessage(p, conn, raw) {
  if (raw.length > 4096) return;
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  p.msgCount++;

  switch (m.t) {
    case 'i': {
      const inp = p.input;
      inp.l = m.l ? 1 : 0; inp.r = m.r ? 1 : 0; inp.u = m.u ? 1 : 0; inp.d = m.d ? 1 : 0; inp.f = m.f ? 1 : 0;
      const a = Number(m.a);
      if (Number.isFinite(a)) inp.a = clamp(a, -Math.PI, Math.PI);
      break;
    }
    case 'act': {
      if (m.k === 'melee') p.acts.melee = true;
      else if (m.k === 'nade') p.acts.nade = true;
      else if (m.k === 'dash') p.acts.dash = true;
      else if (m.k === 'use') p.acts.use = true;
      break;
    }
    case 'sw': {
      const i = m.i | 0;
      if (i >= 0 && i < p.weapons.length && p.weapons[i].ammo !== 0) p.cur = i;
      break;
    }
    case 'c': {
      const now = Date.now();
      if (now - p.lastChatT < 700) return;
      p.lastChatT = now;
      const msg = String(m.msg || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 120);
      if (msg) broadcast({ t: 'c', id: p.id, msg });
      break;
    }
    case 'p':
      conn.send(JSON.stringify({ t: 'p', c: m.c, s: Math.round(game.time * 1000) }));
      break;
    case 'h': {
      if (!p.host || !m.set || typeof m.set !== 'object') return;
      applyHostSettings(m.set, p);
      break;
    }
  }
}

function applyHostSettings(set, host) {
  let mapChanged = false, modeChanged = false, restart = !!set.restart;
  if (typeof set.map === 'string' && MAPS[set.map] && set.map !== game.map.key) { loadMap(set.map); mapChanged = true; }
  if (set.mode === 'ffa' || set.mode === 'tdm') {
    if (set.mode !== game.mode) {
      game.mode = set.mode;
      modeChanged = true;
      // re-balance teams deterministically by score
      const sorted = [...game.players.values()].sort((a, b) => b.kills - a.kills);
      sorted.forEach((pl, i) => { pl.team = game.mode === 'tdm' ? i % 2 : 0; });
    }
  }
  if (set.bots !== undefined) game.botTarget = clamp(set.bots | 0, 0, 8);
  if (set.diff !== undefined) game.botDiff = clamp(set.diff | 0, 0, 2);
  if (set.score !== undefined) game.scoreLimit = clamp(set.score | 0, 5, 100);
  if (set.time !== undefined) game.timeLimit = clamp(set.time | 0, 2, 30);
  if (set.grav !== undefined) game.gravityMul = clamp((set.grav | 0) / 100, 0.3, 2.0);
  maintainBots();
  broadcastSettings();
  if (mapChanged || modeChanged) {
    broadcast({ t: 'map', map: mapPayload(), mode: game.mode, scoreLimit: game.scoreLimit, timeLimit: game.timeLimit, bots: game.botTarget, diff: game.botDiff, grav: Math.round(game.gravityMul * 100) });
    sendRoster();
    resetMatch();
    announce(`${host.name} changed settings — ${game.map.name} · ${game.mode.toUpperCase()}`, 'match');
  } else if (restart) {
    resetMatch();
    announce(`${host.name} restarted the match`, 'match');
  }
}

function broadcastSettings() {
  broadcast({ t: 'set', mode: game.mode, scoreLimit: game.scoreLimit, timeLimit: game.timeLimit, bots: game.botTarget, diff: game.botDiff, grav: Math.round(game.gravityMul * 100) });
}

function handleJoin(conn, name) {
  if (game.players.size >= MAX_PLAYERS) {
    // kick a bot to make room for a human
    const bot = [...game.players.values()].find((p) => p.bot);
    if (bot) { game.players.delete(bot.id); sendRoster(); }
    else { conn.send(JSON.stringify({ t: 'err', msg: 'Server full' })); conn.destroy(); return null; }
  }
  const p = makePlayer(sanitizeName(name), conn, false);
  game.players.set(p.id, p);
  ensureHost();
  conn.send(JSON.stringify({
    t: 'w', id: p.id, map: mapPayload(), mode: game.mode,
    scoreLimit: game.scoreLimit, timeLimit: game.timeLimit,
    bots: game.botTarget, diff: game.botDiff, grav: Math.round(game.gravityMul * 100),
    roster: [...game.players.values()].map((q) => [q.id, q.name, q.team, q.bot ? 1 : 0, q.host ? 1 : 0]),
  }));
  sendRoster();
  announce(`${p.name} joined the arena`, 'info');
  spawnPlayer(p);
  return p;
}

function handleLeave(p) {
  if (!game.players.has(p.id)) return;
  game.players.delete(p.id);
  announce(`${p.name} left the arena`, 'info');
  ensureHost();
  sendRoster();
  maintainBots();
}

/* ---------------------------- HTTP / static ---------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
};
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const conn = new WSConn(socket);
  let player = null;
  let inputCount = 0;
  const rateTimer = setInterval(() => { inputCount = 0; }, 1000);
  conn.onmessage = (raw) => {
    if (++inputCount > 200) return; // flood guard
    if (!player) {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m && m.t === 'j') player = handleJoin(conn, m.name);
      return;
    }
    handleMessage(player, conn, raw);
  };
  conn.onclose = () => {
    clearInterval(rateTimer);
    if (player) handleLeave(player);
  };
});

// keepalive ping + dead connection sweep
setInterval(() => {
  for (const p of game.players.values()) {
    if (!p.conn) continue;
    if (!p.conn.alive) { p.conn.destroy(); continue; }
    p.conn.alive = false;
    p.conn.ping();
  }
}, 30000);

/* -------------------------------- boot --------------------------------- */

function boot() {
  loadMap(String(ARGS.map || 'foundry'));
  game.mode = ARGS.mode === 'tdm' ? 'tdm' : 'ffa';
  game.botTarget = ARGS.bots !== undefined ? clamp(parseInt(ARGS.bots, 10) || 0, 0, 8) : 3;
  game.botDiff = ARGS.diff !== undefined ? clamp(parseInt(ARGS.diff, 10) || 0, 0, 2) : 1;
  game.scoreLimit = clamp(parseInt(ARGS.score, 10) || 25, 5, 100);
  game.timeLimit = clamp(parseInt(ARGS.time, 10) || 8, 2, 30);
  game.gravityMul = ARGS.grav !== undefined ? clamp((parseInt(ARGS.grav, 10) || 100) / 100, 0.3, 2.0) : 1;
  game.tl = game.timeLimit * 60;
  maintainBots();

  // fixed-step loop with accumulator
  let last = process.hrtime.bigint();
  let acc = 0;
  setInterval(() => {
    const now = process.hrtime.bigint();
    acc += Number(now - last) / 1e9;
    last = now;
    if (acc > 0.25) acc = 0.25;
    while (acc >= TICK) { acc -= TICK; tick(); }
  }, 8);

  const port = parseInt(process.env.PORT || ARGS.port, 10) || 3000;
  server.listen(port, () => {
    const actual = server.address().port;
    console.log('LISTENING ' + actual);
    const urls = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const i of ifs[name] || []) {
        if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${actual}`);
      }
    }
    console.log('');
    console.log('  ███╗   ██╗███████╗ ██████╗ ███╗   ██╗');
    console.log('  ████╗  ██║██╔════╝██╔═══██╗████╗  ██║   N E O N');
    console.log('  ██╔██╗ ██║█████╗  ██║   ██║██╔██╗ ██║   M I L I T I A');
    console.log('  ██║╚██╗██║██╔══╝  ██║   ██║██║╚██╗██║');
    console.log('  ██║ ╚████║███████╗╚██████╔╝██║ ╚████║   jetpack arena');
    console.log('  ╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝');
    console.log('');
    console.log(`  Map ${game.map.name} · ${game.mode.toUpperCase()} · ${game.botTarget} bots · first to ${game.scoreLimit}`);
    console.log('');
    console.log(`  PLAY      →  http://localhost:${actual}`);
    for (const u of urls) console.log(`  LAN PARTY →  ${u}   (share this with friends on your network)`);
    console.log('');
  });
  server.on('error', (e) => {
    console.error('Server error: ' + e.message);
    process.exit(1);
  });
}

boot();
