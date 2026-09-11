const path = require('path');

global.window = {};
require(path.join(__dirname, '..', 'assets', 'js', 'levels.js'));

const levels = global.window.DEER_LEVELS;

const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
const WIND = { '^': [0, -1], v: [0, 1], '<': [-1, 0], '>': [1, 0] };
const SOLID = ['#', 'R', 'T'];
const MAX_CHAIN = 14;

function guardAt(guard, tick) {
  const n = guard.route.length;
  if (n === 1) return guard.route[0];
  if (guard.mode === 'loop') return guard.route[(tick + guard.offset) % n];
  const period = 2 * (n - 1);
  let i = (tick + guard.offset) % period;
  if (i >= n) i = period - i;
  return guard.route[i];
}

function parse(level) {
  const grid = level.grid;
  const rows = grid.length;
  const cols = grid[0].length;
  let start = null;
  let goal = null;
  const keys = [];
  const bridges = [];
  const portals = [];

  for (let y = 0; y < rows; y++) {
    if (grid[y].length !== cols) throw new Error(`L${level.id} row ${y}: width ${grid[y].length} != ${cols}`);
    for (let x = 0; x < cols; x++) {
      const c = grid[y][x];
      if (c === 'S') start = [x, y];
      if (c === 'G') goal = [x, y];
      if (c === 'K') keys.push([x, y]);
      if (c === 'B') bridges.push([x, y]);
      if (c === 'P') portals.push([x, y]);
    }
  }

  if (!start) throw new Error(`L${level.id}: missing S`);
  if (!goal) throw new Error(`L${level.id}: missing G`);
  if (portals.length !== 0 && portals.length !== 2) throw new Error(`L${level.id}: portals must come in pairs, found ${portals.length}`);
  if (keys.length > 5) throw new Error(`L${level.id}: too many keys for the bitmask`);
  if (bridges.length > 8) throw new Error(`L${level.id}: too many bridges for the bitmask`);

  return { grid, rows, cols, start, goal, keys, bridges, portals };
}

function makeHelpers(map) {
  const keyIndex = new Map(map.keys.map((k, i) => [k.join(','), i]));
  const bridgeIndex = new Map(map.bridges.map((b, i) => [b.join(','), i]));

  const blocked = (x, y, gone) => {
    if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) return true;
    const tile = map.grid[y][x];
    if (SOLID.includes(tile)) return true;
    const bi = bridgeIndex.get(x + ',' + y);
    return bi !== undefined && (gone & (1 << bi)) !== 0;
  };

  const portalPair = (x, y) => {
    const [a, b] = map.portals;
    return a[0] === x && a[1] === y ? b : a;
  };

  const leave = (gone, x, y) => {
    const bi = bridgeIndex.get(x + ',' + y);
    return bi === undefined ? gone : gone | (1 << bi);
  };

  const take = (held, x, y) => {
    const ki = keyIndex.get(x + ',' + y);
    return ki === undefined ? held : held | (1 << ki);
  };

  return { blocked, portalPair, leave, take };
}

function resolveEntry(map, h, fromX, fromY, toX, toY, held, gone) {
  let x = toX;
  let y = toY;
  let keys = h.take(held, x, y);
  let bridges = h.leave(gone, fromX, fromY);
  let teleported = false;

  for (let hop = 0; hop < MAX_CHAIN; hop++) {
    const tile = map.grid[y][x];

    if (tile === 'P' && !teleported) {
      const pair = h.portalPair(x, y);
      if (h.blocked(pair[0], pair[1], bridges)) break;
      x = pair[0];
      y = pair[1];
      teleported = true;
      keys = h.take(keys, x, y);
      continue;
    }

    if (WIND[tile]) {
      const [dx, dy] = WIND[tile];
      if (h.blocked(x + dx, y + dy, bridges)) break;
      bridges = h.leave(bridges, x, y);
      x += dx;
      y += dy;
      teleported = false;
      keys = h.take(keys, x, y);
      continue;
    }

    break;
  }

  return { x, y, keys, bridges };
}

function solve(level, maxDepth = 40) {
  const map = parse(level);
  const h = makeHelpers(map);
  const allKeys = (1 << map.keys.length) - 1;
  const hasGuards = level.guards.length > 0;
  const commands = hasGuards ? ['U', 'D', 'L', 'R', 'W'] : ['U', 'D', 'L', 'R'];

  const startEntry = resolveEntry(map, h, map.start[0], map.start[1], map.start[0], map.start[1], 0, 0);
  const first = { x: startEntry.x, y: startEntry.y, keys: startEntry.keys, bridges: startEntry.bridges, t: 0, path: '' };
  const seen = new Set([`${first.x},${first.y},${first.keys},${first.bridges},0`]);
  const queue = [first];

  while (queue.length) {
    const s = queue.shift();
    if (s.t >= maxDepth) continue;

    for (const cmd of commands) {
      let nx = s.x;
      let ny = s.y;
      if (cmd !== 'W') {
        nx += DIRS[cmd][0];
        ny += DIRS[cmd][1];
        if (h.blocked(nx, ny, s.bridges)) continue;
      }

      const t = s.t + 1;
      const after = cmd === 'W'
        ? { x: s.x, y: s.y, keys: s.keys, bridges: s.bridges }
        : resolveEntry(map, h, s.x, s.y, nx, ny, s.keys, s.bridges);

      let caught = false;
      for (const guard of level.guards) {
        const now = guardAt(guard, t);
        const before = guardAt(guard, s.t);
        if (now[0] === after.x && now[1] === after.y) caught = true;
        if (before[0] === after.x && before[1] === after.y && now[0] === s.x && now[1] === s.y) caught = true;
      }
      if (caught) continue;

      const path = s.path + cmd;
      if (map.grid[after.y][after.x] === 'G' && after.keys === allKeys) return { par: t, path };

      const signature = `${after.x},${after.y},${after.keys},${after.bridges},${t % 24}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      queue.push({ x: after.x, y: after.y, keys: after.keys, bridges: after.bridges, t, path });
    }
  }

  return null;
}

let failures = 0;

for (const level of levels) {
  const map = parse(level);
  const result = solve(level);
  const parMatches = result && result.par === level.par;
  const budgetOk = result && level.maxSteps >= result.par;
  const slack = result ? level.maxSteps - result.par : null;
  if (!result || !parMatches || !budgetOk) failures++;

  const features = [
    map.keys.length ? `key:${map.keys.length}` : '',
    map.bridges.length ? `bridge:${map.bridges.length}` : '',
    map.portals.length ? 'portal' : '',
    level.guards.length ? `guard:${level.guards.length}` : '',
    level.grid.join('').match(/[<>^v]/) ? 'wind' : ''
  ].filter(Boolean).join(' ');

  console.log(
    `L${String(level.id).padStart(2)} ${level.tier.padEnd(6)} ${map.cols}x${map.rows} ` +
    `${features.padEnd(30)} ` +
    (result
      ? `par=${String(result.par).padStart(2)} (ไฟล์=${level.par}) เดินได้=${level.maxSteps} เหลือ=${slack}  ${result.path}` +
        (parMatches ? '' : '  <-- par ไม่ตรง')
        + (budgetOk ? '' : '  <-- maxSteps น้อยกว่า par')
      : 'UNSOLVABLE  <-- เล่นไม่จบ')
  );
}

console.log(failures === 0 ? '\nOK: ทุกด่านผ่าน' : `\nFAIL: มีปัญหา ${failures} ด่าน`);
process.exit(failures === 0 ? 0 : 1);
