/* Core Tetris engine. Pure logic, no DOM. Exposed as window.Tetris. */
(function (global) {
  'use strict';

  const COLS = 10;
  const ROWS = 20;

  const SHAPES = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
    O: [[1, 1], [1, 1]],
    S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]]
  };

  const TYPES = Object.keys(SHAPES);

  const COLORS = {
    I: '#45d0e8', J: '#4f7ff0', L: '#f0963f',
    O: '#f2d33c', S: '#4fd06a', T: '#b25ae8', Z: '#ef4f6b'
  };

  function rotateCW(m) {
    const n = m.length;
    const out = m.map(() => new Array(n).fill(0));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) out[x][n - 1 - y] = m[y][x];
    }
    return out;
  }

  /* Precompute the four rotation states of every piece as relative cell lists. */
  const ROTATIONS = {};
  for (const type of TYPES) {
    let m = SHAPES[type];
    ROTATIONS[type] = [];
    for (let r = 0; r < 4; r++) {
      const cells = [];
      for (let y = 0; y < m.length; y++) {
        for (let x = 0; x < m.length; x++) if (m[y][x]) cells.push({ x, y });
      }
      ROTATIONS[type].push(cells);
      m = rotateCW(m);
    }
  }

  /* S/Z/I have 2 distinct orientations, O has 1 -- used to keep AI search small. */
  const DISTINCT_ROTATIONS = { I: 2, J: 4, L: 4, O: 1, S: 2, T: 4, Z: 2 };

  function cellsOf(type, rot) { return ROTATIONS[type][rot & 3]; }

  function emptyGrid(rows, cols) {
    const g = new Array(rows);
    for (let y = 0; y < rows; y++) g[y] = new Array(cols).fill(null);
    return g;
  }

  function collides(grid, type, rot, px, py) {
    const cells = cellsOf(type, rot);
    const rows = grid.length, cols = grid[0].length;
    for (let i = 0; i < cells.length; i++) {
      const x = px + cells[i].x;
      const y = py + cells[i].y;
      if (x < 0 || x >= cols || y >= rows) return true;
      if (y >= 0 && grid[y][x]) return true;
    }
    return false;
  }

  function dropY(grid, type, rot, px, startY) {
    let y = startY;
    while (!collides(grid, type, rot, px, y + 1)) y++;
    return y;
  }

  /* Writes the piece into a grid copy and clears full rows. */
  function applyPlacement(grid, type, rot, px, py) {
    const rows = grid.length, cols = grid[0].length;
    const next = grid.map((row) => row.slice());
    for (const c of cellsOf(type, rot)) {
      const y = py + c.y, x = px + c.x;
      if (y >= 0 && y < rows && x >= 0 && x < cols) next[y][x] = type;
    }
    const kept = next.filter((row) => row.some((cell) => !cell));
    const cleared = rows - kept.length;
    while (kept.length < rows) kept.unshift(new Array(cols).fill(null));
    return { grid: kept, cleared };
  }

  /* Deterministic PRNG so AI runs can be reproduced. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const LINE_SCORE = [0, 100, 300, 500, 800];
  const GRAVITY_MS = [800, 717, 633, 550, 467, 383, 300, 217, 133, 100, 83, 83, 83, 67, 67, 67, 50, 50, 50, 33];

  function gravityFor(level) {
    return GRAVITY_MS[Math.min(level, GRAVITY_MS.length - 1)];
  }

  function createGame(opts) {
    opts = opts || {};
    const cols = opts.cols || COLS;
    const rows = opts.rows || ROWS;
    const rand = mulberry32(opts.seed != null ? opts.seed : (Date.now() & 0xffffffff));

    let bag = [];
    function nextFromBag() {
      if (!bag.length) {
        bag = TYPES.slice();
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
        }
      }
      return bag.pop();
    }

    const game = {
      cols: cols,
      rows: rows,
      grid: emptyGrid(rows, cols),
      active: null,
      queue: [nextFromBag(), nextFromBag(), nextFromBag()],
      hold: null,
      canHold: true,
      score: 0,
      lines: 0,
      level: 0,
      pieces: 0,
      over: false,
      overReason: null,
      paused: false,
      lastClear: 0,
      /* Callers hook these to react to engine events. */
      onSpawn: null,
      onLock: null,
      onGameOver: null
    };

    let fallTimer = 0;
    let lockTimer = 0;
    let lockResets = 0;
    const LOCK_DELAY = 500;
    const MAX_LOCK_RESETS = 15;

    function spawn() {
      const type = game.queue.shift();
      game.queue.push(nextFromBag());
      const cells = cellsOf(type, 0);
      const width = Math.max.apply(null, cells.map((c) => c.x)) + 1;
      const px = Math.floor((cols - width) / 2);
      const py = -Math.max.apply(null, cells.map((c) => c.y)) - 1;
      game.active = { type: type, rot: 0, x: px, y: py };
      fallTimer = 0; lockTimer = 0; lockResets = 0;
      if (collides(game.grid, type, 0, px, py)) {
        game.over = true;
        game.overReason = 'block out';
        game.active = null;
        if (game.onGameOver) game.onGameOver();
        return;
      }
      game.pieces++;
      if (game.onSpawn) game.onSpawn(game.active);
    }

    function landed() {
      const a = game.active;
      return collides(game.grid, a.type, a.rot, a.x, a.y + 1);
    }

    function lock() {
      const a = game.active;
      /* Lock out: a piece coming to rest with any cell above the playfield ends
         the game. Without this, applyPlacement quietly drops those cells, so a
         full board swallows pieces forever and never tops out. */
      const lockedOut = cellsOf(a.type, a.rot).some((c) => a.y + c.y < 0);
      const res = applyPlacement(game.grid, a.type, a.rot, a.x, a.y);
      game.grid = res.grid;
      game.lastClear = res.cleared;
      if (res.cleared) {
        game.lines += res.cleared;
        game.score += LINE_SCORE[res.cleared] * (game.level + 1);
        game.level = Math.floor(game.lines / 10);
      }
      game.canHold = true;
      const locked = { type: a.type, rot: a.rot, x: a.x, y: a.y, cleared: res.cleared };
      game.active = null;
      if (game.onLock) game.onLock(locked);
      if (lockedOut) {
        game.over = true;
        game.overReason = 'lock out';
        if (game.onGameOver) game.onGameOver();
        return;
      }
      spawn();
    }

    game.move = function (dx) {
      const a = game.active;
      if (!a || game.over || game.paused) return false;
      if (collides(game.grid, a.type, a.rot, a.x + dx, a.y)) return false;
      a.x += dx;
      if (lockResets < MAX_LOCK_RESETS) { lockTimer = 0; lockResets++; }
      return true;
    };

    /* Rotation with simple nudge kicks (no full SRS table). */
    game.rotate = function (dir) {
      const a = game.active;
      if (!a || game.over || game.paused) return false;
      const rot = (a.rot + (dir < 0 ? 3 : 1)) & 3;
      const kicks = [0, -1, 1, -2, 2];
      for (const k of kicks) {
        if (!collides(game.grid, a.type, rot, a.x + k, a.y)) {
          a.rot = rot; a.x += k;
          if (lockResets < MAX_LOCK_RESETS) { lockTimer = 0; lockResets++; }
          return true;
        }
      }
      return false;
    };

    game.softDrop = function () {
      const a = game.active;
      if (!a || game.over || game.paused) return false;
      if (collides(game.grid, a.type, a.rot, a.x, a.y + 1)) return false;
      a.y++; game.score += 1; fallTimer = 0;
      return true;
    };

    game.hardDrop = function () {
      const a = game.active;
      if (!a || game.over || game.paused) return 0;
      const y = dropY(game.grid, a.type, a.rot, a.x, a.y);
      game.score += 2 * (y - a.y);
      const dist = y - a.y;
      a.y = y;
      lock();
      return dist;
    };

    game.holdPiece = function () {
      const a = game.active;
      if (!a || game.over || game.paused || !game.canHold) return false;
      const swap = game.hold;
      game.hold = a.type;
      game.canHold = false;
      if (swap) {
        game.queue.unshift(swap);
      }
      game.active = null;
      spawn();
      return true;
    };

    game.ghostY = function () {
      const a = game.active;
      if (!a) return null;
      return dropY(game.grid, a.type, a.rot, a.x, a.y);
    };

    game.tick = function (dt) {
      if (game.over || game.paused || !game.active) return;
      if (landed()) {
        lockTimer += dt;
        if (lockTimer >= LOCK_DELAY) lock();
        return;
      }
      lockTimer = 0;
      fallTimer += dt;
      const step = gravityFor(game.level);
      while (fallTimer >= step && game.active && !landed()) {
        fallTimer -= step;
        game.active.y++;
      }
    };

    game.reset = function () {
      game.grid = emptyGrid(rows, cols);
      bag = [];
      game.queue = [nextFromBag(), nextFromBag(), nextFromBag()];
      game.hold = null; game.canHold = true;
      game.score = 0; game.lines = 0; game.level = 0; game.pieces = 0;
      game.over = false; game.overReason = null; game.paused = false; game.lastClear = 0;
      game.active = null;
      spawn();
    };

    spawn();
    return game;
  }

  global.Tetris = {
    COLS: COLS, ROWS: ROWS, TYPES: TYPES, COLORS: COLORS,
    ROTATIONS: ROTATIONS, DISTINCT_ROTATIONS: DISTINCT_ROTATIONS,
    cellsOf: cellsOf, collides: collides, dropY: dropY,
    applyPlacement: applyPlacement, emptyGrid: emptyGrid,
    mulberry32: mulberry32, gravityFor: gravityFor,
    createGame: createGame
  };
})(window);
