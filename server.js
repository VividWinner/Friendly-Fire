// server.js
// The "referee" for the game. Tracks every connected player's position and
// stats, runs a fixed-rate game loop, and broadcasts the current state to
// everyone IN THEIR ROOM. Clients never decide what's true — they just send
// inputs/aim/shoot and draw whatever the server tells them.

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ---- World constants ----
const WORLD_WIDTH = 6400;
const WORLD_HEIGHT = 4800;
const PLAYER_RADIUS = 16;
const BASE_SPEED = 6;      // pixels/tick, walking
const SPRINT_SPEED = 10;   // pixels/tick, sprinting
const SPRINT_DRAIN = 1.4;  // stamina/tick while sprinting
const SPRINT_REGEN = 0.6;  // stamina/tick while not sprinting
const TICK_RATE = 30;
const MAX_PLAYERS_PER_ROOM = 4;
const COUNTDOWN_MS = 3000;
const INTERACT_RANGE = 44;

// ---- Round rules ----
const KILL_TARGET = 15;               // first to this many kills ends the round early
const TIME_LIMIT_MS = 5 * 60 * 1000;  // otherwise the round ends after 5 minutes
const RESPAWN_MS = 3000;              // downed players come back after this long
const ROUND_OVER_DISPLAY_MS = 8000;   // how long the results screen sits before the lobby reopens

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c'];

// ---- World content ----
const OBSTACLES = [];  // rectangles — collidable walls
const HOUSES = [];     // {x,y,w,h,rooms:[{x,y,w,h}],roofColor,floorColor,chimney,doors:[{x,y,w}]}
const CHESTS = [];     // {x,y} positions only — open/loot state lives per-room, not here

function addWallSeg(x, y, w, h) { OBSTACLES.push({ x, y, w, h }); }

// A house is a row of 1-6 uniform rooms sharing walls, with a doorway gap
// between each adjacent pair, plus one main entrance on the first room.
function buildHouse(x, y, roomCount, style) {
  const roomW = 150, roomH = 140, wallT = 14, doorGap = 52;
  const totalW = roomCount * roomW;
  const rooms = [];
  const doors = [];

  addWallSeg(x, y, totalW, wallT); // top wall, full span

  // Bottom wall, with a door gap under the first room (main entrance)
  const mainDoorX = x + (roomW - doorGap) / 2;
  addWallSeg(x, y + roomH - wallT, mainDoorX - x, wallT);
  addWallSeg(mainDoorX + doorGap, y + roomH - wallT, x + roomW - (mainDoorX + doorGap), wallT);
  doors.push({ x: mainDoorX, y: y + roomH - wallT / 2, w: doorGap, vertical: false });

  addWallSeg(x, y, wallT, roomH); // left wall
  addWallSeg(x + totalW - wallT, y, wallT, roomH); // right wall

  for (let i = 0; i < roomCount; i++) {
    rooms.push({ x: x + i * roomW, y, w: roomW, h: roomH });
    if (i < roomCount - 1) {
      // Interior dividing wall between room i and i+1, with a doorway gap
      const wallX = x + (i + 1) * roomW - wallT / 2;
      const gapY = y + (roomH - doorGap) / 2;
      addWallSeg(wallX, y, wallT, gapY - y);
      addWallSeg(wallX, gapY + doorGap, wallT, (y + roomH) - (gapY + doorGap));
      doors.push({ x: wallX, y: gapY, w: doorGap, vertical: true });
    }
  }

  // A chest in every room, nudged off-center so it doesn't sit on a doorway.
  rooms.forEach((r) => {
    CHESTS.push({ x: r.x + roomW * 0.28, y: r.y + roomH * 0.62 });
  });

  HOUSES.push({ x, y, w: totalW, h: roomH, rooms, doors, roofColor: style.roofColor, floorColor: style.floorColor, chimney: !!style.chimney });
}

const HOUSE_STYLES = [
  { roofColor: '#8b3a3a', floorColor: '#8a6d4f', chimney: true },
  { roofColor: '#4a5a7a', floorColor: '#7d6a52', chimney: true },
  { roofColor: '#5a7a4a', floorColor: '#8a6d4f', chimney: false },
  { roofColor: '#a05a2c', floorColor: '#6b5842', chimney: false },
  { roofColor: '#6a4a8a', floorColor: '#7d6a52', chimney: true },
];

// Weighted toward smaller houses, with mansions as a rare treat.
const ROOM_COUNT_POOL = [1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 6];

function pickRoomCount() {
  return ROOM_COUNT_POOL[Math.floor(Math.random() * ROOM_COUNT_POOL.length)];
}

function houseFootprint(roomCount) {
  return { w: roomCount * 150, h: 140 };
}

// Scatter houses across the (now much bigger) map with generous spacing so
// they read as a spread-out village, not a cluster.
function placeHouses(count) {
  let attempts = 0;
  while (HOUSES.length < count && attempts < count * 60) {
    attempts++;
    const roomCount = pickRoomCount();
    const { w, h } = houseFootprint(roomCount);
    const x = 200 + Math.random() * (WORLD_WIDTH - w - 400);
    const y = 200 + Math.random() * (WORLD_HEIGHT - h - 400);

    const tooClose = HOUSES.some((existing) => {
      const pad = 260; // generous gap between houses
      return x < existing.x + existing.w + pad && x + w + pad > existing.x &&
             y < existing.y + existing.h + pad && y + h + pad > existing.y;
    });
    if (tooClose) continue;

    buildHouse(x, y, roomCount, HOUSE_STYLES[Math.floor(Math.random() * HOUSE_STYLES.length)]);
  }
}
placeHouses(14);

function circleHitsRect(x, y, radius, o) {
  const closestX = Math.max(o.x, Math.min(x, o.x + o.w));
  const closestY = Math.max(o.y, Math.min(y, o.y + o.h));
  const dx = x - closestX, dy = y - closestY;
  return dx * dx + dy * dy < radius * radius;
}

function scatterCircles(count, minR, maxR, minGap) {
  const list = [];
  let attempts = 0;
  while (list.length < count && attempts < count * 40) {
    attempts++;
    const r = minR + Math.random() * (maxR - minR);
    const x = r + Math.random() * (WORLD_WIDTH - r * 2);
    const y = r + Math.random() * (WORLD_HEIGHT - r * 2);

    const nearHouse = HOUSES.some((h) => x > h.x - 70 && x < h.x + h.w + 70 && y > h.y - 70 && y < h.y + h.h + 70);
    if (nearHouse) continue;

    const tooClose = list.some((p) => {
      const dx = p.x - x, dy = p.y - y;
      return Math.sqrt(dx * dx + dy * dy) < p.r + r + minGap;
    });
    if (tooClose) continue;

    list.push({ x, y, r });
  }
  return list;
}

const ROCKS = scatterCircles(110, 12, 20, 32);
const TREES = scatterCircles(140, 12, 16, 50);
const BUSHES = scatterCircles(100, 10, 15, 18);

function circleHitsSolid(x, y, radius) {
  for (const o of OBSTACLES) if (circleHitsRect(x, y, radius, o)) return true;
  for (const c of ROCKS) {
    const dx = x - c.x, dy = y - c.y;
    if (dx * dx + dy * dy < (radius + c.r) * (radius + c.r)) return true;
  }
  for (const t of TREES) {
    const dx = x - t.x, dy = y - t.y;
    if (dx * dx + dy * dy < (radius + t.r) * (radius + t.r)) return true;
  }
  return false;
}

function randomSpawn() {
  let x, y, tries = 0;
  do {
    x = PLAYER_RADIUS + Math.random() * (WORLD_WIDTH - PLAYER_RADIUS * 2);
    y = PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - PLAYER_RADIUS * 2);
    tries++;
  } while (circleHitsSolid(x, y, PLAYER_RADIUS) && tries < 40);
  return { x, y };
}

// ---- Inventory ----
// Slot 0 is always the sidearm (pistol) and can't be dropped. Slots 1+ are
// free-for-all: weapons, ammo top-ups (merge into an existing stack instead
// of taking a slot), and consumables all compete for the same limited space
// — that scarcity is the point of "manually" choosing what to loot.
const INVENTORY_SIZE = 6;
const WEAPON_TYPES = ['pistol', 'shotgun', 'rifle', 'smg'];
const CONSUMABLE_TYPES = ['health_pack', 'stamina_potion'];

const WEAPON_STATS = {
  pistol:  { damage: 14, fireRateMs: 260, bulletSpeed: 900,  spread: 0.03,  lifetimeMs: 900,  pellets: 1, bulletRadius: 3,   startAmmo: 90 },
  smg:     { damage: 9,  fireRateMs: 90,  bulletSpeed: 950,  spread: 0.09,  lifetimeMs: 750,  pellets: 1, bulletRadius: 3,   startAmmo: 60 },
  rifle:   { damage: 28, fireRateMs: 230, bulletSpeed: 1300, spread: 0.015, lifetimeMs: 1000, pellets: 1, bulletRadius: 3.5, startAmmo: 40 },
  shotgun: { damage: 9,  fireRateMs: 750, bulletSpeed: 800,  spread: 0.22,  lifetimeMs: 380,  pellets: 6, bulletRadius: 3,   startAmmo: 18 },
};
const AMMO_REFILL = { pistol: 12, smg: 20, rifle: 15, shotgun: 6 };

function makeStartingInventory() {
  const inv = new Array(INVENTORY_SIZE).fill(null);
  inv[0] = { type: 'pistol', ammo: WEAPON_STATS.pistol.startAmmo };
  return inv;
}

function findEmptySlot(p) {
  for (let i = 1; i < p.inventory.length; i++) if (!p.inventory[i]) return i;
  return -1;
}

// Places a looted item into a player's inventory (merging ammo/weapon stacks
// where possible). Returns true on success, false if there was nowhere to
// put it — the caller is responsible for telling the looter why it failed.
function giveItem(p, type) {
  if (type === 'pistol_ammo') {
    const pistol = p.inventory.find((i) => i && i.type === 'pistol');
    if (pistol) pistol.ammo += AMMO_REFILL.pistol;
    return true;
  }
  if (WEAPON_TYPES.includes(type)) {
    const existing = p.inventory.find((i) => i && i.type === type);
    if (existing) { existing.ammo += AMMO_REFILL[type]; return true; }
    const slot = findEmptySlot(p);
    if (slot === -1) return false;
    p.inventory[slot] = { type, ammo: WEAPON_STATS[type].startAmmo };
    return true;
  }
  if (CONSUMABLE_TYPES.includes(type)) {
    const slot = findEmptySlot(p);
    if (slot === -1) return false;
    p.inventory[slot] = { type };
    return true;
  }
  return false;
}

// Consuming a health pack / stamina potion from inventory (clicking it).
// Weapons don't go through here — clicking a weapon slot just equips it.
function useItem(p, slot) {
  if (!Number.isInteger(slot) || slot <= 0 || slot >= p.inventory.length) return;
  const item = p.inventory[slot];
  if (!item) return;
  if (item.type === 'health_pack') {
    p.health = Math.min(p.maxHealth, p.health + 35);
    p.inventory[slot] = null;
  } else if (item.type === 'stamina_potion') {
    p.stamina = p.maxStamina;
    p.inventory[slot] = null;
  }
}

// ---- Loot ----
// Each chest has a fixed number of item slots, independently rolled; some
// come up empty. Opening a chest reveals ALL of them at once, and anyone in
// range can take individual items — loot isn't claimed until it's taken.
const CHEST_SLOT_COUNT = 3;
const CHEST_EMPTY_SLOT_CHANCE = 0.35;

const LOOT_TABLE = [
  { type: 'pistol_ammo', weight: 22 },
  { type: 'shotgun', weight: 12 },
  { type: 'rifle', weight: 10 },
  { type: 'smg', weight: 12 },
  { type: 'health_pack', weight: 24 },
  { type: 'stamina_potion', weight: 20 },
];
const LOOT_TOTAL_WEIGHT = LOOT_TABLE.reduce((sum, l) => sum + l.weight, 0);

function rollLoot() {
  let roll = Math.random() * LOOT_TOTAL_WEIGHT;
  for (const item of LOOT_TABLE) {
    if (roll < item.weight) return item.type;
    roll -= item.weight;
  }
  return LOOT_TABLE[LOOT_TABLE.length - 1].type;
}

function rollChestSlot() {
  if (Math.random() < CHEST_EMPTY_SLOT_CHANCE) return null;
  return { type: rollLoot(), taken: false };
}

function freshChestState() {
  return CHESTS.map(() => ({ opened: false, items: Array.from({ length: CHEST_SLOT_COUNT }, rollChestSlot) }));
}

// ---- Room management ----
const rooms = new Map();
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createPlayer(pending) {
  return {
    x: 0, y: 0,
    color: (pending.color && COLORS.includes(pending.color)) ? pending.color : COLORS[Math.floor(Math.random() * COLORS.length)],
    name: pending.name || 'Player',
    ready: false,
    health: 100, maxHealth: 100,
    stamina: 100, maxStamina: 100,
    sprinting: false,
    exhausted: false, // true once stamina hits 0; stays true until it recovers a bit — prevents flicker
    alive: true,
    kills: 0,
    deaths: 0,
    respawnAt: 0,
    aimAngle: 0,
    lastShotAt: {}, // weapon type -> timestamp of last shot with it, for independent per-weapon cooldowns
    inventory: makeStartingInventory(),
    equipped: 0,
    keys: { up: false, down: false, left: false, right: false, sprint: false },
  };
}

function resetForRound(p) {
  const spawn = randomSpawn();
  p.x = spawn.x; p.y = spawn.y;
  p.health = p.maxHealth;
  p.stamina = p.maxStamina;
  p.sprinting = false;
  p.exhausted = false;
  p.alive = true;
  p.kills = 0;
  p.deaths = 0;
  p.respawnAt = 0;
  p.aimAngle = 0;
  p.lastShotAt = {};
  p.inventory = makeStartingInventory();
  p.equipped = 0;
}

function revivePlayer(p) {
  const spawn = randomSpawn();
  p.x = spawn.x; p.y = spawn.y;
  p.health = p.maxHealth;
  p.stamina = p.maxStamina;
  p.alive = true;
}

function broadcastLobby(room) {
  const roster = Object.entries(room.players).map(([pid, p]) => ({ id: pid, name: p.name, color: p.color, ready: p.ready }));
  const msg = JSON.stringify({ type: 'lobby', players: roster });
  room.clients.forEach((client) => { if (client.readyState === WebSocket.OPEN) client.send(msg); });
}

function roomIsActive(room) {
  return room.phase === 'countdown' || room.phase === 'playing';
}

function tryStartGame(room, code) {
  const ids = Object.keys(room.players);
  if (ids.length === 0) return;
  if (!ids.every((pid) => room.players[pid].ready)) return;

  room.phase = 'countdown';
  room.roundStartsAt = Date.now() + COUNTDOWN_MS;
  room.roundEndsAt = 0; // set once the countdown actually elapses, in tick()
  room.chestState = freshChestState();
  room.bullets = [];
  ids.forEach((pid) => resetForRound(room.players[pid]));

  const msg = JSON.stringify({ type: 'gameStart', countdownMs: COUNTDOWN_MS });
  room.clients.forEach((client) => { if (client.readyState === WebSocket.OPEN) client.send(msg); });
  console.log(`[room] ${code} started with ${ids.length} player(s)`);
}

function broadcastKill(room, shooter, target, weaponType) {
  const msg = JSON.stringify({
    type: 'kill',
    killerName: shooter ? shooter.name : null,
    killerColor: shooter ? shooter.color : null,
    victimName: target.name,
    victimColor: target.color,
    weapon: weaponType,
    selfKill: !shooter || shooter === target,
  });
  room.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function applyDamage(room, shooterId, targetId, damage, weaponType) {
  const target = room.players[targetId];
  if (!target || !target.alive) return;
  target.health -= damage;
  if (target.health <= 0) {
    target.health = 0;
    target.alive = false;
    target.deaths = (target.deaths || 0) + 1;
    target.respawnAt = Date.now() + RESPAWN_MS;
    const shooter = room.players[shooterId];
    if (shooter && shooter !== target) shooter.kills = (shooter.kills || 0) + 1;
    broadcastKill(room, shooter, target, weaponType);
    checkRoundEnd(room);
  }
}

function checkRoundEnd(room) {
  if (room.phase !== 'playing') return;
  const someoneHitTarget = Object.values(room.players).some((p) => (p.kills || 0) >= KILL_TARGET);
  if (someoneHitTarget) endRound(room, 'killTarget');
}

function endRound(room, reason) {
  if (room.phase !== 'playing') return;
  room.phase = 'roundOver';
  const scores = Object.values(room.players)
    .map((p) => ({ name: p.name, color: p.color, kills: p.kills || 0, deaths: p.deaths || 0 }))
    .sort((a, b) => b.kills - a.kills);
  const msg = JSON.stringify({ type: 'roundOver', scores, reason });
  room.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
  setTimeout(() => returnToLobby(room), ROUND_OVER_DISPLAY_MS);
}

function returnToLobby(room) {
  if (rooms.get(room.code) !== room) return; // room already torn down (everyone left)
  room.phase = 'lobby';
  room.bullets = [];
  Object.values(room.players).forEach((p) => { p.ready = false; });
  broadcastLobby(room);
  const msg = JSON.stringify({ type: 'returnToLobby' });
  room.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function openChestForPlayer(ws, room, idx, p) {
  const state = room.chestState[idx];
  if (!state) return;
  state.opened = true;
  const hasItems = state.items.some((it) => it && !it.taken);
  ws.send(JSON.stringify({ type: hasItems ? 'chestOpen' : 'chestEmpty', chestIndex: idx }));
}

function fireWeapon(room, shooterId, p, angle) {
  if (!p.alive) return;
  const item = p.inventory[p.equipped];
  if (!item) return;
  const stats = WEAPON_STATS[item.type];
  if (!stats) return; // equipped slot isn't a weapon (shouldn't happen — equip already guards this)

  const now = Date.now();
  const last = p.lastShotAt[item.type] || 0;
  if (now - last < stats.fireRateMs) return;
  if (item.ammo <= 0) return;

  p.lastShotAt[item.type] = now;
  item.ammo -= 1;

  const spawnDist = PLAYER_RADIUS + 8;
  for (let i = 0; i < stats.pellets; i++) {
    const a = angle + (Math.random() - 0.5) * 2 * stats.spread;
    room.bullets.push({
      id: nextBulletId++,
      ownerId: shooterId,
      x: p.x + Math.cos(a) * spawnDist,
      y: p.y + Math.sin(a) * spawnDist,
      vx: Math.cos(a) * stats.bulletSpeed,
      vy: Math.sin(a) * stats.bulletSpeed,
      damage: stats.damage,
      radius: stats.bulletRadius,
      type: item.type,
      color: p.color,
      expiresAt: now + stats.lifetimeMs,
    });
  }
}

let nextBulletId = 1;

const WORLD_PAYLOAD = {
  w: WORLD_WIDTH, h: WORLD_HEIGHT,
  obstacles: OBSTACLES, houses: HOUSES, rocks: ROCKS, trees: TREES, bushes: BUSHES, chests: CHESTS,
};

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).slice(2, 10);
  ws.playerId = id;
  ws.roomCode = null;
  ws.pending = { name: `Player-${id.slice(0, 4)}`, color: null };

  ws.send(JSON.stringify({ type: 'welcome', id, world: WORLD_PAYLOAD }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    try {
    if (msg.type === 'auth') {
      if (typeof msg.name === 'string') ws.pending.name = msg.name.slice(0, 20);
      if (typeof msg.color === 'string' && COLORS.includes(msg.color)) ws.pending.color = msg.color;
      const room = ws.roomCode && rooms.get(ws.roomCode);
      if (room && room.players[id]) {
        room.players[id].name = ws.pending.name;
        if (ws.pending.color) room.players[id].color = ws.pending.color;
        if (room.phase === 'lobby') broadcastLobby(room);
      }
      return;
    }

    if (msg.type === 'createRoom') {
      const code = generateRoomCode();
      const room = { code, players: {}, clients: new Set(), phase: 'lobby', roundStartsAt: 0, roundEndsAt: 0, chestState: [], bullets: [] };
      room.players[id] = createPlayer(ws.pending);
      room.clients.add(ws);
      rooms.set(code, room);
      ws.roomCode = code;
      ws.send(JSON.stringify({ type: 'roomCreated', code }));
      broadcastLobby(room);
      console.log(`[room] ${code} created by ${id}`);
      return;
    }

    if (msg.type === 'joinRoom') {
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ type: 'roomError', message: 'Room not found. Check the code and try again.' })); return; }
      if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) { ws.send(JSON.stringify({ type: 'roomError', message: 'That room is full (4/4).' })); return; }

      room.players[id] = createPlayer(ws.pending);
      room.clients.add(ws);
      ws.roomCode = code;
      if (room.phase !== 'lobby') resetForRound(room.players[id]);
      ws.send(JSON.stringify({ type: 'roomJoined', code, started: room.phase !== 'lobby' }));
      if (room.phase === 'lobby') broadcastLobby(room);
      console.log(`[room] ${id} joined ${code}`);
      return;
    }

    if (msg.type === 'toggleReady') {
      const room = ws.roomCode && rooms.get(ws.roomCode);
      if (room && room.phase === 'lobby' && room.players[id]) {
        room.players[id].ready = !room.players[id].ready;
        broadcastLobby(room);
        tryStartGame(room, ws.roomCode);
      }
      return;
    }

    if (msg.type === 'input') {
      const room = ws.roomCode && rooms.get(ws.roomCode);
      const p = room && room.players[id];
      if (p && roomIsActive(room) && msg.keys && typeof msg.keys === 'object') {
        p.keys = {
          up: !!msg.keys.up, down: !!msg.keys.down, left: !!msg.keys.left, right: !!msg.keys.right,
          sprint: !!msg.keys.sprint,
        };
        if (typeof msg.aimAngle === 'number' && isFinite(msg.aimAngle)) p.aimAngle = msg.aimAngle;
      }
      return;
    }

    if (msg.type === 'equip') {
      const room = ws.roomCode && rooms.get(ws.roomCode);
      const p = room && room.players[id];
      const item = p && Number.isInteger(msg.index) && msg.index >= 0 && msg.index < p.inventory.length
        ? p.inventory[msg.index] : null;
      if (item && WEAPON_TYPES.includes(item.type)) {
        p.equipped = msg.index;
      }
      return;
    }

    if (msg.type === 'useItem') {
      const room = ws.roomCode && rooms.get(ws.roomCode);
      const p = room && room.players[id];
      if (p && Number.isInteger(msg.slot)) useItem(p, msg.slot);
      return;
    }

    if (msg.type === 'dropItem') {
      const room = ws.roomCode && rooms.get(ws.roomCode);
      const p = room && room.players[id];
      if (p && Number.isInteger(msg.slot) && msg.slot > 0 && msg.slot < p.inventory.length) {
        p.inventory[msg.slot] = null;
        if (p.equipped === msg.slot) p.equipped = 0;
      }
      return;
    }

    if (msg.type === 'shoot') {
      const room = ws.roomCode && rooms.get(ws.roomCode);
      const p = room && room.players[id];
      if (!room || !p || room.phase !== 'playing') return;
      const angle = typeof msg.angle === 'number' && isFinite(msg.angle) ? msg.angle : p.aimAngle;
      p.aimAngle = angle;
      fireWeapon(room, id, p, angle);
      return;
    }

    if (msg.type === 'interact') {
      const room = ws.roomCode && rooms.get(ws.roomCode);
      if (!room || room.phase !== 'playing') return;
      const p = room.players[id];
      if (!p || !p.alive) return;

      let closestIdx = -1, closestDist = INTERACT_RANGE;
      CHESTS.forEach((c, idx) => {
        const dx = p.x - c.x, dy = p.y - c.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestDist) { closestDist = dist; closestIdx = idx; }
      });
      if (closestIdx === -1) return;
      openChestForPlayer(ws, room, closestIdx, p);
      return;
    }

    if (msg.type === 'openChest') {
      const room = ws.roomCode && rooms.get(ws.roomCode);
      if (!room || room.phase !== 'playing') return;
      const p = room.players[id];
      if (!p || !p.alive) return;
      const idx = msg.chestIndex;
      if (!Number.isInteger(idx) || idx < 0 || idx >= CHESTS.length) return;
      const c = CHESTS[idx];
      const dx = p.x - c.x, dy = p.y - c.y;
      if (Math.sqrt(dx * dx + dy * dy) > INTERACT_RANGE) return; // too far — ignore silently, no error needed
      openChestForPlayer(ws, room, idx, p);
      return;
    }

    if (msg.type === 'lootTake') {
      const room = ws.roomCode && rooms.get(ws.roomCode);
      if (!room || room.phase !== 'playing') return;
      const p = room.players[id];
      if (!p || !p.alive) return;
      const idx = msg.chestIndex, slot = msg.slot;
      const state = room.chestState[idx];
      if (!state || !state.opened) return;
      const item = state.items[slot];
      if (!item || item.taken) return;
      const c = CHESTS[idx];
      const dx = p.x - c.x, dy = p.y - c.y;
      if (Math.sqrt(dx * dx + dy * dy) > INTERACT_RANGE * 1.6) return; // some leeway — they may have stepped back slightly

      if (giveItem(p, item.type)) {
        item.taken = true;
      } else {
        ws.send(JSON.stringify({ type: 'actionFailed', reason: 'Inventory full' }));
      }
      return;
    }
    } catch (err) {
      // A single malformed/unexpected message should never take the whole
      // server (and everyone else's game) down with it.
      console.error('[message handler error]', err);
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode && rooms.get(ws.roomCode);
    if (room) {
      delete room.players[id];
      room.clients.delete(ws);
      if (room.clients.size === 0) {
        rooms.delete(ws.roomCode);
        console.log(`[room] ${ws.roomCode} closed (empty)`);
      } else if (room.phase === 'lobby') {
        broadcastLobby(room);
        tryStartGame(room, ws.roomCode);
      }
    }
  });
});

// ---- Game loop ----
function movePlayer(p) {
  const wantsToMove = p.keys.up || p.keys.down || p.keys.left || p.keys.right;

  // Hysteresis: once fully exhausted, you have to recover to 15% stamina
  // before you're allowed to sprint again — without this, hitting exactly 0
  // and regenerating a fraction of a point immediately re-triggers sprint,
  // which drains it again next tick, causing a rapid on/off flicker.
  if (p.stamina <= 0) p.exhausted = true;
  else if (p.stamina >= p.maxStamina * 0.15) p.exhausted = false;

  const sprinting = p.keys.sprint && !p.exhausted && p.stamina > 0 && wantsToMove;
  p.sprinting = sprinting;
  const speed = sprinting ? SPRINT_SPEED : BASE_SPEED;
  p.stamina = sprinting
    ? Math.max(0, p.stamina - SPRINT_DRAIN)
    : Math.min(p.maxStamina, p.stamina + SPRINT_REGEN);

  let newX = p.x;
  if (p.keys.left) newX -= speed;
  if (p.keys.right) newX += speed;
  newX = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, newX));
  if (!circleHitsSolid(newX, p.y, PLAYER_RADIUS)) p.x = newX;

  let newY = p.y;
  if (p.keys.up) newY -= speed;
  if (p.keys.down) newY += speed;
  newY = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, newY));
  if (!circleHitsSolid(p.x, newY, PLAYER_RADIUS)) p.y = newY;
}

// Bullets are simulated in several sub-steps per tick rather than one big
// jump — at rifle speed a full tick's movement (~43px) is wider than an
// interior wall (14px), so a single end-of-tick check could tunnel clean
// through it. Sub-stepping keeps each individual move smaller than the
// thinnest solid object in the world.
const BULLET_SUBSTEPS = 6;

function moveBullets(room, dtSec) {
  const now = Date.now();
  const remaining = [];
  for (const b of room.bullets) {
    if (now >= b.expiresAt) continue;
    let hit = false;
    const stepDt = dtSec / BULLET_SUBSTEPS;

    for (let s = 0; s < BULLET_SUBSTEPS && !hit; s++) {
      b.x += b.vx * stepDt;
      b.y += b.vy * stepDt;

      if (b.x < 0 || b.x > WORLD_WIDTH || b.y < 0 || b.y > WORLD_HEIGHT) { hit = true; break; }

      for (const o of OBSTACLES) {
        if (circleHitsRect(b.x, b.y, b.radius, o)) { hit = true; break; }
      }
      if (hit) break;

      for (const rk of ROCKS) {
        const dx = b.x - rk.x, dy = b.y - rk.y;
        if (dx * dx + dy * dy < (b.radius + rk.r) * (b.radius + rk.r)) { hit = true; break; }
      }
      if (hit) break;

      for (const t of TREES) {
        const dx = b.x - t.x, dy = b.y - t.y;
        if (dx * dx + dy * dy < (b.radius + t.r) * (b.radius + t.r)) { hit = true; break; }
      }
      if (hit) break;

      for (const pid in room.players) {
        if (pid === b.ownerId) continue;
        const target = room.players[pid];
        if (!target.alive) continue;
        const dx = b.x - target.x, dy = b.y - target.y;
        if (dx * dx + dy * dy < (b.radius + PLAYER_RADIUS) * (b.radius + PLAYER_RADIUS)) {
          applyDamage(room, b.ownerId, pid, b.damage, b.type);
          hit = true;
          break;
        }
      }
    }
    if (!hit) remaining.push(b);
  }
  room.bullets = remaining;
}

function tick() {
  rooms.forEach((room) => {
    try {
      tickRoom(room);
    } catch (err) {
      console.error('[tick error]', err);
    }
  });
}

function tickRoom(room) {
  if (room.phase === 'countdown' && Date.now() >= room.roundStartsAt) {
    room.phase = 'playing';
    room.roundEndsAt = Date.now() + TIME_LIMIT_MS;
  }
  if (room.phase !== 'countdown' && room.phase !== 'playing') return;

  const frozen = room.phase === 'countdown';
  for (const id in room.players) {
    const p = room.players[id];
    if (!p.alive) {
      if (Date.now() >= p.respawnAt) revivePlayer(p);
      continue;
    }
    if (!frozen) movePlayer(p);
  }

  if (room.phase === 'playing') {
    moveBullets(room, 1 / TICK_RATE);
    if (Date.now() >= room.roundEndsAt) { endRound(room, 'timeUp'); return; }
  }

  const stateMsg = JSON.stringify({
    type: 'state',
    players: room.players,
    chests: room.chestState,
    bullets: room.bullets,
    roundEndsAt: room.roundEndsAt || 0,
  });
  room.clients.forEach((client) => { if (client.readyState === WebSocket.OPEN) client.send(stateMsg); });
}

setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Friendly Fire server running on port ${PORT}`);
});
