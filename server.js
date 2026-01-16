const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
const PORT = process.env.PORT || 3000;

/**
 * Room state machine:
 * lobby -> reveal (private role sent) -> steps (order shown) -> vote -> results
 *
 * Security model:
 * - Only host can change room settings, start game, start voting, end game, kick
 * - Server enforces all host-only actions even if someone tampers with the UI
 * - Chat is full text with guardrails (length, basic filter, slowmode)
 */

const rooms = new Map();

/** Word bank (starter). You can expand anytime. */
const WORDS = {
  Locations: ["Cathedral","Airport","Library","Stadium","Museum","Aquarium","Hospital","Mall","Beach","Castle"],
  Food: ["Pizza","Sushi","Burger","Taco","Pancake","Ramen","Steak","Salad"],
  Animals: ["Tiger","Elephant","Dolphin","Eagle","Shark","Giraffe","Wolf","Panda"],
  Objects: ["Backpack","Laptop","Headphones","Notebook","Water Bottle","Calculator","Skateboard","Keychain"],
  Movies: ["Inception","Titanic","Avatar","Frozen","Rocky","Up","Jaws","Coco"],
  Sports: ["Soccer","Basketball","Football","Tennis","Baseball","Hockey","Track","Swimming"]
};

/** Better hints: per-word hints where possible, fallback otherwise. */
const HINTS = {
  Cathedral: ["sanctuary","stained glass","choir","tall spires","echoing halls"],
  Airport: ["terminal","boarding gate","security line","runway","luggage"],
  Library: ["quiet","bookshelves","study tables","librarian","checkout desk"],
  Stadium: ["bleachers","crowd noise","scoreboard","field","tickets"],
  Museum: ["exhibits","artifacts","gallery","history","quiet walking"],
  Aquarium: ["tanks","fish","sharks","sea life","glass tunnel"],
  Hospital: ["nurses","ER","waiting room","doctors","hallways"],
  Mall: ["stores","food court","shopping","escalator","parking lot"],
  Beach: ["sand","waves","boardwalk","towels","sunburn"],
  Castle: ["moat","towers","royal","stone walls","drawbridge"],

  Pizza: ["slices","toppings","cheesy","delivery","crust"],
  Sushi: ["rice","rolls","soy sauce","wasabi","chopsticks"],
  Burger: ["bun","patty","fries","grill","ketchup"],
  Taco: ["tortilla","salsa","crunch","toppings","street food"],
  Pancake: ["syrup","breakfast","stack","butter","griddle"],
  Ramen: ["noodles","broth","chopsticks","steam","toppings"],
  Steak: ["grill marks","medium-rare","knife","juicy","protein"],
  Salad: ["greens","dressing","bowl","fresh","crunchy"],

  Tiger: ["stripes","big cat","jungle","predator","roar"],
  Elephant: ["trunk","tusks","huge","savanna","memory"],
  Dolphin: ["ocean","smart","clicks","swimming","pods"],
  Eagle: ["wings","talons","soaring","sharp eyes","nest"],
  Shark: ["teeth","ocean","fin","predator","swimming"],
  Giraffe: ["long neck","spots","tall","savanna","leaves"],
  Wolf: ["pack","howl","forest","predator","moon"],
  Panda: ["bamboo","black and white","bear","cute","China"],

  Backpack: ["straps","zippers","school","books","carry"],
  Laptop: ["keyboard","screen","charger","homework","apps"],
  Headphones: ["music","volume","earbuds","noise","playlist"],
  Notebook: ["paper","notes","spiral","classes","writing"],
  "Water Bottle": ["hydration","cap","refill","gym","sip"],
  Calculator: ["math","buttons","numbers","tests","equations"],
  Skateboard: ["wheels","tricks","deck","skate park","kickflip"],
  Keychain: ["keys","ring","clip","small","pocket"],

  Inception: ["dreams","mind-bending","layers","heist","spinning top"],
  Titanic: ["ship","iceberg","ocean","tragedy","love story"],
  Avatar: ["blue aliens","Pandora","3D","jungle","sci‑fi"],
  Frozen: ["snow","sisters","Let It Go","ice powers","Disney"],
  Rocky: ["boxing","training","Philadelphia","underdog","ring"],
  Up: ["balloons","old man","adventure","house","Disney/Pixar"],
  Jaws: ["shark","ocean","thriller","beach","classic"],
  Coco: ["music","family","afterlife","Day of the Dead","guitar"],

  Soccer: ["goal","cleats","field","passes","World Cup"],
  Basketball: ["hoops","dribble","court","three-pointer","NBA"],
  Football: ["touchdown","helmets","yard line","QB","NFL"],
  Tennis: ["racket","serve","net","match","court"],
  Baseball: ["bat","glove","diamond","home run","MLB"],
  Hockey: ["ice","puck","sticks","goalie","rink"],
  Track: ["laps","sprint","relay","lanes","meet"],
  Swimming: ["pool","laps","goggles","freestyle","lane lines"]
};

const CATEGORY_HINTS = {
  Locations: ["public place","somewhere you can visit","a place people gather","think buildings/areas"],
  Food: ["something you can eat","think meals/snacks","often in restaurants","common ingredient"],
  Animals: ["a living creature","think habitat","wild vs domestic","has unique features"],
  Objects: ["something you can hold/use","common item","found at home/school","tool or accessory"],
  Movies: ["a film title","characters/plot","genre clue","famous scenes"],
  Sports: ["a sport/game","equipment involved","field/court/pool","rules and scoring"]
};

function code6() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const now = () => Date.now();
const cleanText = (s) => String(s ?? "").trim();

const BAD_WORDS = ["fuck","shit","bitch","asshole","dick","pussy","cunt","nigger","faggot"];
function maskProfanity(msg) {
  let out = msg;
  for (const w of BAD_WORDS) out = out.replace(new RegExp(`\\b${w}\\b`, "gi"), "****");
  return out;
}
function getHintFor(word, category) {
  if (HINTS[word]) return pick(HINTS[word]);
  return pick(CATEGORY_HINTS[category] || ["think broadly"]);
}

function newRoom(hostSocketId, hostName) {
  return {
    code: code6(),
    host: hostSocketId,
    state: "lobby",
    category: "Locations",
    settings: { imposters: 1, showCategoryToImposter: true, showHintToImposter: true },
    word: null,
    imposters: new Set(),
    players: new Map(), // socketId -> { name, ready, vote, joinedAt }
    turnOrder: [],
    chat: [],
    lastChatTs: new Map()
  };
}

function serializeRoom(room) {
  return {
    code: room.code,
    host: room.host,
    state: room.state,
    category: room.category,
    settings: room.settings,
    players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, ready: !!p.ready })),
    turnOrder: room.turnOrder.map((id) => ({ id, name: room.players.get(id)?.name || "Player" })),
    results: room.state === "results" ? { word: room.word, imposters: [...room.imposters] } : null,
    chat: room.chat.slice(-80)
  };
}
const isHost = (room, socket) => room && socket && socket.id === room.host;
const broadcast = (room) => io.to(room.code).emit("update", serializeRoom(room));

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    const hostName = cleanText(name) || "Guest";
    const room = newRoom(socket.id, hostName);
    rooms.set(room.code, room);

    room.players.set(socket.id, { name: hostName, ready: false, vote: null, joinedAt: now() });
    socket.join(room.code);
    cb?.({ code: room.code });
    broadcast(room);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    const roomCode = cleanText(code).toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ error: "Room not found" });
    if (room.state !== "lobby") return cb?.({ error: "Game already started" });

    const playerName = cleanText(name) || "Guest";
    room.players.set(socket.id, { name: playerName, ready: false, vote: null, joinedAt: now() });
    socket.join(room.code);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on("leaveRoom", ({ code }) => {
    const room = rooms.get(cleanText(code).toUpperCase());
    if (!room) return;
    socket.leave(room.code);
    removePlayerFromRoom(room, socket.id);
  });

  socket.on("kickPlayer", ({ code, playerId }) => {
    const room = rooms.get(cleanText(code).toUpperCase());
    if (!isHost(room, socket)) return;
    const targetId = cleanText(playerId);
    if (!targetId || !room.players.has(targetId)) return;

    io.to(targetId).emit("kicked");
    io.sockets.sockets.get(targetId)?.leave(room.code);
    removePlayerFromRoom(room, targetId);
  });

  socket.on("updateSettings", ({ code, category, settings }) => {
    const room = rooms.get(cleanText(code).toUpperCase());
    if (!isHost(room, socket)) return;
    if (!room || room.state !== "lobby") return;

    if (category && WORDS[category]) room.category = category;

    if (settings && typeof settings === "object") {
      const imp = Number(settings.imposters);
      if (Number.isFinite(imp)) {
        const maxImp = Math.max(1, Math.floor(room.players.size / 2));
        room.settings.imposters = Math.max(1, Math.min(maxImp, Math.floor(imp)));
      }
      if (typeof settings.showCategoryToImposter === "boolean") room.settings.showCategoryToImposter = settings.showCategoryToImposter;
      if (typeof settings.showHintToImposter === "boolean") room.settings.showHintToImposter = settings.showHintToImposter;
    }
    broadcast(room);
  });

  socket.on("startGame", ({ code }) => {
    const room = rooms.get(cleanText(code).toUpperCase());
    if (!isHost(room, socket)) return;
    if (!room || room.state !== "lobby") return;

    const playerIds = [...room.players.keys()];
    if (playerIds.length < 3) return;

    room.word = pick(WORDS[room.category] || WORDS.Locations);

    const maxImp = Math.max(1, Math.floor(playerIds.length / 2));
    const impostersCount = Math.max(1, Math.min(room.settings.imposters || 1, maxImp));

    const shuffled = shuffle(playerIds);
    room.imposters = new Set(shuffled.slice(0, impostersCount));

    for (const id of playerIds) {
      const p = room.players.get(id);
      p.ready = false;
      p.vote = null;
    }
    room.turnOrder = [];
    room.chat = [];
    room.lastChatTs = new Map();

    for (const id of playerIds) {
      const isImp = room.imposters.has(id);
      const hint = isImp ? getHintFor(room.word, room.category) : null;
      io.to(id).emit("role", {
        isImposter: isImp,
        word: isImp ? null : room.word,
        category: room.category,
        showCategory: !!room.settings.showCategoryToImposter,
        showHint: !!room.settings.showHintToImposter,
        hint
      });
    }

    room.state = "reveal";
    broadcast(room);
  });

  socket.on("ready", ({ code }) => {
    const room = rooms.get(cleanText(code).toUpperCase());
    if (!room || !room.players.has(socket.id)) return;
    if (room.state !== "reveal") return;

    room.players.get(socket.id).ready = true;

    if ([...room.players.values()].every(pp => !!pp.ready)) {
      room.turnOrder = shuffle([...room.players.keys()]);
      room.state = "steps";
    }
    broadcast(room);
  });

  socket.on("startVoting", ({ code }) => {
    const room = rooms.get(cleanText(code).toUpperCase());
    if (!isHost(room, socket)) return;
    if (!room || room.state !== "steps") return;

    for (const p of room.players.values()) p.vote = null;
    room.state = "vote";
    broadcast(room);
  });

  socket.on("vote", ({ code, targetId }) => {
    const room = rooms.get(cleanText(code).toUpperCase());
    if (!room || !room.players.has(socket.id)) return;
    if (room.state !== "vote") return;

    const target = cleanText(targetId);
    if (!target || !room.players.has(target)) return;

    room.players.get(socket.id).vote = target;

    if ([...room.players.values()].every(p => !!p.vote)) room.state = "results";
    broadcast(room);
  });

  socket.on("endGame", ({ code }) => {
    const room = rooms.get(cleanText(code).toUpperCase());
    if (!isHost(room, socket)) return;
    if (!room || room.state === "lobby") return;
    room.state = "results";
    broadcast(room);
  });

  socket.on("resetLobby", ({ code }) => {
    const room = rooms.get(cleanText(code).toUpperCase());
    if (!isHost(room, socket)) return;
    if (!room) return;

    room.state = "lobby";
    room.word = null;
    room.imposters = new Set();
    room.turnOrder = [];
    room.chat = [];
    room.lastChatTs = new Map();
    for (const p of room.players.values()) { p.ready = false; p.vote = null; }
    broadcast(room);
  });

  socket.on("chatSend", ({ code, text }, cb) => {
    const room = rooms.get(cleanText(code).toUpperCase());
    if (!room || !room.players.has(socket.id)) return;
    if (room.state === "lobby") return;

    const raw = cleanText(text);
    if (!raw) return;

    let msg = raw.slice(0, 160);
    const lastTs = room.lastChatTs.get(socket.id) || 0;
    const t = now();
    if (t - lastTs < 1200) return;
    room.lastChatTs.set(socket.id, t);

    msg = maskProfanity(msg);
    const sender = room.players.get(socket.id)?.name || "Player";

    const entry = { id: `${t}-${Math.random().toString(16).slice(2)}`, ts: t, name: sender, text: msg };
    room.chat.push(entry);
    if (room.chat.length > 120) room.chat = room.chat.slice(-120);

    broadcast(room);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) removePlayerFromRoom(room, socket.id);
    }
  });
});

function removePlayerFromRoom(room, socketId) {
  room.players.delete(socketId);
  room.lastChatTs?.delete(socketId);

  if (room.players.size === 0) { rooms.delete(room.code); return; }

  if (room.host === socketId) {
    let bestId = null, bestTs = Infinity;
    for (const [id, p] of room.players.entries()) {
      if ((p.joinedAt ?? 0) < bestTs) { bestTs = p.joinedAt ?? 0; bestId = id; }
    }
    room.host = bestId || [...room.players.keys()][0];
  }

  room.turnOrder = room.turnOrder.filter(id => room.players.has(id));
  if (room.state !== "lobby" && room.players.size < 3) room.state = "results";
  broadcast(room);
}

server.listen(PORT, () => console.log("Server running on", PORT));
