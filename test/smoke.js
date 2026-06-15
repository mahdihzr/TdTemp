/*
 * Smoke test for NEON MILITIA.
 * Boots the real server, connects over raw TCP speaking RFC6455 WebSocket,
 * joins the match, and asserts:
 *   - welcome + roster arrive with valid map data
 *   - snapshots stream at ~30 Hz
 *   - holding "move right" actually moves our player (server physics + input)
 *   - bots are alive and shooting (combat events flow)
 *   - chat round-trips
 *   - static file serving works
 */
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const PORT = 3177;
let failures = 0;
const ok = (cond, label) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label);
  if (!cond) failures++;
};

/* --- minimal websocket client --- */
function wsConnect(port, onMsg) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let upgraded = false;
    let buf = Buffer.alloc(0);
    sock.on('connect', () => {
      sock.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    sock.on('error', reject);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        if (!/101/.test(head)) { reject(new Error('upgrade failed: ' + head.split('\r\n')[0])); return; }
        buf = buf.slice(idx + 4);
        upgraded = true;
        resolve({
          send(obj) {
            const payload = Buffer.from(JSON.stringify(obj), 'utf8');
            const mask = crypto.randomBytes(4);
            let header;
            const len = payload.length;
            if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
            else { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
            header[0] = 0x81;
            const masked = Buffer.from(payload);
            for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
            sock.write(Buffer.concat([header, mask, masked]));
          },
          close() { sock.destroy(); },
        });
      }
      // parse server frames (unmasked)
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
        if (buf.length < off + len) return;
        const op = buf[0] & 0x0f;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op === 0x1) {
          try { onMsg(JSON.parse(payload.toString('utf8'))); } catch (e) {}
        } else if (op === 0x9) {
          // pong
          const h = Buffer.alloc(2 + 4); h[0] = 0x8A; h[1] = 0x80; sock.write(h);
        }
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(50);
  }
  ok(false, label + ' (timeout)');
  return false;
}

function fetch200(port, p) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ code: res.statusCode, bytes: n }));
    }).on('error', () => resolve({ code: 0, bytes: 0 }));
  });
}

async function main() {
  console.log('Booting server…');
  // CAVERN has a full ground floor and no lava/void. Veteran bots (diff 2) fight
  // hard so combat/kill checks pass fast and the idle test client is fragged
  // often — giving recurring spawn-protection windows for the physics checks.
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(PORT), '--bots', '4', '--diff', '2', '--map', 'cavern'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOut = '';
  server.stdout.on('data', (d) => { serverOut += d.toString(); });
  server.stderr.on('data', (d) => { serverOut += d.toString(); });
  let exited = false;
  server.on('exit', () => { exited = true; });

  await waitFor(() => serverOut.includes('LISTENING'), 5000, 'server boots');

  const page = await fetch200(PORT, '/');
  ok(page.code === 200 && page.bytes > 500, `serves index.html (HTTP ${page.code}, ${page.bytes} bytes)`);
  const js = await fetch200(PORT, '/client.js');
  ok(js.code === 200 && js.bytes > 5000, `serves client.js (HTTP ${js.code}, ${js.bytes} bytes)`);
  const evil = await fetch200(PORT, '/../server.js');
  ok(evil.code !== 200 || evil.bytes === 0, 'blocks path traversal');

  // connect & join
  const msgs = { w: null, snaps: [], kills: 0, chats: [], rosters: 0, ownShots: 0, events: { shots: 0, hits: 0 } };
  const ws = await wsConnect(PORT, (m) => {
    if (m.t === 'w') msgs.w = m;
    else if (m.t === 's') {
      msgs.snaps.push(m);
      const mine = msgs.w && msgs.w.id;
      for (const e of m.e) {
        if (e[0] === 0) { msgs.events.shots++; if (e[5] === mine) msgs.ownShots++; }
        if (e[0] === 2) msgs.events.hits++;
      }
    }
    else if (m.t === 'k') msgs.kills++;
    else if (m.t === 'c') msgs.chats.push(m);
    else if (m.t === 'r') msgs.rosters++;
  });
  ws.send({ t: 'j', name: 'SMOKETEST' });

  await waitFor(() => msgs.w !== null, 3000, 'welcome arrives');
  if (msgs.w) {
    ok(typeof msgs.w.id === 'number', 'welcome has player id');
    ok(msgs.w.map && Array.isArray(msgs.w.map.rects) && msgs.w.map.rects.length > 5, 'welcome has map geometry');
    ok(Array.isArray(msgs.w.roster) && msgs.w.roster.length >= 5, `roster includes bots (${msgs.w.roster ? msgs.w.roster.length : 0} players)`);
  }
  const myId = msgs.w ? msgs.w.id : -1;

  // snapshots streaming
  await sleep(1500);
  const snapCount1 = msgs.snaps.length;
  ok(snapCount1 > 30, `snapshots stream (${snapCount1} in ~1.5s, want >30)`);

  const findMe = () => {
    for (let i = msgs.snaps.length - 1; i >= 0; i--) {
      const me = msgs.snaps[i].p.find((a) => a[0] === myId);
      if (me) return me;
    }
    return null;
  };

  const alive = () => { const me = findMe(); return me && !(me[9] & 8); };
  // spawn-protected (flag 4): ~2s of invulnerability. The idle test client gets
  // fragged by the deadly bots every few seconds, so protected windows recur —
  // and move/jetpack don't break protection, so measuring inside one can't be
  // interrupted by a frag. Each retry alternates direction to dodge wall wedging.
  const safe = () => { const me = findMe(); return me && !(me[9] & 8) && (me[9] & 4); };
  const idle = () => ws.send({ t: 'i', l: 0, r: 0, u: 0, d: 0, f: 0, a: 0 });
  const attempt = async (label, fn, gate) => {
    for (let i = 0; i < 8; i++) { await waitFor(gate || alive, 9000, label); const r = await fn(i); idle(); if (r !== null) return r; await sleep(150); }
    return null;
  };

  // jetpack: jet up-and-sideways during spawn protection, track the peak rise
  const rise = await attempt('jetpack check', async (i) => {
    if (!safe()) return null;
    const dir = i % 2 ? -1 : 1, startY = findMe()[2]; let peakY = startY;
    ws.send({ t: 'i', l: dir < 0 ? 1 : 0, r: dir > 0 ? 1 : 0, u: 1, d: 0, f: 0, a: 0 });
    for (let k = 0; k < 16; k++) { await sleep(50); if (!alive()) return null; peakY = Math.min(peakY, findMe()[2]); }
    return peakY - startY < -40 ? peakY - startY : null;
  }, safe);
  ok(rise !== null, `jetpack lifts player (peak rise=${rise === null ? 'boxed in' : Math.round(-rise)}px)`);

  // movement: hold a direction during spawn protection, require travel
  const dx = await attempt('move check', async (i) => {
    if (!safe()) return null;
    const dir = i % 2 ? -1 : 1, x0 = findMe()[1]; let moved = 0;
    ws.send({ t: 'i', l: dir < 0 ? 1 : 0, r: dir > 0 ? 1 : 0, u: 0, d: 0, f: 0, a: 0 });
    for (let k = 0; k < 16; k++) { await sleep(50); if (!alive()) return null; moved = findMe()[1] - x0; }
    return Math.abs(moved) > 50 ? moved : null;
  }, safe);
  ok(dx !== null, `input moves player (dx=${dx === null ? 'stuck' : Math.round(dx)}px)`);

  // firing: confirm our own muzzle events fire (dual-wield light weapon → ≥2/shot).
  // Returns as soon as a shot lands, so a frag can't mask a working trigger.
  const fired = await attempt('fire check', async () => {
    const shots0 = msgs.ownShots;
    ws.send({ t: 'i', l: 0, r: 0, u: 0, d: 0, f: 1, a: 0.5 });
    for (let k = 0; k < 12; k++) { await sleep(50); if (msgs.ownShots > shots0) return msgs.ownShots - shots0; }
    return null;
  });
  ok(fired !== null, `firing produces shots (${fired === null ? 'none' : fired} muzzle events)`);

  // combat + a full kill cycle (deadly bots have been fighting throughout)
  await waitFor(() => msgs.events.shots > 20, 12000, 'bots are shooting');
  ok(msgs.events.shots > 20, `combat events flow (${msgs.events.shots} shots, ${msgs.events.hits} hits)`);
  await waitFor(() => msgs.kills >= 1, 40000, 'a kill happens');
  ok(msgs.kills >= 1, `kill feed works (${msgs.kills} kills, ${msgs.events.hits} hits)`);

  // chat round-trip
  ws.send({ t: 'c', msg: 'hello arena' });
  await waitFor(() => msgs.chats.some((c) => c.msg === 'hello arena'), 2000, 'chat echoes');
  ok(msgs.chats.some((c) => c.msg === 'hello arena'), 'chat round-trips');

  ok(!exited, 'server still alive after the session');

  ws.close();
  server.kill();
  await sleep(200);

  console.log('');
  if (failures > 0) {
    console.log(`SMOKE TEST: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('SMOKE TEST: ALL GREEN');
  process.exit(0);
}

main().catch((e) => { console.error('smoke test crashed:', e); process.exit(1); });
