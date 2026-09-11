(function () {
  'use strict';

  var LEVELS = window.DEER_LEVELS;
  var TIERS = window.DEER_TIERS;

  var STORAGE_KEY = 'deer-escape-progress-v2';
  var LIVES_PER_LEVEL = 3;
  var STEP_MS = 330;
  var WARP_MS = 260;
  var CRASH_PAUSE_MS = 620;
  var TWO_STAR_SLACK = 1;
  var MAX_CELL = 64;
  var MIN_CELL = 26;
  var BOARD_PADDING = 12;
  var MAX_EFFECT_HOPS = 14;
  var LOW_STEPS_WARNING = 3;

  var LAYOUT_QUERIES = ['(min-width: 900px)', '(orientation: landscape) and (max-height: 600px)', '(min-width: 560px)'];

  var TILE = {
    VOID: '#', PATH: '.', START: 'S', GOAL: 'G',
    ROCK: 'R', THORN: 'T', KEY: 'K', BRIDGE: 'B', PORTAL: 'P'
  };
  var SOLID_TILES = [TILE.VOID, TILE.ROCK, TILE.THORN];

  var WIND = {
    '^': { dx: 0, dy: -1, facing: 'up' },
    'v': { dx: 0, dy: 1, facing: 'down' },
    '<': { dx: -1, dy: 0, facing: 'left' },
    '>': { dx: 1, dy: 0, facing: 'right' }
  };

  var DIRECTIONS = {
    U: { dx: 0, dy: -1, glyph: '↑' },
    D: { dx: 0, dy: 1, glyph: '↓' },
    L: { dx: -1, dy: 0, glyph: '←' },
    R: { dx: 1, dy: 0, glyph: '→' },
    W: { dx: 0, dy: 0, glyph: '⏱' }
  };

  var KEY_TO_COMMAND = {
    ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R',
    w: 'U', s: 'D', a: 'L', d: 'R', W: 'U', S: 'D', A: 'L', D: 'R'
  };

  var els = {};
  var state = {
    screen: 'home',
    levelIndex: 0,
    level: null,
    lives: LIVES_PER_LEVEL,
    program: [],
    running: false,
    world: null,
    progress: { unlocked: 1, stars: {} },
    soundOn: true
  };

  function loadProgress() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { unlocked: 1, stars: {} };
      var parsed = JSON.parse(raw);
      return {
        unlocked: Math.min(Math.max(parsed.unlocked || 1, 1), LEVELS.length),
        stars: parsed.stars || {}
      };
    } catch (err) {
      return { unlocked: 1, stars: {} };
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
    } catch (err) {
      return;
    }
  }

  function totalStars() {
    return Object.keys(state.progress.stars).reduce(function (sum, id) {
      return sum + state.progress.stars[id];
    }, 0);
  }

  function clearedCount() {
    return Object.keys(state.progress.stars).length;
  }

  function perfectCount() {
    return Object.keys(state.progress.stars).filter(function (id) {
      return state.progress.stars[id] === 3;
    }).length;
  }

  function parseLevel(raw) {
    var rows = raw.grid.length;
    var cols = raw.grid[0].length;
    var start = null;
    var goal = null;
    var keys = [];
    var bridges = [];
    var portals = [];
    var winds = [];

    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var tile = raw.grid[y][x];
        if (tile === TILE.START) start = { x: x, y: y };
        if (tile === TILE.GOAL) goal = { x: x, y: y };
        if (tile === TILE.KEY) keys.push({ x: x, y: y });
        if (tile === TILE.BRIDGE) bridges.push({ x: x, y: y });
        if (tile === TILE.PORTAL) portals.push({ x: x, y: y });
        if (WIND[tile]) winds.push({ x: x, y: y, facing: WIND[tile].facing });
      }
    }

    return {
      raw: raw,
      rows: rows,
      cols: cols,
      start: start,
      goal: goal,
      keys: keys,
      bridges: bridges,
      portals: portals,
      winds: winds,
      hasGuards: raw.guards.length > 0
    };
  }

  function tileAt(x, y) {
    var level = state.level;
    if (x < 0 || y < 0 || x >= level.cols || y >= level.rows) return TILE.VOID;
    return level.raw.grid[y][x];
  }

  function hasSpot(list, x, y) {
    return list.some(function (spot) { return spot.x === x && spot.y === y; });
  }

  function guardPositionAt(guard, tick) {
    var length = guard.route.length;
    if (length === 1) return guard.route[0];
    if (guard.mode === 'loop') return guard.route[(tick + guard.offset) % length];
    var period = 2 * (length - 1);
    var index = (tick + guard.offset) % period;
    if (index >= length) index = period - index;
    return guard.route[index];
  }

  function newWorld() {
    return { x: state.level.start.x, y: state.level.start.y, keys: [], broken: [] };
  }

  function worldBlocked(world, x, y) {
    var tile = tileAt(x, y);
    if (SOLID_TILES.indexOf(tile) !== -1) return true;
    return tile === TILE.BRIDGE && hasSpot(world.broken, x, y);
  }

  function portalPartner(x, y) {
    var portals = state.level.portals;
    var first = portals[0];
    return (first.x === x && first.y === y) ? portals[1] : first;
  }

  function breakBridge(world, x, y) {
    if (tileAt(x, y) === TILE.BRIDGE && !hasSpot(world.broken, x, y)) {
      world.broken.push({ x: x, y: y });
    }
  }

  function takeKey(world, x, y) {
    if (tileAt(x, y) !== TILE.KEY || hasSpot(world.keys, x, y)) return false;
    world.keys.push({ x: x, y: y });
    return true;
  }

  function allKeysTaken(world) {
    return world.keys.length === state.level.keys.length;
  }

  function resolveEntry(world, fromX, fromY, toX, toY) {
    breakBridge(world, fromX, fromY);

    world.x = toX;
    world.y = toY;

    var tookKey = takeKey(world, world.x, world.y);
    var warped = false;
    var pushed = false;
    var justTeleported = false;

    for (var hop = 0; hop < MAX_EFFECT_HOPS; hop++) {
      var tile = tileAt(world.x, world.y);

      if (tile === TILE.PORTAL && !justTeleported) {
        var pair = portalPartner(world.x, world.y);
        if (worldBlocked(world, pair.x, pair.y)) break;
        world.x = pair.x;
        world.y = pair.y;
        justTeleported = true;
        warped = true;
        if (takeKey(world, world.x, world.y)) tookKey = true;
        continue;
      }

      var wind = WIND[tile];
      if (wind) {
        if (worldBlocked(world, world.x + wind.dx, world.y + wind.dy)) break;
        breakBridge(world, world.x, world.y);
        world.x += wind.dx;
        world.y += wind.dy;
        justTeleported = false;
        pushed = true;
        if (takeKey(world, world.x, world.y)) tookKey = true;
        continue;
      }

      break;
    }

    return { tookKey: tookKey, warped: warped, pushed: pushed };
  }

  function crashMessage(x, y) {
    var tile = tileAt(x, y);
    if (tile === TILE.ROCK) return 'ชนก้อนหิน!';
    if (tile === TILE.THORN) return 'เหยียบกอหนาม!';
    if (tile === TILE.BRIDGE) return 'สะพานเถาวัลย์เส้นนี้ขาดไปแล้ว!';
    return 'เดินออกนอกเส้นทาง!';
  }

  function stepWorld(world, command, tick) {
    var direction = DIRECTIONS[command];
    var previousX = world.x;
    var previousY = world.y;
    var effects = { tookKey: false, warped: false, pushed: false };

    if (command !== 'W') {
      var nextX = previousX + direction.dx;
      var nextY = previousY + direction.dy;
      if (worldBlocked(world, nextX, nextY)) {
        return { type: 'crash', message: crashMessage(nextX, nextY), atX: nextX, atY: nextY };
      }
      effects = resolveEntry(world, previousX, previousY, nextX, nextY);
    }

    var caught = state.level.raw.guards.some(function (guard) {
      var now = guardPositionAt(guard, tick);
      var before = guardPositionAt(guard, tick - 1);
      var landedOnDeer = now[0] === world.x && now[1] === world.y;
      var swapped = before[0] === world.x && before[1] === world.y &&
        now[0] === previousX && now[1] === previousY;
      return landedOnDeer || swapped;
    });

    if (caught) {
      return { type: 'caught', message: 'ยักษ์จับกวางน้อยได้!', atX: world.x, atY: world.y };
    }

    if (tileAt(world.x, world.y) === TILE.GOAL && allKeysTaken(world)) {
      return { type: 'win', tookKey: effects.tookKey, warped: effects.warped };
    }

    return { type: 'ok', tookKey: effects.tookKey, warped: effects.warped, pushed: effects.pushed };
  }

  var audioContext = null;

  function ensureAudio() {
    if (audioContext || !state.soundOn) return;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (Ctor) audioContext = new Ctor();
  }

  function tone(frequency, duration, type, volume, delay) {
    if (!state.soundOn || !audioContext) return;
    var oscillator = audioContext.createOscillator();
    var gain = audioContext.createGain();
    var startAt = audioContext.currentTime + (delay || 0);
    oscillator.type = type || 'square';
    oscillator.frequency.setValueAtTime(frequency, startAt);
    gain.gain.setValueAtTime(volume || 0.05, startAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.02);
  }

  var SOUNDS = {
    tap: function () { tone(520, 0.07, 'square', 0.04); },
    step: function () { tone(360, 0.09, 'triangle', 0.05); },
    gust: function () { tone(620, 0.16, 'sine', 0.05); tone(880, 0.12, 'sine', 0.04, 0.06); },
    warp: function () { tone(300, 0.1, 'sine', 0.06); tone(900, 0.18, 'sine', 0.05, 0.07); },
    key: function () { tone(880, 0.1, 'sine', 0.07); tone(1180, 0.14, 'sine', 0.06, 0.08); },
    crash: function () { tone(150, 0.3, 'sawtooth', 0.07); },
    win: function () {
      [523, 659, 784, 1046].forEach(function (frequency, index) {
        tone(frequency, 0.2, 'triangle', 0.07, index * 0.11);
      });
    },
    over: function () {
      [400, 330, 262].forEach(function (frequency, index) {
        tone(frequency, 0.26, 'sawtooth', 0.06, index * 0.16);
      });
    }
  };

  function showScreen(name) {
    state.screen = name;
    var map = { home: els.screenHome, levels: els.screenLevels, game: els.screenGame, finish: els.screenFinish };
    Object.keys(map).forEach(function (key) {
      map[key].classList.toggle('is-active', key === name);
    });
    els.stage.classList.toggle('stage--wide', name === 'game');
    if (name === 'home') renderHome();
    if (name === 'levels') renderLevelGrid();
    window.scrollTo(0, 0);
  }

  function renderHome() {
    els.statCleared.textContent = clearedCount();
    els.statStars.textContent = totalStars();
    els.statTotal.textContent = LEVELS.length;
  }

  function renderLevelGrid() {
    els.levelGrid.innerHTML = '';

    LEVELS.forEach(function (level, index) {
      var unlocked = index + 1 <= state.progress.unlocked;
      var stars = state.progress.stars[level.id] || 0;

      var card = document.createElement('button');
      card.className = 'lvcard' + (stars > 0 ? ' lvcard--done' : '');
      card.disabled = !unlocked;
      card.setAttribute('aria-label', 'ด่าน ' + level.id + ' ' + level.name);

      var number = document.createElement('span');
      number.className = 'lvcard__no';
      number.textContent = level.id;

      var tier = document.createElement('span');
      tier.className = 'lvcard__tier';
      tier.textContent = TIERS[level.tier].label;

      var starRow = document.createElement('span');
      starRow.className = 'lvcard__stars';
      for (var i = 0; i < 3; i++) {
        starRow.appendChild(makeIcon('i-star', i < stars ? 'is-on' : ''));
      }

      card.appendChild(number);
      card.appendChild(tier);
      card.appendChild(starRow);

      if (!unlocked) {
        var lock = document.createElement('span');
        lock.className = 'lvcard__lock';
        lock.dataset.no = 'ด่าน ' + level.id;
        lock.appendChild(makeIcon('i-lock', ''));
        card.appendChild(lock);
      }

      card.addEventListener('click', function () {
        SOUNDS.tap();
        openLevelIntro(index);
      });

      els.levelGrid.appendChild(card);
    });
  }

  function makeIcon(id, className) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    if (className) svg.setAttribute('class', className);
    return svg;
  }

  function openLevelIntro(index) {
    var level = LEVELS[index];
    openModal({
      artIcon: 'i-deer',
      title: 'ด่าน ' + level.id + ' · ' + level.name,
      bodyHtml: '<p>' + level.story + '</p>' +
        '<p class="modal__goal">ทางที่สั้นที่สุด <b>' + level.par + '</b> ก้าว · เดินได้สูงสุด <b>' + level.maxSteps + '</b> ก้าว</p>',
      actions: [
        { label: 'เริ่มด่านนี้', kind: 'primary', onClick: function () { closeModal(); startLevel(index); } },
        { label: 'ยกเลิก', kind: 'soft', onClick: closeModal }
      ]
    });
  }

  function startLevel(index) {
    state.levelIndex = index;
    state.level = parseLevel(LEVELS[index]);
    state.lives = LIVES_PER_LEVEL;
    state.program = [];
    state.running = false;
    state.world = newWorld();

    showScreen('game');
    renderLevelChrome();
    buildBoard();
    fitBoard();
    renderQueue();
    setControlsLocked(false);
    setStatus('วางแผนเส้นทางแล้วกดเล่น', '');
  }

  function renderLevelChrome() {
    var raw = state.level.raw;
    els.gameTitle.textContent = 'ด่าน ' + raw.id + ' · ' + raw.name;
    els.gameTier.textContent = TIERS[raw.tier].label;
    els.gameTier.className = 'chip chip--' + raw.tier;
    els.parSteps.textContent = raw.par;
    els.btnWait.hidden = !state.level.hasGuards;
    renderLives();
  }

  function renderLives() {
    els.lives.innerHTML = '';
    for (var i = 0; i < LIVES_PER_LEVEL; i++) {
      els.lives.appendChild(makeIcon('i-heart', i < state.lives ? '' : 'is-lost'));
    }
  }

  function buildBoard() {
    var level = state.level;
    els.board.style.setProperty('--cols', level.cols);
    els.board.style.setProperty('--rows', level.rows);
    els.boardCells.innerHTML = '';

    for (var y = 0; y < level.rows; y++) {
      for (var x = 0; x < level.cols; x++) {
        els.boardCells.appendChild(buildCell(x, y));
      }
    }

    buildActors();
    refreshTiles();
  }

  function buildCell(x, y) {
    var tile = tileAt(x, y);
    var cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.x = x;
    cell.dataset.y = y;

    if (tile === TILE.VOID) {
      cell.classList.add('cell--void');
      return cell;
    }

    cell.classList.add('cell--walk');

    if (tile === TILE.START) {
      cell.classList.add('cell--start');
      cell.appendChild(makeIcon('i-cage', ''));
    } else if (tile === TILE.GOAL) {
      cell.classList.add('cell--goal');
      cell.appendChild(makeIcon('i-gate', ''));
    } else if (tile === TILE.ROCK) {
      cell.appendChild(makeIcon('i-rock', ''));
    } else if (tile === TILE.THORN) {
      cell.appendChild(makeIcon('i-thorn', ''));
    } else if (tile === TILE.KEY) {
      cell.classList.add('cell--key');
      cell.appendChild(makeIcon('i-key', ''));
    } else if (tile === TILE.BRIDGE) {
      cell.classList.add('cell--bridge');
      cell.appendChild(makeIcon('i-bridge', ''));
    } else if (tile === TILE.PORTAL) {
      cell.classList.add('cell--portal');
      cell.appendChild(makeIcon('i-portal', ''));
    } else if (WIND[tile]) {
      cell.classList.add('cell--wind', 'cell--wind-' + WIND[tile].facing);
      cell.appendChild(makeIcon('i-wind', ''));
    }

    return cell;
  }

  function buildActors() {
    els.boardActors.innerHTML = '';

    state.level.raw.guards.forEach(function (guard, index) {
      guard.route.forEach(function (spot) {
        var marker = document.createElement('div');
        marker.className = 'patrol';
        marker.style.setProperty('--x', spot[0]);
        marker.style.setProperty('--y', spot[1]);
        els.boardActors.appendChild(marker);
      });

      var node = document.createElement('div');
      node.className = 'actor actor--guard';
      node.dataset.guard = index;
      node.appendChild(makeIcon('i-guard', ''));
      els.boardActors.appendChild(node);
    });

    var deer = document.createElement('div');
    deer.className = 'actor actor--deer';
    deer.id = 'deerActor';
    deer.appendChild(makeIcon('i-deer', ''));
    els.boardActors.appendChild(deer);

    positionActors(0, false);
  }

  function placeActor(node, x, y, animate) {
    if (!animate) node.style.transition = 'none';
    node.style.setProperty('--x', x);
    node.style.setProperty('--y', y);
    if (!animate) {
      void node.offsetWidth;
      node.style.transition = '';
    }
  }

  function positionActors(tick, animate) {
    var deer = document.getElementById('deerActor');
    if (!deer) return;

    placeActor(deer, state.world.x, state.world.y, animate);

    state.level.raw.guards.forEach(function (guard, index) {
      var node = els.boardActors.querySelector('[data-guard="' + index + '"]');
      if (!node) return;
      var spot = guardPositionAt(guard, tick);
      placeActor(node, spot[0], spot[1], animate);
    });
  }

  var fitQueued = false;

  function scheduleFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(function () {
      fitQueued = false;
      fitBoard();
    });
  }

  function fitBoard() {
    if (!state.level) return;
    var level = state.level;
    var availableWidth = els.boardwrap.clientWidth || els.board.parentElement.clientWidth;
    var isDesktopLayout = window.matchMedia('(min-width: 900px)').matches;
    var isShortLandscape = window.matchMedia('(orientation: landscape) and (max-height: 600px)').matches;
    var heightShare = isShortLandscape ? 0.56 : (isDesktopLayout ? 0.66 : 0.44);
    var heightBudget = window.innerHeight * heightShare;

    var byWidth = (availableWidth - BOARD_PADDING) / level.cols;
    var byHeight = (heightBudget - BOARD_PADDING) / level.rows;
    var cell = Math.floor(Math.min(byWidth, byHeight, MAX_CELL));

    els.board.style.setProperty('--cell', Math.max(MIN_CELL, cell) + 'px');
  }

  function renderKeyCount() {
    var total = state.level.keys.length;
    els.keyCount.hidden = total === 0;
    if (total === 0) return;
    els.keyCount.innerHTML = '';
    els.keyCount.appendChild(makeIcon('i-key', ''));
    els.keyCount.appendChild(document.createTextNode(state.world.keys.length + '/' + total));
  }

  function refreshTiles() {
    var level = state.level;

    level.keys.forEach(function (spot) {
      var cell = cellAt(spot.x, spot.y);
      if (cell) cell.classList.toggle('is-taken', hasSpot(state.world.keys, spot.x, spot.y));
    });

    level.bridges.forEach(function (spot) {
      var cell = cellAt(spot.x, spot.y);
      if (cell) cell.classList.toggle('is-broken', hasSpot(state.world.broken, spot.x, spot.y));
    });

    var goalCell = els.boardCells.querySelector('.cell--goal');
    if (goalCell) {
      goalCell.classList.toggle('is-open', allKeysTaken(state.world));
      goalCell.classList.toggle('is-locked', !allKeysTaken(state.world));
    }

    renderKeyCount();
  }

  function cellAt(x, y) {
    return els.boardCells.querySelector('[data-x="' + x + '"][data-y="' + y + '"]');
  }

  function stepsLeft() {
    return state.level.raw.maxSteps - state.program.length;
  }

  function renderQueue() {
    els.queue.innerHTML = '';

    var left = stepsLeft();
    els.stepsLeft.textContent = left;
    els.stepsLeftPill.classList.toggle('is-low', left <= LOW_STEPS_WARNING);
    els.stepsLeftPill.classList.toggle('is-empty', left === 0);

    if (state.program.length === 0) {
      var empty = document.createElement('span');
      empty.className = 'queue__empty';
      empty.textContent = 'กดปุ่มลูกศรเพื่อเพิ่มคำสั่ง';
      els.queue.appendChild(empty);
      return;
    }

    groupProgram(state.program).forEach(function (group) {
      var chip = document.createElement('span');
      chip.className = 'qchip' + (group.command === 'W' ? ' qchip--wait' : '');
      chip.dataset.from = group.from;
      chip.dataset.to = group.to;
      chip.textContent = DIRECTIONS[group.command].glyph;
      if (group.count > 1) {
        var multiplier = document.createElement('small');
        multiplier.textContent = '×' + group.count;
        chip.appendChild(multiplier);
      }
      els.queue.appendChild(chip);
    });
  }

  function groupProgram(program) {
    var groups = [];
    program.forEach(function (command, index) {
      var last = groups[groups.length - 1];
      if (last && last.command === command) {
        last.count += 1;
        last.to = index;
        return;
      }
      groups.push({ command: command, count: 1, from: index, to: index });
    });
    return groups;
  }

  function highlightChip(stepIndex) {
    Array.prototype.forEach.call(els.queue.children, function (chip) {
      var from = Number(chip.dataset.from);
      var to = Number(chip.dataset.to);
      chip.classList.toggle('is-running', stepIndex >= from && stepIndex <= to);
      chip.classList.toggle('is-done', stepIndex > to);
    });
  }

  function pushCommand(command) {
    if (state.running) return;
    if (command === 'W' && !state.level.hasGuards) return;

    if (stepsLeft() <= 0) {
      showToast('เดินได้แค่ ' + state.level.raw.maxSteps + ' ก้าว ลองหาทางที่สั้นกว่านี้');
      return;
    }

    state.program.push(command);
    SOUNDS.tap();
    renderQueue();
    setStatus('วางแผนแล้ว ' + state.program.length + ' ก้าว', '');
  }

  function undoCommand() {
    if (state.running || state.program.length === 0) return;
    state.program.pop();
    SOUNDS.tap();
    renderQueue();
  }

  function clearProgram() {
    if (state.running || state.program.length === 0) return;
    state.program = [];
    SOUNDS.tap();
    renderQueue();
    setStatus('ล้างคำสั่งแล้ว เริ่มวางแผนใหม่', '');
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function setControlsLocked(locked) {
    els.dpad.querySelectorAll('.dbtn').forEach(function (button) { button.disabled = locked; });
    els.btnUndo.disabled = locked;
    els.btnClear.disabled = locked;
    els.btnRun.disabled = locked;
    els.btnRun.classList.toggle('is-running', locked);
  }

  function runProgram() {
    if (state.running) return;
    if (state.program.length === 0) {
      showToast('ยังไม่มีคำสั่ง ลองกดลูกศรก่อน');
      return;
    }

    ensureAudio();
    state.running = true;
    setControlsLocked(true);
    setStatus('กวางน้อยกำลังเดิน...', '');
    executeFrom(0);
  }

  function executeFrom(index) {
    if (index >= state.program.length) {
      finishRunWithoutGoal();
      return;
    }

    highlightChip(index);

    var outcome = stepWorld(state.world, state.program[index], index + 1);
    var deer = document.getElementById('deerActor');

    if (outcome.type === 'crash') {
      SOUNDS.crash();
      shakeBoard(deer);
      delay(CRASH_PAUSE_MS).then(function () { loseLife(outcome.message); });
      return;
    }

    positionActors(index + 1, !outcome.warped);
    refreshTiles();

    if (outcome.warped) {
      deer.classList.add('is-warping');
      setTimeout(function () { deer.classList.remove('is-warping'); }, WARP_MS);
    }

    if (outcome.type === 'caught') {
      SOUNDS.crash();
      shakeBoard(deer);
      delay(CRASH_PAUSE_MS).then(function () { loseLife(outcome.message); });
      return;
    }

    if (outcome.tookKey) SOUNDS.key();
    else if (outcome.warped) SOUNDS.warp();
    else if (outcome.pushed) SOUNDS.gust();
    else SOUNDS.step();

    if (outcome.type === 'win') {
      SOUNDS.win();
      deer.classList.add('is-win');
      delay(560).then(completeLevel);
      return;
    }

    delay(STEP_MS).then(function () { executeFrom(index + 1); });
  }

  function shakeBoard(deer) {
    els.board.classList.add('is-shaking');
    if (deer) deer.classList.add('is-hit');
    setTimeout(function () { els.board.classList.remove('is-shaking'); }, 420);
  }

  function finishRunWithoutGoal() {
    var atLockedGate = tileAt(state.world.x, state.world.y) === TILE.GOAL && !allKeysTaken(state.world);
    var message = atLockedGate ? 'ประตูยังล็อกอยู่ ต้องเก็บกุญแจให้ครบ' : 'ก้าวหมดแต่ยังไม่ถึงประตู';
    loseLife(message);
  }

  function loseLife(message) {
    state.lives -= 1;

    var hearts = els.lives.querySelectorAll('svg');
    var lostHeart = hearts[state.lives];
    if (lostHeart) {
      lostHeart.classList.add('is-lost', 'is-losing');
      setTimeout(function () { lostHeart.classList.remove('is-losing'); }, 460);
    }

    state.running = false;
    resetAttempt();

    if (state.lives <= 0) {
      SOUNDS.over();
      setStatus(message, 'bad');
      setTimeout(showGameOver, 420);
      return;
    }

    setControlsLocked(false);
    setStatus(message + ' เหลืออีก ' + state.lives + ' ชีวิต', 'bad');
    showToast(message);
  }

  function resetAttempt() {
    state.program = [];
    state.world = newWorld();
    positionActors(0, false);
    refreshTiles();
    renderQueue();
    var deer = document.getElementById('deerActor');
    if (deer) deer.classList.remove('is-hit', 'is-win', 'is-warping');
  }

  function starsForRun(stepsUsed) {
    var par = state.level.raw.par;
    if (stepsUsed <= par) return 3;
    if (stepsUsed <= par + TWO_STAR_SLACK) return 2;
    return 1;
  }

  function completeLevel() {
    var raw = state.level.raw;
    var used = state.program.length;
    var stars = starsForRun(used);
    var previous = state.progress.stars[raw.id] || 0;

    state.progress.stars[raw.id] = Math.max(previous, stars);
    state.progress.unlocked = Math.max(state.progress.unlocked, Math.min(raw.id + 1, LEVELS.length));
    saveProgress();

    state.running = false;
    setControlsLocked(false);
    setStatus('ผ่านด่านแล้ว!', 'good');
    launchConfetti();

    var isLastLevel = state.levelIndex === LEVELS.length - 1;
    var body = '<p>ใช้ไป <b>' + used + '</b> ก้าว จากทางที่สั้นที่สุด <b>' + raw.par + '</b> ก้าว</p>';
    body += stars === 3
      ? '<p class="modal__praise">เพอร์เฟกต์! เจอเส้นทางที่สั้นที่สุดแล้ว</p>'
      : '<p>ลดให้เหลือ ' + raw.par + ' ก้าวเพื่อเก็บ 3 ดาว</p>';

    var actions = [];
    if (isLastLevel) {
      actions.push({ label: 'ดูใบประกาศ', kind: 'primary', onClick: function () { closeModal(); showFinish(); } });
    } else {
      actions.push({ label: 'ด่านถัดไป', kind: 'primary', onClick: function () { closeModal(); startLevel(state.levelIndex + 1); } });
    }
    actions.push({ label: 'เล่นด่านนี้ซ้ำ', kind: 'soft', onClick: function () { closeModal(); startLevel(state.levelIndex); } });
    actions.push({ label: 'เลือกด่าน', kind: 'soft', onClick: function () { closeModal(); showScreen('levels'); } });

    openModal({ title: 'ยอดเยี่ยม!', stars: stars, bodyHtml: body, actions: actions });
  }

  function showGameOver() {
    setControlsLocked(false);
    openModal({
      artText: '💔',
      title: 'หมดชีวิตแล้ว',
      bodyHtml: '<p>กวางน้อยยังออกจากด่านนี้ไม่ได้ ลองวางแผนเส้นทางใหม่อีกครั้ง</p>' +
        '<p class="modal__goal">คำใบ้: ' + state.level.raw.hint + '</p>',
      actions: [
        { label: 'ลองใหม่อีกครั้ง', kind: 'primary', onClick: function () { closeModal(); startLevel(state.levelIndex); } },
        { label: 'เลือกด่านอื่น', kind: 'soft', onClick: function () { closeModal(); showScreen('levels'); } }
      ]
    });
  }

  function showFinish() {
    els.finishStars.textContent = totalStars();
    els.finishPerfect.textContent = perfectCount();
    els.finishTotal.textContent = LEVELS.length;
    showScreen('finish');
    launchConfetti();
  }

  function setStatus(message, tone) {
    els.statusMsg.textContent = message;
    els.statusbar.classList.toggle('is-bad', tone === 'bad');
    els.statusbar.classList.toggle('is-good', tone === 'good');
  }

  var toastTimer = null;

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('is-show'); }, 2000);
  }

  function launchConfetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var colors = ['#2961E2', '#E8A62C', '#2E9E5B', '#E5484D', '#C2D840'];
    for (var i = 0; i < 34; i++) {
      var piece = document.createElement('div');
      piece.className = 'confetti';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
      piece.style.animationDelay = (Math.random() * 0.5) + 's';
      document.body.appendChild(piece);
      scheduleRemoval(piece);
    }
  }

  function scheduleRemoval(node) {
    setTimeout(function () { node.remove(); }, 3600);
  }

  function openModal(config) {
    els.modalArt.innerHTML = '';
    if (config.artIcon) els.modalArt.appendChild(makeIcon(config.artIcon, ''));
    if (config.artText) els.modalArt.textContent = config.artText;

    els.modalTitle.textContent = config.title;
    els.modalBody.innerHTML = config.bodyHtml || '';

    if (typeof config.stars === 'number') {
      var row = document.createElement('div');
      row.className = 'starrow';
      for (var i = 0; i < 3; i++) {
        row.appendChild(makeIcon('i-star', i < config.stars ? 'is-on' : ''));
      }
      els.modalBody.insertBefore(row, els.modalBody.firstChild);
    }

    els.modalActions.innerHTML = '';
    (config.actions || []).forEach(function (action) {
      var button = document.createElement('button');
      button.className = 'btn btn--block btn--' + (action.kind || 'soft');
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      els.modalActions.appendChild(button);
    });

    els.modal.hidden = false;
    var firstButton = els.modalActions.querySelector('button');
    if (firstButton) firstButton.focus();
  }

  function closeModal() {
    els.modal.hidden = true;
  }

  function iconMarkup(id) {
    return '<svg><use href="#' + id + '"></use></svg>';
  }

  function showHowTo() {
    var legend = '<div class="legend">' +
      '<div>' + iconMarkup('i-deer') + '<span><b>กวางน้อย</b> ตัวละครที่เราสั่งให้เดิน</span></div>' +
      '<div>' + iconMarkup('i-gate') + '<span><b>ประตูป่า</b> จุดหมายของแต่ละด่าน</span></div>' +
      '<div>' + iconMarkup('i-key') + '<span><b>กุญแจ</b> เก็บให้ครบก่อนประตูจึงเปิด</span></div>' +
      '<div>' + iconMarkup('i-rock') + '<span><b>ก้อนหิน / กอหนาม</b> ห้ามเดินชน</span></div>' +
      '<div>' + iconMarkup('i-wind') + '<span><b>ลมพัด</b> พัดต่อไปอีกช่องฟรี ไม่เสียก้าว ลมที่เรียงกันจะพัดต่อกันเป็นทอด</span></div>' +
      '<div>' + iconMarkup('i-bridge') + '<span><b>สะพานเถาวัลย์</b> ข้ามได้ครั้งเดียวแล้วขาด</span></div>' +
      '<div>' + iconMarkup('i-portal') + '<span><b>ประตูมิติ</b> เหยียบแล้ววาร์ปไปอีกบานทันที ฟรี ไม่เสียก้าว</span></div>' +
      '<div>' + iconMarkup('i-guard') + '<span><b>ยักษ์</b> เดินไปมาตามจุดสีแดง ใช้ปุ่มรอเพื่อหลบ</span></div>' +
      '</div>';

    openModal({
      title: 'วิธีเล่น',
      bodyHtml: '<ol>' +
        '<li>ทุ่งเปิดให้เดินได้อิสระทุกทาง ไปถึงประตูได้หลายเส้นทาง แต่ <b>จำนวนก้าวมีจำกัด</b></li>' +
        '<li>เลข <b>สั้นสุด</b> คือจำนวนก้าวของเส้นทางที่สั้นที่สุด ให้นับช่องในใจเอาเองว่าจะเดินทางไหน</li>' +
        '<li>กดปุ่มลูกศรเรียงคำสั่งให้ครบก่อน แล้วค่อยกดปุ่ม <b>เล่น</b></li>' +
        '<li>ชนสิ่งกีดขวาง โดนยักษ์จับ หรือก้าวหมดก่อนถึงประตู จะเสีย 1 ชีวิต จาก 3 ชีวิต</li>' +
        '<li>เดินได้เท่ากับเลข <b>สั้นสุด</b> จะได้ 3 ดาว</li>' +
        '</ol>' + legend,
      actions: [{ label: 'เข้าใจแล้ว', kind: 'primary', onClick: closeModal }]
    });
  }

  function showHint() {
    openModal({
      artText: '💡',
      title: 'คำใบ้',
      bodyHtml: '<p>' + state.level.raw.hint + '</p>' +
        '<p class="modal__goal">ทางที่สั้นที่สุดของด่านนี้คือ <b>' + state.level.raw.par + '</b> ก้าว</p>',
      actions: [{ label: 'ปิด', kind: 'primary', onClick: closeModal }]
    });
  }

  function confirmLeaveGame() {
    if (state.program.length === 0 && state.lives === LIVES_PER_LEVEL) {
      showScreen('levels');
      return;
    }
    openModal({
      artText: '🚪',
      title: 'ออกจากด่านนี้?',
      bodyHtml: '<p>ความคืบหน้าในด่านนี้จะหายไป</p>',
      actions: [
        { label: 'ออกจากด่าน', kind: 'danger', onClick: function () { closeModal(); showScreen('levels'); } },
        { label: 'เล่นต่อ', kind: 'soft', onClick: closeModal }
      ]
    });
  }

  function confirmResetProgress() {
    openModal({
      artText: '🧹',
      title: 'ล้างความคืบหน้า?',
      bodyHtml: '<p>ดาวและด่านที่ปลดล็อกทั้งหมดจะถูกลบ</p>',
      actions: [
        { label: 'ล้างเลย', kind: 'danger', onClick: function () {
          state.progress = { unlocked: 1, stars: {} };
          saveProgress();
          closeModal();
          renderHome();
          showToast('ล้างความคืบหน้าแล้ว');
        } },
        { label: 'ยกเลิก', kind: 'soft', onClick: closeModal }
      ]
    });
  }

  function cacheElements() {
    [
      'stage', 'screenHome', 'screenLevels', 'screenGame', 'screenFinish',
      'statCleared', 'statStars', 'statTotal', 'levelGrid', 'gameTitle', 'gameTier', 'lives',
      'board', 'boardCells', 'boardActors', 'statusMsg', 'keyCount',
      'queue', 'parSteps', 'stepsLeft', 'stepsLeftPill', 'dpad',
      'btnRun', 'btnUndo', 'btnClear', 'btnHint',
      'btnPlay', 'btnHowTo', 'btnLevels', 'btnResetProgress', 'btnSound', 'btnInstall',
      'modal', 'modalArt', 'modalTitle', 'modalBody', 'modalActions', 'toast',
      'finishStars', 'finishPerfect', 'finishTotal'
    ].forEach(function (id) { els[id] = document.getElementById(id); });

    els.boardwrap = document.querySelector('.boardwrap');
    els.statusbar = document.querySelector('.statusbar');
    els.btnWait = els.dpad.querySelector('.dbtn--wait');
  }

  function bindEvents() {
    els.btnPlay.addEventListener('click', function () {
      ensureAudio();
      SOUNDS.tap();
      openLevelIntro(Math.min(state.progress.unlocked, LEVELS.length) - 1);
    });

    els.btnHowTo.addEventListener('click', function () { ensureAudio(); showHowTo(); });
    els.btnLevels.addEventListener('click', function () { ensureAudio(); showScreen('levels'); });
    els.btnResetProgress.addEventListener('click', confirmResetProgress);

    document.querySelectorAll('[data-back]').forEach(function (button) {
      button.addEventListener('click', function () {
        var target = button.dataset.back;
        if (state.screen === 'game' && target === 'levels') {
          confirmLeaveGame();
          return;
        }
        showScreen(target);
      });
    });

    els.dpad.addEventListener('click', function (event) {
      var button = event.target.closest('.dbtn');
      if (button) pushCommand(button.dataset.cmd);
    });

    els.btnRun.addEventListener('click', runProgram);
    els.btnUndo.addEventListener('click', undoCommand);
    els.btnClear.addEventListener('click', clearProgram);
    els.btnHint.addEventListener('click', showHint);

    els.btnSound.addEventListener('click', function () {
      state.soundOn = !state.soundOn;
      els.btnSound.classList.toggle('is-off', !state.soundOn);
      els.btnSound.textContent = state.soundOn ? '🔊' : '🔇';
      if (state.soundOn) { ensureAudio(); SOUNDS.tap(); }
    });

    els.modal.querySelector('[data-close-modal]').addEventListener('click', function () {
      if (els.modalActions.children.length > 1) closeModal();
    });

    document.addEventListener('keydown', function (event) {
      if (!els.modal.hidden) {
        if (event.key === 'Escape') closeModal();
        return;
      }
      if (state.screen !== 'game') return;

      var command = KEY_TO_COMMAND[event.key];
      if (command) {
        event.preventDefault();
        pushCommand(command);
        return;
      }
      if (event.key === ' ' && state.level.hasGuards) {
        event.preventDefault();
        pushCommand('W');
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        runProgram();
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        undoCommand();
      }
      if (event.key === 'Escape') confirmLeaveGame();
    });

    window.addEventListener('resize', scheduleFit);
    window.addEventListener('orientationchange', function () {
      scheduleFit();
      setTimeout(fitBoard, 300);
    });

    LAYOUT_QUERIES.forEach(function (query) {
      var media = window.matchMedia(query);
      if (media.addEventListener) media.addEventListener('change', function () { setTimeout(fitBoard, 60); });
      else if (media.addListener) media.addListener(function () { setTimeout(fitBoard, 60); });
    });

    if (window.ResizeObserver) {
      new ResizeObserver(scheduleFit).observe(els.boardwrap);
    }
  }

  var deferredInstall = null;

  function runningStandalone() {
    return window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches;
  }

  function isApplePortable() {
    var ua = navigator.userAgent;
    if (/Android|CrOS|Windows/.test(ua)) return false;
    var iPadOnDesktopUa = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    return /iPad|iPhone|iPod/.test(ua) || iPadOnDesktopUa;
  }

  function showIosInstallSteps() {
    openModal({
      artText: '📲',
      title: 'ติดตั้งลงหน้าจอ',
      bodyHtml: '<ol>' +
        '<li>กดปุ่ม <b>แชร์</b> ที่แถบล่างของ Safari</li>' +
        '<li>เลื่อนหาแล้วเลือก <b>เพิ่มลงในหน้าจอโฮม</b></li>' +
        '<li>กด <b>เพิ่ม</b> แล้วเปิดเกมจากไอคอนได้เลย</li>' +
        '</ol>',
      actions: [{ label: 'เข้าใจแล้ว', kind: 'primary', onClick: closeModal }]
    });
  }

  function setupInstallPrompt() {
    if (runningStandalone()) return;

    if (isApplePortable()) {
      els.btnInstall.hidden = false;
      els.btnInstall.addEventListener('click', showIosInstallSteps);
      return;
    }

    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      deferredInstall = event;
      els.btnInstall.hidden = false;
    });

    els.btnInstall.addEventListener('click', function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () {
        deferredInstall = null;
        els.btnInstall.hidden = true;
      });
    });

    window.addEventListener('appinstalled', function () {
      deferredInstall = null;
      els.btnInstall.hidden = true;
      showToast('ติดตั้งเกมลงหน้าจอแล้ว');
    });
  }

  function init() {
    cacheElements();
    state.progress = loadProgress();
    bindEvents();
    setupInstallPrompt();
    showScreen('home');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
