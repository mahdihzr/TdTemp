/*
 * NEON MILITIA — browser client
 * Renders authoritative server snapshots with interpolation, sends inputs,
 * and layers on all the juice: particles, screen shake, synth audio, HUD.
 * Protocol: see header of server.js
 */
'use strict';

/* ============================== DOM / CANVAS ============================ */

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
let viewW = 0, viewH = 0, DPR = 1;

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  viewW = window.innerWidth; viewH = window.innerHeight;
  canvas.width = Math.round(viewW * DPR);
  canvas.height = Math.round(viewH * DPR);
}
window.addEventListener('resize', resize);
resize();

/* ============================== CONSTANTS =============================== */

const PHW = 14, PHH = 23;
const WNAME = ['PISTOL', 'SMG', 'SHOTGUN', 'RIFLE', 'SNIPER', 'ROCKET'];
const KILLNAME = ['PISTOL', 'SMG', 'SHOTGUN', 'RIFLE', 'SNIPER', 'ROCKET', 'GRENADE', 'MELEE', 'LAVA', 'VOID'];
const ITEMNAME = { 0: 'PISTOL', 1: 'SMG', 2: 'SHOTGUN', 3: 'RIFLE', 4: 'SNIPER', 5: 'ROCKET LAUNCHER', 10: 'MEDKIT', 11: 'GRENADES' };
const TEAM_COLORS = ['#ff4655', '#2e9bff'];
const TEAM_NAMES = ['RED', 'BLUE'];

const FLAG_JET = 1, FLAG_GROUND = 2, FLAG_PROT = 4, FLAG_DEAD = 8;

/* ================================ STATE ================================= */

const state = {
  connected: false,
  myId: -1,
  map: null,
  mode: 'ffa',
  scoreLimit: 25,
  timeLimit: 8,
  bots: 3,
  diff: 1,
  roster: new Map(),          // id -> {name, team, bot, host}
  snaps: [],                  // parsed snapshots
  playTs: 0,                  // interpolated server-time being rendered (ms)
  killfeed: [],               // {t, ktxt, kcol, vtxt, vcol, w}
  anns: [],                   // {msg, kind, t}
  floaters: [],               // {x,y,vy,txt,col,t,size}
  hitArrows: [],              // {ang,t}
  matchOver: null,            // {wid, wteam}
  dmgFlash: 0,
  hitmarkT: 0,
  recoilHeat: 0,
  lastSlot: 0,
  muted: false,
  lastKiller: '',
};

const cam = { x: 1300, y: 750, shakeT: 0, shakeMag: 0 };
const mouse = { x: 0, y: 0, down: false };
const keys = {};
let ws = null;
let selfSmooth = null;        // smoothed render position of self
let chatOpen = false, escOpen = false, boardOpen = false;
let parallax = null;
let prevBulletPos = new Map();
let menuT = 0;

/* ============================= AUDIO ENGINE ============================= */

const AU = {
  ctx: null, master: null, sfxG: null, musG: null, noiseBuf: null,
  jetGain: null, started: false,
  sfxVol: 0.8, musVol: 0.45,

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.sfxG = this.ctx.createGain();
    this.sfxG.connect(this.master);
    this.musG = this.ctx.createGain();
    this.musG.connect(this.master);
    this.setSfx(this.sfxVol); this.setMus(this.musVol);
    // shared noise buffer
    const len = this.ctx.sampleRate * 1.5;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // jetpack loop
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 0.7;
    this.jetGain = this.ctx.createGain();
    this.jetGain.gain.value = 0;
    src.connect(bp); bp.connect(this.jetGain); this.jetGain.connect(this.sfxG);
    src.start();
    this.startMusic();
    this.started = true;
  },
  setSfx(v) { this.sfxVol = v; if (this.sfxG) this.sfxG.gain.value = v * v; },
  setMus(v) { this.musVol = v; if (this.musG) this.musG.gain.value = v * v * 0.5; },
  setMuted(m) { if (this.master) this.master.gain.value = m ? 0 : 1; },

  pan(x) {
    if (!this.ctx || this.ctx.createStereoPanner === undefined) return null;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, (x - cam.x) / 700));
    return p;
  },
  dist(x, y) {
    const d = Math.hypot(x - cam.x, y - cam.y);
    return Math.max(0, 1 - d / 1500);
  },
  out(node, x, y, gain) {
    const g = this.ctx.createGain();
    g.gain.value = gain * (x !== undefined ? this.dist(x, y) : 1);
    node.connect(g);
    const p = x !== undefined ? this.pan(x) : null;
    if (p) { g.connect(p); p.connect(this.sfxG); } else g.connect(this.sfxG);
    return g;
  },
  osc(type, f0, f1, dur, gain, x, y) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1 !== null) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = this.out(o, x, y, gain);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur, gain, filtType, f0, f1, x, y) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = 0.7 + Math.random() * 0.6;
    let node = s;
    if (filtType) {
      const f = this.ctx.createBiquadFilter();
      f.type = filtType; f.frequency.setValueAtTime(f0, t);
      if (f1) f.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
      f.Q.value = 1;
      s.connect(f); node = f;
    }
    const g = this.out(node, x, y, gain);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.start(t); s.stop(t + dur + 0.02);
  },

  shot(wt, x, y) {
    if (!this.ctx) return;
    switch (wt) {
      case 0: this.noise(0.10, 0.50, 'lowpass', 3200, 400, x, y); this.osc('square', 420, 90, 0.07, 0.20, x, y); break;
      case 1: this.noise(0.07, 0.38, 'highpass', 900, null, x, y); this.osc('square', 520, 140, 0.05, 0.14, x, y); break;
      case 2: this.noise(0.28, 0.85, 'lowpass', 1500, 180, x, y); this.osc('sine', 160, 50, 0.22, 0.5, x, y); break;
      case 3: this.noise(0.11, 0.55, 'lowpass', 4200, 500, x, y); this.osc('sawtooth', 300, 70, 0.09, 0.22, x, y); break;
      case 4: this.noise(0.4, 0.9, 'lowpass', 5000, 300, x, y); this.osc('sawtooth', 900, 60, 0.3, 0.3, x, y); break;
      case 5: this.noise(0.5, 0.7, 'lowpass', 900, 2400, x, y); this.osc('sawtooth', 90, 220, 0.4, 0.25, x, y); break;
    }
  },
  expl(x, y, big) {
    if (!this.ctx) return;
    this.noise(big ? 0.9 : 0.6, 1.1, 'lowpass', 2200, 60, x, y);
    this.osc('sine', 140, 28, big ? 0.7 : 0.5, 0.9, x, y);
    this.osc('triangle', 90, 30, 0.4, 0.5, x, y);
  },
  hitConfirm() { this.osc('square', 1100, 700, 0.05, 0.16); },
  hurt() { this.osc('sawtooth', 220, 60, 0.18, 0.4); this.noise(0.12, 0.3, 'lowpass', 800, 200); },
  melee(x, y) { this.noise(0.14, 0.4, 'bandpass', 1600, 300, x, y); },
  meleeHit(x, y) { this.noise(0.12, 0.6, 'lowpass', 700, 120, x, y); this.osc('sine', 150, 60, 0.12, 0.5, x, y); },
  dash(x, y) { this.noise(0.22, 0.4, 'bandpass', 600, 2400, x, y); },
  pickup(kind) {
    if (!this.ctx) return;
    if (kind === 10) { this.osc('sine', 520, 780, 0.12, 0.25); this.osc('sine', 780, 1040, 0.14, 0.2); }
    else { this.osc('square', 300, 600, 0.08, 0.18); this.osc('square', 600, 900, 0.1, 0.14); }
  },
  dry() { this.osc('square', 900, 500, 0.04, 0.1); },
  spawnFx(x, y) { this.osc('sine', 200, 900, 0.25, 0.2, x, y); },
  death(x, y) { this.osc('sawtooth', 300, 40, 0.5, 0.4, x, y); this.noise(0.4, 0.5, 'lowpass', 1200, 100, x, y); },
  bounce(x, y) { this.osc('square', 500, 320, 0.04, 0.12, x, y); },
  sting(kind) {
    if (!this.ctx) return;
    const notes = kind === 'gold' ? [660, 880, 1320] : [440, 660, 880];
    notes.forEach((f, i) => setTimeout(() => this.osc('square', f, f, 0.12, 0.18), i * 70));
  },
  uiClick() { this.osc('square', 700, 500, 0.04, 0.1); },

  /* tiny dark synthwave loop */
  musicStep: 0, musicTimer: null,
  startMusic() {
    if (this.musicTimer) return;
    const bass = [55, 55, 65.4, 55, 73.4, 55, 49, 49];           // A C D A...
    const arp = [220, 261.6, 329.6, 261.6, 220, 293.7, 329.6, 392];
    const stepDur = 60 / 132 / 2; // 16ths at 132bpm
    let nextT = this.ctx.currentTime + 0.1;
    this.musicTimer = setInterval(() => {
      if (!this.ctx) return;
      while (nextT < this.ctx.currentTime + 0.25) {
        const s = this.musicStep;
        const t = nextT;
        // bass every 8th
        if (s % 2 === 0) {
          const f = bass[(s / 2) % 8];
          const o = this.ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
          const fl = this.ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 320;
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 1.8);
          o.connect(fl); fl.connect(g); g.connect(this.musG);
          o.start(t); o.stop(t + stepDur * 2);
        }
        // kick on quarters
        if (s % 4 === 0) {
          const o = this.ctx.createOscillator(); o.type = 'sine';
          o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
          o.connect(g); g.connect(this.musG); o.start(t); o.stop(t + 0.16);
        }
        // hat offbeats
        if (s % 4 === 2) {
          const sN = this.ctx.createBufferSource(); sN.buffer = this.noiseBuf;
          const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
          sN.connect(f); f.connect(g); g.connect(this.musG); sN.start(t); sN.stop(t + 0.06);
        }
        // sparse arp on bar 2 of 4
        if ((Math.floor(s / 16) % 4) >= 2 && s % 2 === 1) {
          const f = arp[(s >> 1) % 8] * 2;
          const o = this.ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 1.5);
          o.connect(g); g.connect(this.musG); o.start(t); o.stop(t + stepDur * 1.6);
        }
        nextT += stepDur;
        this.musicStep++;
      }
    }, 100);
  },
};

/* ============================== NETWORKING ============================== */

function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  $('menuStatus').textContent = 'CONNECTING…';
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'j', name }));
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    handleMsg(m);
  };
  ws.onclose = () => {
    if (state.connected) toast('DISCONNECTED FROM SERVER');
    state.connected = false;
    state.snaps = [];
    document.body.classList.remove('ingame');
    $('menu').classList.remove('hidden');
    $('escMenu').classList.add('hidden');
    $('menuStatus').textContent = 'CONNECTION LOST — DEPLOY TO RETRY';
  };
  ws.onerror = () => { $('menuStatus').textContent = 'CONNECTION FAILED — IS THE SERVER UP?'; };
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function handleMsg(m) {
  switch (m.t) {
    case 'w':
      state.myId = m.id;
      applyMap(m.map, m);
      setRoster(m.roster);
      state.connected = true;
      state.snaps = [];
      state.matchOver = null;
      $('menu').classList.add('hidden');
      document.body.classList.add('ingame');
      $('menuStatus').textContent = '';
      syncHostPanel();
      break;
    case 'map':
      applyMap(m.map, m);
      state.snaps = [];
      state.matchOver = null;
      particles.length = 0;
      prevBulletPos.clear();
      syncHostPanel();
      break;
    case 'r':
      setRoster(m.l);
      syncHostPanel();
      break;
    case 's': onSnapshot(m); break;
    case 'k': onKill(m); break;
    case 'c': onChat(m); break;
    case 'a': onAnnounce(m); break;
    case 'o':
      state.matchOver = { wid: m.wid, wteam: m.wteam };
      AU.sting('gold');
      break;
  }
}

function applyMap(map, m) {
  state.map = map;
  state.mode = m.mode;
  if (m.scoreLimit) state.scoreLimit = m.scoreLimit;
  if (m.timeLimit) state.timeLimit = m.timeLimit;
  if (m.bots !== undefined) state.bots = m.bots;
  if (m.diff !== undefined) state.diff = m.diff;
  buildParallax();
  cam.x = map.w / 2; cam.y = map.h / 2;
  selfSmooth = null;
}

function setRoster(list) {
  state.roster.clear();
  for (const r of list) state.roster.set(r[0], { name: r[1], team: r[2], bot: !!r[3], host: !!r[4] });
}

function nameOf(id) {
  if (id === -1) return 'THE ARENA';
  const r = state.roster.get(id);
  return r ? r.name : '???';
}
function colorFor(id) {
  const r = state.roster.get(id);
  if (state.mode === 'tdm' && r) return TEAM_COLORS[r.team] || '#fff';
  return `hsl(${(id * 131) % 360} 75% 62%)`;
}
function amHost() {
  const r = state.roster.get(state.myId);
  return r && r.host;
}

/* parse snapshot into maps for interpolation */
function onSnapshot(m) {
  const snap = {
    ts: m.ts, recvAt: performance.now(),
    st: m.st, tl: m.tl, ta: m.ta, tb: m.tb,
    players: new Map(), bullets: new Map(), nades: new Map(),
    items: new Set(m.it),
  };
  for (const a of m.p) {
    snap.players.set(a[0], {
      id: a[0], x: a[1], y: a[2], vx: a[3], vy: a[4], aim: a[5], hp: a[6], fuel: a[7],
      cur: a[8], flags: a[9], kills: a[10], deaths: a[11], deadT: a[12] / 10,
      weapons: a[13], nades: a[14], nadeCd: a[15] / 10, dashCd: a[16] / 10,
    });
  }
  for (const a of m.b) snap.bullets.set(a[0], { id: a[0], t: a[1], x: a[2], y: a[3], vx: a[4], vy: a[5] });
  for (const a of m.n) snap.nades.set(a[0], { id: a[0], x: a[1], y: a[2], fuse: a[3] });
  state.snaps.push(snap);
  if (state.snaps.length > 40) state.snaps.shift();
  if (snap.st === 0 && state.matchOver) { state.matchOver = null; }
  for (const e of m.e) onEvent(e, snap);
}

function onEvent(e, snap) {
  switch (e[0]) {
    case 0: { // shot
      const [, x, y, aim, wt, pid] = e;
      fxMuzzle(x, y, aim, wt);
      AU.shot(wt, x, y);
      if (pid === state.myId) { state.recoilHeat = Math.min(1, state.recoilHeat + (wt === 2 || wt === 4 ? 0.7 : 0.25)); addShake(wt === 4 || wt === 2 ? 5 : 2, 0.12); }
      break;
    }
    case 1: fxExplosion(e[1], e[2], e[3]); break;
    case 2: { // hit
      const [, x, y, vid, sid, dmg] = e;
      fxBlood(x, y);
      if (sid === state.myId && vid !== state.myId) {
        state.hitmarkT = 0.18;
        AU.hitConfirm();
        addFloater(x, y - 30, `-${dmg}`, '#ffd34d', 15);
      }
      if (vid === state.myId) {
        state.dmgFlash = Math.min(1, state.dmgFlash + dmg / 55);
        addShake(Math.min(10, dmg * 0.35), 0.25);
        AU.hurt();
        const shooter = snap.players.get(sid);
        const me = snap.players.get(state.myId);
        if (shooter && me) state.hitArrows.push({ ang: Math.atan2(shooter.y - me.y, shooter.x - me.x), t: 1 });
      }
      break;
    }
    case 3: fxSpark(e[1], e[2]); break;
    case 4: { // pickup
      const [, x, y, itype, pid] = e;
      fxPickup(x, y);
      if (pid === state.myId) { AU.pickup(itype); addFloater(x, y - 40, '+ ' + (ITEMNAME[itype] || '?'), '#7df9ff', 13); }
      break;
    }
    case 5: { // melee swing
      const p = snap.players.get(e[1]);
      if (p) { fxSlash(p.x, p.y, p.aim); AU.melee(p.x, p.y); }
      break;
    }
    case 6: { fxSpawn(e[2], e[3]); AU.spawnFx(e[2], e[3]); break; }
    case 7: { // dash
      const p = snap.players.get(e[1]);
      if (p) { fxDash(p.x, p.y, e[2], colorFor(e[1])); AU.dash(p.x, p.y); }
      break;
    }
    case 8: AU.bounce(e[1], e[2]); break;
    case 9: if (e[1] === state.myId) AU.dry(); break;
    case 10: { fxGibs(e[1], e[2]); AU.death(e[1], e[2]); addShake(6, 0.3); break; }
  }
}

function onKill(m) {
  const kname = m.k === -1 ? null : nameOf(m.k);
  state.killfeed.unshift({
    t: 6,
    ktxt: m.sui ? '' : (kname || ''), kcol: m.k === -1 ? '#999' : colorFor(m.k),
    vtxt: nameOf(m.v), vcol: colorFor(m.v),
    w: KILLNAME[m.w] || '?', sui: m.sui,
  });
  if (state.killfeed.length > 6) state.killfeed.pop();
  if (m.v === state.myId) {
    state.lastKiller = m.sui ? 'YOURSELF' : (kname || KILLNAME[m.w]);
  } else if (m.k === state.myId) {
    AU.sting();
    const vname = nameOf(m.v);
    centerText(m.w === 7 ? `BOOTED ${vname}` : `ELIMINATED ${vname}`, 'frag');
  }
}

function onChat(m) {
  const div = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = m.id === -1 ? 'SERVER' : nameOf(m.id);
  b.style.color = m.id === -1 ? '#ffd34d' : colorFor(m.id);
  div.appendChild(b);
  div.appendChild(document.createTextNode(': ' + m.msg));
  const log = $('chatlog');
  log.appendChild(div);
  while (log.children.length > 7) log.removeChild(log.firstChild);
  setTimeout(() => { if (div.parentNode) div.parentNode.removeChild(div); }, 11000);
}

function onAnnounce(m) {
  if (m.kind === 'info') { toast(m.msg); return; }
  centerText(m.msg, m.kind);
  if (m.kind === 'streak') AU.sting('gold');
}

function centerText(msg, kind) {
  state.anns.push({ msg, kind, t: kind === 'big' ? 2.2 : 3.0, max: kind === 'big' ? 2.2 : 3.0 });
  if (state.anns.length > 3) state.anns.shift();
}

function toast(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 3300);
}

/* input sender — keyboard+mouse, with touch joysticks overlaid when used */
setInterval(() => {
  if (!state.connected || !state.map) return;
  const me = curSelf();

  // base: keyboard movement + mouse aim/fire
  let l = (keys['a'] || keys['arrowleft']) ? 1 : 0;
  let r = (keys['d'] || keys['arrowright']) ? 1 : 0;
  let u = (keys['w'] || keys[' '] || keys['arrowup']) ? 1 : 0;
  let d = (keys['s'] || keys['arrowdown']) ? 1 : 0;
  let aim = 0;
  if (me) {
    const wx = cam.x + (mouse.x - viewW / 2);
    const wy = cam.y + (mouse.y - viewH / 2);
    aim = Math.atan2(wy - me.y, wx - me.x);
  }
  let f = mouse.down ? 1 : 0;

  // touch joysticks take over the axes they're actively driving
  if (touch.enabled) {
    const mv = touch.move, am = touch.aim, DZ = 0.30;
    if (mv.active) {
      l = mv.nx < -DZ ? 1 : 0;
      r = mv.nx > DZ ? 1 : 0;
      u = mv.ny < -0.34 ? 1 : 0;
      d = mv.ny > 0.55 ? 1 : 0;
    }
    if (am.active && am.mag > 0.18) { touch.lastAim = Math.atan2(am.ny, am.nx); touch.usedAim = true; }
    if (touch.usedAim) aim = touch.lastAim;
    const touchFire = (touch.autoFire && am.active && am.mag > 0.25) || touch.fireHeld;
    f = (f || touchFire) ? 1 : 0;
  }
  if (chatOpen || escOpen) f = 0;

  send({ t: 'i', l, r, u, d, f, a: Math.round(aim * 1000) / 1000 });
}, 33);

setInterval(() => { send({ t: 'p', c: Date.now() }); }, 3000);

/* =============================== INPUT ================================== */

window.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  if (chatOpen) {
    if (k === 'enter') { const v = $('chatin').value.trim(); if (v) send({ t: 'c', msg: v }); closeChat(); ev.preventDefault(); }
    else if (k === 'escape') { closeChat(); ev.preventDefault(); }
    return;
  }
  if (k === 'tab') { boardOpen = true; $('scorebox').classList.remove('hidden'); ev.preventDefault(); return; }
  if (k === 'escape') { toggleEsc(); ev.preventDefault(); return; }
  if (escOpen) return;
  if (k === 't' || k === 'enter') { openChat(); ev.preventDefault(); return; }
  keys[k] = true;
  if (!state.connected) return;
  if (k === 'f') send({ t: 'act', k: 'melee' });
  else if (k === 'g') send({ t: 'act', k: 'nade' });
  else if (k === 'shift') send({ t: 'act', k: 'dash' });
  else if (k === 'e') send({ t: 'act', k: 'use' });
  else if (k === 'm') { state.muted = !state.muted; AU.setMuted(state.muted); toast(state.muted ? 'MUTED' : 'SOUND ON'); }
  else if (k >= '1' && k <= '3') switchSlot(parseInt(k, 10) - 1);
  else if (k === 'q') switchSlot(state.lastSlot);
  if (k === ' ' || k === 'arrowup' || k === 'arrowdown') ev.preventDefault();
});
window.addEventListener('keyup', (ev) => {
  const k = ev.key.toLowerCase();
  if (k === 'tab') { boardOpen = false; $('scorebox').classList.add('hidden'); ev.preventDefault(); return; }
  keys[k] = false;
});
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.down = false; });

canvas.addEventListener('mousemove', (ev) => { mouse.x = ev.clientX; mouse.y = ev.clientY; });
canvas.addEventListener('mousedown', (ev) => {
  AU.init();
  if (ev.button === 0) mouse.down = true;
  else if (ev.button === 2 && state.connected) send({ t: 'act', k: 'melee' });
});
window.addEventListener('mouseup', (ev) => { if (ev.button === 0) mouse.down = false; });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvas.addEventListener('wheel', (ev) => {
  const me = curSelf();
  if (!me || !me.weapons) return;
  const n = me.weapons.length;
  const dir = ev.deltaY > 0 ? 1 : -1;
  switchSlot(((me.cur + dir) % n + n) % n);
}, { passive: true });

function switchSlot(i) {
  const me = curSelf();
  if (!me || !me.weapons || i >= me.weapons.length || i === me.cur) return;
  state.lastSlot = me.cur;
  send({ t: 'sw', i });
}
function cycleWeapon() {
  const me = curSelf();
  if (!me || !me.weapons) return;
  const n = me.weapons.length;
  switchSlot((me.cur + 1) % n);
}

/* ============================== TOUCH CONTROLS =========================== */
/* Mini-Militia-style: left thumb = floating move/fly stick, right thumb =
   floating aim stick with auto-fire, plus action buttons. Coexists with
   mouse/keyboard so hybrid touch-laptops still work. */

const IS_TOUCH = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
  ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;

function clampNum(v, a, b, dflt) { return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : dflt; }
function makeStick() { return { active: false, bx: 0, by: 0, kx: 0, ky: 0, nx: 0, ny: 0, mag: 0 }; }

const touch = {
  enabled: IS_TOUCH,
  autoFire: localStorage.getItem('nm_autofire') !== '0',
  lefty: localStorage.getItem('nm_lefty') === '1',
  scale: clampNum(parseFloat(localStorage.getItem('nm_tscale')), 0.75, 1.4, 1),
  move: makeStick(), aim: makeStick(),
  lastAim: 0, usedAim: false, fireHeld: false,
  buttons: [], weaponHit: [],
  active: new Map(),  // touch identifier -> { role:'move'|'aim'|'btn'|'wpn', id, slot }
  moveZone: null, aimZone: null, stickR: 82, moveDefault: [0, 0], aimDefault: [0, 0],
};

function touchLayout() {
  const s = touch.scale;
  const R = 82 * s;
  const aimRight = !touch.lefty;            // right-handed: aim stick on the right
  const midX = viewW * 0.5;
  const top = viewH * 0.30;                 // keep top strip free for HUD
  const left = { x0: 0, x1: midX, y0: top, y1: viewH };
  const right = { x0: midX, x1: viewW, y0: top, y1: viewH };
  touch.moveZone = aimRight ? left : right;
  touch.aimZone = aimRight ? right : left;
  touch.stickR = R;
  const lowCorner = viewH - 132 * s;
  touch.moveDefault = aimRight ? [136 * s, lowCorner] : [viewW - 136 * s, lowCorner];
  touch.aimDefault = aimRight ? [viewW - 136 * s, lowCorner] : [136 * s, lowCorner];

  // action buttons live on the aim-thumb side, in the upper region (tap by
  // reaching up), so they never collide with the floating aim stick below.
  const colX = aimRight ? viewW - 48 * s : 48 * s;
  const col2X = aimRight ? viewW - 134 * s : 134 * s;
  const br = 31 * s, br2 = 28 * s;
  const y0 = viewH * 0.30, gap = 82 * s;
  const btns = [
    { id: 'nade', label: 'NADE', glyph: '✛', cx: colX, cy: y0, r: br },
    { id: 'melee', label: 'MELEE', glyph: '⚔', cx: colX, cy: y0 + gap, r: br },
    { id: 'dash', label: 'DASH', glyph: '⟫', cx: colX, cy: y0 + gap * 2, r: br },
    { id: 'swap', label: 'SWAP', glyph: '⟳', cx: col2X, cy: y0, r: br2 },
    { id: 'use', label: 'GRAB', glyph: '▤', cx: col2X, cy: y0 + gap, r: br2 },
  ];
  if (!touch.autoFire) {
    btns.push({ id: 'fire', label: 'FIRE', glyph: '◉', cx: aimRight ? viewW - 78 * s : 78 * s, cy: viewH - 78 * s, r: 50 * s, hold: true });
  }
  // system buttons, top-right corner
  btns.push({ id: 'menu', glyph: '☰', cx: viewW - 28, cy: 30, r: 19, sys: true });
  btns.push({ id: 'board', glyph: '≣', cx: viewW - 72, cy: 30, r: 19, sys: true });
  touch.buttons = btns;
}

function inZone(x, y, z) { return z && x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1; }

function touchHitTest(x, y) {
  touchLayout();
  for (const b of touch.buttons) {
    const rr2 = (b.r + 10) * (b.r + 10);
    const dx = x - b.cx, dy = y - b.cy;
    if (dx * dx + dy * dy <= rr2) return { role: 'btn', id: b.id, hold: !!b.hold };
  }
  for (const w of touch.weaponHit) {
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return { role: 'wpn', slot: w.i };
  }
  if (inZone(x, y, touch.moveZone)) return { role: 'move' };
  if (inZone(x, y, touch.aimZone)) return { role: 'aim' };
  return null;
}

function updateStick(st, x, y) {
  const R = touch.stickR;
  let dx = x - st.bx, dy = y - st.by;
  const mag = Math.hypot(dx, dy) || 0.0001;
  const cl = Math.min(mag, R);
  const ux = dx / mag, uy = dy / mag;
  st.kx = st.bx + ux * cl; st.ky = st.by + uy * cl;
  st.nx = (ux * cl) / R; st.ny = (uy * cl) / R;
  st.mag = cl / R;
}

function onTouchButton(id, down) {
  if (id === 'menu') { if (down) toggleEsc(); return; }
  if (id === 'board') {
    boardOpen = down ? true : false;
    $('scorebox').classList.toggle('hidden', !boardOpen);
    return;
  }
  if (id === 'fire') { touch.fireHeld = down; return; }
  if (!down || !state.connected || escOpen) return;
  if (id === 'nade') send({ t: 'act', k: 'nade' });
  else if (id === 'melee') send({ t: 'act', k: 'melee' });
  else if (id === 'dash') send({ t: 'act', k: 'dash' });
  else if (id === 'use') send({ t: 'act', k: 'use' });
  else if (id === 'swap') cycleWeapon();
}

function handleTouchStart(t) {
  const hit = touchHitTest(t.clientX, t.clientY);
  if (!hit) return;
  if (hit.role === 'btn') {
    touch.active.set(t.identifier, { role: 'btn', id: hit.id });
    onTouchButton(hit.id, true);
  } else if (hit.role === 'wpn') {
    touch.active.set(t.identifier, { role: 'wpn' });
    switchSlot(hit.slot);
  } else {
    const st = hit.role === 'move' ? touch.move : touch.aim;
    touch.active.set(t.identifier, { role: hit.role });
    st.active = true; st.bx = t.clientX; st.by = t.clientY;
    updateStick(st, t.clientX, t.clientY);
  }
}
function handleTouchEnd(t) {
  const a = touch.active.get(t.identifier);
  if (!a) return;
  touch.active.delete(t.identifier);
  if (a.role === 'move') { const s = touch.move; s.active = false; s.nx = s.ny = s.mag = 0; }
  else if (a.role === 'aim') { const s = touch.aim; s.active = false; s.nx = s.ny = s.mag = 0; }
  else if (a.role === 'btn') onTouchButton(a.id, false);
}

if (IS_TOUCH) {
  const tOpts = { passive: false };
  canvas.addEventListener('touchstart', (ev) => {
    AU.init();
    ev.preventDefault();
    for (const t of ev.changedTouches) handleTouchStart(t);
  }, tOpts);
  canvas.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    for (const t of ev.changedTouches) {
      const a = touch.active.get(t.identifier);
      if (!a) continue;
      if (a.role === 'move') updateStick(touch.move, t.clientX, t.clientY);
      else if (a.role === 'aim') updateStick(touch.aim, t.clientX, t.clientY);
    }
  }, tOpts);
  const endH = (ev) => { ev.preventDefault(); for (const t of ev.changedTouches) handleTouchEnd(t); };
  canvas.addEventListener('touchend', endH, tOpts);
  canvas.addEventListener('touchcancel', endH, tOpts);
}

function releaseKeys() { for (const k in keys) keys[k] = false; mouse.down = false; }
function openChat() { chatOpen = true; releaseKeys(); $('chatrow').classList.remove('hidden'); $('chatin').focus(); }
function closeChat() { chatOpen = false; $('chatin').value = ''; $('chatrow').classList.add('hidden'); $('chatin').blur(); }

function toggleEsc() {
  escOpen = !escOpen;
  if (escOpen) releaseKeys();
  $('escMenu').classList.toggle('hidden', !escOpen);
  if (escOpen) syncHostPanel();
}

function syncHostPanel() {
  $('hostPanel').classList.toggle('hidden', !amHost());
  if (state.map) $('hMap').value = state.map.key;
  $('hMode').value = state.mode;
  $('hBots').value = String(state.bots);
  $('hDiff').value = String(state.diff);
  $('hScore').value = String(state.scoreLimit);
  $('hTime').value = String(state.timeLimit);
}

/* ====================== INTERPOLATION / RENDER STATE ===================== */

function interpDelayMs() { return 80; }

function currentRenderState(dtMs) {
  const snaps = state.snaps;
  if (snaps.length === 0) return null;
  const newest = snaps[snaps.length - 1];
  const target = newest.ts - interpDelayMs();
  if (state.playTs === 0 || Math.abs(target - state.playTs) > 600) state.playTs = target;
  else {
    state.playTs += dtMs;
    state.playTs += (target - state.playTs) * 0.08;
  }
  const t = state.playTs;
  let a = snaps[0], b = newest;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].ts <= t) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; break; }
  }
  const span = Math.max(1, b.ts - a.ts);
  const f = Math.max(0, Math.min(1, (t - a.ts) / span));

  const out = { st: b.st, tl: b.tl, ta: b.ta, tb: b.tb, items: b.items, players: new Map(), bullets: [], nades: [], newest };
  for (const [id, pb] of b.players) {
    const pa = a.players.get(id);
    let o;
    if (pa && a !== b) {
      let da = pb.aim - pa.aim;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      o = Object.assign({}, pb, {
        x: pa.x + (pb.x - pa.x) * f,
        y: pa.y + (pb.y - pa.y) * f,
        aim: pa.aim + da * f,
      });
    } else o = Object.assign({}, pb);
    out.players.set(id, o);
  }
  // self: use newest + tiny extrapolation for responsiveness
  const meN = newest.players.get(state.myId);
  if (meN && !(meN.flags & FLAG_DEAD)) {
    const ex = Math.min(0.08, (performance.now() - newest.recvAt) / 1000);
    const tx = meN.x + meN.vx * ex, ty = meN.y + meN.vy * ex;
    if (!selfSmooth) selfSmooth = { x: tx, y: ty };
    const k = 1 - Math.exp(-22 * (dtMs / 1000));
    selfSmooth.x += (tx - selfSmooth.x) * k;
    selfSmooth.y += (ty - selfSmooth.y) * k;
    const meO = out.players.get(state.myId);
    if (meO) { meO.x = selfSmooth.x; meO.y = selfSmooth.y; }
  } else selfSmooth = null;

  for (const [id, bb] of b.bullets) {
    const ba = a.bullets.get(id);
    out.bullets.push(ba && a !== b
      ? { id, t: bb.t, x: ba.x + (bb.x - ba.x) * f, y: ba.y + (bb.y - ba.y) * f, vx: bb.vx, vy: bb.vy }
      : Object.assign({}, bb));
  }
  for (const [id, nb] of b.nades) {
    const na = a.nades.get(id);
    out.nades.push(na && a !== b
      ? { id, x: na.x + (nb.x - na.x) * f, y: na.y + (nb.y - na.y) * f, fuse: nb.fuse }
      : Object.assign({}, nb));
  }
  return out;
}

let R = null; // current render state, refreshed each frame
function curSelf() {
  if (R) return R.players.get(state.myId) || null;
  const last = state.snaps[state.snaps.length - 1];
  return last ? last.players.get(state.myId) || null : null;
}

/* =============================== PARTICLES ============================== */

const particles = [];
function P(p) { if (particles.length < 900) particles.push(p); }

function fxMuzzle(x, y, aim, wt) {
  const n = wt === 2 ? 10 : 4;
  for (let i = 0; i < n; i++) {
    const a = aim + (Math.random() - 0.5) * 0.9;
    const s = 180 + Math.random() * 320;
    P({ kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0.12 + Math.random() * 0.08, max: 0.2, size: 2.2, col: '#ffd34d', grav: 0 });
  }
  P({ kind: 'flash', x: x + Math.cos(aim) * 8, y: y + Math.sin(aim) * 8, t: 0.06, max: 0.06, size: wt === 4 ? 26 : 16, col: '#fff1b8' });
}

function fxExplosion(x, y, r) {
  addShake(Math.min(16, 1600 / (1 + Math.hypot(x - cam.x, y - cam.y) / 60)), 0.4);
  AU.expl(x, y, r > 100);
  P({ kind: 'flash', x, y, t: 0.12, max: 0.12, size: r * 0.9, col: '#fff3c4' });
  P({ kind: 'ring', x, y, t: 0.35, max: 0.35, size: r * 1.5, col: '#ffb347' });
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 460;
    P({ kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, t: 0.3 + Math.random() * 0.5, max: 0.8, size: 2.5 + Math.random() * 2, col: Math.random() < 0.5 ? '#ffb347' : '#ff7a3c', grav: 600 });
  }
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2, s = 20 + Math.random() * 90;
    P({ kind: 'smoke', x: x + Math.cos(a) * r * 0.3, y: y + Math.sin(a) * r * 0.3, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 50, t: 0.7 + Math.random() * 0.7, max: 1.4, size: 14 + Math.random() * 18, col: '#555' });
  }
}

function fxBlood(x, y) {
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2, s = 50 + Math.random() * 220;
    P({ kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, t: 0.3 + Math.random() * 0.3, max: 0.6, size: 2.4, col: '#ff3050', grav: 900 });
  }
}

function fxGibs(x, y) {
  P({ kind: 'flash', x, y, t: 0.1, max: 0.1, size: 40, col: '#ff8095' });
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 380;
    P({ kind: 'gib', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 160, t: 0.7 + Math.random() * 0.6, max: 1.3, size: 3 + Math.random() * 3.5, col: Math.random() < 0.6 ? '#ff3050' : '#c01f3a', grav: 1100 });
  }
}

function fxSpark(x, y) {
  for (let i = 0; i < 5; i++) {
    const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 200;
    P({ kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0.15 + Math.random() * 0.15, max: 0.3, size: 1.8, col: '#ffe9a8', grav: 500 });
  }
}

function fxPickup(x, y) {
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6, s = 60 + Math.random() * 140;
    P({ kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0.4, max: 0.4, size: 2, col: '#7df9ff', grav: -100 });
  }
}

function fxSlash(x, y, aim) {
  P({ kind: 'slash', x: x + Math.cos(aim) * 30, y: y + Math.sin(aim) * 30, aim, t: 0.14, max: 0.14, size: 34, col: '#cfe9ff' });
}

function fxSpawn(x, y) {
  P({ kind: 'ring', x, y, t: 0.5, max: 0.5, size: 70, col: '#7df9ff' });
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    P({ kind: 'spark', x: x + Math.cos(a) * 26, y: y + Math.sin(a) * 30, vx: Math.cos(a) * 40, vy: -120 - Math.random() * 120, t: 0.5, max: 0.5, size: 2.2, col: '#7df9ff', grav: -200 });
  }
}

function fxDash(x, y, dir, col) {
  for (let i = 0; i < 7; i++) {
    P({ kind: 'ghost', x: x - dir * i * 9, y, t: 0.22 - i * 0.02, max: 0.25, size: 1 - i * 0.09, col });
  }
}

function fxJet(x, y, facing) {
  P({
    kind: 'flame', x: x - facing * 9 + (Math.random() - 0.5) * 5, y: y + 14,
    vx: -facing * 30 + (Math.random() - 0.5) * 40, vy: 160 + Math.random() * 120,
    t: 0.18 + Math.random() * 0.12, max: 0.3, size: 4.5 + Math.random() * 3,
    col: Math.random() < 0.4 ? '#7df9ff' : '#41c7ff', grav: 0,
  });
}

function stepParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t -= dt;
    if (p.t <= 0) { particles.splice(i, 1); continue; }
    if (p.vx !== undefined) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.grav) p.vy += p.grav * dt;
      if (p.kind === 'smoke') { p.vx *= 0.98; p.vy *= 0.98; p.size += 16 * dt; }
    }
  }
}

function drawParticles() {
  for (const p of particles) {
    const a = Math.max(0, p.t / p.max);
    switch (p.kind) {
      case 'spark': case 'flame': case 'gib': {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.col;
        const s = p.size * (p.kind === 'flame' ? a : 1);
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        break;
      }
      case 'smoke': {
        ctx.globalAlpha = a * 0.35;
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill();
        break;
      }
      case 'flash': {
        ctx.globalAlpha = a;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
        g.addColorStop(0, p.col); g.addColorStop(1, 'rgba(255,200,80,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill();
        break;
      }
      case 'ring': {
        const r = (1 - a) * p.size;
        ctx.globalAlpha = a;
        ctx.strokeStyle = p.col; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.stroke();
        break;
      }
      case 'slash': {
        ctx.globalAlpha = a * 2 > 1 ? 1 : a * 2;
        ctx.strokeStyle = p.col; ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1.4 - a), p.aim - 1.1, p.aim + 1.1);
        ctx.stroke();
        break;
      }
      case 'ghost': {
        ctx.globalAlpha = a * 0.5;
        ctx.fillStyle = p.col;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(p.x - PHW * p.size, p.y - PHH * p.size, PHW * 2 * p.size, PHH * 2 * p.size, 8);
        else ctx.rect(p.x - PHW * p.size, p.y - PHH * p.size, PHW * 2 * p.size, PHH * 2 * p.size);
        ctx.fill();
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
}

function addFloater(x, y, txt, col, size) {
  state.floaters.push({ x: x + (Math.random() - 0.5) * 18, y, vy: -60, txt, col, t: 1, size: size || 14 });
  if (state.floaters.length > 24) state.floaters.shift();
}

function addShake(mag, dur) {
  cam.shakeMag = Math.max(cam.shakeMag, mag);
  cam.shakeT = Math.max(cam.shakeT, dur);
}

/* ============================== PARALLAX BG ============================= */

function buildParallax() {
  const m = state.map;
  const rng = mulberry(0xC0FFEE ^ m.w);
  parallax = { stars: [], far: [], mid: [] };
  for (let i = 0; i < 130; i++) {
    parallax.stars.push({ x: rng() * m.w * 1.6 - m.w * 0.3, y: rng() * m.h * 1.2 - m.h * 0.1, s: rng() * 1.8 + 0.4, tw: rng() * 6 });
  }
  const kind = m.theme.parallax;
  if (kind === 'city') {
    for (let x = -300; x < m.w * 1.3; x += 90 + rng() * 140) {
      const h = 200 + rng() * 480;
      const b = { x, y: m.h - h * 1.1, w: 60 + rng() * 110, h: h * 1.4, win: [] };
      for (let i = 0; i < 14; i++) if (rng() < 0.5) b.win.push([rng() * b.w * 0.8 + b.w * 0.1, rng() * b.h * 0.7]);
      parallax.far.push(b);
    }
  } else if (kind === 'industrial') {
    for (let x = -300; x < m.w * 1.3; x += 160 + rng() * 240) {
      parallax.far.push({ x, y: m.h - 320 - rng() * 320, w: 90 + rng() * 180, h: 900, win: [], chimney: rng() < 0.5 });
    }
  } else {
    for (let x = -300; x < m.w * 1.3; x += 200 + rng() * 200) {
      parallax.far.push({ x, y: m.h - 200 - rng() * 500, w: 240 + rng() * 260, h: 900, blob: true, win: [] });
    }
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawBackground(now) {
  const m = state.map;
  const th = m.theme;
  const g = ctx.createLinearGradient(0, 0, 0, viewH);
  g.addColorStop(0, th.bgTop); g.addColorStop(1, th.bgBot);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, viewW, viewH);

  if (!parallax) return;
  // stars (slowest layer)
  ctx.save();
  ctx.translate(viewW / 2 - cam.x * 0.15, viewH / 2 - cam.y * 0.15);
  for (const s of parallax.stars) {
    const tw = 0.5 + 0.5 * Math.sin(now * 0.002 + s.tw);
    ctx.globalAlpha = 0.25 + tw * 0.5;
    ctx.fillStyle = '#cfe4ff';
    ctx.fillRect(s.x, s.y * 0.6, s.s, s.s);
  }
  ctx.restore();
  // far silhouettes
  ctx.save();
  ctx.translate(viewW / 2 - cam.x * 0.4, viewH / 2 - cam.y * 0.4);
  ctx.globalAlpha = 0.55;
  for (const b of parallax.far) {
    if (b.blob) {
      ctx.fillStyle = 'rgba(8,16,12,0.9)';
      ctx.beginPath(); ctx.ellipse(b.x + b.w / 2, b.y + 500, b.w, 480, 0, 0, 7); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(6,9,20,0.95)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      if (b.chimney) ctx.fillRect(b.x + b.w * 0.3, b.y - 90, 22, 90);
      ctx.fillStyle = 'rgba(255,210,110,0.5)';
      for (const w of b.win) ctx.fillRect(b.x + w[0], b.y + w[1], 5, 7);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/* =============================== WORLD DRAW ============================= */

function worldTransform() {
  let sx = 0, sy = 0;
  if (cam.shakeT > 0) {
    const k = cam.shakeT;
    sx = (Math.random() - 0.5) * 2 * cam.shakeMag * k;
    sy = (Math.random() - 0.5) * 2 * cam.shakeMag * k;
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.translate(Math.round(viewW / 2 - cam.x + sx), Math.round(viewH / 2 - cam.y + sy));
}

function drawMap(now) {
  const m = state.map, th = m.theme;
  // lava first (under platforms)
  for (const lz of m.lava) {
    const grad = ctx.createLinearGradient(0, lz[1], 0, lz[1] + lz[3]);
    grad.addColorStop(0, '#ff9a3c'); grad.addColorStop(0.4, '#ff5a1f'); grad.addColorStop(1, '#7a1604');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(lz[0], lz[1] + 6);
    for (let x = lz[0]; x <= lz[0] + lz[2]; x += 16) {
      ctx.lineTo(x, lz[1] + 4 + Math.sin(now * 0.003 + x * 0.045) * 4);
    }
    ctx.lineTo(lz[0] + lz[2], lz[1] + lz[3]);
    ctx.lineTo(lz[0], lz[1] + lz[3]);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.35 + 0.15 * Math.sin(now * 0.004);
    ctx.fillStyle = '#ff7a3c';
    ctx.fillRect(lz[0], lz[1] - 26, lz[2], 26);
    ctx.globalAlpha = 1;
    if (Math.random() < 0.3) {
      P({ kind: 'spark', x: lz[0] + Math.random() * lz[2], y: lz[1] + 6, vx: (Math.random() - 0.5) * 30, vy: -60 - Math.random() * 120, t: 0.8, max: 0.8, size: 2.5, col: '#ffb347', grav: 60 });
    }
  }
  // platforms
  for (const r of m.rects) {
    ctx.fillStyle = th.plat;
    ctx.fillRect(r[0], r[1], r[2], r[3]);
    // inner shade
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(r[0] + 3, r[1] + 6, r[2] - 6, Math.max(0, r[3] - 9));
    // neon top edge
    ctx.fillStyle = th.edge;
    ctx.fillRect(r[0], r[1], r[2], 3);
    ctx.globalAlpha = 0.22;
    ctx.fillRect(r[0], r[1] + 3, r[2], 7);
    ctx.globalAlpha = 1;
  }
  // void fade for bottomless maps
  if (m.voidY) {
    const g = ctx.createLinearGradient(0, m.voidY - 420, 0, m.voidY + 60);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,5,0.95)');
    ctx.fillStyle = g;
    ctx.fillRect(-500, m.voidY - 420, m.w + 1000, 520);
  }
}

function drawItems(now) {
  const m = state.map;
  for (let i = 0; i < m.items.length; i++) {
    const def = m.items[i];
    const active = R.items.has(i);
    const x = def[1], y = def[2] + Math.sin(now * 0.003 + i) * 4;
    // pad
    ctx.globalAlpha = active ? 0.8 : 0.18;
    const g = ctx.createRadialGradient(def[1], def[2] + 18, 2, def[1], def[2] + 18, 26);
    g.addColorStop(0, m.theme.accent); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(def[1] - 26, def[2] - 8, 52, 30);
    if (!active) { ctx.globalAlpha = 1; continue; }
    ctx.globalAlpha = 1;
    if (def[0] === 10) { // medkit
      ctx.fillStyle = '#0e2b16';
      ctx.strokeStyle = '#41ff7a'; ctx.lineWidth = 1.5;
      rr(x - 11, y - 9, 22, 18, 3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#41ff7a';
      ctx.fillRect(x - 6, y - 2.5, 12, 5); ctx.fillRect(x - 2.5, y - 6, 5, 12);
    } else if (def[0] === 11) { // nades
      ctx.fillStyle = '#27330e';
      ctx.strokeStyle = '#c6ff41'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x - 5, y, 6.5, 0, 7); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(x + 6, y + 2, 6.5, 0, 7); ctx.fill(); ctx.stroke();
    } else {
      ctx.save();
      ctx.translate(x, y);
      drawGun(def[0], 1.1);
      ctx.restore();
    }
  }
}

function rr(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/* gun shapes, drawn pointing +x, origin at grip */
function drawGun(t, s) {
  ctx.save();
  ctx.scale(s, s);
  ctx.lineWidth = 1.2;
  const body = '#222b40', edge = '#54678f', acc = ['#9fb6e8', '#ffd34d', '#ff7a3c', '#9fe87f', '#b78dff', '#ff5470'][t];
  ctx.fillStyle = body; ctx.strokeStyle = edge;
  switch (t) {
    case 0:
      rr(0, -4, 15, 6, 1); ctx.fill(); ctx.stroke();
      ctx.fillRect(2, 2, 5, 7);
      ctx.fillStyle = acc; ctx.fillRect(13, -3.5, 3, 2); break;
    case 1:
      rr(-4, -4, 22, 7, 1); ctx.fill(); ctx.stroke();
      ctx.fillRect(4, 3, 5, 8); ctx.fillRect(-7, -2, 4, 4);
      ctx.fillStyle = acc; ctx.fillRect(16, -3, 5, 2); break;
    case 2:
      rr(-5, -4, 28, 6, 1); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#3a2a1a'; ctx.fillRect(8, 1, 9, 4);
      ctx.fillStyle = acc; ctx.fillRect(21, -3.5, 4, 3); break;
    case 3:
      rr(-6, -4, 30, 6, 1); ctx.fill(); ctx.stroke();
      ctx.fillRect(6, 2, 5, 9); ctx.fillRect(-9, -3, 4, 6);
      ctx.fillStyle = acc; ctx.fillRect(22, -3.5, 4, 2); break;
    case 4:
      rr(-8, -3.5, 40, 5, 1); ctx.fill(); ctx.stroke();
      ctx.fillRect(2, 1.5, 5, 8);
      ctx.fillStyle = acc;
      ctx.beginPath(); ctx.arc(6, -6, 3.4, 0, 7); ctx.fill();
      ctx.fillRect(28, -3, 5, 1.6); break;
    case 5:
      rr(-8, -6, 30, 11, 3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = acc;
      ctx.beginPath(); ctx.moveTo(22, -6); ctx.lineTo(30, -0.5); ctx.lineTo(22, 5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#111722'; ctx.fillRect(-8, -2, 6, 4); break;
  }
  ctx.restore();
}

function drawPlayer(p, now) {
  if (p.flags & FLAG_DEAD) return;
  const isMe = p.id === state.myId;
  const col = colorFor(p.id);
  const facing = Math.abs(p.aim) > Math.PI / 2 ? -1 : 1;
  const grounded = !!(p.flags & FLAG_GROUND);
  const jetting = !!(p.flags & FLAG_JET);
  const x = p.x, y = p.y;

  if (jetting) { fxJet(x, y, facing); fxJet(x, y, facing); }

  ctx.save();
  ctx.translate(x, y);

  // spawn protection shimmer
  if (p.flags & FLAG_PROT) {
    ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now * 0.02);
    ctx.strokeStyle = '#7df9ff'; ctx.lineWidth = 2;
    ctx.setLineDash([7, 6]);
    ctx.beginPath(); ctx.arc(0, 0, 33, now * 0.003, now * 0.003 + 7); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // legs
  const speed = Math.abs(p.vx);
  const phase = grounded && speed > 30 ? Math.sin(now * 0.022 * Math.max(1, speed / 160)) : 0;
  ctx.strokeStyle = '#10131f'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-4, 10); ctx.lineTo(-4 + phase * 8 * facing, 22);
  ctx.moveTo(5, 10); ctx.lineTo(5 - phase * 8 * facing, 22);
  ctx.stroke();

  // jetpack
  ctx.fillStyle = '#1a2030'; ctx.strokeStyle = '#3b4a6b'; ctx.lineWidth = 1.4;
  rr(-facing * 17 - 5, -14, 10, 20, 3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = jetting ? '#41c7ff' : '#23314f';
  ctx.fillRect(-facing * 17 - 3.4, 3, 7, 3);

  // torso
  ctx.fillStyle = col;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 2;
  rr(-11, -12, 22, 26, 7); ctx.fill(); ctx.stroke();
  // chest light
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(facing * 2 - 2, -6, 4, 3);

  // head + visor
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(0, -19, 8.5, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#0c1322';
  const va = Math.max(-0.9, Math.min(0.9, facing === 1 ? p.aim : (p.aim > 0 ? Math.PI - p.aim : -Math.PI - p.aim)));
  ctx.save();
  ctx.translate(0, -19);
  ctx.scale(facing, 1);
  ctx.rotate(va * 0.5);
  rr(1, -3.4, 8, 7, 3); ctx.fill();
  ctx.fillStyle = '#41c7ff';
  ctx.fillRect(4.5, -1.8, 4, 3.4);
  ctx.restore();

  // arm + gun
  ctx.save();
  ctx.translate(0, -5);
  ctx.rotate(p.aim);
  if (facing === -1) ctx.scale(1, -1);
  ctx.strokeStyle = '#10131f'; ctx.lineWidth = 4.4;
  ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(12, 3); ctx.stroke();
  ctx.translate(10, 0);
  drawGun(p.weapons && p.weapons[p.cur] ? p.weapons[p.cur][0] : 0, 1.25);
  ctx.restore();

  ctx.restore();

  // name + hp bar (not for self)
  if (!isMe) {
    ctx.font = '700 11px sans-serif';
    ctx.textAlign = 'center';
    const r = state.roster.get(p.id);
    ctx.fillStyle = col;
    ctx.fillText(r ? r.name : '?', x, y - 44);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 18, y - 39, 36, 4.5);
    ctx.fillStyle = p.hp > 50 ? '#41ff7a' : p.hp > 25 ? '#ffd34d' : '#ff4655';
    ctx.fillRect(x - 18, y - 39, 36 * Math.max(0, p.hp) / 100, 4.5);
  }
}

function drawBullets() {
  for (const b of R.bullets) {
    const prev = prevBulletPos.get(b.id);
    const px = prev ? prev.x : b.x - b.vx * 0.016;
    const py = prev ? prev.y : b.y - b.vy * 0.016;
    prevBulletPos.set(b.id, { x: b.x, y: b.y, seen: performance.now() });
    if (b.t === 5) { // rocket
      const ang = Math.atan2(b.vy, b.vx);
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(ang);
      ctx.fillStyle = '#39455f';
      rr(-10, -4, 18, 8, 3); ctx.fill();
      ctx.fillStyle = '#ff5470';
      ctx.beginPath(); ctx.moveTo(8, -4); ctx.lineTo(15, 0); ctx.lineTo(8, 4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffd34d';
      ctx.beginPath(); ctx.moveTo(-10, -3); ctx.lineTo(-17 - Math.random() * 7, 0); ctx.lineTo(-10, 3); ctx.closePath(); ctx.fill();
      ctx.restore();
      P({ kind: 'smoke', x: b.x, y: b.y, vx: 0, vy: -14, t: 0.5, max: 0.5, size: 5, col: '#778' });
    } else {
      const len = b.t === 4 ? 3.2 : 1.6;
      const grad = ctx.createLinearGradient(px, py, b.x, b.y);
      const colHead = b.t === 4 ? '#d9b8ff' : '#ffe9a8';
      grad.addColorStop(0, 'rgba(255,210,120,0)');
      grad.addColorStop(1, colHead);
      ctx.strokeStyle = grad;
      ctx.lineWidth = b.t === 4 ? 3 : 2.2;
      ctx.beginPath();
      ctx.moveTo(b.x - (b.x - px) * len, b.y - (b.y - py) * len);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillRect(b.x - 1.4, b.y - 1.4, 2.8, 2.8);
    }
  }
  // GC old tracer entries
  if (prevBulletPos.size > 200) {
    const cutoff = performance.now() - 1000;
    for (const [id, v] of prevBulletPos) if (v.seen < cutoff) prevBulletPos.delete(id);
  }
}

function drawNades(now) {
  for (const n of R.nades) {
    const blink = n.fuse < 0.7 ? (Math.sin(now * 0.04) > 0 ? 1 : 0) : 0;
    ctx.save();
    ctx.translate(n.x, n.y);
    ctx.rotate(now * 0.01 % 7);
    ctx.fillStyle = blink ? '#ff5470' : '#2b3a18';
    ctx.strokeStyle = '#c6ff41'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(0, 0, 6.5, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c6ff41';
    ctx.fillRect(-1.5, -9, 3, 4);
    ctx.restore();
  }
}

/* ================================= HUD ================================== */

function drawHUD(now, dt) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const me = R ? R.players.get(state.myId) : null;

  // damage flash + low hp vignette
  if (state.dmgFlash > 0.01 || (me && me.hp < 35 && !(me.flags & FLAG_DEAD))) {
    const lowHp = me && me.hp < 35 && !(me.flags & FLAG_DEAD) ? (0.5 + 0.22 * Math.sin(now * 0.008)) * (1 - me.hp / 40) : 0;
    const a = Math.min(0.65, state.dmgFlash * 0.6 + lowHp * 0.5);
    const g = ctx.createRadialGradient(viewW / 2, viewH / 2, viewH * 0.3, viewW / 2, viewH / 2, viewH * 0.75);
    g.addColorStop(0, 'rgba(255,30,60,0)');
    g.addColorStop(1, `rgba(255,30,60,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewW, viewH);
  }
  state.dmgFlash = Math.max(0, state.dmgFlash - dt * 1.8);

  // hit direction arrows
  for (let i = state.hitArrows.length - 1; i >= 0; i--) {
    const h = state.hitArrows[i];
    h.t -= dt;
    if (h.t <= 0) { state.hitArrows.splice(i, 1); continue; }
    ctx.save();
    ctx.translate(viewW / 2, viewH / 2);
    ctx.rotate(h.ang);
    ctx.globalAlpha = Math.min(1, h.t) * 0.8;
    ctx.fillStyle = '#ff4655';
    ctx.beginPath();
    ctx.moveTo(150, 0); ctx.lineTo(128, -13); ctx.lineTo(128, 13);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  if (!me) return;
  const dead = !!(me.flags & FLAG_DEAD);
  const tHud = touch.enabled;

  /* --- health & fuel (bottom-left on desktop; top, right of minimap on touch) --- */
  const bw = tHud ? 200 : 230;
  const bx = tHud ? 214 : 22;
  const hpY = tHud ? 20 : viewH - 66;
  const fuelY = tHud ? 42 : viewH - 44;
  ctx.font = '800 13px sans-serif';
  ctx.textAlign = 'left';
  barBox(bx, hpY, bw, 16);
  const hpc = me.hp > 50 ? '#41ff7a' : me.hp > 25 ? '#ffd34d' : '#ff4655';
  bar(bx, hpY, bw, 16, me.hp / 100, hpc);
  ctx.fillStyle = '#eaf3ff';
  ctx.fillText(`HP ${Math.max(0, me.hp)}`, bx + 6, hpY + 12.5);
  const lowFuel = me.fuel < 25;
  barBox(bx, fuelY, bw, 11);
  bar(bx, fuelY, bw, 11, me.fuel / 100, lowFuel && Math.sin(now * 0.02) > 0 ? '#ff8a5c' : '#41c7ff');
  ctx.fillStyle = '#9ab4e8';
  ctx.font = '700 9px sans-serif';
  ctx.fillText('JET FUEL', bx + 6, fuelY + 8.5);

  /* --- weapons: horizontal tappable strip on touch, else bottom-right panel --- */
  if (tHud && me.weapons) {
    drawWeaponsTouch(me);
  } else if (me.weapons) {
    const ww = 118, wh = 30;
    let wy = viewH - 24 - me.weapons.length * (wh + 6);
    for (let i = 0; i < me.weapons.length; i++) {
      const [wt, ammo] = me.weapons[i];
      const sel = i === me.cur;
      const x0 = viewW - ww - 22, y0 = wy + i * (wh + 6);
      ctx.fillStyle = sel ? 'rgba(65,199,255,0.18)' : 'rgba(8,12,26,0.7)';
      ctx.strokeStyle = sel ? '#41c7ff' : 'rgba(90,140,230,0.35)';
      ctx.lineWidth = sel ? 2 : 1;
      rr(x0, y0, ww, wh, 4); ctx.fill(); ctx.stroke();
      ctx.save();
      ctx.translate(x0 + 26, y0 + wh / 2 + 2);
      drawGun(wt, 0.95);
      ctx.restore();
      ctx.fillStyle = sel ? '#fff' : '#8fa8d8';
      ctx.font = '800 11px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(ammo < 0 ? '∞' : String(ammo), x0 + ww - 8, y0 + 19);
      ctx.textAlign = 'left';
      ctx.fillStyle = sel ? '#7df9ff' : '#5d6f96';
      ctx.font = '700 8px sans-serif';
      ctx.fillText(`${i + 1} ${WNAME[wt]}`, x0 + 46, y0 + 12);
    }
    // grenades + dash
    const gy = viewH - 18;
    ctx.textAlign = 'right';
    ctx.font = '700 11px sans-serif';
    let gx = viewW - 26;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i < me.nades ? '#c6ff41' : 'rgba(120,140,90,0.25)';
      ctx.beginPath(); ctx.arc(gx - i * 16, gy - 4, 5, 0, 7); ctx.fill();
    }
    ctx.fillStyle = '#8fa8d8';
    ctx.fillText('G', gx - 4 * 16 - 8, gy);
    // dash cooldown
    const dx0 = viewW - ww - 22 - 60;
    ctx.fillStyle = me.dashCd <= 0 ? '#7df9ff' : 'rgba(125,249,255,0.25)';
    ctx.font = '800 11px sans-serif';
    ctx.fillText('⚡DASH', dx0 + 48, viewH - 30);
    if (me.dashCd > 0) {
      ctx.fillStyle = 'rgba(125,249,255,0.8)';
      ctx.fillRect(dx0, viewH - 26, 48 * (1 - me.dashCd / 2.2), 3);
    }
  }

  /* --- top-center: timer + score --- */
  ctx.textAlign = 'center';
  const tlSec = Math.max(0, R.tl | 0);
  const timeTxt = R.st === 1 ? 'NEXT ROUND ' + tlSec : `${String((tlSec / 60) | 0).padStart(2, '0')}:${String(tlSec % 60).padStart(2, '0')}`;
  ctx.font = '800 20px sans-serif';
  ctx.fillStyle = 'rgba(8,12,26,0.7)';
  rr(viewW / 2 - 150, 12, 300, 54, 8); ctx.fill();
  ctx.fillStyle = tlSec < 60 && R.st === 0 ? '#ffd34d' : '#eaf3ff';
  ctx.fillText(timeTxt, viewW / 2, 36);
  ctx.font = '700 12px sans-serif';
  if (state.mode === 'tdm') {
    ctx.fillStyle = TEAM_COLORS[0];
    ctx.textAlign = 'right';
    ctx.fillText(`RED ${R.ta}`, viewW / 2 - 12, 56);
    ctx.fillStyle = TEAM_COLORS[1];
    ctx.textAlign = 'left';
    ctx.fillText(`${R.tb} BLUE`, viewW / 2 + 12, 56);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#5d6f96';
    ctx.fillText('·', viewW / 2, 56);
  } else {
    let lead = 0, leadName = '—';
    for (const [id, p] of R.players) if (p.kills > lead) { lead = p.kills; leadName = nameOf(id); }
    ctx.fillStyle = '#9ab4e8';
    ctx.fillText(`YOU ${me.kills} · LEAD ${lead} (${leadName}) · FIRST TO ${state.scoreLimit}`, viewW / 2, 56);
  }

  /* --- killfeed top-right (pushed down on touch to clear system buttons) --- */
  ctx.font = '700 12px sans-serif';
  let ky = tHud ? 62 : 24;
  for (const k of state.killfeed) {
    k.t -= dt;
    if (k.t <= 0) continue;
    ctx.globalAlpha = Math.min(1, k.t);
    ctx.textAlign = 'right';
    const wTxt = `[${k.w}]`;
    let x = viewW - 22;
    ctx.fillStyle = k.vcol; ctx.fillText(k.vtxt, x, ky);
    x -= ctx.measureText(k.vtxt).width + 7;
    ctx.fillStyle = '#8fa8d8'; ctx.fillText(wTxt, x, ky);
    x -= ctx.measureText(wTxt).width + 7;
    if (k.ktxt) { ctx.fillStyle = k.kcol; ctx.fillText(k.ktxt, x, ky); }
    ky += 19;
  }
  state.killfeed = state.killfeed.filter((k) => k.t > 0);
  ctx.globalAlpha = 1;

  /* --- minimap top-left --- */
  drawMinimap();

  /* --- floaters --- */
  // drawn in world space — handled separately

  /* --- announcements --- */
  let ay = viewH * 0.24;
  for (let i = state.anns.length - 1; i >= 0; i--) {
    const a = state.anns[i];
    a.t -= dt;
    if (a.t <= 0) { state.anns.splice(i, 1); continue; }
    const age = a.max - a.t;
    const pop = Math.min(1, age * 8);
    const fade = Math.min(1, a.t * 2);
    ctx.save();
    ctx.translate(viewW / 2, ay);
    ctx.scale(0.7 + pop * 0.3, 0.7 + pop * 0.3);
    ctx.globalAlpha = fade;
    ctx.textAlign = 'center';
    const big = a.kind === 'big';
    ctx.font = `900 ${big ? 54 : a.kind === 'frag' ? 26 : 30}px sans-serif`;
    const col = a.kind === 'streak' ? '#ffd34d' : a.kind === 'frag' ? '#7df9ff' : a.kind === 'match' ? '#41c7ff' : '#fff';
    ctx.shadowColor = col; ctx.shadowBlur = 26;
    ctx.fillStyle = col;
    ctx.fillText(a.msg, 0, 0);
    ctx.restore();
    ay += big ? 64 : 40;
  }

  /* --- hitmarker + crosshair --- */
  state.hitmarkT = Math.max(0, state.hitmarkT - dt);
  state.recoilHeat = Math.max(0, state.recoilHeat - dt * 2.4);
  if (!dead && !escOpen) {
    let cx, cy;
    const touchAiming = touch.enabled && touch.usedAim;
    if (touchAiming) {
      const psx = viewW / 2 + (me.x - cam.x), psy = viewH / 2 + (me.y - cam.y);
      const reach = 78 + state.recoilHeat * 10;
      cx = psx + Math.cos(touch.lastAim) * reach;
      cy = psy + Math.sin(touch.lastAim) * reach;
      // tracer line from muzzle to reticle so aim is readable at a glance
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = touch.aim.active ? '#ff8a3c' : 'rgba(125,249,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(psx + Math.cos(touch.lastAim) * 24, psy + Math.sin(touch.lastAim) * 24); ctx.lineTo(cx, cy); ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      cx = mouse.x; cy = mouse.y;
    }
    const sp = 7 + state.recoilHeat * 16;
    ctx.strokeStyle = 'rgba(125,249,255,0.95)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      ctx.moveTo(cx + Math.cos(a) * sp, cy + Math.sin(a) * sp);
      ctx.lineTo(cx + Math.cos(a) * (sp + 7), cy + Math.sin(a) * (sp + 7));
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(125,249,255,0.9)';
    ctx.fillRect(cx - 1.2, cy - 1.2, 2.4, 2.4);
    if (state.hitmarkT > 0) {
      ctx.strokeStyle = `rgba(255,211,77,${state.hitmarkT / 0.18})`;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + Math.PI / 4;
        ctx.moveTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5);
        ctx.lineTo(cx + Math.cos(a) * 13, cy + Math.sin(a) * 13);
      }
      ctx.stroke();
    }
  }

  /* --- on-screen touch controls --- */
  drawTouchControls();

  /* --- death overlay --- */
  if (dead && R.st === 0) {
    ctx.fillStyle = 'rgba(5,2,8,0.45)';
    ctx.fillRect(0, 0, viewW, viewH);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff4655';
    ctx.font = '900 38px sans-serif';
    ctx.shadowColor = '#ff4655'; ctx.shadowBlur = 30;
    ctx.fillText('ELIMINATED', viewW / 2, viewH / 2 - 50);
    ctx.shadowBlur = 0;
    ctx.font = '700 16px sans-serif';
    ctx.fillStyle = '#9ab4e8';
    ctx.fillText(`by ${state.lastKiller}`, viewW / 2, viewH / 2 - 18);
    ctx.font = '900 50px sans-serif';
    ctx.fillStyle = '#eaf3ff';
    ctx.fillText(me.deadT > 0 ? me.deadT.toFixed(1) : '…', viewW / 2, viewH / 2 + 44);
  }

  /* --- match over overlay --- */
  if (R.st === 1) drawMatchOver();
}

function barBox(x, y, w, h) {
  ctx.fillStyle = 'rgba(8,12,26,0.75)';
  ctx.strokeStyle = 'rgba(90,140,230,0.4)';
  ctx.lineWidth = 1;
  rr(x - 2, y - 2, w + 4, h + 4, 3); ctx.fill(); ctx.stroke();
}
function bar(x, y, w, h, f, col) {
  ctx.fillStyle = col;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, f)), h);
}

function drawStickGfx(st, def, col, label) {
  const cx = st.active ? st.bx : def[0];
  const cy = st.active ? st.by : def[1];
  const R = touch.stickR;
  ctx.globalAlpha = st.active ? 0.5 : 0.22;
  ctx.lineWidth = 3;
  ctx.strokeStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.stroke();
  ctx.globalAlpha = st.active ? 0.12 : 0.06;
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
  // knob
  const kx = st.active ? st.kx : cx, ky = st.active ? st.ky : cy;
  ctx.globalAlpha = st.active ? 0.95 : 0.4;
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(kx, ky, R * 0.42, 0, 7); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `800 ${Math.round(11 * touch.scale)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(label, cx, cy + R + 16);
}

function drawTouchButton(b, enabled, pressed, sub) {
  ctx.globalAlpha = b.sys ? 0.6 : (enabled ? 0.85 : 0.32);
  ctx.beginPath(); ctx.arc(b.cx, b.cy, b.r, 0, 7);
  ctx.fillStyle = pressed ? 'rgba(125,249,255,0.35)' : 'rgba(10,16,32,0.72)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = pressed ? '#7df9ff' : (enabled ? 'rgba(120,170,255,0.6)' : 'rgba(120,140,170,0.35)');
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = enabled ? '#eaf3ff' : 'rgba(180,195,225,0.5)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(b.r * (b.sys ? 1.0 : 0.95))}px sans-serif`;
  ctx.fillText(b.glyph, b.cx, b.cy + 1);
  if (b.label && !b.sys) {
    ctx.font = `700 ${Math.round(8 * touch.scale)}px sans-serif`;
    ctx.fillStyle = 'rgba(200,215,245,0.75)';
    ctx.fillText(b.label, b.cx, b.cy + b.r + 9);
  }
  if (sub) {
    ctx.font = `800 ${Math.round(12 * touch.scale)}px sans-serif`;
    ctx.fillStyle = '#c6ff41';
    ctx.fillText(sub, b.cx + b.r * 0.7, b.cy - b.r * 0.7);
  }
  ctx.textBaseline = 'alphabetic';
}

function drawTouchControls() {
  if (!touch.enabled || !R) return;
  const me = R.players.get(state.myId);
  const dead = me && (me.flags & FLAG_DEAD);
  touchLayout();
  ctx.save();
  ctx.globalAlpha = dead ? 0.45 : 1;
  drawStickGfx(touch.move, touch.moveDefault, '#41c7ff', 'MOVE / FLY');
  drawStickGfx(touch.aim, touch.aimDefault, '#ff8a3c', touch.autoFire ? 'AIM · FIRE' : 'AIM');
  const pressed = new Set();
  for (const a of touch.active.values()) if (a.role === 'btn') pressed.add(a.id);
  for (const b of touch.buttons) {
    let enabled = true, sub = '';
    if (me) {
      if (b.id === 'dash') enabled = me.dashCd <= 0;
      else if (b.id === 'nade') { enabled = me.nades > 0; sub = String(me.nades); }
    }
    drawTouchButton(b, enabled, b.id === 'fire' ? touch.fireHeld : pressed.has(b.id), sub);
    if (b.id === 'dash' && me && me.dashCd > 0) {
      ctx.strokeStyle = 'rgba(125,249,255,0.85)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(b.cx, b.cy, b.r + 3, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * (1 - me.dashCd / 2.2)); ctx.stroke();
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// Horizontal, tappable weapon strip for touch — top-center under the timer.
function drawWeaponsTouch(me) {
  touch.weaponHit = [];
  const s = touch.scale;
  const sw = 96 * s, sh = 30 * s, gap = 6 * s;
  const n = me.weapons.length;
  const totalW = n * sw + (n - 1) * gap;
  let x = viewW / 2 - totalW / 2;
  const y = 72;
  for (let i = 0; i < n; i++) {
    const [wt, ammo] = me.weapons[i];
    const sel = i === me.cur;
    ctx.fillStyle = sel ? 'rgba(65,199,255,0.2)' : 'rgba(8,12,26,0.72)';
    ctx.strokeStyle = sel ? '#41c7ff' : 'rgba(90,140,230,0.35)';
    ctx.lineWidth = sel ? 2 : 1;
    rr(x, y, sw, sh, 4); ctx.fill(); ctx.stroke();
    ctx.save(); ctx.translate(x + 24 * s, y + sh / 2 + 2); drawGun(wt, 0.9 * s); ctx.restore();
    ctx.fillStyle = sel ? '#fff' : '#8fa8d8';
    ctx.font = `800 ${Math.round(12 * s)}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(ammo < 0 ? '∞' : String(ammo), x + sw - 8, y + sh / 2 + 4);
    touch.weaponHit.push({ x, y, w: sw, h: sh, i });
    x += sw + gap;
  }
  ctx.textAlign = 'left';
}

function drawMinimap() {
  const m = state.map;
  const mw = 190, scale = mw / m.w, mh = m.h * scale;
  const x0 = 18, y0 = 16;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = 'rgba(5,8,18,0.8)';
  ctx.strokeStyle = 'rgba(90,140,230,0.5)';
  ctx.lineWidth = 1;
  rr(x0 - 4, y0 - 4, mw + 8, mh + 8, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(120,160,240,0.5)';
  for (const r of m.rects) ctx.fillRect(x0 + r[0] * scale, y0 + r[1] * scale, Math.max(1, r[2] * scale), Math.max(1, r[3] * scale));
  ctx.fillStyle = '#ff5a1f';
  for (const lz of m.lava) ctx.fillRect(x0 + lz[0] * scale, y0 + lz[1] * scale, lz[2] * scale, Math.max(1, lz[3] * scale));
  ctx.fillStyle = '#ffd34d';
  for (let i = 0; i < m.items.length; i++) {
    if (!R.items.has(i)) continue;
    ctx.fillRect(x0 + m.items[i][1] * scale - 1, y0 + m.items[i][2] * scale - 1, 2.4, 2.4);
  }
  for (const [id, p] of R.players) {
    if (p.flags & FLAG_DEAD) continue;
    const px = x0 + p.x * scale, py = y0 + p.y * scale;
    if (id === state.myId) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(px, py, 3.4, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath(); ctx.arc(px, py, 5.6, 0, 7); ctx.stroke();
    } else {
      ctx.fillStyle = state.mode === 'tdm' ? TEAM_COLORS[state.roster.get(id) ? state.roster.get(id).team : 0] : '#ff4655';
      ctx.beginPath(); ctx.arc(px, py, 2.6, 0, 7); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawMatchOver() {
  ctx.fillStyle = 'rgba(3,5,12,0.62)';
  ctx.fillRect(0, 0, viewW, viewH);
  ctx.textAlign = 'center';
  const mo = state.matchOver;
  let title = 'ROUND OVER', col = '#41c7ff';
  if (mo) {
    if (state.mode === 'tdm') {
      if (mo.wteam === -1) { title = 'DRAW'; }
      else {
        title = `${TEAM_NAMES[mo.wteam]} TEAM WINS`;
        col = TEAM_COLORS[mo.wteam];
        const r = state.roster.get(state.myId);
        if (r) title = r.team === mo.wteam ? 'VICTORY' : 'DEFEAT';
      }
    } else {
      title = mo.wid === state.myId ? 'VICTORY' : `WINNER: ${nameOf(mo.wid)}`;
      col = mo.wid === state.myId ? '#ffd34d' : '#41c7ff';
    }
  }
  ctx.font = '900 58px sans-serif';
  ctx.fillStyle = col;
  ctx.shadowColor = col; ctx.shadowBlur = 36;
  ctx.fillText(title, viewW / 2, viewH * 0.34);
  ctx.shadowBlur = 0;
  // podium top 3
  const sorted = [...R.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).slice(0, 3);
  ctx.font = '700 19px sans-serif';
  sorted.forEach((p, i) => {
    ctx.fillStyle = ['#ffd34d', '#c8d6f5', '#cd9a62'][i];
    ctx.fillText(`${i + 1}. ${nameOf(p.id)} — ${p.kills} / ${p.deaths}`, viewW / 2, viewH * 0.34 + 52 + i * 30);
  });
}

function drawFloaters(dt) {
  ctx.textAlign = 'center';
  for (let i = state.floaters.length - 1; i >= 0; i--) {
    const f = state.floaters[i];
    f.t -= dt;
    if (f.t <= 0) { state.floaters.splice(i, 1); continue; }
    f.y += f.vy * dt;
    f.vy *= 0.95;
    ctx.globalAlpha = Math.min(1, f.t * 2);
    ctx.font = `900 ${f.size}px sans-serif`;
    ctx.fillStyle = f.col;
    ctx.fillText(f.txt, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

/* ============================== SCOREBOARD ============================== */

let boardRefreshT = 0;
function refreshScoreboard() {
  if (!R) return;
  const tbl = $('scoretable');
  const rows = [...R.players.values()].map((p) => ({
    id: p.id, kills: p.kills, deaths: p.deaths,
    r: state.roster.get(p.id) || { name: '?', team: 0, bot: false, host: false },
  })).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  tbl.innerHTML = '';
  const mkRow = (cells, cls) => {
    const tr = document.createElement('tr');
    if (cls) tr.className = cls;
    for (const c of cells) tr.appendChild(c);
    tbl.appendChild(tr);
    return tr;
  };
  const th = (t) => { const e = document.createElement('th'); e.textContent = t; return e; };
  const td = (t, col) => { const e = document.createElement('td'); e.textContent = t; if (col) e.style.color = col; return e; };
  mkRow([th('PLAYER'), th('K'), th('D'), th('PING')]);
  const addPlayer = (row) => {
    const tag = (row.r.host ? ' ★' : '') + (row.r.bot ? ' [BOT]' : '');
    mkRow([td(row.r.name + tag, colorFor(row.id)), td(row.kills), td(row.deaths), td(row.r.bot ? '—' : 'LAN')], row.id === state.myId ? 'me' : '');
  };
  if (state.mode === 'tdm') {
    for (const team of [0, 1]) {
      const trh = mkRow([td(`${TEAM_NAMES[team]} — ${team === 0 ? R.ta : R.tb}`, TEAM_COLORS[team]), td(''), td(''), td('')], 'teamhdr');
      trh.style.borderTop = '2px solid ' + TEAM_COLORS[team];
      rows.filter((r) => r.r.team === team).forEach(addPlayer);
    }
  } else {
    rows.forEach(addPlayer);
  }
  $('scoreTitle').textContent = `${state.map ? state.map.name : ''} · ${state.mode.toUpperCase()} · FIRST TO ${state.scoreLimit}`;
}

/* ============================== MENU SCENE ============================== */

function drawMenuScene(now, dt) {
  menuT += dt;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, viewH);
  g.addColorStop(0, '#05070f'); g.addColorStop(1, '#101b38');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, viewW, viewH);
  // drifting star field
  const rng = mulberry(42);
  for (let i = 0; i < 120; i++) {
    const sx = (rng() * viewW * 1.2 + menuT * (6 + rng() * 20)) % (viewW + 60) - 30;
    const sy = rng() * viewH;
    ctx.globalAlpha = 0.2 + rng() * 0.6;
    ctx.fillStyle = i % 9 === 0 ? '#7df9ff' : '#cfe4ff';
    const s = rng() * 2 + 0.5;
    ctx.fillRect(sx, sy, s, s);
  }
  ctx.globalAlpha = 1;
  // grid floor
  ctx.strokeStyle = 'rgba(65,199,255,0.12)';
  ctx.lineWidth = 1;
  const horizon = viewH * 0.72;
  for (let i = 0; i < 14; i++) {
    const y = horizon + Math.pow(i / 14, 1.7) * (viewH - horizon);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(viewW, y); ctx.stroke();
  }
  const off = (menuT * 40) % 80;
  for (let x = -80 + off; x < viewW + 80; x += 80) {
    ctx.beginPath();
    ctx.moveTo(viewW / 2 + (x - viewW / 2) * 0.25, horizon);
    ctx.lineTo(x, viewH);
    ctx.stroke();
  }
}

/* ============================== MAIN LOOP =============================== */

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  const dtMs = now - lastFrame;
  lastFrame = now;

  if (!state.connected || !state.map) {
    drawMenuScene(now, dt);
    return;
  }

  R = currentRenderState(dtMs);
  if (!R) { drawMenuScene(now, dt); return; }

  // camera
  const me = R.players.get(state.myId);
  if (me) {
    const lookX = Math.max(-150, Math.min(150, (mouse.x - viewW / 2) * 0.22));
    const lookY = Math.max(-110, Math.min(110, (mouse.y - viewH / 2) * 0.22));
    const tx = me.x + ((me.flags & FLAG_DEAD) ? 0 : lookX);
    const ty = me.y + ((me.flags & FLAG_DEAD) ? -30 : lookY);
    const k = 1 - Math.exp(-8 * dt);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    // keep the view inside the map; center if the map is smaller than the view
    const minX = viewW * 0.5, maxX = state.map.w - viewW * 0.5;
    const minY = viewH * 0.5, maxY = state.map.h - viewH * 0.5;
    cam.x = minX > maxX ? state.map.w / 2 : Math.max(minX, Math.min(maxX, cam.x));
    cam.y = minY > maxY ? state.map.h / 2 : Math.max(minY, Math.min(maxY, cam.y));
    if (!Number.isFinite(cam.x)) cam.x = state.map.w / 2;
    if (!Number.isFinite(cam.y)) cam.y = state.map.h / 2;
  }
  cam.shakeT = Math.max(0, cam.shakeT - dt);
  if (cam.shakeT <= 0) cam.shakeMag = 0;

  // jet loop volume
  if (AU.jetGain) {
    const jetting = me && (me.flags & FLAG_JET);
    const cur = AU.jetGain.gain.value;
    AU.jetGain.gain.value = cur + ((jetting ? 0.20 : 0) - cur) * Math.min(1, dt * 12);
  }

  stepParticles(dt);

  drawBackground(now);
  worldTransform();
  drawMap(now);
  drawItems(now);
  drawNades(now);
  for (const [id, p] of R.players) if (id !== state.myId) drawPlayer(p, now);
  const meP = R.players.get(state.myId);
  if (meP) drawPlayer(meP, now);
  drawBullets();
  drawParticles();
  drawFloaters(dt);

  drawHUD(now, dt);

  if (boardOpen) {
    boardRefreshT -= dt;
    if (boardRefreshT <= 0) { boardRefreshT = 0.3; refreshScoreboard(); }
  }
}
requestAnimationFrame(frame);

/* ================================ BOOT ================================== */

$('lanUrl').textContent = location.host;
$('name').value = localStorage.getItem('nm_name') || '';

function goImmersive() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
  const lock = () => { try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch (e) {} };
  if (req) { try { const p = req.call(el); if (p && p.then) p.then(lock).catch(lock); else lock(); } catch (e) { lock(); } }
  else lock();
}

function deploy() {
  AU.init();
  const name = $('name').value.trim() || 'PLAYER';
  localStorage.setItem('nm_name', name);
  if (touch.enabled) goImmersive();
  connect(name);
}
$('deploy').addEventListener('click', deploy);
$('name').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') deploy(); ev.stopPropagation(); });

/* touch setup: swap menu hints, reveal touch settings, wire toggles */
if (touch.enabled) {
  document.body.classList.add('touch');
  const ts = $('touchSettings');
  if (ts) ts.classList.remove('hidden');
  const afc = $('optAutoFire'), lhc = $('optLefty'), tsz = $('optTouchSize');
  if (afc) { afc.checked = touch.autoFire; afc.addEventListener('change', () => { touch.autoFire = afc.checked; localStorage.setItem('nm_autofire', afc.checked ? '1' : '0'); }); }
  if (lhc) { lhc.checked = touch.lefty; lhc.addEventListener('change', () => { touch.lefty = lhc.checked; localStorage.setItem('nm_lefty', lhc.checked ? '1' : '0'); }); }
  if (tsz) { tsz.value = String(Math.round(touch.scale * 100)); tsz.addEventListener('input', () => { touch.scale = clampNum(parseFloat(tsz.value) / 100, 0.75, 1.4, 1); localStorage.setItem('nm_tscale', String(touch.scale)); }); }
}

$('resume').addEventListener('click', () => toggleEsc());
$('leave').addEventListener('click', () => { if (ws) ws.close(); toggleEsc(); });

$('volSfx').value = String(parseFloat(localStorage.getItem('nm_sfx') ?? '0.8') * 100);
$('volMusic').value = String(parseFloat(localStorage.getItem('nm_mus') ?? '0.45') * 100);
AU.sfxVol = parseFloat($('volSfx').value) / 100;
AU.musVol = parseFloat($('volMusic').value) / 100;
$('volSfx').addEventListener('input', () => { AU.setSfx(parseFloat($('volSfx').value) / 100); localStorage.setItem('nm_sfx', String(AU.sfxVol)); });
$('volMusic').addEventListener('input', () => { AU.setMus(parseFloat($('volMusic').value) / 100); localStorage.setItem('nm_mus', String(AU.musVol)); });

$('hApply').addEventListener('click', () => {
  send({
    t: 'h', set: {
      map: $('hMap').value, mode: $('hMode').value,
      bots: parseInt($('hBots').value, 10), diff: parseInt($('hDiff').value, 10),
      score: parseInt($('hScore').value, 10), time: parseInt($('hTime').value, 10),
    },
  });
  AU.uiClick();
  toggleEsc();
});
$('hRestart').addEventListener('click', () => { send({ t: 'h', set: { restart: true } }); AU.uiClick(); toggleEsc(); });
