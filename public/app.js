import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  increment, arrayUnion, deleteField, deleteDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { DECKS } from './decks.js';
import { APP_VERSION } from './version.js';

const app = initializeApp(firebaseConfig);
// Auto-detect when the streaming transport is broken (iOS Safari + content
// blockers / some wifi) and fall back to long-polling — cures silent hangs.
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

// Firestore promises can hang forever on a bad mobile connection — never let a
// UI flow await one without a deadline.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

// ---------------------------------------------------------------- identity
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
let playerId = localStorage.getItem('nextup_pid');
if (!playerId) { playerId = uid(); localStorage.setItem('nextup_pid', playerId); }

const AVATARS = ['🦊', '🐸', '🦄', '🐼', '🐙', '🦁', '🐯', '🐨', '🐷', '🦉', '🐢', '🦖', '🍕', '🌮', '🎸', '🚀', '⚡', '🌈', '🍩', '👑'];
let myAvatar = localStorage.getItem('nextup_avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)];

// ---------------------------------------------------------------- dom helpers
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

const SCREENS = ['screen-home', 'screen-lobby', 'screen-intro', 'screen-play', 'screen-summary', 'screen-gameover'];
function showScreen(id) {
  for (const s of SCREENS) (s === id ? show : hide)($(s));
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(t), 3000);
}

function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* fine */ }
}

// ---------------------------------------------------------------- sounds
let audioCtx = null;
function beep(freq, dur = 0.12, vol = 0.25, type = 'square') {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch { /* audio not available — fine */ }
}
const sndTick = () => beep(880, 0.08, 0.15);
const sndHeart = () => { beep(90, 0.09, 0.4, 'sine'); setTimeout(() => beep(75, 0.09, 0.35, 'sine'), 130); };
const sndBuzzer = () => { beep(180, 0.7, 0.35, 'sawtooth'); };
const sndCorrect = () => { beep(660, 0.1); setTimeout(() => beep(990, 0.15), 90); };
const sndWrong = () => beep(220, 0.2, 0.2, 'sawtooth');
const sndStart = () => { beep(523, 0.1); setTimeout(() => beep(784, 0.2), 110); };
const sndGolden = () => { beep(784, 0.1); setTimeout(() => beep(988, 0.1), 100); setTimeout(() => beep(1319, 0.25), 200); };
const sndStreak = (n) => {
  const base = 600 + Math.min(n, 12) * 60;
  beep(base, 0.1); setTimeout(() => beep(base * 1.25, 0.1), 90); setTimeout(() => beep(base * 1.5, 0.18), 180);
};
const sndFanfare = () => {
  [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, i === 3 ? 0.5 : 0.16, 0.3), i * 160));
};

// ---------------------------------------------------------------- confetti
function confettiBurst(count = 120, durationMs = 2800) {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  canvas.width = innerWidth; canvas.height = innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const colors = ['#ffd166', '#ef476f', '#06d6a0', '#4cc9f0', '#f78c6b', '#c77dff'];
  const parts = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    w: 6 + Math.random() * 8,
    h: 4 + Math.random() * 6,
    vx: (Math.random() - 0.5) * 3,
    vy: 2 + Math.random() * 4,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.05;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t - t0 < durationMs) requestAnimationFrame(frame);
    else canvas.remove();
  })(t0);
}

// ---------------------------------------------------------------- wake lock
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported — fine */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && room && (room.state === 'playing')) keepAwake(true);
});

// Whenever the app comes back to life (unlocked, foregrounded, restored, back online),
// immediately re-establish the live room stream so we never sit on stale data.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resubscribe();
});
window.addEventListener('online', () => resubscribe());
window.addEventListener('pageshow', (e) => { if (e.persisted) resubscribe(); });
window.addEventListener('focus', () => resubscribe());

// ---------------------------------------------------------------- room state
let roomCode = null;
let roomRef = null;
let unsub = null;
let room = null;           // latest snapshot data
let timerInterval = null;
let lastTickSecond = null;
let prevState = null;
let prevStreak = 0;
// When THIS device saw the round start. All round timing is measured against this
// local anchor — never against timestamps written by another phone, because phone
// clocks can be minutes apart and that made rounds "flash through" on skewed devices.
let roundAnchor = null;
const COUNTDOWN_MS = 3500;
let wordShownAt = null;    // scorer-local: when the current word appeared
let seenReactionTs = -1;
let lastReactionSent = 0;
let overrideTimer = null;  // delayed "player missing?" rescue buttons

const PHASES = {
  1: { name: 'DESCRIBE IT', rule: 'Say anything — just not the word!' },
  2: { name: 'ONE WORD ONLY', rule: 'You get ONE word as a clue. Choose wisely!' },
  3: { name: 'ACT IT OUT', rule: 'No words allowed — charades time!' },
};

const CODE_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ'; // no I, O, Q — easy to read out loud
function makeCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  return c;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function myName() { return ($('name-input').value || '').trim(); }
function isHost() { return room && room.hostId === playerId; }
function isGuesser() { return room?.round?.guesserId === playerId; }
function isScorer() { return room?.round?.scorerId === playerId; }
function nameOf(id) {
  const p = room?.players?.[id];
  return p ? `${p.avatar || '🙂'} ${p.name}` : '???';
}
function gameMode() { return room?.settings?.mode || 'classic'; }
function teamOf(id) {
  if (room?.teams?.red?.includes(id)) return 'red';
  if (room?.teams?.blue?.includes(id)) return 'blue';
  return null;
}
const TEAM_META = { red: { emoji: '🔴', label: 'Red Team' }, blue: { emoji: '🔵', label: 'Blue Team' } };

function deckWords() {
  if (room?.settings?.deck === 'custom') return room.customWords || [];
  return (DECKS[room?.settings?.deck] || DECKS.mix).words;
}
function deckLabel() {
  if (room?.settings?.deck === 'custom') return `✏️ Custom Deck`;
  return (DECKS[room?.settings?.deck] || DECKS.mix).label;
}

function parseCustomWords(text) {
  const seen = new Set();
  return (text || '').split(/[\n,;]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && w.length <= 40)
    .filter((w) => { const k = w.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 400);
}

// Build the words for a round: fresh (never-used) words always come first, and
// already-used words only appear after every fresh word is truly exhausted.
function buildRoundWords(usedWords) {
  const all = deckWords();
  const used = new Set(usedWords || []);
  const fresh = shuffle(all.filter((w) => !used.has(w)));
  if (fresh.length >= 50) return fresh.slice(0, 50);
  const recycled = shuffle(all.filter((w) => used.has(w)));
  return [...fresh, ...recycled].slice(0, 50);
}

// Words this device has seen used, remembered across games AND rooms, so a new
// room on the same night doesn't repeat questions. Capped to the most recent 1500.
function rememberUsedWords(words) {
  try {
    const prev = JSON.parse(localStorage.getItem('nextup_usedwords') || '[]');
    const merged = [...new Set([...prev, ...(words || [])])];
    localStorage.setItem('nextup_usedwords', JSON.stringify(merged.slice(-1500)));
  } catch { /* fine */ }
}
function recallUsedWords() {
  try { return JSON.parse(localStorage.getItem('nextup_usedwords') || '[]'); }
  catch { return []; }
}

function makeRound(guesserId, scorerId, words) {
  const golden = (gameMode() !== 'escalation' && words.length > 3)
    ? words[Math.floor(Math.random() * Math.min(words.length, 20))]
    : null;
  return {
    guesserId, scorerId, words, index: 0, results: [],
    startsAt: null, endsAt: null,
    goldenWord: golden, streak: 0, maxStreak: 0, bonus: 0,
  };
}

// ---------------------------------------------------------------- create / join
async function createRoom() {
  const name = myName();
  if (!name) return toast('Enter your name first!');
  localStorage.setItem('nextup_name', name);
  $('btn-create').disabled = true;
  try {
    let code, ref;
    for (let i = 0; i < 5; i++) {
      code = makeCode();
      ref = doc(db, 'rooms', code);
      try {
        const snap = await withTimeout(getDoc(ref), 4000);
        if (!snap.exists()) break; // code is free
      } catch { break; } // lookup hung — accept the code (collision odds ~1 in 280k)
    }

    // Fire the write and enter immediately — never wait on a server ack that a
    // flaky phone connection might swallow. The live listener confirms it.
    setDoc(ref, {
      code,
      createdAt: Date.now(),
      hostId: playerId,
      state: 'lobby',
      settings: { deck: 'mix', roundSeconds: 60, mode: 'classic', targetScore: 0 },
      players: { [playerId]: { name, avatar: myAvatar, score: 0, joinedAt: Date.now() } },
      upQueue: [],
      usedWords: recallUsedWords(), // no repeats even in a brand-new room
      customWords: parseCustomWords(localStorage.getItem('nextup_customwords') || ''),
      history: [],
      round: null,
      roundNum: 0,
    }).catch((e) => { console.error(e); toast('Could not create room — check your connection.'); });
    enterRoom(code);
  } finally {
    $('btn-create').disabled = false;
  }
}

async function joinRoom() {
  const name = myName();
  const code = ($('code-input').value || '').trim().toUpperCase();
  if (!name) return toast('Enter your name first!');
  if (code.length !== 4) return toast('Room codes are 4 letters.');
  localStorage.setItem('nextup_name', name);
  $('btn-join').disabled = true;
  try {
    const ref = doc(db, 'rooms', code);
    let data = null;
    try {
      const snap = await withTimeout(getDoc(ref), 6000);
      if (!snap.exists()) return toast(`Room ${code} not found.`);
      data = snap.data();
    } catch {
      // lookup hung (flaky phone connection) — join optimistically; if the room
      // doesn't exist the live listener will bounce us back with a message
    }
    if (data && !data.players?.[playerId]) {
      const nameTaken = Object.values(data.players || {}).some(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (nameTaken) return toast('That name is taken in this room — pick another.');
    }
    if (!data || !data.players?.[playerId]) {
      // fire-and-forget: never block the UI on a server ack
      updateDoc(ref, {
        [`players.${playerId}`]: { name, avatar: myAvatar, score: 0, joinedAt: Date.now() },
      }).catch(() => {});
    }
    enterRoom(code);
  } finally {
    $('btn-join').disabled = false;
  }
}

// Phones dim, lock, background the browser, or drop wifi mid-game — any of which can
// silently kill the live Firestore stream and freeze that phone on a stale word.
// These three pieces make every client notice and reconnect on its own.
let lastSnapshotAt = 0;
let lastResubAt = 0;

function subscribeRoom() {
  if (!roomRef) return;
  if (unsub) { unsub(); unsub = null; }
  unsub = onSnapshot(roomRef, (snap) => {
    lastSnapshotAt = Date.now();
    if (!snap.exists()) {
      toast('The room was closed.');
      leaveRoom(false);
      return;
    }
    room = snap.data();
    render();
  }, (err) => {
    console.error(err);
    setTimeout(() => resubscribe(), 1500); // stream errored — quietly reconnect
  });
}

function resubscribe() {
  if (!roomRef) return;
  if (Date.now() - lastResubAt < 4000) return; // don't thrash
  lastResubAt = Date.now();
  subscribeRoom();
}

function enterRoom(code) {
  roomCode = code;
  roomRef = doc(db, 'rooms', code);
  localStorage.setItem('nextup_room', code);
  seenReactionTs = -1;
  lastSnapshotAt = Date.now();
  subscribeRoom();
}

async function leaveRoom(removeSelf = true) {
  if (unsub) { unsub(); unsub = null; }
  if (removeSelf && roomRef && room) {
    try {
      if (isHost() && Object.keys(room.players || {}).length === 1) {
        await deleteDoc(roomRef); // last one out closes the room
      } else {
        const updates = { [`players.${playerId}`]: deleteField() };
        const remaining = Object.keys(room.players).filter((id) => id !== playerId);
        // Hand off host role if the host leaves
        if (isHost() && remaining.length) updates.hostId = remaining[0];
        updates.upQueue = (room.upQueue || []).filter((id) => id !== playerId);

        // Leaving mid-game must never strand the room:
        if (room.state !== 'lobby' && remaining.length === 1) {
          // only one player left — game can't continue
          updates.state = 'gameover';
          updates.round = null;
        } else if (room.round && ['intro', 'playing', 'summary'].includes(room.state)) {
          const r = room.round;
          let guesserId = r.guesserId;
          if (r.guesserId === playerId) {
            if (room.state === 'playing') {
              // the person guessing walked out mid-round — wrap the round up
              updates.state = 'summary';
            } else if (room.state === 'intro') {
              const pool = remaining.filter((id) => id !== r.scorerId);
              guesserId = pickRandom(pool.length ? pool : remaining);
              updates['round.guesserId'] = guesserId;
            }
          }
          if (r.scorerId === playerId) {
            // hand the scoring buttons to someone else
            const pool = remaining.filter((id) => id !== guesserId);
            updates['round.scorerId'] = pickRandom(pool.length ? pool : remaining);
          }
        }
        await updateDoc(roomRef, updates);
      }
    } catch { /* best effort */ }
  }
  roomCode = null; roomRef = null; room = null; roundAnchor = null;
  localStorage.removeItem('nextup_room');
  stopTimer();
  keepAwake(false);
  showScreen('screen-home');
}

// ---------------------------------------------------------------- assignments
function balancedTeams(ids) {
  const red = (room.teams?.red || []).filter((id) => ids.includes(id));
  const blue = (room.teams?.blue || []).filter((id) => ids.includes(id));
  const unassigned = ids.filter((id) => !red.includes(id) && !blue.includes(id));
  for (const id of shuffle(unassigned)) {
    (red.length <= blue.length ? red : blue).push(id);
  }
  return { red, blue };
}

function nextRoundAssignments() {
  const ids = Object.keys(room.players);
  let teams = null;
  let queue = (room.upQueue || []).filter((id) => ids.includes(id));

  if (gameMode() === 'teams') {
    teams = balancedTeams(ids);
    if (queue.length === 0) {
      // new cycle: alternate red / blue so turns swap between teams
      const r = shuffle(teams.red), b = shuffle(teams.blue);
      queue = [];
      for (let i = 0; i < Math.max(r.length, b.length); i++) {
        if (r[i]) queue.push(r[i]);
        if (b[i]) queue.push(b[i]);
      }
    }
  } else if (queue.length === 0) {
    queue = shuffle(ids); // new cycle: everyone goes once
  }

  const guesserId = queue[0];
  queue = queue.slice(1);

  let scorerPool;
  if (teams) {
    const gTeam = teams.red.includes(guesserId) ? 'red' : 'blue';
    const opposite = gTeam === 'red' ? teams.blue : teams.red;
    scorerPool = opposite.length ? opposite : ids.filter((id) => id !== guesserId);
  } else {
    scorerPool = ids.filter((id) => id !== guesserId);
  }
  const scorerId = pickRandom(scorerPool);
  return { guesserId, scorerId, queue, teams };
}

function targetReached() {
  const target = room.settings?.targetScore || 0;
  if (!target || gameMode() === 'escalation') return null;
  if (gameMode() === 'teams') {
    for (const t of ['red', 'blue']) {
      if ((room.teamScores?.[t] || 0) >= target) return TEAM_META[t].emoji + ' ' + TEAM_META[t].label;
    }
    return null;
  }
  const winner = Object.entries(room.players || {}).find(([, p]) => (p.score || 0) >= target);
  return winner ? nameOf(winner[0]) : null;
}

function escalationDone() {
  return gameMode() === 'escalation' && (room.escalation?.phase || 1) > 3;
}

// ---------------------------------------------------------------- game flow
async function startGame() {
  if (!isHost()) return;
  const ids = Object.keys(room.players || {});
  const mode = gameMode();
  if (ids.length < 2) return toast('You need at least 2 players!');
  if (mode === 'teams' && ids.length < 4) return toast('Teams mode needs at least 4 players!');
  if (room.settings.deck === 'custom' && (room.customWords || []).length < 10) {
    return toast('Add at least 10 custom words first!');
  }

  const updates = {
    state: 'intro',
    roundNum: 1,
    history: [],
    // usedWords deliberately NOT reset — no repeat questions across games
  };

  if (mode === 'escalation') {
    const pool = shuffle(deckWords()).slice(0, 30);
    updates.escalation = { pool, phase: 1, remaining: pool };
  } else {
    updates.escalation = deleteField();
  }
  if (mode === 'teams') updates.teamScores = { red: 0, blue: 0 };
  else { updates.teams = deleteField(); updates.teamScores = deleteField(); }

  // teams must exist before assignments compute — stage them locally
  if (mode === 'teams') {
    const t = balancedTeams(shuffle(ids));
    room.teams = t; // local staging so nextRoundAssignments sees it
    updates.teams = t;
  }
  room.upQueue = [];
  const { guesserId, scorerId, queue } = nextRoundAssignments();
  updates.upQueue = queue;
  const words = mode === 'escalation'
    ? shuffle(updates.escalation.remaining)
    : buildRoundWords([]);
  updates.round = makeRound(guesserId, scorerId, words);

  try { await updateDoc(roomRef, updates); }
  catch (e) { console.error(e); toast('Could not start the game.'); }
}

async function guesserReady() {
  const secs = room.settings.roundSeconds || 60;
  // startsAt/endsAt are informational only — clients time rounds off their own
  // local anchor (see roundAnchor) so mismatched phone clocks can't break sync.
  const startsAt = Date.now() + COUNTDOWN_MS;
  try {
    await updateDoc(roomRef, {
      state: 'playing',
      'round.startsAt': startsAt,
      'round.endsAt': startsAt + secs * 1000,
    });
  } catch (e) { console.error(e); toast('Something went wrong — try again.'); }
}

// Everything that must be written when a round finishes (history entry, escalation advance)
function roundEndUpdates(extraEntry, finalBonus, finalMaxStreak) {
  const r = room.round;
  const results = extraEntry ? [...(r.results || []), extraEntry] : (r.results || []);
  const correct = results.filter((x) => x.correct).length;
  const fastest = results
    .filter((x) => x.correct && x.ms != null && x.ms > 400)
    .sort((a, b) => a.ms - b.ms)[0] || null;
  const entry = {
    round: room.roundNum || 1,
    guesserId: r.guesserId,
    correct,
    skips: results.length - correct,
    bonus: finalBonus != null ? finalBonus : (r.bonus || 0),
    maxStreak: finalMaxStreak != null ? finalMaxStreak : (r.maxStreak || 0),
    fastest: fastest ? { word: fastest.word, ms: fastest.ms } : null,
    golden: results.some((x) => x.golden && x.correct),
  };
  const updates = { state: 'summary', history: arrayUnion(entry) };

  if (gameMode() === 'escalation' && room.escalation) {
    const guessed = new Set(results.filter((x) => x.correct).map((x) => x.word));
    let remaining = (room.escalation.remaining || []).filter((w) => !guessed.has(w));
    let phase = room.escalation.phase || 1;
    if (remaining.length === 0) {
      phase += 1;
      if (phase <= 3) remaining = shuffle(room.escalation.pool);
    }
    updates.escalation = { pool: room.escalation.pool, phase, remaining };
  }
  return updates;
}

let scoreTapLock = false;
async function scoreWord(correct) {
  if (!room || room.state !== 'playing' || !isScorer()) return;
  if (!roundAnchor || Date.now() - roundAnchor < COUNTDOWN_MS) return; // still counting down
  if (scoreTapLock) return;
  scoreTapLock = true;
  setTimeout(() => { scoreTapLock = false; }, 350); // debounce double taps

  const r = room.round;
  const word = r.words[r.index];
  if (!word) return;
  const golden = word === r.goldenWord;
  const newStreak = correct ? (r.streak || 0) + 1 : 0;
  const milestone = correct && newStreak >= 3 && newStreak % 3 === 0; // +1 at 3, 6, 9…
  const pts = correct ? (golden ? 2 : 1) + (milestone ? 1 : 0) : 0;
  const ms = wordShownAt ? Date.now() - wordShownAt : null;
  wordShownAt = Date.now();

  if (correct) { golden ? sndGolden() : sndCorrect(); } else { sndWrong(); }
  buzz(correct ? (golden ? [40, 40, 80] : 30) : 15);

  const entry = { word, correct, golden, ms };
  const newMaxStreak = Math.max(r.maxStreak || 0, newStreak);
  const updates = {
    'round.index': increment(1),
    'round.results': arrayUnion(entry),
    'round.streak': newStreak,
    'round.maxStreak': newMaxStreak,
  };
  if (milestone) updates['round.bonus'] = increment(1);
  if (gameMode() !== 'escalation') updates.usedWords = arrayUnion(word);
  if (pts) {
    updates[`players.${r.guesserId}.score`] = increment(pts);
    if (gameMode() === 'teams') {
      const t = teamOf(r.guesserId);
      if (t) updates[`teamScores.${t}`] = increment(pts);
    }
  }
  // Ran out of words? End the round early.
  if (r.index + 1 >= r.words.length) {
    Object.assign(updates, roundEndUpdates(entry, (r.bonus || 0) + (milestone ? 1 : 0), newMaxStreak));
  }
  try { await updateDoc(roomRef, updates); } catch (e) { console.error(e); }
}

async function endRoundByTimer() {
  if (!room || room.state !== 'playing') return;
  try { await updateDoc(roomRef, roundEndUpdates(null)); }
  catch { /* someone else got it */ }
}

async function nextRound() {
  if (!isScorer() && !isHost()) return;
  if (targetReached() || escalationDone()) {
    return updateDoc(roomRef, { state: 'gameover', round: null }).catch(console.error);
  }
  const { guesserId, scorerId, queue, teams } = nextRoundAssignments();
  const words = gameMode() === 'escalation'
    ? shuffle(room.escalation?.remaining || [])
    : buildRoundWords(room.usedWords);
  const updates = {
    state: 'intro',
    roundNum: (room.roundNum || 1) + 1,
    upQueue: queue,
    round: makeRound(guesserId, scorerId, words),
  };
  if (teams) updates.teams = teams;
  try { await updateDoc(roomRef, updates); }
  catch (e) { console.error(e); toast('Could not start the next round.'); }
}

async function endGame() {
  if (!isScorer() && !isHost()) return;
  try { await updateDoc(roomRef, { state: 'gameover', round: null }); }
  catch (e) { console.error(e); }
}

async function skipMissingGuesser() {
  if (!isScorer() && !isHost()) return;
  if (!room || room.state !== 'intro') return;
  const ids = Object.keys(room.players);
  const badGuesser = room.round.guesserId;
  const pool = ids.filter((id) => id !== badGuesser && id !== room.round.scorerId);
  if (!pool.length) return toast('No one else to pass to!');
  const newGuesser = pool[0 + Math.floor(Math.random() * pool.length)];
  const updates = {
    'round.guesserId': newGuesser,
    upQueue: (room.upQueue || []).filter((id) => id !== newGuesser),
  };
  try { await updateDoc(roomRef, updates); toast('Skipped to a new guesser!'); }
  catch (e) { console.error(e); }
}

async function playAgain() {
  if (!isHost()) return;
  const updates = {
    state: 'lobby', round: null, roundNum: 0, upQueue: [], history: [],
    teams: deleteField(), teamScores: deleteField(), escalation: deleteField(),
    // usedWords deliberately kept — no repeat questions across games
  };
  for (const id of Object.keys(room.players)) updates[`players.${id}.score`] = 0;
  try { await updateDoc(roomRef, updates); }
  catch (e) { console.error(e); }
}

// ---------------------------------------------------------------- reactions
async function sendReaction(emoji) {
  if (Date.now() - lastReactionSent < 1000) return; // throttle
  lastReactionSent = Date.now();
  try {
    await updateDoc(roomRef, {
      lastReaction: { emoji, name: room.players?.[playerId]?.name || '', ts: Date.now() },
    });
  } catch { /* fine */ }
}

function spawnReaction(emoji, name) {
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.innerHTML = `<span class="fr-emoji">${esc(emoji)}</span><span class="fr-name">${esc(name)}</span>`;
  el.style.left = (8 + Math.random() * 70) + 'vw';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

// ---------------------------------------------------------------- timer loop
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  lastTickSecond = null;
}

function startTimerLoop() {
  stopTimer();
  timerInterval = setInterval(tick, 200);
  tick();
}

function tick() {
  if (!room || room.state !== 'playing' || !roundAnchor) { stopTimer(); return; }
  // watchdog: if no room updates have arrived in a while mid-round, the stream is
  // probably dead (dimmed screen, dropped wifi) — reconnect before we go stale
  if (Date.now() - lastSnapshotAt > 8000) resubscribe();
  // elapsed is local-clock minus local-clock: immune to clock differences between phones
  const elapsed = Date.now() - roundAnchor;
  const overlay = $('countdown-overlay');

  if (elapsed < COUNTDOWN_MS) {
    // 3-2-1 countdown
    const n = Math.ceil((COUNTDOWN_MS - elapsed) / 1000);
    $('countdown-num').textContent = n > 3 ? '3' : String(n);
    show(overlay);
    return;
  }
  if (!overlay.classList.contains('hidden')) {
    hide(overlay);
    if (!isGuesser()) sndStart();
    if (isScorer()) wordShownAt = Date.now();
  }

  const total = (room.settings.roundSeconds || 60) * 1000;
  const msLeft = Math.max(0, COUNTDOWN_MS + total - elapsed);
  const secLeft = Math.ceil(msLeft / 1000);

  const timerEl = $('play-timer');
  timerEl.textContent = String(Math.min(secLeft, Math.ceil(total / 1000)));
  timerEl.classList.toggle('low', secLeft <= 10);
  const bar = $('timebar');
  bar.style.width = `${(msLeft / total) * 100}%`;
  bar.classList.toggle('low', secLeft <= 10);

  // rising tension: heartbeat under 10s, sharp ticks in the last 5 (not on the face-down phone)
  if (!isGuesser() && secLeft > 0 && secLeft !== lastTickSecond) {
    lastTickSecond = secLeft;
    if (secLeft <= 5) sndTick();
    else if (secLeft <= 10) sndHeart();
  }

  if (msLeft <= 0) {
    stopTimer();
    if (isGuesser()) buzz([200, 80, 200]); // face-down phone buzzes: round over, pick it up!
    else { sndBuzzer(); buzz([120, 60, 120]); }
    // ONLY the scorekeeper's device ends the round; everyone else is a late fallback
    // in case the scorekeeper dropped (their anchor starts no earlier than the
    // scorer's, so a fallback can never end a round prematurely).
    if (isScorer()) endRoundByTimer();
    else setTimeout(() => { if (room?.state === 'playing') endRoundByTimer(); }, 5000);
  }
}

// ---------------------------------------------------------------- rendering
function render() {
  if (!room) return;
  const stateChanged = room.state !== prevState;

  if (stateChanged) {
    clearTimeout(overrideTimer);
    hide($('btn-skip-guesser'));
    prevStreak = 0;
    // this device just saw the round begin — start ITS clock now
    if (room.state === 'playing') roundAnchor = Date.now();
    else roundAnchor = null;
  }

  switch (room.state) {
    case 'lobby': renderLobby(); break;
    case 'intro': renderIntro(stateChanged); break;
    case 'playing': renderPlaying(stateChanged); break;
    case 'summary': renderSummary(stateChanged); break;
    case 'gameover': renderGameOver(stateChanged); break;
    default: renderLobby();
  }

  // floating emoji reactions
  const rx = room.lastReaction;
  if (rx && rx.ts !== seenReactionTs) {
    if (seenReactionTs !== -1) spawnReaction(rx.emoji, rx.name);
    seenReactionTs = rx.ts;
  }

  if (stateChanged) {
    keepAwake(room.state === 'playing' || room.state === 'intro');
    if (room.state !== 'playing') stopTimer();
    // every device banks the used words so whoever hosts next won't repeat them
    if (room.state === 'summary' || room.state === 'gameover') rememberUsedWords(room.usedWords);
  }
  prevState = room.state;
}

function renderLobby() {
  showScreen('screen-lobby');
  $('lobby-code').textContent = room.code;
  $('lobby-url').textContent = location.host;
  const joinUrl = `${location.origin}${location.pathname}?join=${room.code}`;
  const qr = $('qr-img');
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=170x170&margin=8&data=${encodeURIComponent(joinUrl)}`;
  if (qr.dataset.src !== qrSrc) { qr.src = qrSrc; qr.dataset.src = qrSrc; }

  const ids = Object.keys(room.players || {}).sort(
    (a, b) => (room.players[a].joinedAt || 0) - (room.players[b].joinedAt || 0)
  );
  $('lobby-count').textContent = `(${ids.length})`;
  $('lobby-players').innerHTML = ids.map((id) => {
    const p = room.players[id];
    return `<li><span>${esc(p.avatar || '🙂')} ${esc(p.name)}</span>
      ${id === room.hostId ? '<span class="host-tag">HOST</span>' : ''}
      ${id === playerId ? '<span class="you-tag">YOU</span>' : ''}</li>`;
  }).join('');

  const s = room.settings || {};
  if (isHost()) {
    show($('lobby-settings')); hide($('lobby-settings-view'));
    show($('btn-start')); hide($('lobby-wait-msg'));
    $('mode-select').value = s.mode || 'classic';
    $('deck-select').value = s.deck || 'mix';
    $('time-select').value = String(s.roundSeconds || 60);
    $('target-select').value = String(s.targetScore || 0);
    (s.mode === 'escalation' ? hide : show)($('target-block'));
    const customOn = s.deck === 'custom';
    (customOn ? show : hide)($('custom-deck-block'));
    if (customOn) {
      const ta = $('custom-words');
      if (document.activeElement !== ta && !ta.value) {
        ta.value = (room.customWords || []).join('\n') || localStorage.getItem('nextup_customwords') || '';
      }
      $('custom-count').textContent = `${(room.customWords || []).length} words (10 minimum)`;
    }
    const minPlayers = s.mode === 'teams' ? 4 : 2;
    $('btn-start').disabled = ids.length < minPlayers;
    $('btn-start').textContent = ids.length < minPlayers
      ? `🚀 Start Game (need ${minPlayers}+ players)` : '🚀 Start Game';
  } else {
    hide($('lobby-settings')); show($('lobby-settings-view'));
    hide($('btn-start')); show($('lobby-wait-msg'));
    const modeLabel = { classic: '🎯 Classic', teams: '🔴🔵 Teams', escalation: '🎭 Escalation' }[s.mode || 'classic'];
    const deckPart = s.deck === 'custom'
      ? `✏️ Custom Deck (${(room.customWords || []).length} words)` : deckLabel();
    const targetPart = (s.targetScore && s.mode !== 'escalation') ? ` · first to ${s.targetScore}` : '';
    $('settings-summary').textContent = `${modeLabel} · ${deckPart} · ${s.roundSeconds || 60}s rounds${targetPart}`;
  }
}

function renderIntro(stateChanged) {
  showScreen('screen-intro');
  $('intro-round').textContent = `ROUND ${room.roundNum || 1}`;
  $('intro-guesser').textContent = nameOf(room.round.guesserId);
  $('intro-scorer').textContent = nameOf(room.round.scorerId);

  if (gameMode() === 'escalation' && room.escalation) {
    const ph = PHASES[room.escalation.phase] || PHASES[1];
    show($('intro-phase'));
    $('intro-phase').innerHTML = `PHASE ${room.escalation.phase} · ${ph.name}<small>${esc(ph.rule)}</small>`;
  } else hide($('intro-phase'));

  if (gameMode() === 'teams') {
    const t = teamOf(room.round.guesserId);
    const other = t === 'red' ? 'blue' : 'red';
    $('intro-guesser-sub').textContent = `is guessing for ${TEAM_META[t]?.label || '?'}!`;
    show($('intro-team-hint'));
    $('intro-team-hint').textContent =
      `${TEAM_META[t]?.emoji} teammates shout clues — ${TEAM_META[other]?.emoji} stays quiet! 🤫`;
  } else {
    $('intro-guesser-sub').textContent = 'is guessing!';
    hide($('intro-team-hint'));
  }

  if (isGuesser()) {
    show($('intro-guesser-panel')); hide($('intro-wait-msg'));
  } else {
    hide($('intro-guesser-panel')); show($('intro-wait-msg'));
    $('intro-wait-msg').textContent =
      `Waiting for ${nameOf(room.round.guesserId)} to put their phone down…`;
  }

  // If the guesser vanished (phone died, walked off), let the scorer/host skip them
  if (stateChanged) {
    clearTimeout(overrideTimer);
    overrideTimer = setTimeout(() => {
      if (room?.state === 'intro' && !isGuesser() && (isScorer() || isHost())) {
        show($('btn-skip-guesser'));
      }
    }, 15000);
  }
}

function renderPlaying(stateChanged) {
  showScreen('screen-play');
  const r = room.round;

  if (isGuesser()) {
    show($('play-guesser')); hide($('play-clue'));
  } else {
    hide($('play-guesser')); show($('play-clue'));
    $('word-deck').textContent = deckLabel().replace(/^\S+\s/, ''); // drop emoji
    const word = r.words[r.index] || '🎉 Deck cleared!';
    $('word-text').textContent = word;
    const golden = word === r.goldenWord;
    $('word-card').classList.toggle('golden', golden);
    (golden ? show : hide)($('golden-tag'));

    const got = (r.results || []).filter((x) => x.correct).length;
    const streakBit = (r.streak || 0) >= 2 ? `  🔥${r.streak}` : '';
    $('play-tally').textContent = (got ? `✓ ${got}` : '') + streakBit;

    // streak milestone celebration on all clue screens
    if ((r.streak || 0) !== prevStreak) {
      if ((r.streak || 0) >= 3 && r.streak % 3 === 0) {
        sndStreak(r.streak);
        confettiBurst(35, 1600);
      }
      prevStreak = r.streak || 0;
    }

    if (gameMode() === 'escalation' && room.escalation) {
      const ph = PHASES[room.escalation.phase] || PHASES[1];
      show($('play-phase'));
      $('play-phase').textContent = `PHASE ${room.escalation.phase}: ${ph.name}`;
    } else hide($('play-phase'));

    if (isScorer()) {
      show($('scorer-buttons')); hide($('reaction-bar'));
      $('clue-hint').textContent = 'Tap when they get it or give up!';
    } else {
      hide($('scorer-buttons')); show($('reaction-bar'));
      if (gameMode() === 'teams') {
        const myT = teamOf(playerId);
        const gT = teamOf(r.guesserId);
        $('clue-hint').textContent = myT === gT
          ? `Shout clues to ${nameOf(r.guesserId)} — don't say the word!`
          : `🤫 Other team's turn — stay quiet and enjoy!`;
      } else if (gameMode() === 'escalation' && room.escalation) {
        $('clue-hint').textContent = (PHASES[room.escalation.phase] || PHASES[1]).rule;
      } else {
        $('clue-hint').textContent = `Shout clues to ${nameOf(r.guesserId)} — don't say the word!`;
      }
    }
  }
  if (stateChanged || !timerInterval) startTimerLoop();
}

function renderSummary(stateChanged) {
  showScreen('screen-summary');
  const r = room.round || { results: [] };
  const results = r.results || [];
  const got = results.filter((x) => x.correct).length;
  const bonus = r.bonus || 0;
  $('summary-round').textContent = `ROUND ${room.roundNum || 1} OVER`;
  $('summary-headline').innerHTML =
    `🎤 ${esc(nameOf(r.guesserId))} got <span style="color:var(--green)">${got}</span> right!` +
    (bonus ? ` <span style="color:var(--accent)">+${bonus} 🔥 bonus</span>` : '');

  // escalation progress line
  if (gameMode() === 'escalation' && room.escalation) {
    show($('summary-esc-line'));
    const e = room.escalation;
    $('summary-esc-line').textContent = e.phase > 3
      ? '🎭 All 3 phases complete!'
      : `🎭 ${e.remaining.length} word${e.remaining.length === 1 ? '' : 's'} left in Phase ${e.phase} (${(PHASES[e.phase] || {}).name})`;
  } else hide($('summary-esc-line'));

  renderTeamLine($('summary-team-line'));

  $('summary-words').innerHTML = results.length
    ? results.map((x) => {
        const mark = x.correct ? '✓' : '✗';
        const goldBit = x.golden ? ' ✨' : '';
        const msBit = (x.correct && x.ms != null && x.ms > 400) ? ` <small class="ms-bit">${(x.ms / 1000).toFixed(1)}s</small>` : '';
        return `<li><span>${esc(x.word)}${goldBit}${msBit}</span><span class="${x.correct ? 'res-ok' : 'res-no'}">${mark}</span></li>`;
      }).join('')
    : '<li><span>No words were scored this round.</span><span></span></li>';

  renderScoreList($('summary-scores'));

  const done = targetReached() || escalationDone();
  $('btn-next-round').textContent = done ? '🏆 Final Results' : '⏭ Next Round';
  if (done && stateChanged) {
    const who = targetReached();
    if (who) toast(`🏆 ${who} hit ${room.settings.targetScore}!`);
  }

  if (isScorer()) {
    show($('summary-scorer-panel')); hide($('summary-wait-msg'));
  } else {
    hide($('summary-scorer-panel')); show($('summary-wait-msg'));
    $('summary-wait-msg').textContent = `${nameOf(r.scorerId)} chooses what happens next…`;
    // scorer vanished? host can take over after a wait
    if (stateChanged) {
      clearTimeout(overrideTimer);
      overrideTimer = setTimeout(() => {
        if (room?.state === 'summary' && isHost() && !isScorer()) {
          show($('summary-scorer-panel'));
          $('summary-wait-msg').textContent = 'Scorekeeper missing? You can continue as host:';
        }
      }, 15000);
    }
  }
}

function renderGameOver(stateChanged) {
  showScreen('screen-gameover');

  // headline
  let headline = '';
  if (gameMode() === 'teams') {
    const rs = room.teamScores?.red || 0, bs = room.teamScores?.blue || 0;
    headline = rs === bs ? "🤝 It's a tie!"
      : rs > bs ? '🔴 Red Team wins!' : '🔵 Blue Team wins!';
  } else {
    const top = Object.entries(room.players || {}).sort((a, b) => (b[1].score || 0) - (a[1].score || 0))[0];
    if (top && (top[1].score || 0) > 0) headline = `${nameOf(top[0])} wins!`;
  }
  $('gameover-headline').textContent = headline;
  renderTeamLine($('gameover-team-line'));

  renderScoreList($('final-scores'));
  renderAwards();

  if (isHost()) { show($('btn-play-again')); hide($('gameover-wait-msg')); }
  else { hide($('btn-play-again')); show($('gameover-wait-msg')); }

  if (stateChanged) {
    confettiBurst(160, 3200);
    sndFanfare();
    buzz([80, 40, 80, 40, 160]);
  }
}

function renderTeamLine(el) {
  if (gameMode() !== 'teams' || !room.teamScores) { hide(el); return; }
  show(el);
  el.innerHTML =
    `<span class="team-chip red">🔴 Red <b>${room.teamScores.red || 0}</b></span>` +
    `<span class="team-chip blue">🔵 Blue <b>${room.teamScores.blue || 0}</b></span>`;
}

function renderScoreList(el) {
  const entries = Object.entries(room.players || {})
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  el.innerHTML = entries.map(([id, p], i) => {
    const medal = i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : '';
    const teamDot = gameMode() === 'teams' ? (teamOf(id) === 'red' ? '🔴' : teamOf(id) === 'blue' ? '🔵' : '') : '';
    return `<li><span>${medal}${esc(p.avatar || '🙂')} ${esc(p.name)}${id === playerId ? ' (you)' : ''} ${teamDot}</span>
      <span class="pts">${p.score || 0}</span></li>`;
  }).join('');
}

function renderAwards() {
  // dedupe history by round number (fallback writers can double-log)
  const byRound = {};
  for (const e of room.history || []) byRound[e.round] = e;
  const H = Object.values(byRound);
  const awards = [];

  const fastest = H.filter((e) => e.fastest).sort((a, b) => a.fastest.ms - b.fastest.ms)[0];
  if (fastest) awards.push({ emoji: '⚡', title: 'Speed Demon', who: fastest.guesserId, detail: `"${fastest.fastest.word}" in ${(fastest.fastest.ms / 1000).toFixed(1)}s` });

  const hot = H.filter((e) => (e.maxStreak || 0) >= 3).sort((a, b) => b.maxStreak - a.maxStreak)[0];
  if (hot) awards.push({ emoji: '🔥', title: 'On Fire', who: hot.guesserId, detail: `${hot.maxStreak} in a row` });

  const best = H.slice().sort((a, b) => (b.correct || 0) - (a.correct || 0))[0];
  if (best && best.correct > 0) awards.push({ emoji: '🎯', title: 'Sharpshooter', who: best.guesserId, detail: `${best.correct} in one round` });

  const goldCounts = {};
  for (const e of H) if (e.golden) goldCounts[e.guesserId] = (goldCounts[e.guesserId] || 0) + 1;
  const goldTop = Object.entries(goldCounts).sort((a, b) => b[1] - a[1])[0];
  if (goldTop) awards.push({ emoji: '💰', title: 'Golden Touch', who: goldTop[0], detail: `${goldTop[1]} golden word${goldTop[1] > 1 ? 's' : ''}` });

  const skipCounts = {};
  for (const e of H) if (e.skips) skipCounts[e.guesserId] = (skipCounts[e.guesserId] || 0) + e.skips;
  const skipTop = Object.entries(skipCounts).sort((a, b) => b[1] - a[1])[0];
  if (skipTop && skipTop[1] >= 3) awards.push({ emoji: '💨', title: 'Skip Captain', who: skipTop[0], detail: `${skipTop[1]} skips` });

  const el = $('awards');
  if (!awards.length) { hide($('awards-card')); return; }
  show($('awards-card'));
  el.innerHTML = awards.slice(0, 5).map((a) =>
    `<li><span class="award-emoji">${a.emoji}</span>
      <span class="award-body"><b>${a.title}</b><small>${esc(nameOf(a.who))} — ${esc(a.detail)}</small></span></li>`
  ).join('');
}

// ---------------------------------------------------------------- wire up UI
$('btn-create').addEventListener('click', createRoom);
$('btn-join').addEventListener('click', joinRoom);
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('btn-howto').addEventListener('click', () => show($('howto-modal')));
$('btn-howto-close').addEventListener('click', () => hide($('howto-modal')));
$('btn-start').addEventListener('click', startGame);
$('btn-leave-lobby').addEventListener('click', () => leaveRoom(true));
$('btn-leave-game').addEventListener('click', () => leaveRoom(true));
$('btn-ready').addEventListener('click', guesserReady);
$('btn-correct').addEventListener('click', () => scoreWord(true));
$('btn-wrong').addEventListener('click', () => scoreWord(false));
$('btn-next-round').addEventListener('click', nextRound);
$('btn-end-game').addEventListener('click', endGame);
$('btn-play-again').addEventListener('click', playAgain);
$('btn-skip-guesser').addEventListener('click', skipMissingGuesser);
for (const b of document.querySelectorAll('.reaction-btn')) {
  b.addEventListener('click', () => sendReaction(b.dataset.emoji));
}

// Deck dropdown (custom deck last)
$('deck-select').innerHTML = Object.entries(DECKS)
  .map(([key, d]) => `<option value="${key}">${d.label}</option>`).join('')
  + '<option value="custom">✏️ Custom Deck — your own words!</option>';

// Host settings changes sync live to everyone in the lobby
function syncSetting(field, value) {
  if (isHost() && room?.state === 'lobby') {
    updateDoc(roomRef, { [field]: value }).catch(() => {});
  }
}
$('deck-select').addEventListener('change', () => syncSetting('settings.deck', $('deck-select').value));
$('time-select').addEventListener('change', () => syncSetting('settings.roundSeconds', parseInt($('time-select').value, 10)));
$('mode-select').addEventListener('change', () => syncSetting('settings.mode', $('mode-select').value));
$('target-select').addEventListener('change', () => syncSetting('settings.targetScore', parseInt($('target-select').value, 10)));

let customSyncTimer = null;
$('custom-words').addEventListener('input', () => {
  if (!isHost() || room?.state !== 'lobby') return;
  clearTimeout(customSyncTimer);
  customSyncTimer = setTimeout(() => {
    const words = parseCustomWords($('custom-words').value);
    localStorage.setItem('nextup_customwords', $('custom-words').value);
    $('custom-count').textContent = `${words.length} words (10 minimum)`;
    updateDoc(roomRef, { customWords: words }).catch(() => {});
  }, 600);
});

// Avatar picker
function renderAvatarPicker() {
  $('avatar-picker').innerHTML = AVATARS.map((a) =>
    `<button class="avatar-btn${a === myAvatar ? ' selected' : ''}" data-avatar="${a}">${a}</button>`
  ).join('');
  for (const b of document.querySelectorAll('.avatar-btn')) {
    b.addEventListener('click', () => {
      myAvatar = b.dataset.avatar;
      localStorage.setItem('nextup_avatar', myAvatar);
      renderAvatarPicker();
    });
  }
}
renderAvatarPicker();

// Restore name
$('name-input').value = localStorage.getItem('nextup_name') || '';
$('version-label').textContent = `v${APP_VERSION}`;

// iOS/Android only allow sound after a user gesture — unlock audio on first tap
document.addEventListener('pointerdown', () => {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* fine */ }
});

// ---------------------------------------------------------------- menu / about / share / refresh
async function fullRefresh() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* best effort — reload anyway */ }
  location.reload();
}

async function shareApp() {
  const base = location.origin + location.pathname;
  const inRoom = room && roomCode;
  const url = inRoom ? `${base}?join=${roomCode}` : base;
  const data = {
    title: 'Next Up',
    text: inRoom
      ? `Join my Next Up room! Code: ${roomCode}`
      : 'Play Next Up with me — the shout-it-out party guessing game!',
    url,
  };
  try {
    if (navigator.share) await navigator.share(data);
    else { await navigator.clipboard.writeText(`${data.text} ${url}`); toast('Link copied!'); }
  } catch { /* user cancelled the share sheet — fine */ }
}

$('btn-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  // contextual items: leave for anyone in a room, restart/end for the host mid-game
  const inRoom = !!room;
  (inRoom ? show : hide)($('menu-leave'));
  ((inRoom && isHost() && room.state !== 'lobby') ? show : hide)($('menu-restart'));
  ((inRoom && isHost() && ['intro', 'playing', 'summary'].includes(room.state)) ? show : hide)($('menu-endgame'));
  $('menu-dropdown').classList.toggle('hidden');
});
$('menu-leave').addEventListener('click', () => {
  hide($('menu-dropdown'));
  if (confirm('Leave the room?')) leaveRoom(true);
});
$('menu-restart').addEventListener('click', () => {
  hide($('menu-dropdown'));
  if (!isHost()) return;
  if (confirm('Restart the game? Scores reset and everyone goes back to the lobby.')) playAgain();
});
$('menu-endgame').addEventListener('click', () => {
  hide($('menu-dropdown'));
  if (!isHost()) return;
  if (confirm('End the game now and show final scores?')) {
    updateDoc(roomRef, { state: 'gameover', round: null }).catch(console.error);
  }
});
document.addEventListener('click', (e) => {
  if (!$('menu-wrap').contains(e.target)) hide($('menu-dropdown'));
});
$('menu-refresh').addEventListener('click', fullRefresh);
$('menu-share').addEventListener('click', () => { hide($('menu-dropdown')); shareApp(); });
$('menu-about').addEventListener('click', () => {
  hide($('menu-dropdown'));
  $('about-version').textContent = `Version ${APP_VERSION}`;
  show($('about-modal'));
});
$('btn-about-close').addEventListener('click', () => hide($('about-modal')));
$('btn-update').addEventListener('click', fullRefresh);

// On open: fetch version.js fresh and prompt to refresh if a newer version is deployed
async function checkForUpdate() {
  try {
    const res = await fetch(`version.js?nocache=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const m = (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m && m[1] !== APP_VERSION) show($('update-banner'));
  } catch { /* offline — skip */ }
}
checkForUpdate();

// ?join=CODE links (QR / shares) → prefill, and auto-join if we already have a name
const joinParam = new URLSearchParams(location.search).get('join');
const savedRoom = localStorage.getItem('nextup_room');
if (joinParam && /^[A-Za-z]{4}$/.test(joinParam)) {
  history.replaceState(null, '', location.pathname);
  $('code-input').value = joinParam.toUpperCase();
  if (myName()) joinRoom();
  else toast(`Enter your name, then tap Join for room ${joinParam.toUpperCase()}!`);
} else if (savedRoom) {
  // auto-rejoin a room if we were in one (e.g. accidental refresh)
  getDoc(doc(db, 'rooms', savedRoom)).then((snap) => {
    if (snap.exists() && snap.data().players?.[playerId]) enterRoom(savedRoom);
    else localStorage.removeItem('nextup_room');
  }).catch(() => {});
}

// ---------------------------------------------------------------- PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).catch(() => {});
}
