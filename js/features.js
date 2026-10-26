/* Placement enumeration + board features. Shared by every move picker so the
   three backends are compared on identical candidate sets. */
(function (global) {
  'use strict';

  const T = global.Tetris;

  function columnHeights(grid) {
    const rows = grid.length, cols = grid[0].length;
    const h = new Array(cols).fill(0);
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        if (grid[y][x]) { h[x] = rows - y; break; }
      }
    }
    return h;
  }

  function countHoles(grid) {
    const rows = grid.length, cols = grid[0].length;
    let holes = 0;
    for (let x = 0; x < cols; x++) {
      let seen = false;
      for (let y = 0; y < rows; y++) {
        if (grid[y][x]) seen = true;
        else if (seen) holes++;
      }
    }
    return holes;
  }

  /* Filled <-> empty flips per row, counting the walls as filled. */
  function rowTransitions(grid) {
    const rows = grid.length, cols = grid[0].length;
    let t = 0;
    for (let y = 0; y < rows; y++) {
      let prev = true;
      for (let x = 0; x < cols; x++) {
        const cur = !!grid[y][x];
        if (cur !== prev) t++;
        prev = cur;
      }
      if (!prev) t++;
    }
    return t;
  }

  /* Same per column, with the floor counted as filled. */
  function colTransitions(grid) {
    const rows = grid.length, cols = grid[0].length;
    let t = 0;
    for (let x = 0; x < cols; x++) {
      let prev = false;
      for (let y = 0; y < rows; y++) {
        const cur = !!grid[y][x];
        if (cur !== prev) t++;
        prev = cur;
      }
      if (!prev) t++;
    }
    return t;
  }

  /* Sum of 1..depth for every well cell -- punishes deep single-wide canyons. */
  function wellSums(grid) {
    const rows = grid.length, cols = grid[0].length;
    let sum = 0;
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        if (grid[y][x]) continue;
        const leftWall = x === 0 || !!grid[y][x - 1];
        const rightWall = x === cols - 1 || !!grid[y][x + 1];
        if (!leftWall || !rightWall) continue;
        let depth = 0;
        for (let k = y; k < rows && !grid[k][x]; k++) depth++;
        sum += (depth * (depth + 1)) / 2;
        break;
      }
    }
    return sum;
  }

  function bumpiness(heights) {
    let b = 0;
    for (let i = 0; i < heights.length - 1; i++) b += Math.abs(heights[i] - heights[i + 1]);
    return b;
  }

  function boardFeatures(grid) {
    const h = columnHeights(grid);
    let agg = 0, max = 0;
    for (const v of h) { agg += v; if (v > max) max = v; }
    return {
      aggregateHeight: agg,
      maxHeight: max,
      holes: countHoles(grid),
      bumpiness: bumpiness(h),
      rowTransitions: rowTransitions(grid),
      colTransitions: colTransitions(grid),
      wellSums: wellSums(grid)
    };
  }

  /* Every placement reachable by rotate-then-shift-then-hard-drop. */
  function enumeratePlacements(grid, type) {
    const rows = grid.length, cols = grid[0].length;
    const out = [];
    const nRot = T.DISTINCT_ROTATIONS[type];
    for (let rot = 0; rot < nRot; rot++) {
      const cells = T.cellsOf(type, rot);
      const minX = Math.min.apply(null, cells.map((c) => c.x));
      const maxX = Math.max.apply(null, cells.map((c) => c.x));
      for (let x = -minX; x + maxX < cols; x++) {
        let y = -4;
        while (y < rows && T.collides(grid, type, rot, x, y)) y++;
        if (y >= rows) continue;
        y = T.dropY(grid, type, rot, x, y);
        const placed = cells.map((c) => ({ x: x + c.x, y: y + c.y }));
        if (placed.some((c) => c.y < 0)) continue; /* would lock out above the field */
        const res = T.applyPlacement(grid, type, rot, x, y);
        const f = boardFeatures(res.grid);
        const ys = placed.map((c) => c.y);
        /* `x` is the rotation matrix's origin and can be negative; what the log
           and the models should see is the leftmost board column really filled */
        const leftColumn = Math.min.apply(null, placed.map((c) => c.x));
        const landingHeight = rows - (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
        out.push({
          id: 'c' + out.length,
          type: type,
          rot: rot,
          x: x,
          y: y,
          cleared: res.cleared,
          nextGrid: res.grid,
          features: {
            piece: type,
            rotation: rot,
            column: leftColumn,
            linesCleared: res.cleared,
            landingHeight: Math.round(landingHeight * 10) / 10,
            holes: f.holes,
            holesAdded: f.holes - countHoles(grid),
            aggregateHeight: f.aggregateHeight,
            maxHeight: f.maxHeight,
            bumpiness: f.bumpiness,
            rowTransitions: f.rowTransitions,
            colTransitions: f.colTransitions,
            wellSums: f.wellSums
          }
        });
      }
    }
    return out;
  }

  /* El-Tetris "eroded piece cells": rows this placement completes times the
     cells of the placed piece that vanish with them. Rewards clearing with the
     piece itself rather than just stacking next to a full row. */
  function erodedCells(grid, p) {
    const cols = grid[0].length;
    const placed = T.cellsOf(p.type, p.rot).map((c) => ({ x: p.x + c.x, y: p.y + c.y }));
    let lines = 0, cells = 0;
    for (const y of new Set(placed.map((c) => c.y))) {
      const mine = placed.filter((c) => c.y === y);
      let full = true;
      for (let x = 0; x < cols && full; x++) {
        if (!grid[y][x] && !mine.some((c) => c.x === x)) full = false;
      }
      if (full) { lines++; cells += mine.length; }
    }
    return lines * cells;
  }

  /* Present candidates in board order (rotation, then column) so a model
     cannot read the heuristic's preference off the list position: sorted by
     score, option_0 would always be the heuristic's own pick. */
  function boardOrder(placements) {
    return placements.slice().sort((a, b) => (a.rot - b.rot) || (a.features.column - b.features.column));
  }

  /* El-Tetris weights (Islam El-Ashi, 2011) -- the shared baseline. */
  const WEIGHTS = {
    landingHeight: -4.500158825082766,
    linesCleared: 3.4181268101392694,
    rowTransitions: -3.2178882868487753,
    colTransitions: -9.348695305445199,
    holes: -7.899265427351652,
    wellSums: -3.3855972247263626
  };

  function scorePlacement(p) {
    const f = p.features;
    return WEIGHTS.landingHeight * f.landingHeight
      + WEIGHTS.linesCleared * f.linesCleared
      + WEIGHTS.rowTransitions * f.rowTransitions
      + WEIGHTS.colTransitions * f.colTransitions
      + WEIGHTS.holes * f.holes
      + WEIGHTS.wellSums * f.wellSums;
  }

  /* Compact ASCII view of the stack, used as `state.board` for Jev. */
  function asciiBoard(grid) {
    return grid.map((row) => row.map((c) => (c ? '#' : '.')).join('')).join('\n');
  }

  global.Features = {
    columnHeights: columnHeights,
    boardFeatures: boardFeatures,
    enumeratePlacements: enumeratePlacements,
    erodedCells: erodedCells,
    boardOrder: boardOrder,
    scorePlacement: scorePlacement,
    asciiBoard: asciiBoard,
    WEIGHTS: WEIGHTS
  };
})(window);
