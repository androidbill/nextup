import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  increment, arrayUnion, deleteField, deleteDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { DECKS } from './decks.js';

export const APP_VERSION = '2026.07.24.01';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ---------------------------------------------------------------- identity
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
let playerId = localStorage.getItem('nextup_pid');
if (!playerId) { playerId = uid(); localStorage.setItem('nextup_pid', playerId); }

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
const sndBuzzer = () => { beep(180, 0.7, 0.35, 'sawtooth'); };
const sndCorrect = () => { beep(660, 0.1); setTimeout(() => beep(990, 0.15), 90); };
const sndWrong = () => beep(220, 0.2, 0.2, 'sawtooth');
const sndStart = () => { beep(523, 0.1); setTimeout(() => beep(784, 0.2), 110); };

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

// ---------------------------------------------------------------- room state
let roomCode = null;
let roomRef = null;
let unsub = null;
let room = null;           // latest snapshot data
let timerInterval = null;
let lastTickSecond = null;
let prevState = null;
let prevWordIndex = -1;

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
function playerName(id) { return room?.players?.[id]?.name || '???'; }

// Build the words for a round, avoiding repeats across the whole game
function buildRoundWords(deckKey, usedWords) {
  const deck = DECKS[deckKey] || DECKS.mix;
  const used = new Set(usedWords || []);
  let pool = deck.words.filter((w) => !used.has(w));
  if (pool.length < 25) pool = deck.words; // deck exhausted — recycle
  return shuffle(pool).slice(0, 50);
}

// ---------------------------------------------------------------- create / join
async function createRoom() {
  const name = myName();
  if (!name) return toast('Enter your name first!');
  localStorage.setItem('nextup_name', name);
  $('btn-create').disabled = true;
  try {
    let code, ref, snap;
    do {
      code = makeCode();
      ref = doc(db, 'rooms', code);
      snap = await getDoc(ref);
    } while (snap.exists());

    await setDoc(ref, {
      code,
      createdAt: Date.now(),
      hostId: playerId,
      state: 'lobby',
      settings: { deck: 'mix', roundSeconds: 60 },
      players: { [playerId]: { name, score: 0, joinedAt: Date.now() } },
      upQueue: [],
      usedWords: [],
      round: null,
      roundNum: 0,
    });
    enterRoom(code);
  } catch (e) {
    console.error(e);
    toast('Could not create room — check your connection.');
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
    const snap = await getDoc(ref);
    if (!snap.exists()) return toast(`Room ${code} not found.`);
    const data = snap.data();
    const existing = data.players?.[playerId];
    if (!existing) {
      const nameTaken = Object.values(data.players || {}).some(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (nameTaken) return toast('That name is taken in this room — pick another.');
      await updateDoc(ref, {
        [`players.${playerId}`]: { name, score: 0, joinedAt: Date.now() },
      });
    }
    enterRoom(code);
  } catch (e) {
    console.error(e);
    toast('Could not join — check the code and your connection.');
  } finally {
    $('btn-join').disabled = false;
  }
}

function enterRoom(code) {
  roomCode = code;
  roomRef = doc(db, 'rooms', code);
  localStorage.setItem('nextup_room', code);
  if (unsub) unsub();
  unsub = onSnapshot(roomRef, (snap) => {
    if (!snap.exists()) {
      toast('The room was closed.');
      leaveRoom(false);
      return;
    }
    room = snap.data();
    render();
  }, (err) => {
    console.error(err);
    toast('Lost connection to the room.');
  });
}

async function leaveRoom(removeSelf = true) {
  if (unsub) { unsub(); unsub = null; }
  if (removeSelf && roomRef && room) {
    try {
      if (isHost() && Object.keys(room.players || {}).length === 1) {
        await deleteDoc(roomRef); // last one out closes the room
      } else {
        const updates = { [`players.${playerId}`]: deleteField() };
        // Hand off host role if the host leaves
        if (isHost()) {
          const others = Object.keys(room.players).filter((id) => id !== playerId);
          if (others.length) updates.hostId = others[0];
        }
        await updateDoc(roomRef, updates);
      }
    } catch { /* best effort */ }
  }
  roomCode = null; roomRef = null; room = null;
  localStorage.removeItem('nextup_room');
  stopTimer();
  keepAwake(false);
  showScreen('screen-home');
}

// ---------------------------------------------------------------- game flow
function nextRoundAssignments() {
  const ids = Object.keys(room.players);
  let queue = (room.upQueue || []).filter((id) => ids.includes(id));
  if (queue.length === 0) queue = shuffle(ids); // new cycle: everyone goes once
  const guesserId = queue[0];
  queue = queue.slice(1);
  const others = ids.filter((id) => id !== guesserId);
  const scorerId = pickRandom(others);
  return { guesserId, scorerId, queue };
}

async function startGame() {
  if (!isHost()) return;
  const ids = Object.keys(room.players || {});
  if (ids.length < 2) return toast('You need at least 2 players!');
  const deck = $('deck-select').value;
  const roundSeconds = parseInt($('time-select').value, 10);
  const { guesserId, scorerId, queue } = { ...nextRoundAssignments() };
  const words = buildRoundWords(deck, []);
  try {
    await updateDoc(roomRef, {
      settings: { deck, roundSeconds },
      state: 'intro',
      roundNum: 1,
      upQueue: queue,
      usedWords: [],
      round: {
        guesserId, scorerId, words, index: 0, results: [],
        startsAt: null, endsAt: null,
      },
    });
  } catch (e) { console.error(e); toast('Could not start the game.'); }
}

async function guesserReady() {
  const secs = room.settings.roundSeconds || 60;
  const startsAt = Date.now() + 3500; // 3-2-1 countdown
  try {
    await updateDoc(roomRef, {
      state: 'playing',
      'round.startsAt': startsAt,
      'round.endsAt': startsAt + secs * 1000,
    });
  } catch (e) { console.error(e); toast('Something went wrong — try again.'); }
}

let scoreTapLock = false;
async function scoreWord(correct) {
  if (!room || room.state !== 'playing' || !isScorer()) return;
  if (Date.now() < room.round.startsAt) return; // still counting down
  if (scoreTapLock) return;
  scoreTapLock = true;
  setTimeout(() => { scoreTapLock = false; }, 350); // debounce double taps
  const r = room.round;
  const word = r.words[r.index];
  if (!word) return;
  correct ? sndCorrect() : sndWrong();
  const updates = {
    'round.index': increment(1),
    'round.results': arrayUnion({ word, correct }),
    usedWords: arrayUnion(word),
  };
  if (correct) updates[`players.${r.guesserId}.score`] = increment(1);
  // Ran out of words? End the round early.
  if (r.index + 1 >= r.words.length) updates.state = 'summary';
  try { await updateDoc(roomRef, updates); } catch (e) { console.error(e); }
}

async function endRoundByTimer() {
  try { await updateDoc(roomRef, { state: 'summary' }); } catch { /* someone else got it */ }
}

async function nextRound() {
  if (!isScorer()) return;
  const { guesserId, scorerId, queue } = nextRoundAssignments();
  const words = buildRoundWords(room.settings.deck, room.usedWords);
  try {
    await updateDoc(roomRef, {
      state: 'intro',
      roundNum: (room.roundNum || 1) + 1,
      upQueue: queue,
      round: {
        guesserId, scorerId, words, index: 0, results: [],
        startsAt: null, endsAt: null,
      },
    });
  } catch (e) { console.error(e); toast('Could not start the next round.'); }
}

async function endGame() {
  if (!isScorer()) return;
  try { await updateDoc(roomRef, { state: 'gameover', round: null }); }
  catch (e) { console.error(e); }
}

async function playAgain() {
  if (!isHost()) return;
  const updates = { state: 'lobby', round: null, roundNum: 0, upQueue: [], usedWords: [] };
  for (const id of Object.keys(room.players)) updates[`players.${id}.score`] = 0;
  try { await updateDoc(roomRef, updates); }
  catch (e) { console.error(e); }
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
  if (!room || room.state !== 'playing' || !room.round?.startsAt) { stopTimer(); return; }
  const now = Date.now();
  const { startsAt, endsAt } = room.round;
  const overlay = $('countdown-overlay');

  if (now < startsAt) {
    // 3-2-1 countdown
    const n = Math.ceil((startsAt - now) / 1000);
    $('countdown-num').textContent = n > 3 ? '3' : String(n);
    show(overlay);
    return;
  }
  if (!overlay.classList.contains('hidden')) { hide(overlay); if (!isGuesser()) sndStart(); }

  const msLeft = Math.max(0, endsAt - now);
  const secLeft = Math.ceil(msLeft / 1000);
  const total = (room.settings.roundSeconds || 60) * 1000;

  const timerEl = $('play-timer');
  timerEl.textContent = String(secLeft);
  timerEl.classList.toggle('low', secLeft <= 10);
  const bar = $('timebar');
  bar.style.width = `${(msLeft / total) * 100}%`;
  bar.classList.toggle('low', secLeft <= 10);

  // tick sound for the last 5 seconds (not on the guesser's face-down phone)
  if (!isGuesser() && secLeft <= 5 && secLeft > 0 && secLeft !== lastTickSecond) {
    lastTickSecond = secLeft;
    sndTick();
  }

  if (msLeft <= 0) {
    stopTimer();
    if (!isGuesser()) sndBuzzer();
    // The scorekeeper's device ends the round; everyone else is a fallback after a grace period.
    if (isScorer()) endRoundByTimer();
    else setTimeout(() => { if (room?.state === 'playing') endRoundByTimer(); }, 2500);
  }
}

// ---------------------------------------------------------------- rendering
function render() {
  if (!room) return;
  const stateChanged = room.state !== prevState;

  switch (room.state) {
    case 'lobby': renderLobby(); break;
    case 'intro': renderIntro(); break;
    case 'playing': renderPlaying(stateChanged); break;
    case 'summary': renderSummary(); break;
    case 'gameover': renderGameOver(); break;
    default: renderLobby();
  }

  if (stateChanged) {
    keepAwake(room.state === 'playing' || room.state === 'intro');
    if (room.state !== 'playing') stopTimer();
  }
  prevState = room.state;
}

function renderLobby() {
  showScreen('screen-lobby');
  $('lobby-code').textContent = room.code;
  $('lobby-url').textContent = location.host;

  const ids = Object.keys(room.players || {}).sort(
    (a, b) => (room.players[a].joinedAt || 0) - (room.players[b].joinedAt || 0)
  );
  $('lobby-count').textContent = `(${ids.length})`;
  $('lobby-players').innerHTML = ids.map((id) => {
    const p = room.players[id];
    return `<li><span>${esc(p.name)}</span>
      ${id === room.hostId ? '<span class="host-tag">HOST</span>' : ''}
      ${id === playerId ? '<span class="you-tag">YOU</span>' : ''}</li>`;
  }).join('');

  if (isHost()) {
    show($('lobby-settings')); hide($('lobby-settings-view'));
    show($('btn-start')); hide($('lobby-wait-msg'));
    $('btn-start').disabled = ids.length < 2;
    $('btn-start').textContent = ids.length < 2 ? '🚀 Start Game (need 2+ players)' : '🚀 Start Game';
  } else {
    hide($('lobby-settings')); show($('lobby-settings-view'));
    hide($('btn-start')); show($('lobby-wait-msg'));
    const deck = DECKS[room.settings?.deck] || DECKS.mix;
    $('settings-summary').textContent =
      `${deck.label} · ${room.settings?.roundSeconds || 60}s rounds`;
  }
}

function renderIntro() {
  showScreen('screen-intro');
  $('intro-round').textContent = `ROUND ${room.roundNum || 1}`;
  $('intro-guesser').textContent = playerName(room.round.guesserId);
  $('intro-scorer').textContent = playerName(room.round.scorerId);
  if (isGuesser()) {
    show($('intro-guesser-panel')); hide($('intro-wait-msg'));
  } else {
    hide($('intro-guesser-panel')); show($('intro-wait-msg'));
    $('intro-wait-msg').textContent =
      `Waiting for ${playerName(room.round.guesserId)} to put their phone down…`;
  }
}

function renderPlaying(stateChanged) {
  showScreen('screen-play');
  const r = room.round;

  if (isGuesser()) {
    show($('play-guesser')); hide($('play-clue'));
  } else {
    hide($('play-guesser')); show($('play-clue'));
    const deck = DECKS[room.settings?.deck] || DECKS.mix;
    $('word-deck').textContent = deck.label.replace(/^\S+\s/, ''); // drop emoji
    $('word-text').textContent = r.words[r.index] || '🎉 Deck cleared!';
    const got = (r.results || []).filter((x) => x.correct).length;
    $('play-tally').textContent = got ? `✓ ${got}` : '';
    if (isScorer()) {
      show($('scorer-buttons'));
      $('clue-hint').textContent = 'Tap when they get it or give up!';
    } else {
      hide($('scorer-buttons'));
      $('clue-hint').textContent = `Shout clues to ${playerName(r.guesserId)} — don't say the word!`;
    }
  }
  prevWordIndex = r.index;
  if (stateChanged || !timerInterval) startTimerLoop();
}

function renderSummary() {
  showScreen('screen-summary');
  const r = room.round || { results: [] };
  const results = r.results || [];
  const got = results.filter((x) => x.correct).length;
  $('summary-round').textContent = `ROUND ${room.roundNum || 1} OVER`;
  $('summary-headline').innerHTML =
    `🎤 ${esc(playerName(r.guesserId))} got <span style="color:var(--green)">${got}</span> right!`;

  $('summary-words').innerHTML = results.length
    ? results.map((x) =>
        `<li><span>${esc(x.word)}</span><span class="${x.correct ? 'res-ok' : 'res-no'}">${x.correct ? '✓' : '✗'}</span></li>`
      ).join('')
    : '<li><span>No words were scored this round.</span><span></span></li>';

  renderScoreList($('summary-scores'));

  if (isScorer()) {
    show($('summary-scorer-panel')); hide($('summary-wait-msg'));
  } else {
    hide($('summary-scorer-panel')); show($('summary-wait-msg'));
    $('summary-wait-msg').textContent =
      `${playerName(r.scorerId)} chooses what happens next…`;
  }
}

function renderGameOver() {
  showScreen('screen-gameover');
  renderScoreList($('final-scores'));
  if (isHost()) { show($('btn-play-again')); hide($('gameover-wait-msg')); }
  else { hide($('btn-play-again')); show($('gameover-wait-msg')); }
}

function renderScoreList(el) {
  const entries = Object.entries(room.players || {})
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  el.innerHTML = entries.map(([id, p], i) => {
    const medal = i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : '';
    return `<li><span>${medal}${esc(p.name)}${id === playerId ? ' (you)' : ''}</span>
      <span class="pts">${p.score || 0}</span></li>`;
  }).join('');
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

// Deck dropdown
$('deck-select').innerHTML = Object.entries(DECKS)
  .map(([key, d]) => `<option value="${key}">${d.label}</option>`).join('');

// Restore name + auto-rejoin a room if we were in one (e.g. accidental refresh)
$('name-input').value = localStorage.getItem('nextup_name') || '';
$('version-label').textContent = `v${APP_VERSION}`;

const savedRoom = localStorage.getItem('nextup_room');
if (savedRoom) {
  getDoc(doc(db, 'rooms', savedRoom)).then((snap) => {
    if (snap.exists() && snap.data().players?.[playerId]) enterRoom(savedRoom);
    else localStorage.removeItem('nextup_room');
  }).catch(() => {});
}

// ---------------------------------------------------------------- PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).catch(() => {});
}
