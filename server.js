const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

/**
 * In-memory store (fine for MVP).
 * For production scaling: use Redis / DB.
 */
const rooms = new Map();

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const WORD_BANK = {
  Food: [
    "Pizza","Burger","Sushi","Taco","Pasta","Ice Cream","Salad","Steak","Pancakes","Ramen",
    "Dumplings","Fries","Chocolate","Donut","Sandwich"
  ],
  Animals: [
    "Tiger","Elephant","Dolphin","Eagle","Shark","Panda","Wolf","Giraffe","Kangaroo","Penguin",
    "Owl","Cobra","Horse","Fox","Bear"
  ],
  Objects: [
    "Backpack","Laptop","Headphones","Notebook","Water Bottle","Shoes","Watch","Camera","Chair","Umbrella",
    "Keyboard","Mouse","Lamp","Phone","Trophy"
  ],
  Locations: [
    "Cathedral","Stadium","Airport","Library","Museum","Beach","Mall","Hospital","Castle","Park",
    "School","Theater","Subway","Hotel","Restaurant"
  ],
  Movies: [
    "Inception","Titanic","Avatar","Frozen","Jaws","Rocky","Up","Coco","Interstellar","Gladiator"
  ],
  Sports: [
    "Soccer","Basketball","Football","Baseball","Tennis","Hockey","Swimming","Track","Volleyball","Wrestling"
  ]
};

const IMPOSTER_HINTS = {
  // optional “hint to impostor” vibe like your screenshot
  defaultHints: ["Sanctuary", "Tradition", "Iconic", "Famous", "Crowded", "Historic", "Lights", "Big", "Old", "Modern"]
};

function createRoom({ hostSocketId, hostName, settings }) {
  const code = makeCode();
  const room = {
    code,
    hostSocketId,
    state: "lobby", // lobby -> wordReveal -> steps -> voting -> results
    settings: {
      category: settings?.category || "Locations",
      imposters: Math.max(1, Math.min(settings?.imposters ?? 1, 5)),
      showCategoryToImposter: settings?.showCategoryToImposter ?? true,
      showHintToImposter: settings?.showHintToImposter ?? true
    },
    secretWord: null,
    imposterIds: new Set(),
    players: new Map(), // socketId -> { name, isReady, hasVoted, voteFor }
    startingPlayerId: null
  };
  room.players.set(hostSocketId, { name: hostName, isReady: false, hasVoted: false, voteFor: null });
  rooms.set(code, room);
  return room;
}

function roomSnapshot(room) {
  const players = [...room.players.entries()].map(([id, p]) => ({
    id,
    name: p.name,
    isReady: p.isReady
  }));
  return {
    code: room.code,
    state: room.state,
    hostSocketId: room.hostSocketId,
    settings: room.settings,
    players,
    playerCount: players.length
  };
}

function assignGame(room) {
  const category = room.settings.category;
  room.secretWord = pickRandom(WORD_BANK[category] || WORD_BANK.Locations);

  const ids = [...room.players.keys()];
  room.imposterIds = new Set();

  // pick imposters
  const count = Math.min(room.settings.imposters, Math.max(1, ids.length - 1));
  const pool = [...ids];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    room.imposterIds.add(pool[idx]);
    pool.splice(idx, 1);
  }

  room.startingPlayerId = pickRandom(ids);

  // reset readiness/votes
  for (const [id, p] of room.players) {
    p.isReady = false;
    p.hasVoted = false;
    p.voteFor = null;
  }
}

function allReady(room) {
  for (const p of room.players.values()) if (!p.isReady) return false;
  return room.players.size > 0;
}

function allVoted(room) {
  for (const p of room.players.values()) if (!p.hasVoted) return false;
  return room.players.size > 0;
}

function tallyVotes(room) {
  const counts = new Map();
  for (const [id, p] of room.players) {
    if (!p.voteFor) continue;
    counts.set(p.voteFor, (counts.get(p.voteFor) || 0) + 1);
  }
  let topId = null;
  let top = -1;
  for (const [id, c] of counts.entries()) {
    if (c > top) { top = c; topId = id; }
  }
  return { counts: Object.fromEntries(counts), topId, top };
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name, settings }, cb) => {
    const safeName = (name || "Guest").trim().slice(0, 18) || "Guest";
    const room = createRoom({ hostSocketId: socket.id, hostName: safeName, settings });
    socket.join(room.code);
    io.to(room.code).emit("roomUpdate", roomSnapshot(room));
    cb?.({ ok: true, code: room.code, room: roomSnapshot(room) });
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (room.state !== "lobby") return cb?.({ ok: false, error: "Game already started." });

    const safeName = (name || "Guest").trim().slice(0, 18) || "Guest";
    room.players.set(socket.id, { name: safeName, isReady: false, hasVoted: false, voteFor: null });
    socket.join(room.code);
    io.to(room.code).emit("roomUpdate", roomSnapshot(room));
    cb?.({ ok: true, room: roomSnapshot(room) });
  });

  socket.on("updateSettings", ({ code, settings }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    if (socket.id !== room.hostSocketId) return;
    if (room.state !== "lobby") return;

    room.settings.category = settings?.category || room.settings.category;
    room.settings.imposters = Math.max(1, Math.min(settings?.imposters ?? room.settings.imposters, 5));
    room.settings.showCategoryToImposter = !!settings?.showCategoryToImposter;
    room.settings.showHintToImposter = !!settings?.showHintToImposter;

    io.to(room.code).emit("roomUpdate", roomSnapshot(room));
  });

  socket.on("kickPlayer", ({ code, playerId }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    if (socket.id !== room.hostSocketId) return;
    if (!room.players.has(playerId)) return;

    // tell kicked user
    io.to(playerId).emit("kicked");
    room.players.delete(playerId);
    io.sockets.sockets.get(playerId)?.leave(room.code);

    io.to(room.code).emit("roomUpdate", roomSnapshot(room));
  });

  socket.on("startGame", ({ code }, cb) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (socket.id !== room.hostSocketId) return cb?.({ ok: false, error: "Only host can start." });
    if (room.players.size < 3) return cb?.({ ok: false, error: "Need at least 3 players." });

    assignGame(room);
    room.state = "wordReveal";
    io.to(room.code).emit("roomUpdate", roomSnapshot(room));

    // send each player their role info privately
    for (const [id] of room.players) {
      const isImposter = room.imposterIds.has(id);
      const category = room.settings.category;
      const hint = pickRandom(IMPOSTER_HINTS.defaultHints);
      io.to(id).emit("yourRole", {
        isImposter,
        category: room.settings.showCategoryToImposter ? category : null,
        hint: room.settings.showHintToImposter ? hint : null,
        secretWord: isImposter ? null : room.secretWord
      });
    }

    cb?.({ ok: true });
  });

  socket.on("readyUp", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;

    p.isReady = true;
    io.to(room.code).emit("roomUpdate", roomSnapshot(room));

    if (room.state === "wordReveal" && allReady(room)) {
      room.state = "steps";
      io.to(room.code).emit("goSteps", {
        startingPlayerId: room.startingPlayerId
      });
      io.to(room.code).emit("roomUpdate", roomSnapshot(room));
    }
  });

  socket.on("beginVoting", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    // host or anyone can trigger; you can restrict to host if you want
    if (room.state !== "steps") return;
    room.state = "voting";
    // clear votes
    for (const p of room.players.values()) {
      p.hasVoted = false;
      p.voteFor = null;
    }
    io.to(room.code).emit("roomUpdate", roomSnapshot(room));
    io.to(room.code).emit("goVoting");
  });

  socket.on("castVote", ({ code, voteFor }, cb) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (room.state !== "voting") return cb?.({ ok: false, error: "Not voting phase." });

    const p = room.players.get(socket.id);
    if (!p) return cb?.({ ok: false, error: "Not in room." });
    if (!room.players.has(voteFor)) return cb?.({ ok: false, error: "Invalid vote." });

    p.hasVoted = true;
    p.voteFor = voteFor;

    if (allVoted(room)) {
      room.state = "results";
      const { counts, topId } = tallyVotes(room);

      io.to(room.code).emit("results", {
        counts,
        mostVotedId: topId,
        imposters: [...room.imposterIds],
        secretWord: room.secretWord
      });

      io.to(room.code).emit("roomUpdate", roomSnapshot(room));
    }

    cb?.({ ok: true });
  });

  socket.on("endGame", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    if (socket.id !== room.hostSocketId) return;

    // back to lobby
    room.state = "lobby";
    room.secretWord = null;
    room.imposterIds = new Set();
    room.startingPlayerId = null;
    for (const p of room.players.values()) {
      p.isReady = false;
      p.hasVoted = false;
      p.voteFor = null;
    }
    io.to(room.code).emit("roomUpdate", roomSnapshot(room));
    io.to(room.code).emit("backToLobby");
  });

  socket.on("disconnect", () => {
    // remove user from any rooms
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);

        // if host left, pick a new host (first remaining)
        if (room.hostSocketId === socket.id) {
          const nextHost = room.players.keys().next().value || null;
          room.hostSocketId = nextHost;
        }

        io.to(room.code).emit("roomUpdate", roomSnapshot(room));

        // delete empty room
        if (room.players.size === 0) {
          rooms.delete(room.code);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
