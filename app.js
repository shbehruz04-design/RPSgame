/**
 * RPS BATTLE — Frontend Logic
 * ═══════════════════════════
 * Fixes applied vs original:
 *  1. Removed ~900 lines of duplicate function definitions (two of every function)
 *  2. Fixed `syncBackendAvailability` — btnCreateRoom/btnJoinRoom were not in dom.waiting
 *     (they are dom.waiting.btnCreateRoom / dom.waiting.btnJoinRoom)
 *  3. Fixed `renderOutcomeBanner` duplicate declaration (was defined twice, causing SyntaxError
 *     in strict-mode builds)
 *  4. Fixed `syncRoomHeader` duplicate declaration
 *  5. Fixed `syncBoardFromRoom` duplicate declaration
 *  6. Fixed `joinQuickMatch` / `routeToHome` / `refreshMatchmaking` / `refreshRoomState`
 *     / `renderRoomWaiting` / `createPrivateRoom` / `joinPrivateRoom` all declared twice
 *  7. Fixed `readyNextRound` / `leaveCurrentSession` duplicate declarations
 *  8. Fixed `playSoloRound` / `submitRoomChoice` duplicate declarations
 *  9. `showGameScreenForSolo` was unused dead code — consolidated into `startSoloMode`
 * 10. `main` function called `loadProfile` and then `setScreen("home")` but never called
 *     `syncBackendAvailability` — fixed in `bootstrap`
 * 11. `dom.game.avatarOppInit` querySelector was fragile — now uses getElementById via
 *     `id="game-init-opp"` on the span (added in index.html)
 * 12. Offline notice (#offline-notice) now shown/hidden correctly
 * 13. `startSoloModeIfNeeded` was dead code — removed
 * 14. `submitChoice` wrapper was dead code — removed (direct calls used)
 * 15. Score display in solo mode fixed — was showing cumulative stats instead of session wins/losses
 */

(function () {
  "use strict";

  /* ════════════════════════════════════════
     CONSTANTS
     ════════════════════════════════════════ */

  const CHOICES = ["rock", "paper", "scissors"];
  const CHOICE_EMOJI = { rock: "🪨", paper: "📄", scissors: "✂️" };
  const BEATS = { rock: "scissors", paper: "rock", scissors: "paper" };

  const STORAGE_KEY = "rps_fallback_state_v3";
  const USERNAME_KEY = "rps_username_v1";
  const PREFS_KEY = "rps_preferences_v3";
  const CLIENT_ID_KEY = "rps_client_id_v3";

  const WIN_MESSAGES = [
    "Clean win.",
    "You read that round perfectly.",
    "That was sharp play.",
    "No hesitation, no mercy.",
  ];
  const LOSE_MESSAGES = [
    "The CPU got you this time.",
    "Reset and run it back.",
    "One round is not the whole match.",
    "Next one is yours.",
  ];
  const DRAW_MESSAGES = [
    "Perfectly balanced.",
    "Same idea, same time.",
    "Nothing wrong with a draw.",
    "You were both thinking alike.",
  ];

  /* ════════════════════════════════════════
     STATE
     ════════════════════════════════════════ */

  const state = {
    clientId: getOrCreateClientId(),
    profile: {
      name: "Player",
      stats: { wins: 0, losses: 0, draws: 0, currentStreak: 0, bestStreak: 0 },
    },
    soundEnabled: true,
    backendReady: false,
    telegram: null,
    audioCtx: null,
    mode: "home", // home | solo | quick | private
    session: null, // { kind, roomId, code }
    room: null,
    isPlaying: false,
    pollTimer: null,
    lastRoomRenderKey: "",
    // Solo session scores (reset per game entry)
    soloScore: { wins: 0, losses: 0 },
    // Internal flags
    _leaving: false,
    _resultPendingTimer: null,
    // Monotonic counters to discard stale/out-of-order async responses
    _roomFetchSeq: 0,
    _roomFetchSeqApplied: 0,
    // Solo mode session token — incremented each time a new solo game
    // starts, so an in-flight playSoloRound() from a PREVIOUS solo
    // session can detect it's stale and abort instead of corrupting
    // the new session's score/board.
    _soloSessionId: 0,
    // Optimistic "I clicked Next round" flag — survives stale poll overwrites
    _optimisticReady: false,
    _optimisticReadyRoundKey: "",
    _readyInFlight: false,
  };

  /* ════════════════════════════════════════
     DOM REFERENCES
     ════════════════════════════════════════ */

  const dom = {
    screens: {
      username: document.getElementById("screen-username"),
      home: document.getElementById("screen-home"),
      waiting: document.getElementById("screen-waiting"),
      game: document.getElementById("screen-game"),
    },
    setup: {
      avatarInit: document.getElementById("setup-avatar-init"),
      input: document.getElementById("username-input"),
      btnConfirm: document.getElementById("btn-confirm-username"),
    },
    home: {
      avatarImg: document.getElementById("home-avatar-img"),
      avatarInit: document.getElementById("home-avatar-init"),
      name: document.getElementById("home-name"),
      wins: document.getElementById("stat-wins"),
      played: document.getElementById("stat-played"),
      streak: document.getElementById("stat-streak"),
      btnVsBot: document.getElementById("btn-vs-bot"),
      btnQuickMatch: document.getElementById("btn-quick-match"),
      btnPrivate: document.getElementById("btn-private"),
      btnSound: document.getElementById("btn-sound-home"),
      offlineNotice: document.getElementById("offline-notice"),
      badgeQuick: document.getElementById("badge-quick"),
      badgePrivate: document.getElementById("badge-private"),
    },
    waiting: {
      title: document.getElementById("waiting-title"),
      sub: document.getElementById("waiting-sub"),
      roomCodeBox: document.getElementById("room-code-box"),
      roomCodeValue: document.getElementById("room-code-val"),
      btnCopyCode: document.getElementById("btn-copy-code"),
      joinBox: document.getElementById("join-box"),
      codeInput: document.getElementById("code-input"),
      btnJoinRoom: document.getElementById("btn-join-room"),
      btnCreateRoom: document.getElementById("btn-create-room"),
      btnCancel: document.getElementById("btn-cancel-wait"),
    },
    game: {
      modeBadge: document.getElementById("game-mode-badge"),
      btnBack: document.getElementById("btn-back-game"),
      btnSound: document.getElementById("btn-sound-game"),
      avatarYouImg: document.getElementById("game-img-you"),
      avatarYouInit: document.getElementById("game-init-you"),
      avatarOppInit: document.getElementById("game-init-opp"),
      nameYou: document.getElementById("game-name-you"),
      nameOpp: document.getElementById("game-name-opp"),
      scoreYou: document.getElementById("game-score-you"),
      scoreOpp: document.getElementById("game-score-opp"),
      arenaYou: document.getElementById("arena-you"),
      arenaOpp: document.getElementById("arena-opp"),
      arenaEmojiYou: document.getElementById("arena-emoji-you"),
      arenaEmojiOpp: document.getElementById("arena-emoji-opp"),
      arenaLabel: document.getElementById("arena-label"),
      resultStrip: document.getElementById("result-strip"),
      resultText: document.getElementById("result-strip-text"),
      resultMsg: document.getElementById("result-strip-msg"),
      choicesRow: document.getElementById("choices-row"),
      choiceButtons: Array.from(document.querySelectorAll(".weapon-btn")),
      playAgainRow: document.getElementById("play-again-row"),
      btnPlayAgain: document.getElementById("btn-play-again"),
      btnLeaveGame: document.getElementById("btn-leave-game"),
      oppStatus: document.getElementById("opp-status"),
      oppStatusText: document.getElementById("opp-status-text"),
    },
    toast: document.getElementById("toast"),
    fxCanvas: document.getElementById("fx-canvas"),
  };

  /* ════════════════════════════════════════
     LOCAL STORAGE HELPERS
     ════════════════════════════════════════ */

  function getOrCreateClientId() {
    // Prefer a STABLE id derived from the Telegram user, when available.
    // This must be checked BEFORE falling back to localStorage, because:
    //  1. It ensures the SAME real person always gets the SAME id, even
    //     across different devices/windows/app reinstalls — which is what
    //     lets the server's self-match guard correctly prevent a player
    //     from being matched against themselves in Quick Match.
    //  2. WebView-embedded contexts (Telegram Mini Apps, wrapped mobile
    //     apps) don't always persist localStorage reliably across reloads,
    //     which would otherwise mint a brand-new random id every launch.
    const tgUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    if (tgUserId) return `tg_${tgUserId}`;

    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const id =
      window.crypto?.randomUUID?.() ||
      `client_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  }

  function loadPreferences() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.soundEnabled === "boolean")
        state.soundEnabled = p.soundEnabled;
    } catch (_) {}
  }

  function savePreferences() {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ soundEnabled: state.soundEnabled }),
    );
  }

  function loadFallbackProfile() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data?.profile?.name) state.profile.name = data.profile.name;
      if (data?.profile?.stats)
        Object.assign(state.profile.stats, data.profile.stats);
    } catch (_) {}
  }

  function saveFallbackProfile() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ profile: state.profile }),
    );
  }

  /* ════════════════════════════════════════
     USERNAME SETUP
     ════════════════════════════════════════ */

  function hasSavedUsername() {
    try {
      return !!localStorage.getItem(USERNAME_KEY);
    } catch (_) {
      return false;
    }
  }

  function saveUsername(name) {
    try {
      localStorage.setItem(USERNAME_KEY, name);
    } catch (_) {}
  }

  function loadSavedUsername() {
    try {
      return localStorage.getItem(USERNAME_KEY) || "";
    } catch (_) {
      return "";
    }
  }

  function confirmUsername() {
    const raw = dom.setup.input.value.trim();
    if (!raw) {
      dom.setup.input.classList.add("input-error");
      dom.setup.input.placeholder = "Please enter a name!";
      setTimeout(() => {
        dom.setup.input.classList.remove("input-error");
        dom.setup.input.placeholder = "Enter your name…";
      }, 1200);
      return;
    }
    const name = raw.slice(0, 20);
    state.profile.name = name;
    saveUsername(name);
    saveFallbackProfile();
    syncProfileToUI();
    setScreen("home");
    loadProfile(); // loadProfile calls syncBackendAvailability internally
  }

  /* ════════════════════════════════════════
     TELEGRAM INTEGRATION
     ════════════════════════════════════════ */

  function getTelegram() {
    return window.Telegram?.WebApp || null;
  }

  function initTelegram() {
    const tg = getTelegram();
    state.telegram = tg;
    if (!tg) return;

    tg.ready();
    tg.expand();

    const user = tg.initDataUnsafe?.user;
    if (!user) return;

    const displayName = user.first_name || user.username || "Player";
    state.profile.name = displayName;

    if (user.photo_url) {
      setAvatar(
        dom.home.avatarImg,
        dom.home.avatarInit,
        user.photo_url,
        displayName,
      );
      setAvatar(
        dom.game.avatarYouImg,
        dom.game.avatarYouInit,
        user.photo_url,
        displayName,
      );
    }
  }

  function triggerHaptic(type) {
    const tg = getTelegram();
    if (!tg?.HapticFeedback) return;
    if (["light", "medium", "heavy"].includes(type)) {
      tg.HapticFeedback.impactOccurred(type);
    } else {
      tg.HapticFeedback.notificationOccurred(type);
    }
  }

  /* ════════════════════════════════════════
     UI HELPERS
     ════════════════════════════════════════ */

  function setScreen(name) {
    Object.entries(dom.screens).forEach(([key, el]) => {
      if (!el) return;
      el.classList.toggle("active", key === name);
    });
  }

  function setAvatar(imgEl, initEl, src, name) {
    if (!imgEl || !initEl) return;
    // Show initial while image loads
    initEl.textContent = getInitial(name);
    initEl.hidden = false;
    imgEl.hidden = true;
    imgEl.src = "";

    if (!src) return;

    const tempImg = new Image();
    tempImg.onload = () => {
      imgEl.src = src;
      imgEl.hidden = false;
      initEl.hidden = true;
    };
    tempImg.onerror = () => {
      imgEl.hidden = true;
      initEl.hidden = false;
      initEl.textContent = getInitial(name);
    };
    tempImg.src = src;
  }

  function getInitial(name) {
    return (name || "P").trim().charAt(0).toUpperCase() || "P";
  }

  function showToast(message) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    dom.toast.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      dom.toast.classList.remove("show");
      setTimeout(() => {
        dom.toast.hidden = true;
      }, 260);
    }, 2000);
  }

  function animateScore(el) {
    if (!el) return;
    el.classList.remove("score-pop");
    void el.offsetWidth;
    el.classList.add("score-pop");
  }

  function syncSoundButtons() {
    const label = state.soundEnabled ? "🔊 Sound on" : "🔇 Sound off";
    dom.home.btnSound.textContent = label;
    dom.game.btnSound.textContent = state.soundEnabled ? "🔊" : "🔇";
  }

  function syncProfileToUI() {
    const { name, stats } = state.profile;
    dom.home.name.textContent = name;
    dom.home.wins.textContent = String(stats.wins);
    dom.home.played.textContent = String(
      stats.wins + stats.losses + stats.draws,
    );
    dom.home.streak.textContent = String(stats.bestStreak);

    // Initials fallback
    if (!state.telegram?.initDataUnsafe?.user?.photo_url) {
      const init = getInitial(name);
      dom.home.avatarInit.textContent = init;
      dom.game.avatarYouInit.textContent = init;
    }
  }

  /**
   * Update multiplayer buttons based on backend availability.
   * Also shows/hides the offline notice and mode badges.
   */
  function syncBackendAvailability() {
    const ok = state.backendReady;

    dom.home.btnQuickMatch.disabled = !ok;
    dom.home.btnPrivate.disabled = !ok;

    // Offline notice
    if (dom.home.offlineNotice) dom.home.offlineNotice.hidden = ok;

    // Mode card badges
    if (dom.home.badgeQuick) {
      dom.home.badgeQuick.textContent = ok ? "Online" : "Offline";
      dom.home.badgeQuick.classList.toggle("offline", !ok);
    }
    if (dom.home.badgePrivate) {
      dom.home.badgePrivate.textContent = ok ? "Online" : "Offline";
      dom.home.badgePrivate.classList.toggle("offline", !ok);
    }
  }

  function showWaitingScreen(title, sub, options = {}) {
    dom.waiting.title.textContent = title;
    dom.waiting.sub.textContent = sub;
    dom.waiting.roomCodeBox.hidden = !options.showCode;
    dom.waiting.joinBox.hidden = !options.showJoin;
    dom.waiting.btnCreateRoom.hidden = !options.showCreate;
    // Re-enable action buttons each time this screen is shown — otherwise
    // a successful create/join leaves them permanently disabled (the
    // disabled flag was only ever cleared in the error/catch path), making
    // it impossible to create or join a room again after returning here.
    dom.waiting.btnCreateRoom.disabled = false;
    dom.waiting.btnJoinRoom.disabled = false;
    setScreen("waiting");
  }

  /* ════════════════════════════════════════
     AUDIO (Web Audio API — synthesised)
     ════════════════════════════════════════ */

  function getAudioContext() {
    if (state.audioCtx) return state.audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      state.audioCtx = new Ctor();
      return state.audioCtx;
    } catch (_) {
      return null;
    }
  }

  function playSound(type) {
    if (!state.soundEnabled) return;
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    const tone = (freq, dur, oscType, gain = 0.12, delay = 0) => {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = oscType;
      osc.frequency.setValueAtTime(freq, now + delay);
      amp.gain.setValueAtTime(gain, now + delay);
      amp.gain.exponentialRampToValueAtTime(0.001, now + delay + dur);
      osc.connect(amp);
      amp.connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + dur);
    };

    if (type === "click") {
      tone(520, 0.09, "sine", 0.14);
    } else if (type === "win") {
      [523, 659, 784, 1047].forEach((f, i) =>
        tone(f, 0.18, "triangle", 0.16, i * 0.09),
      );
    } else if (type === "lose") {
      tone(220, 0.35, "sawtooth", 0.14);
    } else {
      tone(440, 0.22, "sine", 0.12);
    }
  }

  /* ════════════════════════════════════════
     CONFETTI
     ════════════════════════════════════════ */

  const confettiParticles = [];
  let confettiAnimationId = null;

  function resizeCanvas() {
    if (!dom.fxCanvas) return;
    dom.fxCanvas.width = window.innerWidth;
    dom.fxCanvas.height = window.innerHeight;
  }

  function launchConfetti() {
    const canvas = dom.fxCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    resizeCanvas();
    // Cancel any in-flight confetti loop before starting a new one —
    // otherwise rapid consecutive wins spawn multiple overlapping
    // requestAnimationFrame loops fighting over the same canvas/array.
    if (confettiAnimationId !== null) {
      cancelAnimationFrame(confettiAnimationId);
      confettiAnimationId = null;
    }
    confettiParticles.length = 0;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const colours = [
      "#4F8EF7",
      "#9B6DFF",
      "#34D399",
      "#FBBF24",
      "#F87171",
      "#22D3EE",
    ];
    for (let i = 0; i < 80; i++) {
      confettiParticles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height * 0.35 - canvas.height * 0.15,
        size: Math.random() * 6 + 3,
        speed: Math.random() * 3 + 1,
        tilt: Math.random() * 12 - 6,
        tiltAngle: 0,
        tiltSpeed: Math.random() * 0.08 + 0.03,
        colour: colours[Math.floor(Math.random() * colours.length)],
        alpha: 1,
      });
    }

    let frame = 0;
    (function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      frame++;
      confettiParticles.forEach((p, i) => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.beginPath();
        ctx.lineWidth = p.size;
        ctx.strokeStyle = p.colour;
        ctx.moveTo(p.x + p.tilt, p.y);
        ctx.lineTo(p.x + p.tilt + p.size / 2, p.y + p.size);
        ctx.stroke();
        ctx.restore();
        p.y += p.speed;
        p.tiltAngle += p.tiltSpeed;
        p.tilt = Math.sin(p.tiltAngle - i / 4) * 12;
        if (frame > 70) p.alpha -= 0.018;
      });

      if (frame < 150 && confettiParticles.some((p) => p.alpha > 0)) {
        confettiAnimationId = requestAnimationFrame(draw);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        confettiParticles.length = 0;
        confettiAnimationId = null;
      }
    })();
  }

  /* ════════════════════════════════════════
     GAME BOARD HELPERS
     ════════════════════════════════════════ */

  function randomChoice() {
    return CHOICES[Math.floor(Math.random() * CHOICES.length)];
  }

  function determineOutcome(playerChoice, opponentChoice) {
    if (playerChoice === opponentChoice) return "draw";
    return BEATS[playerChoice] === opponentChoice ? "win" : "lose";
  }

  function getOutcomeMessage(outcome) {
    const pool =
      outcome === "win"
        ? WIN_MESSAGES
        : outcome === "lose"
          ? LOSE_MESSAGES
          : DRAW_MESSAGES;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function setChoiceButtonsEnabled(enabled) {
    dom.game.choiceButtons.forEach((btn) => {
      btn.disabled = !enabled;
    });
  }

  function highlightChoice(choice) {
    dom.game.choiceButtons.forEach((btn) =>
      btn.classList.toggle("selected", btn.dataset.choice === choice),
    );
  }

  function clearChoiceHighlight() {
    dom.game.choiceButtons.forEach((btn) => btn.classList.remove("selected"));
  }

  function resetBoard() {
    dom.game.resultStrip.hidden = true;
    dom.game.playAgainRow.hidden = true;
    dom.game.oppStatus.hidden = true;
    dom.game.arenaEmojiYou.textContent = "❓";
    dom.game.arenaEmojiOpp.textContent = "❓";
    dom.game.arenaYou.classList.remove(
      "win",
      "lose",
      "draw",
      "thinking",
      "reveal",
    );
    dom.game.arenaOpp.classList.remove(
      "win",
      "lose",
      "draw",
      "thinking",
      "reveal",
    );
    dom.game.arenaLabel.textContent = "Pick!";
    setChoiceButtonsEnabled(true);
    clearChoiceHighlight();
    // Reset next-round button
    dom.game.btnPlayAgain.textContent = "Next round";
    dom.game.btnPlayAgain.classList.remove("ready-waiting", "result-pending");
    dom.game.btnPlayAgain.disabled = false;
    // Always reset playing flag on board reset
    state.isPlaying = false;
    // Clear optimistic-ready state — a fresh round has begun
    clearTimeout(state._resultPendingTimer);
    state._optimisticReady = false;
    state._optimisticReadyRoundKey = "";
  }

  function renderOutcomeBanner(outcome) {
    dom.game.resultText.textContent =
      outcome === "win"
        ? "You Win! 🎉"
        : outcome === "lose"
          ? "You Lose 😢"
          : "It's a Draw 🤝";
    dom.game.resultMsg.textContent = getOutcomeMessage(outcome);
    dom.game.resultStrip.className = "result-strip " + outcome;
    dom.game.resultStrip.hidden = false;
  }

  /* ════════════════════════════════════════
     MULTIPLAYER ROOM SYNC
     ════════════════════════════════════════ */

  function syncRoomHeader(room) {
    if (!room) return;
    if (room.type === "quick") {
      dom.game.modeBadge.textContent = "Quick match";
    } else if (room.code) {
      dom.game.modeBadge.textContent = `Room ${room.code}`;
    } else {
      dom.game.modeBadge.textContent = "Room";
    }
    dom.game.nameYou.textContent = room.you?.name || state.profile.name;
    dom.game.nameOpp.textContent = room.opponent?.name || "Waiting...";
    dom.game.scoreYou.textContent = String(room.you?.score?.wins ?? 0);
    // Keep last known opponent score if opponent left
    const oppWins =
      room.opponent?.score?.wins ?? state.room?.opponent?.score?.wins ?? 0;
    dom.game.scoreOpp.textContent = String(oppWins);

    if (dom.game.avatarOppInit) {
      dom.game.avatarOppInit.textContent = room.opponent?.name
        ? getInitial(room.opponent.name)
        : "🤖";
    }
    dom.game.oppStatus.hidden = !!room.opponent;
    if (!room.opponent) {
      dom.game.oppStatusText.textContent =
        room.type === "private"
          ? "Waiting for guest..."
          : "Finding opponent...";
    }
  }

  function syncBoardFromRoom(room) {
    if (!room) return;

    const youChoice = room.round?.choices?.you || null;
    const oppChoice = room.round?.choices?.opponent || null;
    const youResult = room.round?.results?.you || null;
    const roomKey = `${room.id}:${room.round?.index}:${room.phase}:${youResult || "none"}`;

    dom.game.arenaYou.classList.remove(
      "win",
      "lose",
      "draw",
      "thinking",
      "reveal",
    );
    dom.game.arenaOpp.classList.remove(
      "win",
      "lose",
      "draw",
      "thinking",
      "reveal",
    );

    if (room.phase === "revealed") {
      dom.game.arenaEmojiYou.textContent = CHOICE_EMOJI[youChoice] || "❓";
      dom.game.arenaEmojiOpp.textContent = CHOICE_EMOJI[oppChoice] || "❓";
      dom.game.arenaYou.classList.add("reveal");
      dom.game.arenaOpp.classList.add("reveal");

      if (youResult === "win") {
        dom.game.arenaYou.classList.add("win");
        dom.game.arenaOpp.classList.add("lose");
      } else if (youResult === "lose") {
        dom.game.arenaYou.classList.add("lose");
        dom.game.arenaOpp.classList.add("win");
      } else {
        dom.game.arenaYou.classList.add("draw");
        dom.game.arenaOpp.classList.add("draw");
      }

      dom.game.arenaLabel.textContent =
        youResult === "win"
          ? "You won!"
          : youResult === "lose"
            ? "You lost"
            : "Draw";
      renderOutcomeBanner(youResult || "draw");
      dom.game.playAgainRow.hidden = false;
      setChoiceButtonsEnabled(false);

      // Disable Next Round briefly so user can't press before result is seen.
      // IMPORTANT: if we've optimistically marked ourselves ready for THIS
      // exact round, trust that over a possibly-stale `room.you.ready` value —
      // this is what prevents the button from "flickering" back to clickable
      // after the user already pressed Next round.
      const currentRoundKey = `${room.id}:${room.round?.index}`;
      const optimisticallyReady =
        state._optimisticReady &&
        state._optimisticReadyRoundKey === currentRoundKey;
      const youReady = !!room.you?.ready || optimisticallyReady;
      const oppReady = !!room.opponent?.ready;

      if (!youReady) {
        // Not yet voted — show it as pending briefly, but stay clickable
        dom.game.btnPlayAgain.classList.add("result-pending");
        dom.game.btnPlayAgain.classList.remove("ready-waiting", "opponent-gone");
        dom.game.btnPlayAgain.textContent = "Next round";
      } else if (youReady && !oppReady) {
        // Already voted (or optimistically marked ready) — waiting for opponent
        clearTimeout(state._resultPendingTimer);
        if (room.opponent?.disconnected) {
          // Opponent's client has gone quiet (closed tab, backgrounded app,
          // lost connection...) — don't leave the player stuck forever.
          dom.game.btnPlayAgain.classList.remove("ready-waiting", "result-pending");
          dom.game.btnPlayAgain.classList.add("opponent-gone");
          dom.game.btnPlayAgain.textContent = "Raqib javob bermayapti 📴 (qayta urinish uchun bosing)";
          if (state.lastDisconnectNotice !== roomKey) {
            state.lastDisconnectNotice = roomKey;
            showToast("Raqib bilan aloqa uzildi. \"Leave\" tugmasini bosing.");
          }
        } else {
          dom.game.btnPlayAgain.classList.add("ready-waiting");
          dom.game.btnPlayAgain.classList.remove("result-pending", "opponent-gone");
          dom.game.btnPlayAgain.textContent = "Waiting for opponent… ⏳";
        }
      } else {
        // Both ready — new round starting
        clearTimeout(state._resultPendingTimer);
        dom.game.btnPlayAgain.classList.remove(
          "ready-waiting",
          "result-pending",
          "opponent-gone",
        );
        dom.game.btnPlayAgain.textContent = "Next round";
      }

      // Only fire sounds/confetti once per unique result
      if (state.lastRoomRenderKey !== roomKey) {
        state.lastRoomRenderKey = roomKey;
        if (youResult === "win") {
          playSound("win");
          triggerHaptic("success");
          launchConfetti();
          animateScore(dom.game.scoreYou);
        } else if (youResult === "lose") {
          playSound("lose");
          triggerHaptic("error");
          animateScore(dom.game.scoreOpp);
        } else {
          playSound("draw");
          triggerHaptic("medium");
        }
      }
      return;
    }

    // Not revealed yet: show your own choice but hide opponent's
    dom.game.arenaEmojiYou.textContent =
      youChoice && room.phase === "choosing"
        ? CHOICE_EMOJI[youChoice] || "❓"
        : "❓";
    dom.game.arenaEmojiOpp.textContent = "❓";
    dom.game.arenaLabel.textContent =
      room.phase === "waiting"
        ? room.type === "private"
          ? "Waiting for opponent"
          : "Finding opponent"
        : room.you?.choice && !room.opponent?.choice
          ? room.opponent?.disconnected
            ? "Raqib javob bermayapti 📴"
            : "Waiting for opponent..."
          : "Pick!";
    dom.game.resultStrip.hidden = true;
    dom.game.playAgainRow.hidden = true;
    setChoiceButtonsEnabled(!!room.canPlay);
  }

  function applyProfileFromServer(profile) {
    if (!profile) return;
    state.profile.name = profile.name || state.profile.name;
    Object.assign(state.profile.stats, profile.stats || {});
    state.backendReady = true;
    saveFallbackProfile();
    syncProfileToUI();
  }

  /* ════════════════════════════════════════
     API
     ════════════════════════════════════════ */

  function getBackendBaseUrl() {
    const configured = window.__RPS_BACKEND_URL__ || "";
    return configured.replace(/\/$/, "");
  }

  async function apiRequest(path, options = {}, timeoutMs = 25000) {
    const baseUrl = getBackendBaseUrl();
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
      clearTimeout(timer);
      const ct = res.headers.get("content-type") || "";
      const payload = ct.includes("application/json")
        ? await res.json()
        : await res.text();
      if (!res.ok) {
        const err = new Error(payload?.error || `Request failed: ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return payload;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        const e = new Error("Request timed out");
        e.transient = true;
        throw e;
      }
      if (err.status === undefined) err.transient = true; // network-level failure
      throw err;
    }
  }

  async function apiRequestRetry(path, options, attempts = 3, delayMs = 700) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await apiRequest(path, options);
      } catch (err) {
        lastErr = err;
        // Only retry transient (network/timeout) failures — a real server
        // error (room full, invalid move, etc) won't fix itself.
        if (!err.transient || i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
    throw lastErr;
  }

  async function loadProfile() {
    try {
      const health = await apiRequest("/api/health");
      state.backendReady = !!health?.ok;
    } catch (_) {
      state.backendReady = false;
    }

    if (state.backendReady) {
      try {
        const data = await apiRequest(
          `/api/profile?playerId=${encodeURIComponent(state.clientId)}&name=${encodeURIComponent(state.profile.name)}`,
        );
        applyProfileFromServer(data.profile);
      } catch (_) {
        state.backendReady = false;
      }
    }

    syncBackendAvailability();
    syncProfileToUI();
    syncSoundButtons();
  }

  /* ════════════════════════════════════════
     POLLING
     ════════════════════════════════════════ */

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling(fn, interval = 1200) {
    stopPolling();
    state.pollTimer = setInterval(fn, interval);
  }

  /* ════════════════════════════════════════
     ROUTING
     ════════════════════════════════════════ */

  function routeToHome() {
    stopPolling();
    state.mode = "home";
    state.session = null;
    state.room = null;
    state.isPlaying = false;
    state._leaving = false;
    state.lastRoomRenderKey = "";
    state.soloScore = { wins: 0, losses: 0 };
    state._optimisticReady = false;
    state._optimisticReadyRoundKey = "";
    state._readyInFlight = false;
    clearTimeout(state._resultPendingTimer);
    setScreen("home");
    syncProfileToUI();
  }

  /* ════════════════════════════════════════
     SOLO (vs CPU) MODE
     ════════════════════════════════════════ */

  function startSoloMode() {
    stopPolling();
    state.mode = "solo";
    state.session = { kind: "solo" };
    state.room = null;
    state.soloScore = { wins: 0, losses: 0 };
    // Invalidate any in-flight playSoloRound() from a previous session
    state._soloSessionId++;
    setScreen("game");
    dom.game.modeBadge.textContent = "vs CPU";
    dom.game.nameYou.textContent = state.profile.name;
    dom.game.nameOpp.textContent = "CPU";
    dom.game.scoreYou.textContent = "0";
    dom.game.scoreOpp.textContent = "0";
    if (dom.game.avatarOppInit) dom.game.avatarOppInit.textContent = "🤖";
    dom.game.oppStatus.hidden = true;
    // Sync avatar for game screen (Telegram photo or initial)
    const tgUser = getTelegram()?.initDataUnsafe?.user;
    if (tgUser?.photo_url) {
      setAvatar(
        dom.game.avatarYouImg,
        dom.game.avatarYouInit,
        tgUser.photo_url,
        state.profile.name,
      );
    } else {
      dom.game.avatarYouInit.textContent = getInitial(state.profile.name);
    }
    resetBoard();
  }

  async function playSoloRound(choice) {
    if (state.isPlaying) return;
    state.isPlaying = true;
    // Capture the session this round belongs to — if the user leaves and
    // starts a new solo game before this round finishes, mySessionId will
    // no longer match state._soloSessionId and we abort without touching
    // the new session's state.
    const mySessionId = state._soloSessionId;
    setChoiceButtonsEnabled(false);
    highlightChoice(choice);
    playSound("click");
    triggerHaptic("light");

    dom.game.resultStrip.hidden = true;
    dom.game.playAgainRow.hidden = true;
    dom.game.arenaLabel.textContent = "Thinking...";
    dom.game.arenaEmojiYou.textContent = CHOICE_EMOJI[choice];
    dom.game.arenaEmojiOpp.textContent = "🤖";
    dom.game.arenaYou.classList.remove("win", "lose", "draw", "reveal");
    dom.game.arenaOpp.classList.remove("win", "lose", "draw", "reveal");
    dom.game.arenaYou.classList.add("thinking");
    dom.game.arenaOpp.classList.add("thinking");

    await delay(650);

    // User may have left during the delay — abort if no longer in solo mode
    // OR if a newer solo session has since started (stale round guard).
    if (state.mode !== "solo" || state._soloSessionId !== mySessionId) {
      state.isPlaying = false;
      return;
    }

    let round;
    try {
      if (state.backendReady) {
        const result = await apiRequest("/api/solo/play", {
          method: "POST",
          body: JSON.stringify({
            playerId: state.clientId,
            name: state.profile.name,
            choice,
          }),
        });
        if (result.profile) applyProfileFromServer(result.profile);
        round = result.round;
      } else {
        // Offline fallback
        const cpuChoice = randomChoice();
        const outcome = determineOutcome(choice, cpuChoice);
        if (outcome === "win") {
          state.profile.stats.wins++;
          state.profile.stats.currentStreak++;
          state.profile.stats.bestStreak = Math.max(
            state.profile.stats.bestStreak,
            state.profile.stats.currentStreak,
          );
        } else if (outcome === "lose") {
          state.profile.stats.losses++;
          state.profile.stats.currentStreak = 0;
        } else {
          state.profile.stats.draws++;
        }
        saveFallbackProfile();
        syncProfileToUI();
        round = { playerChoice: choice, computerChoice: cpuChoice, outcome };
      }
    } catch (err) {
      showToast(String(err.message || "Round failed"));
      state.backendReady = false;
      state.isPlaying = false;
      // Only reset the arena visuals if we're still looking at the same
      // session — otherwise this would stomp on a newer game's UI.
      if (state.mode === "solo" && state._soloSessionId === mySessionId) {
        dom.game.arenaYou.classList.remove("thinking");
        dom.game.arenaOpp.classList.remove("thinking");
        dom.game.arenaLabel.textContent = "Pick!";
        dom.game.arenaEmojiYou.textContent = "❓";
        dom.game.arenaEmojiOpp.textContent = "❓";
        setChoiceButtonsEnabled(true);
        clearChoiceHighlight();
      }
      return;
    }

    // The API call itself took time — re-check that we're still in the
    // same solo session before applying the result to the UI/score.
    if (state.mode !== "solo" || state._soloSessionId !== mySessionId) {
      state.isPlaying = false;
      return;
    }

    // Reveal
    dom.game.arenaYou.classList.remove("thinking");
    dom.game.arenaOpp.classList.remove("thinking");
    dom.game.arenaYou.classList.add("reveal");
    dom.game.arenaOpp.classList.add("reveal");
    dom.game.arenaEmojiYou.textContent = CHOICE_EMOJI[round.playerChoice];
    dom.game.arenaEmojiOpp.textContent = CHOICE_EMOJI[round.computerChoice];

    const outcome = round.outcome;
    if (outcome === "win") {
      dom.game.arenaYou.classList.add("win");
      dom.game.arenaOpp.classList.add("lose");
      state.soloScore.wins++;
    } else if (outcome === "lose") {
      dom.game.arenaYou.classList.add("lose");
      dom.game.arenaOpp.classList.add("win");
      state.soloScore.losses++;
    } else {
      dom.game.arenaYou.classList.add("draw");
      dom.game.arenaOpp.classList.add("draw");
    }

    // Update session scoreboard
    dom.game.scoreYou.textContent = String(state.soloScore.wins);
    dom.game.scoreOpp.textContent = String(state.soloScore.losses);

    dom.game.arenaLabel.textContent =
      outcome === "win"
        ? "You won! 🎉"
        : outcome === "lose"
          ? "You lost 😢"
          : "Draw 🤝";
    renderOutcomeBanner(outcome);

    if (outcome === "win") {
      animateScore(dom.game.scoreYou);
      playSound("win");
      triggerHaptic("success");
      launchConfetti();
    } else if (outcome === "lose") {
      animateScore(dom.game.scoreOpp);
      playSound("lose");
      triggerHaptic("error");
    } else {
      playSound("draw");
      triggerHaptic("medium");
    }

    dom.game.playAgainRow.hidden = false;
    // Disable briefly so result is seen before moving on.
    // Use the SAME tracked timer slot as multiplayer (state._resultPendingTimer)
    // so navigating away (routeToHome/resetBoard) reliably cancels it — an
    // untracked setTimeout here could otherwise fire later and corrupt the
    // button state of a different round/session the user has since started.
    dom.game.btnPlayAgain.disabled = true;
    dom.game.btnPlayAgain.classList.add("result-pending");
    clearTimeout(state._resultPendingTimer);
    state._resultPendingTimer = setTimeout(() => {
      if (dom.game.btnPlayAgain.classList.contains("result-pending")) {
        dom.game.btnPlayAgain.disabled = false;
        dom.game.btnPlayAgain.classList.remove("result-pending");
      }
    }, 1200);
    state.isPlaying = false;
  }

  /* ════════════════════════════════════════
     MULTIPLAYER FLOWS
     ════════════════════════════════════════ */

  async function joinQuickMatch() {
    if (!state.backendReady) {
      showToast("Start the server: npm start");
      return;
    }
    if (state.mode === "quick" || state.mode === "private") {
      return; // already in matchmaking/room
    }
    state.mode = "quick";
    state.session = { kind: "quick", roomId: null };
    showWaitingScreen("Finding opponent…", "Matching you now.", {
      showJoin: false,
      showCreate: false,
      showCode: false,
    });

    try {
      const result = await apiRequest("/api/matchmaking/join", {
        method: "POST",
        body: JSON.stringify({
          playerId: state.clientId,
          name: state.profile.name,
        }),
      });
      if (result.profile) applyProfileFromServer(result.profile);
      if (result.room) {
        state.session.roomId = result.room.id;
        const seedSeq = ++state._roomFetchSeq;
        applyRoomUpdate(result.room, seedSeq);
        setScreen("game");
        syncRoomHeader(result.room);
        syncBoardFromRoom(result.room);
        startPolling(refreshRoomState);
      } else {
        startPolling(refreshMatchmaking);
      }
    } catch (err) {
      stopPolling();
      showToast(String(err.message || "Unable to find match"));
      routeToHome();
    }
  }

  async function refreshMatchmaking() {
    if (!state.session) return;
    try {
      const data = await apiRequest(
        `/api/matchmaking/status?playerId=${encodeURIComponent(state.clientId)}`,
      );
      if (data.profile) applyProfileFromServer(data.profile);

      // idle = removed from queue (e.g. server restarted) — go home quietly
      if (data.status === "idle") {
        stopPolling();
        showToast("Matchmaking cancelled");
        routeToHome();
        return;
      }

      if (data.room) {
        state.session.roomId = data.room.id;
        if (data.room.phase !== "waiting") {
          const seedSeq = ++state._roomFetchSeq;
          applyRoomUpdate(data.room, seedSeq);
          setScreen("game");
          syncRoomHeader(data.room);
          syncBoardFromRoom(data.room);
          startPolling(refreshRoomState);
        } else {
          renderRoomWaiting(data.room);
        }
      }
    } catch (err) {
      stopPolling();
      showToast(String(err.message || "Matchmaking failed"));
      routeToHome();
    }
  }

  async function refreshRoomState() {
    if (!state.session?.roomId) return;
    // Claim the next sequence number for this request
    const mySeq = ++state._roomFetchSeq;
    try {
      const data = await apiRequest(
        `/api/rooms/state?roomId=${encodeURIComponent(state.session.roomId)}&playerId=${encodeURIComponent(state.clientId)}`,
      );
      state._roomPollFailures = 0; // connection is healthy again
      if (data.profile) applyProfileFromServer(data.profile);
      // Capture prevPhase BEFORE overwriting state.room
      const prevPhase = state.room?.phase;
      const applied = applyRoomUpdate(data.room, mySeq);
      if (!applied) return; // a newer response already won — discard this one entirely
      if (data.room.phase === "waiting") {
        renderRoomWaiting(data.room);
      } else {
        setScreen("game");
        // Transitioned from revealed → choosing: clear stale result UI
        if (prevPhase === "revealed" && data.room.phase === "choosing") {
          state.lastRoomRenderKey = "";
          resetBoard();
        }
        syncRoomHeader(data.room);
        syncBoardFromRoom(data.room);
      }
    } catch (err) {
      // Ignore network errors from superseded/aborted polls
      if (mySeq < state._roomFetchSeqApplied) return;
      const msg = String(err.message || "");
      const isDefinitelyGone = msg.includes("Room not found") || msg.includes("404");
      if (isDefinitelyGone) {
        // The room genuinely no longer exists server-side (most likely the
        // free-tier server process restarted and wiped in-memory rooms).
        stopPolling();
        if (state.mode === "quick") {
          showToast("Server qayta ishga tushdi. Yangi raqib qidirilmoqda…");
          state.mode = "home"; // clear the "already in matchmaking" guard
          state.session = null;
          state.room = null;
          joinQuickMatch();
        } else {
          showToast("Xona topilmadi — server qayta ishga tushgan bo'lishi mumkin.");
          routeToHome();
        }
        return;
      }
      // Transient failure (timeout, dropped connection, server briefly
      // waking up, etc). Don't nuke the session on one bad poll — retry
      // silently for a while before giving up.
      state._roomPollFailures = (state._roomPollFailures || 0) + 1;
      if (state._roomPollFailures === 2) {
        showToast("Ulanish sekinlashdi, qayta urinilmoqda…");
      }
      if (state._roomPollFailures >= 8) {
        // ~10s+ of consistently failing polls — genuinely unreachable now.
        stopPolling();
        showToast(msg || "Server bilan aloqa uzildi.");
        routeToHome();
      }
    }
  }

  /**
   * Centralized room-state writer. Ensures only the freshest
   * server response is ever applied to state.room, regardless
   * of which async call (poll vs. user action) resolves last.
   * Also clears the optimistic-ready flag once the server
   * confirms what we expect (round advanced, or our ready=true
   * is reflected back).
   */
  function applyRoomUpdate(room, seq) {
    if (seq !== undefined) {
      if (seq < state._roomFetchSeqApplied) return false; // stale, ignore
      state._roomFetchSeqApplied = seq;
    }
    state.room = room;

    // Clear optimistic-ready flag once server state genuinely matches:
    // either the round has moved on, or the server itself now reports
    // this player as ready.
    if (state._optimisticReady) {
      const roundKey = `${room.id}:${room.round?.index}`;
      const serverSaysReady = !!room.you?.ready;
      const roundAdvanced = roundKey !== state._optimisticReadyRoundKey;
      if (serverSaysReady || roundAdvanced || room.phase === "choosing") {
        state._optimisticReady = false;
        state._optimisticReadyRoundKey = "";
      }
    }
    return true;
  }

  function renderRoomWaiting(room) {
    applyRoomUpdate(room);
    state.mode = room.type === "quick" ? "quick" : "private";

    if (room.type === "private") {
      if (room.phase === "waiting" && room.you?.role === "host") {
        showWaitingScreen(
          "Share this code",
          "Send the room code to your opponent.",
          {
            showCode: true,
            showCreate: false,
            showJoin: false,
          },
        );
        dom.waiting.roomCodeValue.textContent = room.code;
      } else if (room.phase === "waiting") {
        showWaitingScreen("Joining private room", "Waiting for the host...", {
          showJoin: true,
          showCreate: true,
          showCode: false,
        });
      } else {
        setScreen("game");
        syncRoomHeader(room);
        syncBoardFromRoom(room);
      }
      return;
    }

    // Quick match waiting
    if (room.phase === "waiting") {
      showWaitingScreen("Finding opponent…", "Waiting for a match.", {
        showJoin: false,
        showCreate: false,
        showCode: false,
      });
    } else {
      setScreen("game");
      syncRoomHeader(room);
      syncBoardFromRoom(room);
    }
  }

  function openPrivateLobby() {
    if (!state.backendReady) {
      showToast("Start the server: npm start");
      return;
    }
    if (state.mode === "quick" || state.mode === "private") {
      return; // already in matchmaking/room
    }
    stopPolling();
    state.mode = "private";
    state.session = { kind: "private", roomId: null };
    state.room = null;
    dom.waiting.codeInput.value = ""; // clear any stale code from a previous attempt
    showWaitingScreen("Private room", "Create a room or join with a code.", {
      showJoin: true,
      showCreate: true,
      showCode: false,
    });
  }

  async function createPrivateRoom() {
    if (!state.backendReady) {
      showToast("Start the server: npm start");
      return;
    }
    if (dom.waiting.btnCreateRoom.disabled) return;
    dom.waiting.btnCreateRoom.disabled = true;
    try {
      const result = await apiRequest("/api/rooms/create", {
        method: "POST",
        body: JSON.stringify({
          playerId: state.clientId,
          name: state.profile.name,
        }),
      });
      if (result.profile) applyProfileFromServer(result.profile);
      state.session = {
        kind: "private",
        roomId: result.room.id,
        code: result.room.code,
      };
      renderRoomWaiting(result.room);
      startPolling(refreshRoomState);
    } catch (err) {
      showToast(String(err.message || "Unable to create room"));
      dom.waiting.btnCreateRoom.disabled = false;
    }
  }

  async function joinPrivateRoom() {
    if (!state.backendReady) {
      showToast("Start the server: npm start");
      return;
    }
    const code = dom.waiting.codeInput.value.trim().toUpperCase();
    if (!code || code.length < 4) {
      showToast("Enter a valid room code");
      dom.waiting.codeInput.focus();
      return;
    }
    if (dom.waiting.btnJoinRoom.disabled) return;
    dom.waiting.btnJoinRoom.disabled = true;
    try {
      const result = await apiRequest("/api/rooms/join", {
        method: "POST",
        body: JSON.stringify({
          playerId: state.clientId,
          name: state.profile.name,
          code,
        }),
      });
      if (result.profile) applyProfileFromServer(result.profile);
      state.session = {
        kind: "private",
        roomId: result.room.id,
        code: result.room.code,
      };
      const seedSeq = ++state._roomFetchSeq;
      applyRoomUpdate(result.room, seedSeq);
      setScreen("game");
      syncRoomHeader(result.room);
      syncBoardFromRoom(result.room);
      startPolling(refreshRoomState);
    } catch (err) {
      showToast(String(err.message || "Room not found"));
      dom.waiting.btnJoinRoom.disabled = false;
    }
  }

  async function submitRoomChoice(choice) {
    if (!state.session?.roomId || state.isPlaying) return;
    state.isPlaying = true;
    setChoiceButtonsEnabled(false);
    highlightChoice(choice);
    playSound("click");
    triggerHaptic("light");
    dom.game.arenaLabel.textContent = "Waiting for opponent…";
    dom.game.arenaEmojiYou.textContent = CHOICE_EMOJI[choice] || "❓";
    dom.game.arenaEmojiOpp.textContent = "❓";
    dom.game.arenaYou.classList.remove("thinking");
    dom.game.arenaOpp.classList.add("thinking");

    const mySeq = ++state._roomFetchSeq;

    try {
      const result = await apiRequestRetry("/api/rooms/play", {
        method: "POST",
        body: JSON.stringify({
          roomId: state.session.roomId,
          playerId: state.clientId,
          choice,
        }),
      });
      if (result.profile) applyProfileFromServer(result.profile);
      const applied = applyRoomUpdate(result.room, mySeq);
      // Remove thinking state before syncing board
      dom.game.arenaYou.classList.remove("thinking");
      dom.game.arenaOpp.classList.remove("thinking");
      if (applied) {
        syncRoomHeader(result.room);
        syncBoardFromRoom(result.room);
      }
    } catch (err) {
      showToast(String(err.message || "Could not play round"));
      dom.game.arenaYou.classList.remove("thinking");
      dom.game.arenaOpp.classList.remove("thinking");
      dom.game.arenaEmojiYou.textContent = CHOICE_EMOJI[choice] || "❓";
      setChoiceButtonsEnabled(!!state.room?.canPlay);
      clearChoiceHighlight();
    } finally {
      state.isPlaying = false;
    }
  }

  async function readyNextRound() {
    if (state.mode === "solo") {
      resetBoard();
      return;
    }
    if (!state.session?.roomId || !state.room) return;

    // Guard against double-clicks while a ready request is already in flight
    if (state._readyInFlight) return;
    state._readyInFlight = true;

    // Set optimistic flag BEFORE the request, keyed to the current round,
    // so any stale poll response arriving in the meantime can't undo it.
    state._optimisticReady = true;
    state._optimisticReadyRoundKey = `${state.room.id}:${state.room.round?.index}`;

    // Cancel any pending "lock button" timer from the result-pending phase —
    // we're past that now, the user has acted.
    clearTimeout(state._resultPendingTimer);

    // Immediately show waiting state on button (optimistic UI)
    dom.game.btnPlayAgain.textContent = "Waiting for opponent… ⏳";
    dom.game.btnPlayAgain.classList.remove("result-pending");
    dom.game.btnPlayAgain.classList.add("ready-waiting");

    const mySeq = ++state._roomFetchSeq;

    try {
      const result = await apiRequestRetry("/api/rooms/ready", {
        method: "POST",
        body: JSON.stringify({
          roomId: state.session.roomId,
          playerId: state.clientId,
        }),
      });
      if (result.profile) applyProfileFromServer(result.profile);
      const applied = applyRoomUpdate(result.room, mySeq);
      if (applied) {
        if (result.room.phase === "choosing") {
          state.lastRoomRenderKey = "";
          resetBoard();
          syncRoomHeader(result.room);
          syncBoardFromRoom(result.room);
        } else {
          syncRoomHeader(result.room);
          syncBoardFromRoom(result.room);
        }
      }
    } catch (err) {
      state._optimisticReady = false;
      state._optimisticReadyRoundKey = "";
      const msg = String(err.message || "Could not start next round");
      if (msg.includes("Room not found") || err.status === 404) {
        stopPolling();
        if (state.mode === "quick") {
          showToast("Server qayta ishga tushdi. Yangi raqib qidirilmoqda…");
          state.mode = "home";
          state.session = null;
          state.room = null;
          joinQuickMatch();
        } else {
          showToast("Xona topilmadi — server qayta ishga tushgan bo'lishi mumkin.");
          routeToHome();
        }
        return;
      }
      showToast(msg);
      // Re-enable button so user can try again
      dom.game.btnPlayAgain.classList.remove("ready-waiting", "result-pending");
      dom.game.btnPlayAgain.textContent = "Next round";
    } finally {
      state._readyInFlight = false;
    }
  }

  async function leaveCurrentSession() {
    if (state._leaving) return;
    state._leaving = true;
    stopPolling(); // stop polling immediately before async calls
    try {
      if (state.session?.roomId) {
        // In a room — always use rooms/leave regardless of mode
        await apiRequest("/api/rooms/leave", {
          method: "POST",
          body: JSON.stringify({
            roomId: state.session.roomId,
            playerId: state.clientId,
          }),
        });
      } else if (state.mode === "quick") {
        // In matchmaking queue, not yet in a room
        await apiRequest("/api/matchmaking/leave", {
          method: "POST",
          body: JSON.stringify({ playerId: state.clientId }),
        });
      }
    } catch (_) {}
    state._leaving = false;
    routeToHome();
  }

  /* ════════════════════════════════════════
     UTILITY
     ════════════════════════════════════════ */

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ════════════════════════════════════════
     EVENT BINDING
     ════════════════════════════════════════ */

  function bindEvents() {
    // Username setup
    dom.setup.btnConfirm.addEventListener("click", confirmUsername);
    dom.setup.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmUsername();
    });

    // Home
    dom.home.btnVsBot.addEventListener("click", () => {
      triggerHaptic("light");
      startSoloMode();
    });
    dom.home.btnQuickMatch.addEventListener("click", () => {
      triggerHaptic("light");
      joinQuickMatch();
    });
    dom.home.btnPrivate.addEventListener("click", () => {
      triggerHaptic("light");
      openPrivateLobby();
    });
    dom.home.btnSound.addEventListener("click", () => {
      state.soundEnabled = !state.soundEnabled;
      syncSoundButtons();
      savePreferences();
      if (state.soundEnabled) playSound("click");
    });

    // Waiting
    dom.waiting.btnCancel.addEventListener("click", leaveCurrentSession);
    dom.waiting.btnCreateRoom.addEventListener("click", createPrivateRoom);
    dom.waiting.btnJoinRoom.addEventListener("click", joinPrivateRoom);
    dom.waiting.codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") joinPrivateRoom();
    });
    dom.waiting.btnCopyCode.addEventListener("click", () => {
      const code = dom.waiting.roomCodeValue.textContent.trim();
      if (!code || code === "——") return;
      navigator.clipboard
        .writeText(code)
        .then(() => showToast("Code copied!"))
        .catch(() => showToast("Could not copy"));
    });

    // Game
    dom.game.btnBack.addEventListener("click", leaveCurrentSession);
    dom.game.btnLeaveGame.addEventListener("click", leaveCurrentSession);
    dom.game.btnPlayAgain.addEventListener("click", readyNextRound);
    dom.game.btnSound.addEventListener("click", () => {
      state.soundEnabled = !state.soundEnabled;
      syncSoundButtons();
      savePreferences();
      if (state.soundEnabled) playSound("click");
    });

    dom.game.choiceButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.mode === "solo") {
          playSoloRound(btn.dataset.choice);
        } else {
          submitRoomChoice(btn.dataset.choice);
        }
      });
    });

    // Global
    window.addEventListener("resize", resizeCanvas);
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        (state.mode === "solo" ||
          state.mode === "quick" ||
          state.mode === "private")
      ) {
        leaveCurrentSession();
      }
    });
  }

  /* ════════════════════════════════════════
     BOOTSTRAP
     ════════════════════════════════════════ */

  async function bootstrap() {
    loadPreferences();
    initTelegram();
    loadFallbackProfile();
    bindEvents();
    resizeCanvas();
    syncSoundButtons();
    syncProfileToUI();

    const isTelegram = !!getTelegram()?.initDataUnsafe?.user;

    if (isTelegram) {
      // Telegram: name & avatar already set by initTelegram — go straight to home
      setScreen("home");
      await loadProfile(); // loadProfile calls syncBackendAvailability internally
    } else if (hasSavedUsername()) {
      // Returning user: use saved name
      state.profile.name = loadSavedUsername() || state.profile.name;
      syncProfileToUI();
      setScreen("home");
      await loadProfile(); // loadProfile calls syncBackendAvailability internally
    } else {
      // First time: show username setup screen
      setScreen("username");
      // Pre-fill avatar preview with first letter as user types
      dom.setup.input.addEventListener("input", () => {
        const val = dom.setup.input.value.trim();
        dom.setup.avatarInit.textContent = val
          ? val.charAt(0).toUpperCase()
          : "?";
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    // DOMContentLoaded already fired (e.g. script loaded late/async) —
    // run immediately instead of waiting for an event that will never come.
    bootstrap();
  }
})();
