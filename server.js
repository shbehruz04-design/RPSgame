const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "state.json");
const PORT = Number(process.env.PORT || 3000);

// Optional MongoDB support: if MONGODB_URI is set, use it as primary
const MONGODB_URI = process.env.MONGODB_URI || null;
let useMongo = !!MONGODB_URI;
let _mongoClient = null;
let _mongoDb = null;
let storeCache = { players: {} };

const CHOICES = ["rock", "paper", "scissors"];
const BEATS = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
};
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const rooms = new Map();
const roomsByCode = new Map();
const activeRoomByPlayer = new Map();
const matchmakingQueue = [];
const queuedPlayers = new Set();

// If a player hasn't hit ANY room endpoint (state/play/ready) for this long,
// we consider them disconnected (tab closed, app backgrounded, network
// dropped, etc). The client polls roughly every 1.2s, so ~4-5 missed polls.
const DISCONNECT_TIMEOUT_MS = 12000;

function touchLastSeen(room, playerId) {
  if (!room || !playerId) return;
  if (!room.lastSeen) room.lastSeen = {};
  room.lastSeen[playerId] = Date.now();
}

function isPlayerDisconnected(room, playerId) {
  if (!room || !playerId) return false;
  const last = room.lastSeen?.[playerId];
  if (!last) return false; // never seen yet — don't flag, avoid false positives
  return Date.now() - last > DISCONNECT_TIMEOUT_MS;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureFileStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ players: {} }, null, 2));
  }
}

function readFileStore() {
  ensureFileStore();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (_) {
    return { players: {} };
  }
}

function writeFileStore(store) {
  ensureFileStore();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error("writeFileStore error", e && e.message);
  }
}

async function initMongo() {
  if (!useMongo) return;
  try {
    const { MongoClient } = require("mongodb");
    _mongoClient = new MongoClient(MONGODB_URI);
    await _mongoClient.connect();
    _mongoDb = _mongoClient.db();
    const col = _mongoDb.collection("players");
    await col.createIndex({ _id: 1 }, { unique: true });

    // load into cache
    const docs = await col.find({}).toArray();
    const players = {};
    docs.forEach((d) => {
      players[d._id] = {
        name: d.name,
        stats: d.stats || {
          wins: 0,
          losses: 0,
          draws: 0,
          currentStreak: 0,
          bestStreak: 0,
        },
        history: d.history || [],
        updatedAt: d.updatedAt || new Date().toISOString(),
      };
    });
    storeCache.players = players;
    console.log(
      "MongoDB connected, players loaded:",
      Object.keys(players).length,
    );
  } catch (err) {
    console.error(
      "Mongo init failed, falling back to file store:",
      err && err.message,
    );
    useMongo = false;
    storeCache = readFileStore();
  }
}

// readStore returns in-memory cache (loaded at startup)
function readStore() {
  return storeCache;
}

// writeStore updates cache immediately and persists asynchronously to Mongo and file fallback
function writeStore(store, changedPlayerIds = null) {
  storeCache = store;
  // persist to file as backup (async to avoid blocking request)
  setImmediate(() => {
    try {
      writeFileStore(store);
    } catch (_) {}
  });

  if (useMongo && _mongoDb) {
    // Only sync players that actually changed; fall back to all if unspecified
    const idsToSync = changedPlayerIds
      ? changedPlayerIds.filter((id) => store.players[id])
      : Object.keys(store.players || {});

    if (idsToSync.length === 0) return;

    (async () => {
      try {
        const col = _mongoDb.collection("players");
        await Promise.all(
          idsToSync.map((id) => {
            const profile = store.players[id];
            return col.updateOne(
              { _id: id },
              {
                $set: {
                  name: profile.name,
                  stats: profile.stats,
                  history: profile.history || [],
                  updatedAt: profile.updatedAt,
                },
              },
              { upsert: true },
            );
          }),
        );
      } catch (err) {
        console.error("writeStore (mongo) error", err && err.message);
      }
    })();
  }
}

function createProfile(name = "Player") {
  return {
    name,
    stats: {
      wins: 0,
      losses: 0,
      draws: 0,
      currentStreak: 0,
      bestStreak: 0,
    },
    history: [],
    updatedAt: nowIso(),
  };
}

function createScore() {
  return { wins: 0, losses: 0, draws: 0 };
}

function normalizePlayerId(value) {
  const id = String(value || "").trim();
  return id || "guest";
}

function safeName(value) {
  return (String(value || "").trim() || "Player").slice(0, 32);
}

function randomChoice() {
  return CHOICES[Math.floor(Math.random() * CHOICES.length)];
}

function randomCode(length = 6) {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function determineOutcome(playerChoice, opponentChoice) {
  if (playerChoice === opponentChoice) return "draw";
  return BEATS[playerChoice] === opponentChoice ? "win" : "lose";
}

function oppositeOutcome(outcome) {
  if (outcome === "win") return "lose";
  if (outcome === "lose") return "win";
  return "draw";
}

function touchProfile(store, playerId, name) {
  if (!store.players[playerId]) {
    store.players[playerId] = createProfile(name);
  } else if (name && store.players[playerId].name !== name) {
    store.players[playerId].name = name;
  }
  return store.players[playerId];
}

function updateProfile(profile, outcome) {
  profile.updatedAt = nowIso();
  if (outcome === "win") {
    profile.stats.wins += 1;
    profile.stats.currentStreak += 1;
    profile.stats.bestStreak = Math.max(
      profile.stats.bestStreak,
      profile.stats.currentStreak,
    );
  } else if (outcome === "lose") {
    profile.stats.losses += 1;
    profile.stats.currentStreak = 0;
  } else {
    profile.stats.draws += 1;
  }
}

function resetProfile(profile) {
  profile.stats = {
    wins: 0,
    losses: 0,
    draws: 0,
    currentStreak: 0,
    bestStreak: 0,
  };
  profile.history = [];
  profile.updatedAt = nowIso();
}

function makeRoomId() {
  return `room_${randomCode(10)}`;
}

function makeRoom(type, hostId, hostName) {
  const room = {
    id: makeRoomId(),
    code: type === "private" ? randomCode(6) : null,
    type,
    status: type === "private" ? "waiting" : "active",
    phase: type === "private" ? "waiting" : "choosing",
    hostId,
    guestId: null,
    players: {},
    scores: {},
    ready: {},
    lastSeen: {},
    round: {
      index: type === "private" ? 0 : 1,
      choices: {},
      results: {},
      startedAt: type === "private" ? null : nowIso(),
      resolvedAt: null,
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  room.players[hostId] = { id: hostId, name: hostName, role: "host" };
  room.scores[hostId] = createScore();
  touchLastSeen(room, hostId);
  return room;
}

function addPlayerToRoom(room, playerId, name, role) {
  room.players[playerId] = { id: playerId, name, role };
  room.scores[playerId] = room.scores[playerId] || createScore();
  touchLastSeen(room, playerId);
  room.updatedAt = nowIso();
}

function getOpponentId(room, viewerId) {
  if (room.hostId === viewerId) return room.guestId;
  if (room.guestId === viewerId) return room.hostId;
  return null;
}

function startNewRound(room) {
  room.round = {
    index: room.round.index + 1,
    choices: {},
    results: {},
    startedAt: nowIso(),
    resolvedAt: null,
  };
  room.phase = "choosing";
  room.status = "active";
  room.ready = {};
  room.updatedAt = nowIso();
}

function resolveRoomRound(room, store) {
  const hostChoice = room.round.choices[room.hostId];
  const guestChoice = room.round.choices[room.guestId];
  const hostOutcome = determineOutcome(hostChoice, guestChoice);
  const guestOutcome = oppositeOutcome(hostOutcome);

  room.round.results[room.hostId] = {
    choice: hostChoice,
    outcome: hostOutcome,
  };
  room.round.results[room.guestId] = {
    choice: guestChoice,
    outcome: guestOutcome,
  };
  room.round.resolvedAt = nowIso();
  room.phase = "revealed";
  room.status = "active";
  room.updatedAt = nowIso();

  // Ensure score objects exist before incrementing
  if (!room.scores[room.hostId]) room.scores[room.hostId] = createScore();
  if (!room.scores[room.guestId]) room.scores[room.guestId] = createScore();

  room.scores[room.hostId][
    hostOutcome === "win" ? "wins" : hostOutcome === "lose" ? "losses" : "draws"
  ] += 1;
  room.scores[room.guestId][
    guestOutcome === "win"
      ? "wins"
      : guestOutcome === "lose"
        ? "losses"
        : "draws"
  ] += 1;

  const hostProfile = touchProfile(
    store,
    room.hostId,
    room.players[room.hostId].name,
  );
  const guestProfile = touchProfile(
    store,
    room.guestId,
    room.players[room.guestId].name,
  );
  updateProfile(hostProfile, hostOutcome);
  updateProfile(guestProfile, guestOutcome);
}

function buildRoomView(room, viewerId, store) {
  const opponentId = getOpponentId(room, viewerId);
  const viewer = room.players[viewerId];
  const opponent = opponentId ? room.players[opponentId] : null;
  const viewerScore = room.scores[viewerId] || createScore();
  const opponentScore = opponentId
    ? room.scores[opponentId] || createScore()
    : null;
  const viewerResult = room.round.results[viewerId] || null;
  const opponentResult = opponentId
    ? room.round.results[opponentId] || null
    : null;
  const profile = touchProfile(store, viewerId, viewer?.name || "Player");

  return {
    ok: true,
    profile,
    room: {
      id: room.id,
      code: room.code,
      type: room.type,
      status: room.status,
      phase: room.phase,
      you: {
        id: viewerId,
        name: viewer?.name || "Player",
        role: viewer?.role || "player",
        score: viewerScore,
        choice: room.round.choices[viewerId] || null,
        result: viewerResult?.outcome || null,
        ready: !!room.ready[viewerId],
      },
      opponent: opponent
        ? {
            id: opponentId,
            name: opponent.name,
            role: opponent.role || "player",
            score: opponentScore || createScore(),
            // Only reveal opponent's choice after the round is resolved (prevent cheating)
            choice:
              room.phase === "revealed"
                ? room.round.choices[opponentId] || null
                : null,
            result: opponentResult?.outcome || null,
            ready: !!room.ready[opponentId],
            disconnected: isPlayerDisconnected(room, opponentId),
          }
        : null,
      round: {
        index: room.round.index,
        resolved: room.phase === "revealed",
        choices: {
          you: room.round.choices[viewerId] || null,
          // Only reveal opponent's choice after round is resolved (prevent cheating)
          opponent:
            room.phase === "revealed" && opponentId
              ? room.round.choices[opponentId] || null
              : null,
        },
        results: {
          you: viewerResult?.outcome || null,
          opponent: opponentResult?.outcome || null,
        },
        startedAt: room.round.startedAt,
        resolvedAt: room.round.resolvedAt,
      },
      waitingForOpponent: room.phase === "waiting" || !opponentId,
      canPlay:
        room.status === "active" &&
        room.phase === "choosing" &&
        !!opponentId &&
        !room.round.choices[viewerId],
      canReady: room.status === "active" && room.phase === "revealed",
      message:
        room.phase === "waiting"
          ? "Waiting for opponent"
          : room.phase === "revealed"
            ? "Round finished"
            : "Pick your weapon",
    },
  };
}

function closeRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.code) {
    roomsByCode.delete(room.code);
  }

  if (room.hostId) activeRoomByPlayer.delete(room.hostId);
  if (room.guestId) activeRoomByPlayer.delete(room.guestId);
  rooms.delete(roomId);
}

function removePlayerFromQueue(playerId) {
  const index = matchmakingQueue.findIndex((p) => p.playerId === playerId);
  if (index !== -1) matchmakingQueue.splice(index, 1);
  queuedPlayers.delete(playerId);
}

function leaveRoom(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.type === "quick") {
    closeRoom(roomId);
    return;
  }

  if (room.hostId === playerId) {
    if (room.guestId) {
      activeRoomByPlayer.delete(room.guestId);
    }
    closeRoom(roomId);
    return;
  }

  if (room.guestId === playerId) {
    room.guestId = null;
    delete room.players[playerId];
    delete room.scores[playerId];
    room.phase = "waiting";
    room.status = "active"; // room is still open for a new guest to join
    room.round = {
      index: room.round.index + 1,
      choices: {},
      results: {},
      startedAt: null,
      resolvedAt: null,
    };
    room.ready = {};
    activeRoomByPlayer.delete(playerId);
    room.updatedAt = nowIso();
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(
  res,
  statusCode,
  text,
  contentType = "text/plain; charset=utf-8",
) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

const MAX_BODY_BYTES = 16 * 1024; // 16 KB

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT, `.${normalized}`);

  if (!filePath.startsWith(ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

function createQuickMatchRoom(playerA, playerB, store) {
  const room = makeRoom("quick", playerA.playerId, playerA.name);
  room.guestId = playerB.playerId;
  addPlayerToRoom(room, playerA.playerId, playerA.name, "host");
  addPlayerToRoom(room, playerB.playerId, playerB.name, "guest");
  room.phase = "choosing";
  room.status = "active";
  room.round.index = 1;
  room.round.startedAt = nowIso();
  rooms.set(room.id, room);
  activeRoomByPlayer.set(playerA.playerId, room.id);
  activeRoomByPlayer.set(playerB.playerId, room.id);
  touchProfile(store, playerA.playerId, playerA.name);
  touchProfile(store, playerB.playerId, playerB.name);
  return room;
}

function joinMatchmaking(playerId, name, store) {
  touchProfile(store, playerId, name);
  if (!queuedPlayers.has(playerId) && !activeRoomByPlayer.has(playerId)) {
    matchmakingQueue.push({ playerId, name });
    queuedPlayers.add(playerId);
  }

  while (matchmakingQueue.length >= 2) {
    const playerA = matchmakingQueue.shift();
    const playerB = matchmakingQueue.shift();
    // Guard against self-match (should never happen but be safe)
    if (playerA.playerId === playerB.playerId) {
      matchmakingQueue.unshift(playerB); // put back, keep only one entry
      queuedPlayers.delete(playerA.playerId);
      queuedPlayers.add(playerB.playerId);
      break;
    }
    queuedPlayers.delete(playerA.playerId);
    queuedPlayers.delete(playerB.playerId);
    const room = createQuickMatchRoom(playerA, playerB, store);
    return { matched: true, room };
  }

  return { matched: false };
}

function handleProfile(req, res, urlObject) {
  const store = readStore();
  const playerId = normalizePlayerId(urlObject.searchParams.get("playerId"));
  const name = safeName(urlObject.searchParams.get("name"));
  const existingName = store.players[playerId]?.name;
  const profile = touchProfile(store, playerId, name);
  // Only persist if player is new or name changed
  if (!existingName || existingName !== name) {
    writeStore(store, [playerId]);
  }
  sendJson(res, 200, { ok: true, playerId, profile });
}

async function handleApi(req, res, urlObject) {
  const pathname = urlObject.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/profile") {
    handleProfile(req, res, urlObject);
    return;
  }

  const store = readStore();

  if (req.method === "POST" && pathname === "/api/solo/play") {
    const body = await parseBody(req);
    const choice = String(body.choice || "").trim();
    const playerId = normalizePlayerId(body.playerId);
    const name = safeName(body.name);

    if (!CHOICES.includes(choice)) {
      sendJson(res, 400, { ok: false, error: "Invalid choice" });
      return;
    }

    const profile = touchProfile(store, playerId, name);
    const computerChoice = randomChoice();
    const outcome = determineOutcome(choice, computerChoice);
    updateProfile(profile, outcome);
    writeStore(store, [playerId]);
    sendJson(res, 200, {
      ok: true,
      profile,
      round: {
        playerChoice: choice,
        computerChoice,
        outcome,
      },
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/solo/reset") {
    const body = await parseBody(req);
    const playerId = normalizePlayerId(body.playerId);
    const profile = touchProfile(store, playerId, safeName(body.name));
    resetProfile(profile);
    writeStore(store, [playerId]);
    sendJson(res, 200, { ok: true, profile });
    return;
  }

  if (req.method === "POST" && pathname === "/api/matchmaking/join") {
    const body = await parseBody(req);
    const playerId = normalizePlayerId(body.playerId);
    const name = safeName(body.name);
    const result = joinMatchmaking(playerId, name, store);
    if (result.matched) {
      writeStore(store, [result.room.hostId, result.room.guestId]);
    } else {
      writeStore(store, [playerId]);
    }
    if (result.matched) {
      sendJson(res, 200, buildRoomView(result.room, playerId, store));
    } else {
      sendJson(res, 200, { ok: true, status: "waiting" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/matchmaking/status") {
    const playerId = normalizePlayerId(urlObject.searchParams.get("playerId"));
    const roomId = activeRoomByPlayer.get(playerId);
    if (roomId) {
      const room = rooms.get(roomId);
      if (!room) {
        // Stale reference — clean up and tell client to go idle
        activeRoomByPlayer.delete(playerId);
        sendJson(res, 200, { ok: true, status: "idle" });
        return;
      }
      sendJson(res, 200, buildRoomView(room, playerId, store));
      return;
    }

    if (queuedPlayers.has(playerId)) {
      sendJson(res, 200, { ok: true, status: "waiting" });
      return;
    }

    sendJson(res, 200, { ok: true, status: "idle" });
    return;
  }

  if (req.method === "POST" && pathname === "/api/matchmaking/leave") {
    const body = await parseBody(req);
    const playerId = normalizePlayerId(body.playerId);
    removePlayerFromQueue(playerId);
    const roomId = activeRoomByPlayer.get(playerId);
    if (roomId) leaveRoom(roomId, playerId);
    // No writeStore here — neither removePlayerFromQueue nor leaveRoom
    // touch persisted player profile data, only in-memory room state.
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/rooms/create") {
    const body = await parseBody(req);
    const playerId = normalizePlayerId(body.playerId);
    const name = safeName(body.name);
    const profile = touchProfile(store, playerId, name);
    let roomId = activeRoomByPlayer.get(playerId);
    let room = roomId ? rooms.get(roomId) : null;

    // Stale reference — room was closed, clean up
    if (roomId && !room) {
      activeRoomByPlayer.delete(playerId);
      roomId = null;
    }

    if (!room) {
      room = makeRoom("private", playerId, profile.name);
      rooms.set(room.id, room);
      roomsByCode.set(room.code, room.id);
      activeRoomByPlayer.set(playerId, room.id);
    }

    room.players[playerId].name = profile.name;
    writeStore(store, [playerId]);
    sendJson(res, 200, buildRoomView(room, playerId, store));
    return;
  }

  if (req.method === "POST" && pathname === "/api/rooms/join") {
    const body = await parseBody(req);
    const playerId = normalizePlayerId(body.playerId);
    const name = safeName(body.name);
    const code = String(body.code || "")
      .trim()
      .toUpperCase();
    const roomId = roomsByCode.get(code);
    if (!roomId) {
      sendJson(res, 404, { ok: false, error: "Room code not found" });
      return;
    }

    const room = rooms.get(roomId);
    if (!room || room.phase !== "waiting") {
      sendJson(res, 404, { ok: false, error: "Room unavailable" });
      return;
    }

    if (room.hostId === playerId || room.guestId === playerId) {
      sendJson(res, 200, buildRoomView(room, playerId, store));
      return;
    }

    if (room.guestId) {
      sendJson(res, 409, { ok: false, error: "Room already full" });
      return;
    }

    // Prevent joining if player is already in another active room
    const existingRoomId = activeRoomByPlayer.get(playerId);
    if (existingRoomId && rooms.has(existingRoomId)) {
      sendJson(res, 409, { ok: false, error: "You are already in a room" });
      return;
    }

    touchProfile(store, playerId, name);
    room.guestId = playerId;
    addPlayerToRoom(room, playerId, name, "guest");
    room.phase = "choosing";
    room.status = "active";
    room.round.index = 1;
    room.round.startedAt = nowIso();
    activeRoomByPlayer.set(playerId, room.id);
    writeStore(store, [playerId]);
    sendJson(res, 200, buildRoomView(room, playerId, store));
    return;
  }

  if (req.method === "GET" && pathname === "/api/rooms/state") {
    const playerId = normalizePlayerId(urlObject.searchParams.get("playerId"));
    const roomId = String(urlObject.searchParams.get("roomId") || "").trim();
    const room = rooms.get(roomId);
    if (!room) {
      sendJson(res, 404, { ok: false, error: "Room not found" });
      return;
    }
    // Only allow players who belong to this room
    if (room.hostId !== playerId && room.guestId !== playerId) {
      sendJson(res, 403, { ok: false, error: "Not a member of this room" });
      return;
    }
    touchLastSeen(room, playerId);
    sendJson(res, 200, buildRoomView(room, playerId, store));
    return;
  }

  if (req.method === "POST" && pathname === "/api/rooms/play") {
    const body = await parseBody(req);
    const roomId = String(body.roomId || "").trim();
    const playerId = normalizePlayerId(body.playerId);
    const choice = String(body.choice || "").trim();

    if (!CHOICES.includes(choice)) {
      sendJson(res, 400, { ok: false, error: "Invalid choice" });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      sendJson(res, 404, { ok: false, error: "Room not found" });
      return;
    }

    if (room.phase !== "choosing") {
      // Return current state instead of error — client will sync gracefully
      sendJson(res, 200, buildRoomView(room, playerId, store));
      return;
    }

    if (!room.players[playerId]) {
      sendJson(res, 403, { ok: false, error: "You are not part of this room" });
      return;
    }

    touchLastSeen(room, playerId);

    // Idempotent: if choice already recorded, return current state
    if (room.round.choices[playerId]) {
      sendJson(res, 200, buildRoomView(room, playerId, store));
      return;
    }

    room.round.choices[playerId] = choice;
    room.updatedAt = nowIso();

    if (
      room.hostId &&
      room.guestId &&
      room.round.choices[room.hostId] &&
      room.round.choices[room.guestId]
    ) {
      resolveRoomRound(room, store);
      writeStore(store, [room.hostId, room.guestId]);
      sendJson(res, 200, buildRoomView(room, playerId, store));
      return;
    }

    // Only one player has chosen so far — no player profile data changed
    // yet (only in-memory room.round.choices), nothing to persist.
    sendJson(res, 200, buildRoomView(room, playerId, store));
    return;
  }

  if (req.method === "POST" && pathname === "/api/rooms/ready") {
    const body = await parseBody(req);
    const roomId = String(body.roomId || "").trim();
    const playerId = normalizePlayerId(body.playerId);
    const room = rooms.get(roomId);
    if (!room) {
      sendJson(res, 404, { ok: false, error: "Room not found" });
      return;
    }

    if (room.phase !== "revealed") {
      // Return current state instead of error — client will sync gracefully
      sendJson(res, 200, buildRoomView(room, playerId, store));
      return;
    }

    // Only accept ready from players who belong to this room
    if (room.hostId !== playerId && room.guestId !== playerId) {
      sendJson(res, 403, { ok: false, error: "Not a member of this room" });
      return;
    }

    touchLastSeen(room, playerId);
    room.ready[playerId] = true;
    if (
      room.hostId &&
      room.guestId &&
      room.ready[room.hostId] &&
      room.ready[room.guestId]
    ) {
      startNewRound(room);
    }

    room.updatedAt = nowIso();
    // No writeStore here — ready-state and round transitions are purely
    // in-memory room state; no player profile data changed.
    sendJson(res, 200, buildRoomView(room, playerId, store));
    return;
  }

  if (req.method === "POST" && pathname === "/api/rooms/leave") {
    const body = await parseBody(req);
    const playerId = normalizePlayerId(body.playerId);
    const roomId = String(body.roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) {
      removePlayerFromQueue(playerId);
      sendJson(res, 200, { ok: true });
      return;
    }

    leaveRoom(roomId, playerId);
    // No writeStore here — leaveRoom only mutates in-memory room state,
    // never persisted player profile data.
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Unknown API route" });
}

// ════════════════════════════════════
// ROOM CLEANUP — remove stale rooms every 10 minutes
// ════════════════════════════════════
const ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cleanupStaleRooms() {
  const now = Date.now();
  const stale = [];
  for (const [roomId, room] of rooms.entries()) {
    const updatedAt = new Date(room.updatedAt || 0).getTime();
    if (now - updatedAt > ROOM_TTL_MS) {
      stale.push(roomId);
    }
  }
  for (const roomId of stale) {
    console.log(`Cleaning up stale room: ${roomId}`);
    closeRoom(roomId);
  }
}

setInterval(cleanupStaleRooms, 10 * 60 * 1000);

const server = http.createServer((req, res) => {
  const urlObject = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`,
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (urlObject.pathname.startsWith("/api/")) {
    handleApi(req, res, urlObject).catch((error) => {
      const isBadBody =
        error.message === "Invalid JSON body" ||
        error.message === "Request body too large";
      sendJson(res, isBadBody ? 400 : 500, {
        ok: false,
        error: error.message || "Internal server error",
      });
    });
    return;
  }

  serveStatic(req, res, urlObject.pathname);
});

// Initialize storage (Mongo or file) and start server
(async () => {
  if (useMongo) {
    await initMongo();
  } else {
    storeCache = readFileStore();
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`RPS server running at http://0.0.0.0:${PORT}`);
  });
})().catch((err) => {
  console.error("Startup failed:", err && err.message);
  process.exit(1);
});

// Graceful shutdown: close Mongo client if present
process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down...");
  try {
    if (_mongoClient) await _mongoClient.close();
  } catch (e) {}
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down...");
  try {
    if (_mongoClient) await _mongoClient.close();
  } catch (e) {}
  process.exit(0);
});
