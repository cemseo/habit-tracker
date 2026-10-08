/* Zeichenfläche: Eingabe, Speichern als kompakte Strich-Daten, Rendern und Abspielen.
   Logisches Koordinatensystem 800 x 600 (4:3); jede Fläche rendert mit eigenem Maßstab. */
(function () {
  'use strict';
  const LW = 800, LH = 600;
  const PALETTE = ['#1A1A2E', '#FFFFFF', '#8A8FA3', '#8B5A2B', '#E5383B', '#FF5D4A', '#FF8A3D', '#FFD23F',
    '#8BE04E', '#2BA84A', '#2EC4B6', '#5BC8FF', '#3355E0', '#7B4FD6', '#FF6FA8', '#F2B880'];
  const SIZES = [3, 7, 14, 26];
  const MIN_DIST = 2;           // logische px zwischen gespeicherten Punkten
  const MAX_ENCODED = 300000;   // Zeichen, deutlich unter 1 MB Firestore-Limit

  const clampX = x => Math.max(0, Math.min(LW, Math.round(x)));
  const clampY = y => Math.max(0, Math.min(LH, Math.round(y)));

  /* ---------- Kodierung ---------- */
  // Format: "v1" | op | op ...   Strich: s<farbe>.<stärke>:x0,y0,dx,dy,...   Füllen: f<farbe>:x,y   Löschen: c
  function encode(ops) {
    let start = 0;
    for (let i = ops.length - 1; i >= 0; i--) if (ops[i].k === 'c') { start = i + 1; break; }
    const list = ops.slice(start);
    let step = 1, out;
    do {
      out = 'v1|' + list.map(op => {
        if (op.k === 'f') return 'f' + op.c + ':' + op.x + ',' + op.y;
        let p = op.p;
        if (step > 1 && p.length > 4) {
          const q = [];
          for (let i = 0; i < p.length; i += 2 * step) q.push(p[i], p[i + 1]);
          if (q[q.length - 2] !== p[p.length - 2] || q[q.length - 1] !== p[p.length - 1]) q.push(p[p.length - 2], p[p.length - 1]);
          p = q;
        }
        const n = [p[0], p[1]];
        for (let i = 2; i < p.length; i += 2) n.push(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
        return 's' + op.c + '.' + op.w + ':' + n.join(',');
      }).join('|');
      step *= 2;
    } while (out.length > MAX_ENCODED && step < 64);
    return out;
  }

  function decode(str) {
    const ops = [];
    if (typeof str !== 'string' || !str.startsWith('v1')) return ops;
    for (const part of str.split('|').slice(1)) {
      try {
        if (part === 'c') { ops.push({ k: 'c' }); continue; }
        const [head, body] = part.split(':');
        if (head[0] === 'f') {
          const [x, y] = body.split(',').map(Number);
          const c = +head.slice(1);
          if (PALETTE[c] && isFinite(x) && isFinite(y)) ops.push({ k: 'f', c, x: clampX(x), y: clampY(y) });
        } else if (head[0] === 's') {
          const [c, w] = head.slice(1).split('.').map(Number);
          const n = body.split(',').map(Number);
          if (!PALETTE[c] || !SIZES[w] || n.length < 2 || n.some(v => !isFinite(v))) continue;
          const p = [n[0], n[1]];
          for (let i = 2; i + 1 < n.length; i += 2) p.push(p[i - 2] + n[i], p[i - 1] + n[i + 1]);
          ops.push({ k: 's', c, w, p });
        }
      } catch (e) { /* kaputten Teil überspringen */ }
    }
    return ops;
  }

  /* ---------- Rendern ---------- */
  function clearCtx(ctx) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }

  // Zeichnet Segment-Teile eines Strichs von Punkt-Index a (inkl.) bis b (inkl.), deckungsgleich mit dem kompletten Strich.
  function strokeRange(ctx, op, s, a, b) {
    const p = op.p, n = p.length / 2;
    ctx.strokeStyle = PALETTE[op.c]; ctx.fillStyle = PALETTE[op.c];
    ctx.lineWidth = SIZES[op.w] * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const X = i => p[2 * i] * s, Y = i => p[2 * i + 1] * s;
    const MX = i => (p[2 * i] + p[2 * i + 2]) / 2 * s, MY = i => (p[2 * i + 1] + p[2 * i + 3]) / 2 * s;
    if (n === 1) {
      if (a === 0) { ctx.beginPath(); ctx.arc(X(0), Y(0), SIZES[op.w] * s / 2, 0, Math.PI * 2); ctx.fill(); }
      return;
    }
    ctx.beginPath();
    for (let i = Math.max(1, a); i <= b && i < n; i++) {
      if (i === 1) { ctx.moveTo(X(0), Y(0)); ctx.lineTo(MX(0), MY(0)); }
      else { ctx.moveTo(MX(i - 2), MY(i - 2)); ctx.quadraticCurveTo(X(i - 1), Y(i - 1), MX(i - 1), MY(i - 1)); }
      if (i === n - 1) { ctx.moveTo(MX(i - 1), MY(i - 1)); ctx.lineTo(X(i), Y(i)); }
    }
    ctx.stroke();
  }

  function hexToRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

  function floodFill(ctx, op, s) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const sx = Math.min(W - 1, Math.max(0, Math.round(op.x * s))), sy = Math.min(H - 1, Math.max(0, Math.round(op.y * s)));
    const img = ctx.getImageData(0, 0, W, H), d = img.data;
    const i0 = (sy * W + sx) * 4;
    const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2];
    const [fr, fg, fb] = hexToRgb(PALETTE[op.c]);
    if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 6) return;
    const TOL = 90;
    const mask = new Uint8Array(W * H);
    const similar = j => { const k = j * 4; return Math.abs(d[k] - tr) + Math.abs(d[k + 1] - tg) + Math.abs(d[k + 2] - tb) <= TOL; };
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(), x0 = stack.pop();
      let x = x0, row = y * W;
      if (mask[row + x] || !similar(row + x)) continue;
      while (x > 0 && !mask[row + x - 1] && similar(row + x - 1)) x--;
      let upOpen = false, downOpen = false;
      for (; x < W && !mask[row + x] && similar(row + x); x++) {
        mask[row + x] = 1;
        if (y > 0) {
          const j = row - W + x, ok = !mask[j] && similar(j);
          if (ok && !upOpen) { stack.push(x, y - 1); upOpen = true; } else if (!ok) upOpen = false;
        }
        if (y < H - 1) {
          const j = row + W + x, ok = !mask[j] && similar(j);
          if (ok && !downOpen) { stack.push(x, y + 1); downOpen = true; } else if (!ok) downOpen = false;
        }
      }
    }
    // 1 px ausweiten, damit an Kanten kein weißer Saum bleibt
    for (let y = 0; y < H; y++) {
      for (let x = 0, j = y * W; x < W; x++, j++) {
        if (mask[j] !== 1) continue;
        if (x > 0 && !mask[j - 1]) mask[j - 1] = 2;
        if (x < W - 1 && !mask[j + 1]) mask[j + 1] = 2;
        if (y > 0 && !mask[j - W]) mask[j - W] = 2;
        if (y < H - 1 && !mask[j + W]) mask[j + W] = 2;
      }
    }
    for (let j = 0; j < mask.length; j++) if (mask[j]) { const k = j * 4; d[k] = fr; d[k + 1] = fg; d[k + 2] = fb; d[k + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  }

  function renderOps(ctx, ops, s) {
    clearCtx(ctx);
    for (const op of ops) {
      if (op.k === 'c') clearCtx(ctx);
      else if (op.k === 'f') floodFill(ctx, op, s);
      else strokeRange(ctx, op, s, 0, op.p.length / 2 - 1);
    }
  }

  function makeCanvas(internalW) {
    const c = document.createElement('canvas');
    c.width = internalW; c.height = Math.round(internalW * LH / LW);
    c.className = 'drawing';
    const ctx = c.getContext('2d', { willReadFrequently: true });
    clearCtx(ctx);
    return c;
  }

  // Statische Ansicht
  function renderStatic(canvas, data) {
    const ops = Array.isArray(data) ? data : decode(data);
    renderOps(canvas.getContext('2d'), ops, canvas.width / LW);
  }

  // Strich-für-Strich-Animation. Gibt eine Funktion zum Abbrechen zurück.
  function replay(canvas, data, opts) {
    opts = opts || {};
    const ops = (Array.isArray(data) ? data : decode(data)).filter(o => o.k !== 'c');
    const ctx = canvas.getContext('2d'), s = canvas.width / LW;
    clearCtx(ctx);
    const total = ops.reduce((a, o) => a + (o.k === 's' ? o.p.length / 2 : 20), 0);
    if (!total) { opts.onDone && opts.onDone(); return () => {}; }
    const duration = Math.min(opts.maxMs || 7000, Math.max(1500, total * 3));
    const rate = total / duration;
    let opIdx = 0, ptIdx = 0, budget = 0, last = performance.now(), raf = 0, stopped = false;
    function frame(now) {
      if (stopped) return;
      budget += (now - last) * rate; last = now;
      while (budget > 0 && opIdx < ops.length) {
        const op = ops[opIdx];
        if (op.k === 'f') { floodFill(ctx, op, s); budget -= 20; opIdx++; ptIdx = 0; continue; }
        const n = op.p.length / 2;
        const take = Math.max(1, Math.min(n - ptIdx, Math.floor(budget)));
        strokeRange(ctx, op, s, ptIdx, ptIdx + take - 1);
        ptIdx += take; budget -= take;
        if (ptIdx >= n) { opIdx++; ptIdx = 0; }
      }
      if (opIdx < ops.length) raf = requestAnimationFrame(frame);
      else { opts.onDone && opts.onDone(); }
    }
    raf = requestAnimationFrame(frame);
    return () => { stopped = true; cancelAnimationFrame(raf); };
  }

  /* ---------- Eingabe ---------- */
  function DrawPad(canvas, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const s = canvas.width / LW;
    const pad = { ops: [], tool: 'pen', color: 0, size: 1, onChange: opts.onChange || (() => {}), enabled: true };
    let active = null, cur = null, penSeen = false;

    function point(e) {
      const r = canvas.getBoundingClientRect();
      return [clampX((e.clientX - r.left) / r.width * LW), clampY((e.clientY - r.top) / r.height * LH)];
    }
    // Live: zeichne Segment i ohne Endstück; Endstück erst beim Loslassen
    function liveSeg(i) {
      const p = cur.p;
      ctx.strokeStyle = PALETTE[cur.c]; ctx.lineWidth = SIZES[cur.w] * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      if (i === 1) { ctx.moveTo(p[0] * s, p[1] * s); ctx.lineTo((p[0] + p[2]) / 2 * s, (p[1] + p[3]) / 2 * s); }
      else {
        ctx.moveTo((p[2 * i - 4] + p[2 * i - 2]) / 2 * s, (p[2 * i - 3] + p[2 * i - 1]) / 2 * s);
        ctx.quadraticCurveTo(p[2 * i - 2] * s, p[2 * i - 1] * s, (p[2 * i - 2] + p[2 * i]) / 2 * s, (p[2 * i - 1] + p[2 * i + 1]) / 2 * s);
      }
      ctx.stroke();
    }
    function addLive(x, y) {
      const p = cur.p, n = p.length;
      if (n && Math.hypot(x - p[n - 2], y - p[n - 1]) < MIN_DIST) return;
      p.push(x, y);
      const i = p.length / 2 - 1;
      if (i >= 1) liveSeg(i);
    }
    function finish() {
      if (!cur) return;
      const p = cur.p, n = p.length / 2;
      if (n === 1) strokeRange(ctx, cur, s, 0, 0);
      else {
        ctx.strokeStyle = PALETTE[cur.c]; ctx.lineWidth = SIZES[cur.w] * s; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo((p[2 * n - 4] + p[2 * n - 2]) / 2 * s, (p[2 * n - 3] + p[2 * n - 1]) / 2 * s);
        ctx.lineTo(p[2 * n - 2] * s, p[2 * n - 1] * s);
        ctx.stroke();
      }
      pad.ops.push(cur); cur = null; active = null;
      pad.onChange();
    }

    canvas.addEventListener('pointerdown', e => {
      if (!pad.enabled) return;
      if (e.pointerType === 'pen') penSeen = true;
      else if (e.pointerType === 'touch' && penSeen) return; // Handballen ignorieren, sobald der Stift benutzt wurde
      if (active !== null) return;
      if (e.button && e.button !== 0) return;
      e.preventDefault();
      const [x, y] = point(e);
      if (pad.tool === 'fill') {
        const op = { k: 'f', c: pad.color, x, y };
        floodFill(ctx, op, s); pad.ops.push(op); pad.onChange();
        return;
      }
      active = e.pointerId;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
      cur = { k: 's', c: pad.tool === 'eraser' ? 1 : pad.color, w: pad.size, p: [] };
      addLive(x, y);
    });
    canvas.addEventListener('pointermove', e => {
      if (e.pointerId !== active || !cur) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) { const [x, y] = point(ev); addLive(x, y); }
    });
    const end = e => { if (e.pointerId === active) finish(); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('lostpointercapture', end);
    canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    canvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    pad.redraw = () => renderOps(ctx, pad.ops, s);
    pad.undo = () => { if (cur) return; if (pad.ops.length) { pad.ops.pop(); pad.redraw(); pad.onChange(); } };
    pad.clear = () => { if (cur) return; if (pad.ops.length && pad.ops[pad.ops.length - 1].k !== 'c') { pad.ops.push({ k: 'c' }); clearCtx(ctx); pad.onChange(); } };
    pad.isEmpty = () => { let last = -1; pad.ops.forEach((o, i) => { if (o.k === 'c') last = i; }); return pad.ops.length - 1 === last; };
    pad.encode = () => { if (cur) finish(); return encode(pad.ops); };
    pad.load = str => { pad.ops = decode(str); pad.redraw(); };
    return pad;
  }

  window.Draw = { LW, LH, PALETTE, SIZES, encode, decode, makeCanvas, renderStatic, replay, DrawPad };
})();
