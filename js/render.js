/* Canvas rendering. */
(function (global) {
  'use strict';

  const T = global.Tetris;

  function readVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function cell(ctx, x, y, size, color, style) {
    const pad = Math.max(1, size * 0.06);
    if (style === 'ghost') {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = Math.max(1, size * 0.08);
      roundRect(ctx, x + pad, y + pad, size - pad * 2, size - pad * 2, size * 0.18);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }
    ctx.fillStyle = color;
    roundRect(ctx, x + pad, y + pad, size - pad * 2, size - pad * 2, size * 0.18);
    ctx.fill();
    /* top highlight for a bit of depth */
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    roundRect(ctx, x + pad, y + pad, size - pad * 2, (size - pad * 2) * 0.32, size * 0.18);
    ctx.fill();
  }

  function drawBoard(canvas, game, opts) {
    const ctx = canvas.getContext('2d');
    const dpr = global.devicePixelRatio || 1;
    const size = opts.cellSize;
    const w = game.cols * size, h = game.rows * size;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = readVar('--board-bg', '#11131c');
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = readVar('--grid-line', 'rgba(255,255,255,0.05)');
    ctx.lineWidth = 1;
    for (let x = 1; x < game.cols; x++) {
      ctx.beginPath(); ctx.moveTo(x * size + 0.5, 0); ctx.lineTo(x * size + 0.5, h); ctx.stroke();
    }
    for (let y = 1; y < game.rows; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * size + 0.5); ctx.lineTo(w, y * size + 0.5); ctx.stroke();
    }

    for (let y = 0; y < game.rows; y++) {
      for (let x = 0; x < game.cols; x++) {
        const t = game.grid[y][x];
        if (t) cell(ctx, x * size, y * size, size, T.COLORS[t]);
      }
    }

    const a = game.active;
    if (a) {
      if (opts.ghost) {
        const gy = game.ghostY();
        for (const c of T.cellsOf(a.type, a.rot)) {
          const y = gy + c.y;
          if (y >= 0) cell(ctx, (a.x + c.x) * size, y * size, size, T.COLORS[a.type], 'ghost');
        }
      }
      for (const c of T.cellsOf(a.type, a.rot)) {
        const y = a.y + c.y;
        if (y >= 0) cell(ctx, (a.x + c.x) * size, y * size, size, T.COLORS[a.type]);
      }
    }

    /* AI target overlay: where the current plan intends to land */
    if (opts.plan) {
      const p = opts.plan;
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = readVar('--accent', '#8ab4ff');
      ctx.lineWidth = 2;
      for (const c of T.cellsOf(p.type, p.rot)) {
        const y = p.y + c.y;
        if (y >= 0) {
          roundRect(ctx, (p.x + c.x) * size + 2, y * size + 2, size - 4, size - 4, size * 0.18);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    if (game.over) {
      ctx.fillStyle = 'rgba(8,9,14,0.78)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = readVar('--text', '#e9ecf5');
      ctx.textAlign = 'center';
      ctx.font = '600 24px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('Game over', w / 2, h / 2 - 8);
      ctx.font = '400 13px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = readVar('--muted', '#9aa3b8');
      ctx.fillText('press R to restart', w / 2, h / 2 + 16);
    } else if (game.paused) {
      ctx.fillStyle = 'rgba(8,9,14,0.68)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = readVar('--text', '#e9ecf5');
      ctx.textAlign = 'center';
      ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('Paused', w / 2, h / 2);
    }
  }

  function drawPiece(canvas, type, size) {
    const ctx = canvas.getContext('2d');
    const dpr = global.devicePixelRatio || 1;
    const w = 4 * size, h = 3 * size;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!type) return;
    const cells = T.cellsOf(type, 0);
    const xs = cells.map((c) => c.x), ys = cells.map((c) => c.y);
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    const ox = (w - (maxX - minX + 1) * size) / 2;
    const oy = (h - (maxY - minY + 1) * size) / 2;
    for (const c of cells) {
      cell(ctx, ox + (c.x - minX) * size, oy + (c.y - minY) * size, size, T.COLORS[type]);
    }
  }

  global.Render = { drawBoard: drawBoard, drawPiece: drawPiece };
})(window);
