/* Kritzelpost: Satz → Zeichnung → Beschreibung → … (Stille-Post-Prinzip). */
(function () {
  'use strict';
  const { T, esc, $, $$, toast, avatar, vibrate, tsMs, ICON } = App;
  const FV = () => App.FV;

  const IDEAS_DE = ['Ein Hamster fährt Skateboard auf dem Lehrerpult', 'Der Hausmeister surft auf einer Pizza', 'Ein Dinosaurier schreibt eine Mathearbeit',
    'Eine Giraffe steckt im Fahrstuhl fest', 'Ein Pinguin verkauft Eis in der Wüste', 'Die Schulglocke hat Schluckauf', 'Ein Hai macht Yoga',
    'Ein Roboter verliebt sich in einen Toaster', 'Eine Katze leitet den Sportunterricht', 'Ein Astronaut verliert seinen Schlüssel auf dem Mond',
    'Ein Elefant versteckt sich hinter einem Laternenpfahl', 'Ein Geist hat Angst vor einer Maus', 'Eine Banane fährt Achterbahn',
    'Der Mond isst eine Bratwurst', 'Ein Schneemann im Fitnessstudio', 'Ein Frosch mit Sonnenbrille spielt Gitarre'];
  const IDEAS_EN = ['A hamster skateboards across the teacher\'s desk', 'The janitor surfs on a pizza', 'A dinosaur takes a maths test',
    'A giraffe stuck in an elevator', 'A penguin sells ice cream in the desert', 'The school bell has hiccups', 'A shark doing yoga',
    'A robot falls in love with a toaster', 'A cat teaches PE', 'An astronaut loses his keys on the moon', 'A ghost is scared of a mouse',
    'A banana on a roller coaster', 'A snowman at the gym', 'A frog with sunglasses plays guitar'];
  const REACTIONS = ['😂', '🔥', '😮', '👏'];
  const NOTHING = () => T('(nichts abgegeben)', '(nothing submitted)');

  const subId = (r, s, c) => `${r}_${s}_${c}`;
  const typeOf = s => (s === 0 ? 'write' : (s % 2 === 1 ? 'draw' : 'describe'));
  const durFor = (room, s) => (typeOf(s) === 'draw' ? room.settings.draw : room.settings.write);

  function info(c) {
    const r = c.room, N = r.order.length, s = r.step, p = r.order.indexOf(c.me);
    const ch = p < 0 ? -1 : ((p - s) % N + N) % N;
    const start = tsMs(r.stepStart);
    return {
      N, s, p, c: ch, round: r.round, type: typeOf(s),
      id: subId(r.round, s, ch), prevId: s > 0 ? subId(r.round, s - 1, ch) : null,
      end: (start == null ? c.now() : start) + r.stepDur * 1000
    };
  }

  function doneStatus(c) {
    const r = c.room, N = r.order.length, s = r.step;
    const list = [];
    for (let ch = 0; ch < N; ch++) {
      const uid = r.order[(ch + s) % N];
      const p = r.players[uid];
      if (!p || p.left) continue;
      list.push({ uid, p, done: c.subs.has(subId(r.round, s, ch)) });
    }
    return list;
  }

  /* ---------- Spielsteuerung ---------- */
  async function start(c) {
    const db = App.db, ref = c.ref, me = c.me;
    await db.runTransaction(async t => {
      const snap = await t.get(ref);
      const r = snap.data();
      if (!r || r.status !== 'lobby' || r.hostUid !== me) return;
      const act = c.activePlayers(r).filter(([uid, p]) => uid === me || !c.isStale(p)).map(([u]) => u);
      if (act.length < 3) throw Object.assign(new Error('few'), { code: 'few' });
      for (let i = act.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [act[i], act[j]] = [act[j], act[i]]; }
      t.update(ref, {
        status: 'play', round: (r.round || 0) + 1, order: act, step: 0,
        stepStart: FV().serverTimestamp(), stepDur: r.settings.write,
        album: FV().delete(), updatedAt: FV().serverTimestamp(),
        expiresAt: App.TS.fromMillis(Date.now() + 4 * 3600 * 1000)
      });
    });
  }

  let advancing = false, lastAdvance = 0;
  async function advance(c, round, step) {
    if (advancing || Date.now() - lastAdvance < 3000) return;
    advancing = true; lastAdvance = Date.now();
    try {
      await App.db.runTransaction(async t => {
        const snap = await t.get(c.ref);
        const r = snap.data();
        if (!r || r.status !== 'play' || r.round !== round || r.step !== step) return;
        if (step + 1 < r.order.length) {
          t.update(c.ref, { step: step + 1, stepStart: FV().serverTimestamp(), stepDur: durFor(r, step + 1), updatedAt: FV().serverTimestamp() });
        } else {
          t.update(c.ref, { status: 'album', album: { c: 0, k: 0 }, updatedAt: FV().serverTimestamp() });
        }
      });
    } catch (e) { console.warn('Weiterschalten', e); }
    advancing = false;
  }

  function tick(c) {
    const r = c.room;
    if (r.status !== 'play' || !r.order) return;
    const s = r.step, start = tsMs(r.stepStart);
    if (start == null) return;
    const end = start + r.stepDur * 1000, now = c.now();
    const allDone = doneStatus(c).every(x => x.done);
    if ((c.isHost && (allDone || now > end + 3000)) || now > end + 15000) advance(c, r.round, s);
  }

  async function submit(c, inf, payload) {
    const doc = {
      uid: c.me, r: inf.round, s: inf.s, c: inf.c, t: inf.type === 'draw' ? 'd' : 't',
      at: FV().serverTimestamp(), x: c.room.expiresAt
    };
    if (payload.d != null) doc.d = payload.d; else doc.text = String(payload.text || '').slice(0, 140);
    return c.ref.collection('subs').doc(inf.id).set(doc).catch(e => { console.warn('Abgabe', e); toast(App.roomError(e), 'err'); });
  }

  /* ---------- Bausteine ---------- */
  function headerHtml(inf, title) {
    const dots = Array.from({ length: inf.N }, (_, i) => `<i class="${i < inf.s ? 'past' : (i === inf.s ? 'now' : '')}"></i>`).join('');
    return `<header class="step-head">
      <div class="step-left"><button class="icon-btn quit" data-quit aria-label="${T('Spiel verlassen', 'Leave game')}">${ICON.x}</button><div class="step-label">${T('Schritt', 'Step')} ${inf.s + 1} / ${inf.N}</div><div class="step-dots">${dots}</div></div>
      ${title ? `<div class="step-title">${title}</div>` : '<div></div>'}
      <div class="timer" data-timer>${ICON.clock}<span>0:00</span></div>
    </header>`;
  }
  function updateTimer(el, inf, c) {
    const t = $('[data-timer]', el);
    if (!t) return 0;
    const left = Math.max(0, Math.ceil((inf.end - c.now()) / 1000));
    const txt = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    const span = $('span', t);
    if (span.textContent !== txt) span.textContent = txt;
    t.classList.toggle('low', left <= 10 && left > 0);
    t.classList.toggle('zero', left === 0);
    return inf.end - c.now();
  }
  function waitHtml(c) {
    const list = doneStatus(c), n = list.filter(x => x.done).length;
    return `<div class="done-row">${list.map(x => `<span class="done-av ${x.done ? 'yes' : ''}">${avatar(x.p, 40)}${x.done ? `<b class="tick">${ICON.check}</b>` : ''}</span>`).join('')}</div>
      <div class="strong">${T(`${n} von ${list.length} fertig`, `${n} of ${list.length} done`)}</div>`;
  }

  /* Allgemeiner Schritt-Controller */
  function StepScreen(el, c0) {
    const inf = info(c0);
    let submitted = false, autoDone = false, destroyed = false;
    const mine = c0.subs.get(inf.id);
    const view = inf.type === 'draw' ? DrawView : TextView;
    const v = view(el, c0, inf, {
      submit: async () => {
        if (submitted) return;
        submitted = true; v.lock(true); refreshWait(); vibrate(15);
        await submit(ctxNow(), inf, v.payload());
      },
      edit: () => { submitted = false; v.lock(false); refreshWait(); }
    });
    let lastC = c0;
    const ctxNow = () => lastC;
    const q = $('[data-quit]', el);
    if (q) q.onclick = async () => { if (await App.confirmBox(T('Spiel verlassen? Die anderen spielen ohne dich weiter. Mit dem Code kannst du wieder rein.', 'Leave the game? The others continue. You can rejoin with the code.'), T('Verlassen', 'Leave'), true)) App.leaveRoom(); };
    if (mine) { v.restore(mine); submitted = true; v.lock(true); }
    function refreshWait() {
      const w = $('[data-wait]', el);
      if (!w) return;
      w.classList.toggle('show', submitted);
      $('[data-waitlist]', w).innerHTML = waitHtml(lastC);
    }
    return {
      update(c) {
        lastC = c; v.update(c);
        // Nach Neuladen kommen die Abgaben oft erst nach dem Raum an: eigene Abgabe dann wiederherstellen
        const m = c.subs.get(inf.id);
        if (m && !submitted && v.isPristine()) { v.restore(m); submitted = true; v.lock(true); }
        refreshWait();
      },
      tick(c) {
        lastC = c;
        const left = updateTimer(el, inf, c);
        if (left <= 0 && !autoDone && !destroyed) {
          autoDone = true;
          if (!submitted) { submitted = true; v.lock(true); refreshWait(); submit(c, inf, v.payload()); }
          v.timeUp && v.timeUp();
        }
      },
      destroy() { destroyed = true; v.destroy && v.destroy(); }
    };
  }

  function waitOverlay() {
    return `<div class="wait-card card" data-wait>
      <div class="wait-title">${ICON.check}<span>${T('Abgegeben! Warte auf die anderen …', 'Submitted! Waiting for the others …')}</span></div>
      <div data-waitlist></div>
      <button class="btn soft" data-edit>${T('Doch noch ändern', 'Change it')}</button>
    </div>`;
  }

  function TextView(el, c, inf, act) {
    const isWrite = inf.type === 'write';
    const prev = inf.prevId ? c.subs.get(inf.prevId) : null;
    el.innerHTML = `<div class="page step ${isWrite ? 'write' : 'describe'}">
      ${headerHtml(inf, isWrite ? '' : T('Was ist das?', 'What is this?'))}
      <div class="step-body">
        ${isWrite ? `<h1 class="step-h1">${T('Schreib einen Satz, den man malen kann', 'Write a sentence someone can draw')}</h1>` : `<div class="describe-pic"><div class="pic-frame" data-pic></div></div>`}
        <form class="card text-card" novalidate>
          <label class="field" for="txt">${isWrite ? T('Dein Satz', 'Your sentence') : T('Beschreib die Zeichnung in einem Satz', 'Describe the drawing in one sentence')}</label>
          <input id="txt" name="t" maxlength="140" autocomplete="off" autocorrect="on" enterkeyhint="done" placeholder="${isWrite ? T('z. B. Ein Hai macht Yoga', 'e.g. A shark doing yoga') : T('Das ist …', 'This is …')}">
          <div class="row between gap">
            ${isWrite ? `<button type="button" class="btn soft" data-idea>🎲 ${T('Idee würfeln', 'Random idea')}</button>` : '<span></span>'}
            <button class="btn green xl shadow" type="submit">${T('Fertig', 'Done')}</button>
          </div>
        </form>
        ${waitOverlay()}
      </div>
    </div>`;
    const f = $('form', el), inp = f.t;
    let picCanvas = null, picRendered = null;
    function renderPic(cc) {
      if (isWrite) return;
      const p = cc.subs.get(inf.prevId);
      const key = p ? (p.d || '') : '';
      if (picRendered === key) return;
      picRendered = key;
      const frame = $('[data-pic]', el);
      if (!picCanvas) { picCanvas = Draw.makeCanvas(1200); frame.appendChild(picCanvas); }
      Draw.renderStatic(picCanvas, key);
      frame.classList.toggle('nothing', !p || !p.d || Draw.decode(p.d).length === 0);
      frame.dataset.nothing = NOTHING();
    }
    renderPic(c);
    void prev;
    if (isWrite) $('[data-idea]', el).onclick = () => {
      const list = T(IDEAS_DE, IDEAS_EN);
      inp.value = list[Math.floor(Math.random() * list.length)];
    };
    f.onsubmit = e => { e.preventDefault(); inp.blur(); act.submit(); };
    $('[data-edit]', el).onclick = () => { act.edit(); setTimeout(() => inp.focus(), 50); };
    return {
      payload: () => ({ text: inp.value.replace(/\s+/g, ' ').trim() }),
      restore: sub => { inp.value = sub.text || ''; },
      isPristine: () => !inp.value,
      lock: on => { inp.disabled = on; $$('button', f).forEach(b => b.disabled = on); },
      update: cc => renderPic(cc),
      timeUp: () => inp.blur()
    };
  }

  function DrawView(el, c, inf, act) {
    const pal = Draw.PALETTE.map((hex, i) => `<button class="swatch ${i === 0 ? 'on' : ''}" style="--sw:${hex}" data-color="${i}" aria-label="${T('Farbe', 'Colour')} ${i + 1}"></button>`).join('');
    const sizes = Draw.SIZES.map((w, i) => `<button class="tool size ${i === 1 ? 'on' : ''}" data-size="${i}" aria-label="${T('Stärke', 'Size')} ${i + 1}"><i style="--d:${Math.max(5, Math.min(26, w))}px"></i></button>`).join('');
    el.innerHTML = `<div class="page step draw">
      ${headerHtml(inf, '')}
      <div class="prompt card"><span class="tag">${T('Mal das', 'Draw this')}</span><span class="prompt-text" data-prompt></span></div>
      <div class="draw-layout">
        <div class="toolbar card" role="toolbar">
          <button class="tool on" data-tool="pen" aria-label="${T('Stift', 'Pen')}"><svg viewBox="0 0 24 24"><path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/></svg></button>
          <button class="tool" data-tool="eraser" aria-label="${T('Radierer', 'Eraser')}"><svg viewBox="0 0 24 24"><path d="M8 20h12"/><path d="M4.5 15.5l9-9a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3L13 19H8.5z"/><path d="M9 11l5 5"/></svg></button>
          <button class="tool" data-tool="fill" aria-label="${T('Füllen', 'Fill')}"><svg viewBox="0 0 24 24"><path d="M5 11l7-7 7 7-7 7z"/><path d="M5 11h14"/><path d="M20 15s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0c0-1 1.5-3 1.5-3z"/></svg></button>
          <span class="sep"></span>
          ${sizes}
          <span class="sep grow"></span>
          <button class="tool" data-undo aria-label="${T('Rückgängig', 'Undo')}"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg></button>
          <button class="tool danger" data-clear aria-label="${T('Alles löschen', 'Clear all')}"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg></button>
        </div>
        <div class="pad-area" data-area><div class="pad-frame" data-frame></div>${waitOverlay()}</div>
        <div class="side">
          <div class="palette card">${pal}</div>
          <button class="btn green xl shadow done-btn" data-done>${T('Fertig', 'Done')}</button>
        </div>
      </div>
    </div>`;
    const canvas = Draw.makeCanvas(1600);
    canvas.classList.add('pad');
    $('[data-frame]', el).appendChild(canvas);
    const pad = Draw.DrawPad(canvas, { onChange: () => {} });
    const area = $('[data-area]', el), frame = $('[data-frame]', el);
    function fit() {
      const r = area.getBoundingClientRect();
      if (!r.width || !r.height) return;
      let w = r.width, h = w * 3 / 4;
      if (h > r.height) { h = r.height; w = h * 4 / 3; }
      frame.style.width = Math.floor(w) + 'px'; frame.style.height = Math.floor(h) + 'px';
    }
    const ro = window.ResizeObserver ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(area); else window.addEventListener('resize', fit);
    setTimeout(fit, 0);

    function setPrompt(cc) {
      const p = cc.subs.get(inf.prevId);
      const txt = p && p.text ? p.text : '';
      const pt = $('[data-prompt]', el);
      const shown = txt || NOTHING() + ' – ' + T('mal, was du willst!', 'draw whatever you like!');
      if (pt.textContent !== shown) { pt.textContent = shown; pt.classList.toggle('nothing', !txt); }
    }
    setPrompt(c);
    $$('[data-tool]', el).forEach(b => b.onclick = () => {
      pad.tool = b.dataset.tool;
      $$('[data-tool]', el).forEach(x => x.classList.toggle('on', x === b));
    });
    $$('[data-size]', el).forEach(b => b.onclick = () => {
      pad.size = +b.dataset.size;
      $$('[data-size]', el).forEach(x => x.classList.toggle('on', x === b));
      if (pad.tool === 'fill') $('[data-tool=pen]', el).click();
    });
    $$('[data-color]', el).forEach(b => b.onclick = () => {
      pad.color = +b.dataset.color;
      $$('[data-color]', el).forEach(x => x.classList.toggle('on', x === b));
      if (pad.tool === 'eraser') $('[data-tool=pen]', el).click();
    });
    $('[data-undo]', el).onclick = () => pad.undo();
    $('[data-clear]', el).onclick = () => pad.clear();
    $('[data-done]', el).onclick = () => act.submit();
    $('[data-edit]', el).onclick = () => act.edit();
    return {
      payload: () => ({ d: pad.encode() }),
      restore: sub => { if (sub.d) pad.load(sub.d); },
      isPristine: () => pad.ops.length === 0,
      lock: on => { pad.enabled = !on; $$('.toolbar button, .palette button, [data-done]', el).forEach(b => b.disabled = on); el.classList.toggle('locked', on); },
      update: cc => setPrompt(cc),
      destroy: () => { if (ro) ro.disconnect(); }
    };
  }

  function SpectatorScreen(el) {
    el.innerHTML = `<div class="center-wrap"><div class="card center-msg">
      <h2>${T('Die Runde läuft schon', 'A round is in progress')}</h2>
      <p>${T('Du bist bei der nächsten Runde dabei. Bleib einfach hier.', 'You will be in the next round. Just stay here.')}</p>
      <button class="btn white" data-leave>${T('Raum verlassen', 'Leave room')}</button></div></div>`;
    $('[data-leave]', el).onclick = () => App.leaveRoom();
    return {};
  }

  /* ---------- Album ---------- */
  function itemHtml(c, ch, s, key) {
    const r = c.room, N = r.order.length;
    const sub = c.subs.get(subId(r.round, s, ch));
    const uid = sub ? sub.uid : r.order[(ch + s) % N];
    const p = r.players[uid] || { n: '?', c: 0 };
    const t = typeOf(s);
    const right = s % 2 === 1;
    const verb = t === 'draw' ? T('hat gemalt', 'drew') : (t === 'write' ? T('hat geschrieben', 'wrote') : T('hat geraten', 'guessed'));
    const body = t === 'draw'
      ? `<div class="album-pic" data-pic="${key}"></div>`
      : `<div class="bubble ${sub && sub.text ? '' : 'nothing'}">${esc(sub && sub.text ? sub.text : NOTHING())}</div>`;
    return `<div class="album-item ${right ? 'right' : ''}" data-item="${key}">
      ${avatar(p, 44)}
      <div class="album-col"><div class="muted strong small">${esc(p.n)} ${verb}</div>${body}<div class="react-row" data-react="${key}"></div></div>
    </div>`;
  }

  function reactHtml(c, sub) {
    if (!sub) return '';
    const re = sub.re || {};
    const counts = REACTIONS.map((_, i) => Object.values(re).filter(v => v === i).length);
    const mine = re[c.me];
    return REACTIONS.map((e, i) => `<button class="react ${mine === i ? 'on' : ''}" data-r="${i}">${e}${counts[i] ? ` <b>${counts[i]}</b>` : ''}</button>`).join('');
  }

  function AlbumScreen(el, c0) {
    const N = c0.room.order.length;
    el.innerHTML = `<div class="page album">
      <aside class="chain-list" data-chains></aside>
      <section class="card album-main">
        <div class="album-feed" data-feed></div>
        <div class="album-bar" data-bar></div>
      </section>
    </div>`;
    let shownChain = -1, shown = new Set(), stops = [], lastC = c0;
    const feed = $('[data-feed]', el);
    function chainsHtml(c) {
      const a = c.room.album || { c: 0, k: 0 };
      return `<div class="album-title">${T('Album', 'Album')}</div>` + c.room.order.map((uid, ch) => {
        const p = c.room.players[uid] || { n: '?', c: 0 };
        const st = ch < a.c ? T('fertig', 'done') : (ch === a.c ? T('läuft gerade', 'now playing') : T('wartet', 'waiting'));
        return `<div class="chain ${ch === a.c ? 'on' : ''} ${ch < a.c ? 'past' : ''}">${avatar(p, 36)}<div><b>${T('Kette von', 'Chain by')} ${esc(p.n)}</b><span class="muted small">${st}</span></div></div>`;
      }).join('');
    }
    function update(c) {
      lastC = c;
      const a = c.room.album || { c: 0, k: 0 };
      const cl = $('[data-chains]', el);
      cl.innerHTML = chainsHtml(c);
      const on = $('.chain.on', cl);
      if (on && cl.scrollWidth > cl.clientWidth) cl.scrollLeft = on.offsetLeft - (cl.clientWidth - on.offsetWidth) / 2;
      if (a.c !== shownChain) {
        stops.forEach(f => f()); stops = [];
        feed.innerHTML = ''; shown = new Set(); shownChain = a.c;
        feed.classList.remove('swap'); void feed.offsetWidth; feed.classList.add('swap');
      }
      for (let s = 0; s <= Math.min(a.k, N - 1); s++) {
        const key = a.c + '-' + s;
        const sub = c.subs.get(subId(c.room.round, s, a.c));
        let node = $(`[data-item="${key}"]`, feed);
        const isNewest = s === a.k;
        if (!node) {
          feed.insertAdjacentHTML('beforeend', itemHtml(c, a.c, s, key));
          node = feed.lastElementChild;
          node.classList.add('reveal');
          shown.add(key);
          if (typeOf(s) === 'draw') {
            const holder = $('[data-pic]', node);
            const cv = Draw.makeCanvas(1200);
            holder.appendChild(cv);
            if (!sub || !sub.d || !Draw.decode(sub.d).length) { holder.classList.add('nothing'); holder.dataset.nothing = NOTHING(); }
            else if (isNewest) stops.push(Draw.replay(cv, sub.d));
            else Draw.renderStatic(cv, sub.d);
          }
          if (isNewest) setTimeout(() => node.scrollIntoView({ behavior: 'smooth', block: 'end' }), 60);
        }
        const rr = $(`[data-react="${key}"]`, node);
        const html = reactHtml(c, sub);
        if (rr.dataset.h !== html) {
          rr.dataset.h = html; rr.innerHTML = html;
          $$('[data-r]', rr).forEach(b => b.onclick = () => react(lastC, s, a.c, +b.dataset.r));
        }
      }
      // Leiste
      const bar = $('[data-bar]', el);
      const lastChain = a.c >= N - 1, lastStep = a.k >= N - 1;
      const label = `${T('Kette', 'Chain')} ${a.c + 1} / ${N} · ${T('Schritt', 'Step')} ${a.k + 1} / ${N}`;
      const html = c.isHost
        ? `<div class="muted strong">${label}</div>
           ${!lastStep ? `<button class="btn soft" data-all>${T('Ganze Kette', 'Whole chain')}</button>` : ''}
           <button class="btn yellow lg shadow" data-next>${lastStep ? (lastChain ? T('Zum Ende', 'Finish') : T('Nächste Kette', 'Next chain')) : T('Weiter', 'Next')}</button>`
        : `<div class="muted strong">${label}</div><div class="muted small">${T('Der Host blättert weiter.', 'The host turns the pages.')}</div>
           <button class="btn soft sm" data-leave>${T('Verlassen', 'Leave')}</button>`;
      if (bar.dataset.h !== html) {
        bar.dataset.h = html; bar.innerHTML = html;
        const nx = $('[data-next]', bar), all = $('[data-all]', bar), lv = $('[data-leave]', bar);
        if (nx) nx.onclick = () => albumStep(lastC, 'next');
        if (all) all.onclick = () => albumStep(lastC, 'all');
        if (lv) lv.onclick = async () => { if (await App.confirmBox(T('Raum verlassen?', 'Leave the room?'), T('Verlassen', 'Leave'), true)) App.leaveRoom(); };
      }
    }
    return { update, destroy: () => stops.forEach(f => f()) };
  }

  function albumStep(c, what) {
    const r = c.room, N = r.order.length, a = r.album || { c: 0, k: 0 };
    let upd;
    if (what === 'all') upd = { album: { c: a.c, k: N - 1 } };
    else if (a.k < N - 1) upd = { album: { c: a.c, k: a.k + 1 } };
    else if (a.c < N - 1) upd = { album: { c: a.c + 1, k: 0 } };
    else upd = { status: 'done' };
    upd.updatedAt = FV().serverTimestamp();
    c.ref.update(upd).catch(e => toast(App.roomError(e), 'err'));
  }

  function react(c, s, ch, i) {
    const id = subId(c.room.round, s, ch);
    const sub = c.subs.get(id);
    if (!sub) return;
    const cur = sub.re && sub.re[c.me];
    vibrate(8);
    c.ref.collection('subs').doc(id).update({ ['re.' + c.me]: cur === i ? FV().delete() : i }).catch(e => console.warn('Reaktion', e));
  }

  /* ---------- Ende ---------- */
  function DoneScreen(el, c0) {
    const r0 = c0.room, N = r0.order.length;
    el.innerHTML = `<div class="page done">
      <header class="topbar">
        <h1 class="hero-title">${T('Das war\'s!', 'That\'s it!')}</h1>
        <div class="row gap" data-actions></div>
      </header>
      <div class="gallery">${r0.order.map((uid, ch) => {
        const p = r0.players[uid] || { n: '?', c: 0 };
        return `<section class="card gallery-chain"><h3>${avatar(p, 32)} ${T('Kette von', 'Chain by')} ${esc(p.n)}</h3><div class="gallery-row">${
          Array.from({ length: N }, (_, s) => `<div class="g-item ${typeOf(s) === 'draw' ? 'pic' : 'txt'}" data-g="${ch}-${s}"></div>`).join('')}</div></section>`;
      }).join('')}</div>
    </div>`;
    const io = window.IntersectionObserver ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { fill(e.target); io.unobserve(e.target); } }), { rootMargin: '200px' }) : null;
    let lastC = c0;
    function fill(node) {
      const [ch, s] = node.dataset.g.split('-').map(Number);
      const c = lastC, sub = c.subs.get(subId(c.room.round, s, ch));
      const uid = sub ? sub.uid : c.room.order[(ch + s) % N];
      const p = c.room.players[uid] || { n: '?' };
      if (typeOf(s) === 'draw') {
        const cv = Draw.makeCanvas(640);
        node.innerHTML = '';
        node.appendChild(cv);
        if (sub && sub.d) Draw.renderStatic(cv, sub.d); else node.classList.add('nothing');
      } else {
        node.innerHTML = `<div class="bubble ${sub && sub.text ? '' : 'nothing'}">${esc(sub && sub.text ? sub.text : NOTHING())}</div>`;
      }
      node.insertAdjacentHTML('beforeend', `<div class="muted small">${esc(p.n)}</div>`);
    }
    $$('[data-g]', el).forEach(n => io ? io.observe(n) : fill(n));
    let busy = false;
    function update(c) {
      lastC = c;
      const a = $('[data-actions]', el);
      const html = c.isHost
        ? `<button class="btn white" data-leave>${T('Verlassen', 'Leave')}</button><button class="btn green lg shadow" data-again ${busy ? 'disabled' : ''}>${T('Nochmal spielen', 'Play again')}</button>`
        : `<span class="waiting-host light"><span class="dots-anim"><i></i><i></i><i></i></span>${T('Warte auf den Host …', 'Waiting for host …')}</span><button class="btn white" data-leave>${T('Verlassen', 'Leave')}</button>`;
      if (a.dataset.h === html) return;
      a.dataset.h = html; a.innerHTML = html;
      $('[data-leave]', a).onclick = async () => { if (await App.confirmBox(T('Raum verlassen?', 'Leave the room?'), T('Verlassen', 'Leave'), true)) App.leaveRoom(); };
      const ag = $('[data-again]', a);
      if (ag) ag.onclick = async () => { busy = true; update(lastC); try { await playAgain(lastC); } catch (e) { toast(App.roomError(e), 'err'); } busy = false; };
    }
    return { update, destroy: () => io && io.disconnect() };
  }

  async function playAgain(c) {
    const r = c.room, db = App.db;
    // Alte Abgaben löschen (spart Speicher), dann zurück in die Lobby
    const ids = Array.from(c.subs.keys());
    for (let i = 0; i < ids.length; i += 400) {
      const b = db.batch();
      ids.slice(i, i + 400).forEach(id => b.delete(c.ref.collection('subs').doc(id)));
      await b.commit();
    }
    const upd = {
      status: 'lobby', order: FV().delete(), step: FV().delete(), stepStart: FV().delete(), stepDur: FV().delete(), album: FV().delete(),
      updatedAt: FV().serverTimestamp(), expiresAt: App.TS.fromMillis(Date.now() + 4 * 3600 * 1000)
    };
    Object.entries(r.players).forEach(([uid, p]) => { if (p.left) upd['players.' + uid] = FV().delete(); });
    await c.ref.update(upd);
  }

  App.registerGame({
    id: 'kritzelpost',
    title: () => 'Kritzelpost',
    blurb: () => T('Satz schreiben, malen, raten. Am Ende siehst du, was aus deinem Satz geworden ist.', 'Write, draw, guess. In the end you see what became of your sentence.'),
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/></svg>',
    minPlayers: 3,
    defaultSettings: { draw: 90, write: 45 },
    settings: [
      { key: 'draw', label: () => T('Zeit pro Zeichnung', 'Time per drawing'), options: [60, 90, 120] },
      { key: 'write', label: () => T('Zeit pro Satz', 'Time per sentence'), options: [30, 45, 60] }
    ],
    lobbyHint: n => T(`${n} Spieler = ${n} Schritte, ca. ${Math.max(3, Math.round(n * 1.4))} Minuten.`, `${n} players = ${n} steps, about ${Math.max(3, Math.round(n * 1.4))} minutes.`),
    start, tick,
    view(c) {
      const r = c.room;
      if (r.status === 'play') {
        if (!r.order || r.order.indexOf(c.me) < 0) return { key: 'kp-spec-' + r.round, factory: SpectatorScreen };
        return { key: `kp-${r.round}-${r.step}`, factory: StepScreen };
      }
      if (r.status === 'album') {
        if (!r.order) return { key: 'kp-spec-a', factory: SpectatorScreen };
        return { key: 'kp-album-' + r.round, factory: AlbumScreen };
      }
      return { key: 'kp-done-' + r.round, factory: DoneScreen };
    }
  });
})();
