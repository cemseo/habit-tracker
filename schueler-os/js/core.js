/* Schüler OS: Login, Startseite, Räume, Lobby. Spiele registrieren sich über App.registerGame(). */
(function () {
  'use strict';

  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyDwahmidKJUcryp09ATk1u27UQiABswx2M',
    authDomain: 'goal-and-habit-tracker-4bd83.firebaseapp.com',
    projectId: 'goal-and-habit-tracker-4bd83',
    storageBucket: 'goal-and-habit-tracker-4bd83.firebasestorage.app',
    messagingSenderId: '47842969300',
    appId: '1:47842969300:web:0ad2868cbba707c1ef9d41'
  };
  const ROOMS = 'schuelerOsRooms';                     // eigene oberste Sammlung, nichts unter users/
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O, 1/I
  const COLORS = ['#FF8A3D', '#FFD23F', '#3DDC97', '#B57BFF', '#5BC8FF', '#FF6FA8', '#FF5D4A', '#8BE04E', '#2EC4B6', '#F2B880', '#A8B0D0', '#E0C3FF'];
  const MAX_PLAYERS = 12;
  const HEARTBEAT_MS = window.__PS_HEARTBEAT_MS || 45000;
  const STALE_MS = window.__PS_STALE_MS || 110000;
  const ROOM_TTL_MS = 4 * 3600 * 1000;

  const GAMES = {};
  const GAME_LIST = [
    { id: 'kritzelpost' },
    { id: 'slf', soon: true, de: 'Stadt-Land-Fluss', en: 'Categories', dDe: 'Buchstabe, Kategorien, schnell sein.', dEn: 'One letter, many categories, be quick.', color: '#3DDC97' },
    { id: 'karten', soon: true, de: 'Kartenspiel', en: 'Card game', dDe: 'Farben und Zahlen ablegen, wer zuerst leer ist.', dEn: 'Match colours and numbers, empty your hand first.', color: '#FF6FA8' },
    { id: 'verraeter', soon: true, de: 'Verräter-Spiel', en: 'Traitor game', dDe: 'Einer von euch lügt. Findet ihn.', dEn: 'One of you is lying. Find them.', color: '#B57BFF' }
  ];

  const S = {
    lang: lsGet('ps_lang') === 'en' ? 'en' : 'de',
    authReady: false, user: null, name: '',
    roomCode: null, room: null, subs: new Map(), subsRound: null,
    offset: 0, offsetSamples: [], pendingBeat: null
  };
  let auth, db, FV, TS;
  let unsubRoom = null, unsubSubs = null, current = null, lastLeaveMsg = '';

  /* ---------- kleine Helfer ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* privat */ } }
  const T = (de, en) => (S.lang === 'en' ? en : de);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const tsMs = t => (t && typeof t.toMillis === 'function') ? t.toMillis() : (typeof t === 'number' ? t : null);
  const serverNow = () => Date.now() + S.offset;
  const vibrate = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* egal */ } };
  const initial = n => (String(n || '?').trim()[0] || '?').toUpperCase();

  function toast(msg, kind) {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    box.appendChild(t);
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 5200 : 3200);
  }

  function confirmBox(text, okLabel, danger) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = `<div class="modal card" role="dialog" aria-modal="true">
        <p>${esc(text)}</p>
        <div class="row gap end">
          <button class="btn soft" data-no>${T('Abbrechen', 'Cancel')}</button>
          <button class="btn ${danger ? 'danger' : 'yellow'}" data-yes>${esc(okLabel)}</button>
        </div></div>`;
      document.body.appendChild(wrap);
      requestAnimationFrame(() => wrap.classList.add('in'));
      const done = v => { wrap.classList.remove('in'); setTimeout(() => wrap.remove(), 200); resolve(v); };
      wrap.addEventListener('click', e => { if (e.target === wrap) done(false); });
      $('[data-no]', wrap).onclick = () => done(false);
      $('[data-yes]', wrap).onclick = () => done(true);
    });
  }

  function avatar(p, size, extra) {
    const c = COLORS[(p && p.c) || 0] || COLORS[0];
    return `<span class="avatar ${extra || ''}" style="--av:${c};--sz:${size || 44}px" aria-hidden="true">${esc(initial(p && p.n))}</span>`;
  }

  const LOGO = `<svg viewBox="0 0 38 38" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 26c4-10 8-14 11-9s5 9 9 2 6-11 8-8"/><circle cx="31" cy="8" r="3"/></svg>`;
  const ICON = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    enter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/></svg>',
    crown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18h18l-2-10-4 4-3-6-3 6-4-4z"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M10 2h4"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>'
  };

  /* ---------- Bildschirmsteuerung ---------- */
  function ctx() {
    const me = S.user ? S.user.uid : null;
    return {
      room: S.room, code: S.roomCode, me, name: S.name, subs: S.subs,
      isHost: !!(S.room && S.room.hostUid === me),
      now: serverNow, ref: S.roomCode ? db.collection(ROOMS).doc(S.roomCode) : null,
      isStale, activePlayers
    };
  }

  function show(key, factory) {
    const app = $('#app');
    if (current && current.key === key) { if (current.ctl.update) current.ctl.update(ctx()); return; }
    if (current && current.ctl.destroy) { try { current.ctl.destroy(); } catch (e) { console.warn(e); } }
    const el = document.createElement('div');
    el.className = 'screen enter';
    app.replaceChildren(el);
    window.scrollTo(0, 0);
    const ctl = factory(el, ctx()) || {};
    current = { key, ctl };
    if (ctl.update) ctl.update(ctx());
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('enter')));
  }

  function render() {
    if (!S.authReady) return;
    if (!S.user) return show('auth', AuthScreen);
    if (!S.name || S.editName) return show('name', NameScreen);
    if (!S.roomCode) return show('hub', HubScreen);
    if (!S.room) return show('loading-' + S.roomCode, LoadingScreen);
    if (S.room.status === 'lobby') return show('lobby-' + S.roomCode, LobbyScreen);
    const g = GAMES[S.room.game];
    if (!g) return show('unknown', el => { el.innerHTML = `<div class="center-msg card">${T('Dieses Spiel kennt die App noch nicht. Bitte Seite neu laden.', 'Unknown game. Please reload.')}</div>`; });
    const v = g.view(ctx());
    show(v.key, v.factory);
  }

  /* ---------- Login ---------- */
  function authError(e) {
    const c = (e && e.code) || '';
    if (c.includes('invalid-email')) return T('Die E-Mail-Adresse sieht falsch aus.', 'That email looks wrong.');
    if (c.includes('wrong-password') || c.includes('invalid-credential') || c.includes('user-not-found') || c.includes('invalid-login')) return T('E-Mail oder Passwort stimmt nicht.', 'Wrong email or password.');
    if (c.includes('email-already-in-use')) return T('Mit dieser E-Mail gibt es schon ein Konto. Melde dich an.', 'This email already has an account. Sign in.');
    if (c.includes('weak-password')) return T('Passwort muss mindestens 6 Zeichen haben.', 'Password needs at least 6 characters.');
    if (c.includes('too-many-requests')) return T('Zu viele Versuche. Warte kurz.', 'Too many attempts. Wait a moment.');
    if (c.includes('network')) return T('Keine Verbindung zum Internet.', 'No internet connection.');
    return T('Hat nicht geklappt: ', 'Did not work: ') + (c || (e && e.message) || '?');
  }

  function langToggle() {
    return `<button class="linkbtn" data-lang>${S.lang === 'de' ? 'DE · <u>EN</u>' : '<u>DE</u> · EN'}</button>`;
  }
  function bindLang(el) {
    $$('[data-lang]', el).forEach(b => b.onclick = () => { S.lang = S.lang === 'de' ? 'en' : 'de'; lsSet('ps_lang', S.lang); document.documentElement.lang = S.lang; current = null; render(); });
  }

  function AuthScreen(el) {
    let mode = 'in', busy = false;
    function draw(msg, info) {
      el.innerHTML = `<div class="auth-wrap">
        <div class="auth-intro">
          <div class="brand big"><span class="logo">${LOGO}</span><span>Schüler OS</span></div>
          <h1>${T('Ein Konto.<br>Alle Spiele.', 'One account.<br>All the games.')}</h1>
          <p>${T('Melde dich mit demselben Konto an wie im Habit Tracker. Dann Raum auf, Code ansagen, losspielen.', 'Sign in with the same account as the habit tracker. Open a room, share the code, play.')}</p>
        </div>
        <form class="card auth-card" novalidate>
          <div class="seg" role="tablist">
            <button type="button" role="tab" class="${mode === 'in' ? 'on' : ''}" data-mode="in">${T('Anmelden', 'Sign in')}</button>
            <button type="button" role="tab" class="${mode === 'up' ? 'on' : ''}" data-mode="up">${T('Registrieren', 'Sign up')}</button>
          </div>
          <label class="field">${T('E-Mail', 'Email')}<input name="email" type="email" autocomplete="email" autocapitalize="off" required></label>
          <label class="field">${T('Passwort', 'Password')}<input name="pw" type="password" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}" required minlength="6"></label>
          ${msg ? `<div class="form-msg err">${esc(msg)}</div>` : ''}
          ${info ? `<div class="form-msg ok">${esc(info)}</div>` : ''}
          <button class="btn yellow xl" type="submit" ${busy ? 'disabled' : ''}>${busy ? T('Moment …', 'One moment …') : (mode === 'in' ? T('Los geht\'s', 'Let\'s go') : T('Konto erstellen', 'Create account'))}</button>
          <div class="row between small">
            <button type="button" class="linkbtn" data-reset>${T('Passwort vergessen?', 'Forgot password?')}</button>
            ${langToggle()}
          </div>
        </form></div>`;
      bindLang(el);
      const f = $('form', el);
      $$('[data-mode]', el).forEach(b => b.onclick = () => { mode = b.dataset.mode; const em = f.email.value; draw(); $('form', el).email.value = em; });
      $('[data-reset]', el).onclick = async () => {
        const email = f.email.value.trim();
        if (!email) return draw(T('Gib zuerst deine E-Mail ein.', 'Enter your email first.'));
        try { await auth.sendPasswordResetEmail(email); draw('', T('Wenn es das Konto gibt, kommt gleich eine E-Mail.', 'If the account exists, an email is on its way.')); }
        catch (e) { draw(authError(e)); }
        $('form', el).email.value = email;
      };
      f.onsubmit = async e => {
        e.preventDefault();
        if (busy) return;
        const email = f.email.value.trim(), pw = f.pw.value;
        if (!email || !pw) return;
        busy = true; draw(); const f2 = $('form', el); f2.email.value = email; f2.pw.value = pw;
        try {
          if (mode === 'in') await auth.signInWithEmailAndPassword(email, pw);
          else await auth.createUserWithEmailAndPassword(email, pw);
        } catch (err) {
          busy = false; draw(authError(err)); const f3 = $('form', el); f3.email.value = email;
        }
      };
    }
    draw();
    return {};
  }

  function NameScreen(el) {
    el.innerHTML = `<div class="center-wrap"><form class="card name-card">
      <h2>${T('Wie sollen dich die anderen sehen?', 'What should others call you?')}</h2>
      <label class="field">${T('Anzeigename', 'Display name')}<input name="n" maxlength="16" autocomplete="nickname" required value="${esc(S.name || '')}"></label>
      <button class="btn green xl" type="submit">${T('Speichern', 'Save')}</button>
      ${S.editName ? `<button type="button" class="btn soft" data-cancel>${T('Abbrechen', 'Cancel')}</button>` : `<button type="button" class="linkbtn" data-out>${T('Abmelden', 'Sign out')}</button>`}
    </form></div>`;
    const f = $('form', el);
    setTimeout(() => f.n.focus(), 50);
    if ($('[data-out]', el)) $('[data-out]', el).onclick = () => auth.signOut();
    if ($('[data-cancel]', el)) $('[data-cancel]', el).onclick = () => { S.editName = false; render(); };
    f.onsubmit = async e => {
      e.preventDefault();
      const n = f.n.value.replace(/\s+/g, ' ').trim().slice(0, 16);
      if (n.length < 2) return toast(T('Mindestens 2 Zeichen.', 'At least 2 characters.'), 'err');
      await saveName(n);
    };
    return {};
  }

  async function saveName(n) {
    S.name = n; S.editName = false;
    lsSet('ps_name_' + S.user.uid, n);
    try { await S.user.updateProfile({ displayName: n }); } catch (e) { console.warn('Name nur lokal gespeichert', e); }
    current = null; render();
  }

  /* ---------- Startseite ---------- */
  function HubScreen(el) {
    const kp = GAMES.kritzelpost;
    el.innerHTML = `<div class="page hub">
      <header class="topbar">
        <div class="brand"><span class="logo">${LOGO}</span><span>Schüler OS</span></div>
        <div class="row gap">
          ${langToggle()}
          <div class="profile-chip">
            ${avatar({ n: S.name, c: 0 }, 36)}
            <button class="linkbtn strong" data-name title="${T('Namen ändern', 'Change name')}">${esc(S.name)}</button>
            <button class="btn soft sm" data-out>${T('Abmelden', 'Sign out')}</button>
          </div>
        </div>
      </header>
      <h1 class="hero-title">${T('Was spielen wir?', 'What are we playing?')}</h1>
      <div class="hub-grid">
        <section class="game-pick">
          <article class="card game-card main" style="--gc:#FFD23F">
            <div class="game-badge">${kp.icon}</div>
            <div class="game-text">
              <h2>${esc(kp.title())}</h2>
              <p>${esc(kp.blurb())}</p>
              <p class="meta">${T('3 bis 12 Spieler · ca. 8 Minuten', '3 to 12 players · about 8 minutes')}</p>
            </div>
            <button class="btn ink xl" data-create>${ICON.plus}${T('Raum erstellen', 'Create room')}</button>
          </article>
          <div class="soon-grid">
            ${GAME_LIST.filter(g => g.soon).map(g => `<article class="card game-card soon" style="--gc:${g.color}" aria-disabled="true">
              <span class="pill">${T('Bald', 'Soon')}</span>
              <h3>${esc(T(g.de, g.en))}</h3>
              <p>${esc(T(g.dDe, g.dEn))}</p>
            </article>`).join('')}
          </div>
        </section>
        <form class="card join-card" novalidate>
          <div class="game-badge green">${ICON.enter}</div>
          <h2>${T('Raum beitreten', 'Join a room')}</h2>
          <p>${T('Code vom Host eintippen.', 'Type the code from the host.')}</p>
          <label class="sr" for="code-in">${T('Raumcode', 'Room code')}</label>
          <input id="code-in" class="code-input" name="code" maxlength="6" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" inputmode="text" placeholder="K7PQ2M">
          <button class="btn green xl" type="submit">${T('Beitreten', 'Join')}</button>
        </form>
      </div>
    </div>`;
    bindLang(el);
    $('[data-out]', el).onclick = async () => { if (await confirmBox(T('Abmelden? Das gilt auch für den Habit Tracker auf diesem Gerät.', 'Sign out? This also signs you out of the habit tracker on this device.'), T('Abmelden', 'Sign out'), true)) auth.signOut(); };
    $('[data-name]', el).onclick = () => { S.editName = true; render(); };
    const createBtn = $('[data-create]', el);
    createBtn.onclick = async () => {
      createBtn.disabled = true;
      try { await createRoom('kritzelpost'); } catch (e) { toast(roomError(e), 'err'); }
      createBtn.disabled = false;
    };
    const f = $('form', el), inp = f.code;
    inp.addEventListener('input', () => {
      const clean = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (inp.value !== clean) inp.value = clean;
    });
    f.onsubmit = async e => {
      e.preventDefault();
      const code = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 6) return toast(T('Der Code hat 6 Zeichen.', 'The code has 6 characters.'), 'err');
      const btn = $('button[type=submit]', f); btn.disabled = true;
      try { await joinRoom(code); } catch (err) { toast(roomError(err), 'err'); }
      btn.disabled = false;
    };
    return {};
  }

  function LoadingScreen(el) {
    el.innerHTML = `<div class="center-msg card">${T('Verbinde mit Raum …', 'Connecting to room …')}</div>`;
    return {};
  }

  /* ---------- Räume ---------- */
  function roomError(e) {
    const c = (e && (e.code || e.message)) || '';
    if (c === 'not-found') return T('Diesen Raum gibt es nicht. Code prüfen.', 'Room not found. Check the code.');
    if (c === 'full') return T('Der Raum ist voll (12 Spieler).', 'The room is full (12 players).');
    if (c === 'running') return T('Das Spiel läuft schon. Warte, bis die Runde vorbei ist.', 'The game is already running. Wait until the round ends.');
    if (c === 'few') return T('Mindestens 3 Spieler, die online sind.', 'At least 3 players who are online.');
    if (String(c).includes('permission')) return T('Keine Berechtigung. Sind die Firestore-Regeln für Schüler OS veröffentlicht?', 'Permission denied. Are the Firestore rules published?');
    if (String(c).includes('unavailable') || String(c).includes('network')) return T('Keine Verbindung. Prüf das WLAN.', 'No connection. Check the Wi-Fi.');
    return T('Fehler: ', 'Error: ') + c;
  }
  const err = code => Object.assign(new Error(code), { code });

  function randomCode() {
    const a = new Uint32Array(6);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, n => CODE_CHARS[n % CODE_CHARS.length]).join('');
  }
  function freeColor(players) {
    const used = new Set(Object.values(players || {}).map(p => p.c));
    for (let i = 0; i < COLORS.length; i++) if (!used.has(i)) return i;
    return Object.keys(players || {}).length % COLORS.length;
  }
  function playerEntry(c) { return { n: S.name, c, j: Date.now(), s: FV.serverTimestamp(), left: false }; }
  function isStale(p) {
    if (!p) return true;
    const s = tsMs(p.s);
    return s != null && serverNow() - s > STALE_MS;
  }
  function activePlayers(room) {
    return Object.entries((room && room.players) || {}).filter(([, p]) => !p.left).sort((a, b) => (a[1].j || 0) - (b[1].j || 0));
  }

  async function createRoom(gameId) {
    const g = GAMES[gameId];
    const me = S.user.uid;
    let code = null;
    for (let tries = 0; tries < 6 && !code; tries++) {
      const c = randomCode();
      const ref = db.collection(ROOMS).doc(c);
      code = await db.runTransaction(async t => {
        const snap = await t.get(ref);
        if (snap.exists) return null;
        t.set(ref, {
          code: c, game: gameId, hostUid: me, status: 'lobby', round: 0,
          settings: Object.assign({}, g.defaultSettings),
          players: { [me]: playerEntry(0) },
          createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
          expiresAt: TS.fromMillis(Date.now() + ROOM_TTL_MS)
        });
        return c;
      });
    }
    if (!code) throw err('Kein freier Code gefunden');
    S.pendingBeat = null; // erster Abgleich mit dem nächsten Heartbeat
    setTimeout(heartbeat, 1500);
    enterRoom(code);
    setTimeout(cleanupExpired, 4000);
  }

  async function joinRoom(code) {
    const me = S.user.uid;
    const ref = db.collection(ROOMS).doc(code);
    const tStart = Date.now();
    await db.runTransaction(async t => {
      const snap = await t.get(ref);
      if (!snap.exists) throw err('not-found');
      const r = snap.data();
      const p = r.players || {};
      if (p[me]) {
        t.update(ref, { ['players.' + me + '.left']: false, ['players.' + me + '.n']: S.name, ['players.' + me + '.s']: FV.serverTimestamp() });
        return;
      }
      if (r.status !== 'lobby' && r.status !== 'done') throw err('running');
      if (Object.keys(p).length >= MAX_PLAYERS) throw err('full');
      t.update(ref, { ['players.' + me]: playerEntry(freeColor(p)), updatedAt: FV.serverTimestamp() });
    });
    S.pendingBeat = { t: tStart + (Date.now() - tStart) * 0.75, prev: null };
    enterRoom(code);
    vibrate(15);
  }

  function enterRoom(code) {
    stopListeners();
    S.roomCode = code; S.room = null; S.subs = new Map(); S.subsRound = null;
    lsSet('ps_room_' + S.user.uid, code);
    const ref = db.collection(ROOMS).doc(code);
    let first = true;
    unsubRoom = ref.onSnapshot({ includeMetadataChanges: true }, snap => {
      if (S.roomCode !== code) return;
      if (!snap.exists) {
        if (snap.metadata.fromCache && first) return; // Erst Server abwarten
        return leaveLocal(T('Der Raum wurde geschlossen.', 'The room was closed.'));
      }
      first = false;
      const data = snap.data({ serverTimestamps: 'estimate' });
      const me = S.user.uid;
      if (!data.players || !data.players[me]) {
        if (snap.metadata.hasPendingWrites || snap.metadata.fromCache) return;
        return leaveLocal(T('Du bist nicht mehr in diesem Raum.', 'You are no longer in this room.'));
      }
      if (S.pendingBeat && !snap.metadata.hasPendingWrites && !snap.metadata.fromCache) {
        const s = tsMs(data.players[me].s);
        if (s != null && s !== S.pendingBeat.prev) {
          const mid = (S.pendingBeat.t + Date.now()) / 2;
          S.offsetSamples.push(s - mid);
          if (S.offsetSamples.length > 5) S.offsetSamples.shift();
          const sorted = S.offsetSamples.slice().sort((a, b) => a - b);
          S.offset = sorted[Math.floor(sorted.length / 2)];
          S.pendingBeat = null;
        }
      }
      if (data.players[me].left && !snap.metadata.hasPendingWrites) {
        // Ich war als "weg" markiert, bin aber wieder da (z. B. andere Registerkarte)
        ref.update({ ['players.' + me + '.left']: false }).catch(() => {});
      }
      S.room = data;
      syncSubs();
      render();
    }, e => {
      console.warn('Raum-Listener', e);
      if (S.roomCode === code) leaveLocal(roomError(e));
    });
  }

  function syncSubs() {
    const r = S.room;
    const want = r && r.status !== 'lobby' ? r.round : null;
    if (want === S.subsRound) return;
    if (unsubSubs) { unsubSubs(); unsubSubs = null; }
    S.subs = new Map(); S.subsRound = want;
    if (want == null) return;
    const code = S.roomCode;
    unsubSubs = db.collection(ROOMS).doc(code).collection('subs').where('r', '==', want).onSnapshot(q => {
      if (S.roomCode !== code || S.subsRound !== want) return;
      const m = new Map();
      q.docs.forEach(d => m.set(d.id, d.data({ serverTimestamps: 'estimate' })));
      S.subs = m;
      render();
    }, e => { console.warn('Abgaben-Listener', e); toast(roomError(e), 'err'); });
  }

  function stopListeners() {
    if (unsubRoom) { unsubRoom(); unsubRoom = null; }
    if (unsubSubs) { unsubSubs(); unsubSubs = null; }
  }

  function leaveLocal(msg) {
    stopListeners();
    if (S.user) lsSet('ps_room_' + S.user.uid, null);
    S.roomCode = null; S.room = null; S.subs = new Map(); S.subsRound = null;
    if (msg && msg !== lastLeaveMsg) { toast(msg); lastLeaveMsg = msg; setTimeout(() => { lastLeaveMsg = ''; }, 3000); }
    render();
  }

  async function deleteRoomFully(ref) {
    const subs = await ref.collection('subs').get();
    const docs = subs.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const b = db.batch();
      docs.slice(i, i + 400).forEach(d => b.delete(d.ref));
      await b.commit();
    }
    await ref.delete();
  }

  async function leaveRoom() {
    const code = S.roomCode, me = S.user.uid;
    if (!code) return;
    const ref = db.collection(ROOMS).doc(code);
    const r = S.room;
    leaveLocal();
    try {
      if (r && Object.keys(r.players || {}).length <= 1) { await deleteRoomFully(ref); return; }
      await db.runTransaction(async t => {
        const snap = await t.get(ref);
        if (!snap.exists) return;
        const d = snap.data();
        if (!d.players || !d.players[me]) return;
        const upd = { updatedAt: FV.serverTimestamp() };
        const inGame = d.status === 'play' || d.status === 'album';
        if (inGame) upd['players.' + me + '.left'] = true;
        else upd['players.' + me] = FV.delete();
        if (d.hostUid === me) {
          const next = activePlayers(d).filter(([u, p]) => u !== me && !isStale(p))[0] || activePlayers(d).filter(([u]) => u !== me)[0];
          if (next) upd.hostUid = next[0];
        }
        t.update(ref, upd);
      });
    } catch (e) { console.warn('Verlassen', e); }
  }

  async function kick(uid) {
    if (!S.room || S.room.hostUid !== S.user.uid) return;
    try { await db.collection(ROOMS).doc(S.roomCode).update({ ['players.' + uid]: FV.delete(), updatedAt: FV.serverTimestamp() }); }
    catch (e) { toast(roomError(e), 'err'); }
  }

  async function cleanupExpired() {
    try {
      const q = await db.collection(ROOMS).where('expiresAt', '<', TS.now()).limit(3).get();
      for (const d of q.docs) await deleteRoomFully(d.ref);
    } catch (e) { console.warn('Aufräumen übersprungen', e && e.code); }
  }

  function heartbeat() {
    if (!S.roomCode || !S.room || document.visibilityState !== 'visible') return;
    const me = S.user.uid;
    const mine = S.room.players && S.room.players[me];
    S.pendingBeat = { t: Date.now(), prev: mine ? tsMs(mine.s) : null };
    db.collection(ROOMS).doc(S.roomCode).update({ ['players.' + me + '.s']: FV.serverTimestamp() }).catch(e => console.warn('Heartbeat', e && e.code));
  }

  let lastHostTry = 0;
  function hostWatch() {
    const r = S.room;
    if (!r || !S.user) return;
    const me = S.user.uid;
    if (r.hostUid === me) return;
    const host = r.players && r.players[r.hostUid];
    if (host && !host.left && !isStale(host)) return;
    const cand = activePlayers(r).filter(([, p]) => !isStale(p));
    if (!cand.length || cand[0][0] !== me) return;
    if (Date.now() - lastHostTry < 8000) return;
    lastHostTry = Date.now();
    const ref = db.collection(ROOMS).doc(S.roomCode);
    db.runTransaction(async t => {
      const snap = await t.get(ref);
      if (!snap.exists) return;
      const d = snap.data();
      const h = d.players && d.players[d.hostUid];
      if (h && !h.left && !isStale(h)) return;
      t.update(ref, { hostUid: me, updatedAt: FV.serverTimestamp() });
    }).then(() => toast(T('Du bist jetzt Host.', 'You are host now.'))).catch(e => console.warn('Host-Wechsel', e));
  }

  /* ---------- Lobby ---------- */
  function LobbyScreen(el) {
    const g = GAMES[S.room.game];
    el.innerHTML = `<div class="page lobby">
      <header class="topbar">
        <button class="btn white" data-leave>${ICON.back}${T('Verlassen', 'Leave')}</button>
        <div class="topbar-title">${esc(g ? g.title() : '')} · Lobby</div>
        <div class="topbar-spacer"></div>
      </header>
      <div class="lobby-grid">
        <div class="lobby-side">
          <div class="card code-card">
            <div class="label">${T('Raumcode', 'Room code')}</div>
            <div class="code-big" data-code></div>
            <button class="btn white sm" data-copy>${T('Code kopieren', 'Copy code')}</button>
          </div>
          <div class="card settings-card" data-settings></div>
        </div>
        <div class="card players-card">
          <div class="row between baseline"><h2>${T('Spieler', 'Players')}</h2><div class="muted strong" data-count></div></div>
          <div class="player-grid" data-players></div>
          <div class="lobby-foot" data-foot></div>
        </div>
      </div>
    </div>`;
    $('[data-leave]', el).onclick = async () => { if (await confirmBox(T('Raum verlassen?', 'Leave the room?'), T('Verlassen', 'Leave'), true)) leaveRoom(); };
    $('[data-copy]', el).onclick = () => {
      try { navigator.clipboard.writeText(S.roomCode).then(() => toast(T('Code kopiert', 'Code copied'))); } catch (e) { /* egal */ }
    };
    let seenPlayers = new Set();
    let starting = false;
    function update(c) {
      const r = c.room;
      $('[data-code]', el).textContent = c.code;
      // Einstellungen
      const sDiv = $('[data-settings]', el);
      const sHtml = `<h3>${T('Einstellungen', 'Settings')}</h3>` + g.settings.map(st => `
        <div class="setting"><div class="label">${esc(st.label())}</div>
          <div class="seg3">${st.options.map(o => `<button class="${r.settings && r.settings[st.key] === o ? 'on' : ''}" data-set="${st.key}" data-val="${o}" ${c.isHost ? '' : 'disabled'}>${o} s</button>`).join('')}</div>
        </div>`).join('') + (c.isHost ? '' : `<p class="muted small">${T('Nur der Host kann das ändern.', 'Only the host can change this.')}</p>`);
      if (sDiv.dataset.h !== sHtml) { sDiv.dataset.h = sHtml; sDiv.innerHTML = sHtml; }
      $$('[data-set]', sDiv).forEach(b => b.onclick = () => {
        c.ref.update({ ['settings.' + b.dataset.set]: +b.dataset.val, updatedAt: FV.serverTimestamp() }).catch(e => toast(roomError(e), 'err'));
      });
      // Spieler
      const list = activePlayers(r);
      $('[data-count]', el).textContent = list.length + ' / ' + MAX_PLAYERS;
      const pDiv = $('[data-players]', el);
      const pHtml = list.map(([uid, p]) => {
        const stale = isStale(p), host = uid === r.hostUid, mine = uid === c.me;
        const isNew = !seenPlayers.has(uid);
        return `<div class="player ${host ? 'host' : ''} ${stale ? 'stale' : ''} ${isNew ? 'pop' : ''}">
          ${avatar(p, 52)}
          <div class="pname"><b>${esc(p.n)}${mine ? ` <span class="muted">(${T('du', 'you')})</span>` : ''}</b>
          <span class="muted small">${host ? ICON.crown + 'Host' : (stale ? T('offline?', 'offline?') : T('bereit', 'ready'))}</span></div>
          ${c.isHost && !mine ? `<button class="icon-btn" aria-label="${T('Entfernen', 'Remove')}" data-kick="${esc(uid)}">${ICON.x}</button>` : ''}
        </div>`;
      }).join('') + (list.length < MAX_PLAYERS ? `<div class="player empty">${T('Warte auf mehr …', 'Waiting for more …')}</div>` : '');
      const pKey = pHtml.replace(/ pop/g, '');
      if (pDiv.dataset.h !== pKey) { pDiv.dataset.h = pKey; pDiv.innerHTML = pHtml; }
      seenPlayers = new Set(list.map(([u]) => u));
      $$('[data-kick]', pDiv).forEach(b => b.onclick = async () => {
        const p = r.players[b.dataset.kick];
        if (await confirmBox(T(`${p ? p.n : 'Spieler'} aus dem Raum entfernen?`, `Remove ${p ? p.n : 'player'}?`), T('Entfernen', 'Remove'), true)) kick(b.dataset.kick);
      });
      // Start
      const online = list.filter(([, p]) => !isStale(p)).length;
      const min = g.minPlayers;
      const foot = $('[data-foot]', el);
      let fHtml;
      if (c.isHost) {
        fHtml = `<div class="muted">${online < min ? T(`Noch ${min - online} Spieler fehlen (mindestens ${min}).`, `${min - online} more players needed (min ${min}).`) : esc(g.lobbyHint(online))}</div>
          <button class="btn green xl shadow" data-start ${online < min || starting ? 'disabled' : ''}>${T('Starten', 'Start')}</button>`;
        if (foot.dataset.h !== fHtml) { foot.dataset.h = fHtml; foot.innerHTML = fHtml; }
        $('[data-start]', foot).onclick = async () => {
          starting = true; update(ctx());
          try { await g.start(ctx()); vibrate(20); } catch (e) { toast(roomError(e), 'err'); }
          starting = false; if (current && current.ctl === api) update(ctx());
        };
      } else {
        const host = r.players[r.hostUid];
        fHtml = `<div class="waiting-host"><span class="dots-anim"><i></i><i></i><i></i></span>${T(`Warte, bis ${esc(host ? host.n : 'der Host')} startet …`, `Waiting for ${esc(host ? host.n : 'the host')} to start …`)}</div>`;
        if (foot.dataset.h !== fHtml) { foot.dataset.h = fHtml; foot.innerHTML = fHtml; }
      }
    }
    const api = { update };
    return api;
  }

  /* ---------- Start ---------- */
  function boot() {
    document.documentElement.lang = S.lang;
    if (!window.firebase) { $('#app').innerHTML = '<div class="center-msg card">Firebase konnte nicht geladen werden. Internet prüfen und neu laden.</div>'; return; }
    try { firebase.initializeApp(FIREBASE_CONFIG); } catch (e) { /* schon initialisiert */ }
    auth = firebase.auth();
    db = firebase.firestore();
    try { db.settings({ experimentalAutoDetectLongPolling: true, merge: true }); } catch (e) { /* egal */ }
    FV = firebase.firestore.FieldValue;
    TS = firebase.firestore.Timestamp;

    // iPad: Zoom-Gesten und Doppeltipp-Zoom unterbinden
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });

    auth.onAuthStateChanged(user => {
      stopListeners();
      S.user = user || null; S.roomCode = null; S.room = null; S.subs = new Map(); S.subsRound = null;
      S.name = user ? (user.displayName || lsGet('ps_name_' + user.uid) || '') : '';
      S.editName = false;
      S.authReady = true;
      current = null;
      if (user && S.name) {
        const saved = lsGet('ps_room_' + user.uid);
        if (saved && /^[A-Z0-9]{6}$/.test(saved)) {
          joinRoom(saved).catch(() => {
            lsSet('ps_room_' + user.uid, null);
            if (S.roomCode === saved && !S.room) { S.roomCode = null; render(); }
          });
          S.roomCode = saved; // Ladeanzeige bis joinRoom fertig
        }
      }
      render();
    });

    setInterval(heartbeat, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { heartbeat(); render(); } });
    setInterval(() => {
      if (current && current.ctl.tick) { try { current.ctl.tick(ctx()); } catch (e) { console.warn(e); } }
    }, 250);
    setInterval(() => {
      if (!S.room) return;
      hostWatch();
      const g = GAMES[S.room.game];
      if (g && g.tick && S.room.status !== 'lobby') { try { g.tick(ctx()); } catch (e) { console.warn(e); } }
      if (S.room.status === 'lobby' && current && current.ctl.update) current.ctl.update(ctx()); // "offline?" aktualisieren
    }, 1000);
  }

  window.App = {
    boot, registerGame: g => { GAMES[g.id] = g; },
    T, esc, $, $$, toast, confirmBox, avatar, vibrate, tsMs, ICON, COLORS, ROOMS,
    leaveRoom, roomError, get FV() { return FV; }, get TS() { return TS; }, get db() { return db; },
    _state: S
  };
})();
