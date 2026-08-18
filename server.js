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
const WORLD_WIDTH = 9600;   // 50% bigger than the original 6400 in each dimension
const WORLD_HEIGHT = 7200;  // (2.25x total area) — prop counts below are scaled to match
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
const TIME_LIMIT_MS = 5 * 60 * 1000;  // a round lasts 5 minutes; whoever has the most kills when it ends wins
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

// Houses are placed on a jittered grid rather than pure rejection sampling.
// Rejection sampling (try a random spot, retry if it collides) makes close
// spawns *unlikely*, not impossible — with enough houses on the map, "two
// spawn right next to each other" was bound to happen occasionally. A grid
// guarantees every house gets its own cell with guaranteed clearance from
// its neighbors; the random jitter *within* each cell is what keeps it
// from actually looking like a grid.
function placeHouses(count) {
  const cellW = 1300, cellH = 520; // comfortably fits even the largest (6-room, 900x140) house with real breathing room
  const marginX = 300, marginY = 300; // keep houses off the world edge
  const cols = Math.floor((WORLD_WIDTH - marginX * 2) / cellW);
  const rows = Math.floor((WORLD_HEIGHT - marginY * 2) / cellH);

  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ c, r });
  // Fisher-Yates shuffle — take cells in random order so which grid slots
  // end up empty (gaps to walk/drive through) varies map to map.
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  const target = Math.min(count, cells.length);
  for (let i = 0; i < target; i++) {
    const { c, r } = cells[i];
    const roomCount = pickRoomCount();
    const { w, h } = houseFootprint(roomCount);

    const cellX = marginX + c * cellW;
    const cellY = marginY + r * cellH;
    const jitterInset = 60; // keep the house off the cell's own edge, away from its neighbor
    const jitterRangeX = Math.max(0, cellW - w - jitterInset * 2);
    const jitterRangeY = Math.max(0, cellH - h - jitterInset * 2);
    const x = cellX + jitterInset + Math.random() * jitterRangeX;
    const y = cellY + jitterInset + Math.random() * jitterRangeY;

    buildHouse(x, y, roomCount, HOUSE_STYLES[Math.floor(Math.random() * HOUSE_STYLES.length)]);
  }
}
placeHouses(32);

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

// Counts scaled by 2.25x (matching the 50%-bigger-per-dimension map area)
// to keep the same density — a bigger map with the old counts would just
// feel emptier, not more interesting.
const ROCKS = scatterCircles(248, 12, 20, 32);
const TREES = scatterCircles(315, 12, 16, 50);
const BUSHES = scatterCircles(225, 10, 15, 18);

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
  pistol:  { damage: 14, fireRateMs: 260, bulletSpeed: 900,  spread: 0.03,  lifetimeMs: 900,  pellets: 1, bulletRadius: 3,   magSize: 12, reloadMs: 900,  startAmmo: 90 },
  smg:     { damage: 9,  fireRateMs: 90,  bulletSpeed: 950,  spread: 0.09,  lifetimeMs: 750,  pellets: 1, bulletRadius: 3,   magSize: 25, reloadMs: 1400, startAmmo: 90 },
  rifle:   { damage: 28, fireRateMs: 230, bulletSpeed: 1300, spread: 0.015, lifetimeMs: 1000, pellets: 1, bulletRadius: 3.5, magSize: 20, reloadMs: 1700, startAmmo: 80 },
  shotgun: { damage: 9,  fireRateMs: 750, bulletSpeed: 800,  spread: 0.22,  lifetimeMs: 380,  pellets: 6, bulletRadius: 3,   magSize: 6,  reloadMs: 2200, startAmmo: 30 },
};
const AMMO_REFILL = { pistol: 12, smg: 20, rifle: 15, shotgun: 6 }; // added to RESERVE, not the magazine directly

// A fresh weapon starts with a full magazine and whatever's left over as
// reserve — never more ammo than startAmmo actually allows.
function freshWeaponAmmo(type) {
  const stats = WEAPON_STATS[type];
  const mag = Math.min(stats.magSize, stats.startAmmo);
  return { mag, reserve: stats.startAmmo - mag };
}

function makeStartingInventory() {
  const inv = new Array(INVENTORY_SIZE).fill(null);
  inv[0] = { type: 'pistol', ...freshWeaponAmmo('pistol') };
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
    if (pistol) pistol.reserve += AMMO_REFILL.pistol;
    return true;
  }
  if (WEAPON_TYPES.includes(type)) {
    const existing = p.inventory.find((i) => i && i.type === type);
    if (existing) { existing.reserve += AMMO_REFILL[type]; return true; }
    const slot = findEmptySlot(p);
    if (slot === -1) return false;
    p.inventory[slot] = { type, ...freshWeaponAmmo(type) };
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
    reloadingUntil: 0, // 0 = not reloading; otherwise a timestamp this player's current reload finishes at
    reloadingSlot: -1, // which inventory slot that reload applies to — switching weapons cancels it
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
  p.reloadingUntil = 0;
  p.reloadingSlot = -1;
  p.inventory = makeStartingInventory();
  p.equipped = 0;
}

function revivePlayer(p) {
  const spawn = randomSpawn();
  p.x = spawn.x; p.y = spawn.y;
  p.health = p.maxHealth;
  p.stamina = p.maxStamina;
  p.alive = true;
  p.reloadingUntil = 0;
  p.reloadingSlot = -1;
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
  }
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

  // Anyone who joined mid-round as a spectator becomes a real, joinable
  // party member now that a fresh round is being set up — this is exactly
  // the moment they were waiting for.
  room.spectators.forEach((pending, sid) => { room.players[sid] = createPlayer(pending); });
  room.spectators.clear();

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
  if (p.reloadingUntil && Date.now() < p.reloadingUntil) return; // hands are busy
  const item = p.inventory[p.equipped];
  if (!item) return;
  const stats = WEAPON_STATS[item.type];
  if (!stats) return; // equipped slot isn't a weapon (shouldn't happen — equip already guards this)

  const now = Date.now();
  const last = p.lastShotAt[item.type] || 0;
  if (now - last < stats.fireRateMs) return;
  if (item.mag <= 0) return; // dry — needs a reload, server won't do it automatically

  p.lastShotAt[item.type] = now;
  item.mag -= 1;

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

// Starts a reload if the currently-equipped weapon is eligible (not already
// full, has spare reserve ammo to pull from, not already reloading). The
// actual mag refill happens later, in completeReload — the delay in
// between is the whole point.
function startReload(p) {
  if (!p.alive) return;
  const item = p.inventory[p.equipped];
  if (!item) return;
  const stats = WEAPON_STATS[item.type];
  if (!stats) return; // not a weapon
  if (p.reloadingUntil && Date.now() < p.reloadingUntil) return; // already reloading
  if (item.mag >= stats.magSize) return; // already full
  if (item.reserve <= 0) return; // nothing to reload with

  p.reloadingUntil = Date.now() + stats.reloadMs;
  p.reloadingSlot = p.equipped;
}

// Called every tick for every alive player — finishes any reload whose
// timer has elapsed, actually moving ammo from reserve into the magazine.
function completeReload(p) {
  if (!p.reloadingUntil || Date.now() < p.reloadingUntil) return;
  const item = p.inventory[p.reloadingSlot];
  const stats = item && WEAPON_STATS[item.type];
  if (item && stats) {
    const needed = stats.magSize - item.mag;
    const transfer = Math.min(needed, item.reserve);
    item.mag += transfer;
    item.reserve -= transfer;
  }
  p.reloadingUntil = 0;
  p.reloadingSlot = -1;
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
      const room = { code, players: {}, spectators: new Map(), clients: new Set(), phase: 'lobby', roundStartsAt: 0, roundEndsAt: 0, chestState: [], bullets: [] };
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

      if (room.phase !== 'lobby') {
        // A round is already underway — spectate instead of dropping
        // straight into combat with no ammo/context. They'll automatically
        // become a real player once this round ends and the lobby reopens
        // (see returnToLobby), same as anyone who leaves mid-round and
        // rejoins — from the server's point of view that's identical to a
        // brand new connection joining mid-round.
        room.spectators.set(id, ws.pending);
        room.clients.add(ws);
        ws.roomCode = code;
        ws.send(JSON.stringify({ type: 'roomJoined', code, started: true, spectating: true }));
        console.log(`[room] ${id} joined ${code} as a spectator`);
        return;
      }

      if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) { ws.send(JSON.stringify({ type: 'roomError', message: 'That room is full (4/4).' })); return; }

      room.players[id] = createPlayer(ws.pending);
      room.clients.add(ws);
      ws.roomCode = code;
      ws.send(JSON.stringify({ type: 'roomJoined', code, started: false, spectating: false }));
      broadcastLobby(room);
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
        if (p.reloadingUntil && p.reloadingSlot !== msg.index) {
          // Switching weapons mid-reload cancels it — standard shooter
          // convention, and simpler/fairer than letting it finish in the
          // background for a weapon you're not even holding anymore.
          p.reloadingUntil = 0;
          p.reloadingSlot = -1;
        }
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
        if (p.reloadingSlot === msg.slot) { p.reloadingUntil = 0; p.reloadingSlot = -1; }
        p.inventory[msg.slot] = null;
        if (p.equipped === msg.slot) p.equipped = 0;
      }
      return;
    }

    if (msg.type === 'reload') {
      const room = ws.roomCode && rooms.get(ws.roomCode);
      const p = room && room.players[id];
      if (!room || !p || room.phase !== 'playing') return;
      startReload(p);
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
      if (!state || !state.opened) return; // must have been opened (by anyone) first — no taking from an unopened chest sight-unseen
      const item = state.items[slot];
      if (!item || item.taken) return;

      // No distance re-check here on purpose: opening the chest already
      // proved proximity, and re-validating it on every individual take
      // meant a single step while browsing the loot list silently failed
      // the request with no feedback at all — that's what looked like
      // "items can't be picked up." Once it's open, anyone can take from
      // it (loot is shared, not claimed) — matches how the chest UI
      // already works (it stays live-updating for everyone regardless).
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
      room.spectators.delete(id);
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
    completeReload(p);
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
