const socket = io();

let myName = "Guest";
let myRoomCode = null;
let room = null;
let myRole = null;
let selectedVote = null;

const $ = (id) => document.getElementById(id);

const screens = {
  home: $("screen-home"),
  lobby: $("screen-lobby"),
  word: $("screen-word"),
  steps: $("screen-steps"),
  vote: $("screen-vote"),
  results: $("screen-results")
};

function showScreen(name) {
  Object.values(screens).forEach(el => el.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function isHost() {
  return room && room.host === socket.id;
}

function setError(el, msg) {
  if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function sanitizeCode(s) {
  return String(s || "").trim().toUpperCase();
}

/* Home */
$("guestBtn").onclick = () => { $("nameInput").value = "Guest"; };

$("joinBtn").onclick = () => { $("joinRow").classList.toggle("hidden"); };

$("hostBtn").onclick = () => {
  myName = ($("nameInput").value || "Guest").trim().slice(0, 18) || "Guest";
  socket.emit("createRoom", { name: myName }, (res) => {
    if (res?.code) { myRoomCode = res.code; setError($("homeError"), ""); showScreen("lobby"); }
    else setError($("homeError"), "Could not create room.");
  });
};

$("joinConfirmBtn").onclick = () => {
  myName = ($("nameInput").value || "Guest").trim().slice(0, 18) || "Guest";
  const code = sanitizeCode($("codeInput").value);
  if (!code) return setError($("homeError"), "Enter a room code.");
  socket.emit("joinRoom", { code, name: myName }, (res) => {
    if (res?.error) return setError($("homeError"), res.error);
    myRoomCode = code; setError($("homeError"), ""); showScreen("lobby");
  });
};

/* Lobby */
$("leaveBtn").onclick = () => {
  if (myRoomCode) socket.emit("leaveRoom", { code: myRoomCode });
  myRoomCode = null; room = null; myRole = null; selectedVote = null;
  showScreen("home");
};

function getSettingsFromUI() {
  return {
    imposters: Number($("impostersInput").value || 1),
    showCategoryToImposter: !!$("showCategoryToggle").checked,
    showHintToImposter: !!$("showHintToggle").checked
  };
}

["categorySelect","impostersInput","showCategoryToggle","showHintToggle"].forEach((id) => {
  $(id).addEventListener("change", () => {
    if (!isHost()) return;
    socket.emit("updateSettings", { code: myRoomCode, category: $("categorySelect").value, settings: getSettingsFromUI() });
  });
  $(id).addEventListener("input", () => {
    if (!isHost()) return;
    socket.emit("updateSettings", { code: myRoomCode, category: $("categorySelect").value, settings: getSettingsFromUI() });
  });
});

$("startBtn").onclick = () => { if (isHost()) socket.emit("startGame", { code: myRoomCode }); };

/* Reveal */
$("readyBtn").onclick = () => {
  socket.emit("ready", { code: myRoomCode });
  $("readyBtn").disabled = true;
  $("readyBtn").textContent = "Waiting...";
};

/* Steps/Vote/Results */
$("startVotingBtn").onclick = () => { if (isHost()) socket.emit("startVoting", { code: myRoomCode }); };
$("endGameBtn").onclick = () => { if (isHost()) socket.emit("endGame", { code: myRoomCode }); };
$("playAgainBtn").onclick = () => { if (isHost()) socket.emit("resetLobby", { code: myRoomCode }); };

/* Chat */
const CHAT_SCREENS = ["word","steps","vote","results"];
function escapeHtml(s){return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));}

function bindChat(screenName) {
  const list = $(`chatList-${screenName}`);
  const input = $(`chatInput-${screenName}`);
  const btn = $(`chatSend-${screenName}`);

  const send = () => {
    const t = (input.value || "").trim();
    if (!t) return;
    socket.emit("chatSend", { code: myRoomCode, text: t }, () => {});
    input.value = "";
  };

  btn.onclick = send;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

  return { list };
}
const chatEls = {};
CHAT_SCREENS.forEach(s => chatEls[s] = bindChat(s));

function renderChat() {
  CHAT_SCREENS.forEach((s) => {
    const list = chatEls[s].list;
    list.innerHTML = "";
    (room?.chat || []).slice(-80).forEach(m => {
      const d = new Date(m.ts);
      const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const row = document.createElement("div");
      row.className = "chatMsg";
      row.innerHTML = `<span class="chatTime">${time}</span> <span class="chatName">${escapeHtml(m.name)}:</span> <span class="chatText">${escapeHtml(m.text)}</span>`;
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
  });
}

/* Render */
function renderLobby() {
  $("roomCodeLabel").textContent = room.code;

  const host = isHost();
  $("hostOnlyNote").classList.toggle("hidden", host);

  $("categorySelect").disabled = !host;
  $("impostersInput").disabled = !host;
  $("showCategoryToggle").disabled = !host;
  $("showHintToggle").disabled = !host;

  $("categorySelect").value = room.category;
  $("impostersInput").value = room.settings.imposters;
  $("showCategoryToggle").checked = !!room.settings.showCategoryToImposter;
  $("showHintToggle").checked = !!room.settings.showHintToImposter;

  $("startBtn").disabled = !(host && room.players.length >= 3);

  const list = $("playersList");
  list.innerHTML = "";
  room.players.forEach(p => {
    const row = document.createElement("div");
    row.className = "playerRow";
    const left = document.createElement("div");
    left.innerHTML = `<div class="playerName">${escapeHtml(p.name)}</div><div class="tag">${p.ready ? "Ready" : "Not ready"}</div>`;
    row.appendChild(left);

    const right = document.createElement("div");
    if (host && p.id !== socket.id) {
      const kick = document.createElement("button");
      kick.className = "kickBtn";
      kick.textContent = "Kick";
      kick.onclick = () => socket.emit("kickPlayer", { code: myRoomCode, playerId: p.id });
      right.appendChild(kick);
    } else {
      const tag = document.createElement("div");
      tag.className = "tag";
      tag.textContent = (p.id === room.host) ? "Host" : "";
      right.appendChild(tag);
    }
    row.appendChild(right);
    list.appendChild(row);
  });
}

function renderRoleCard() {
  $("readyBtn").disabled = false;
  $("readyBtn").textContent = "Ready";

  const showCat = !myRole?.isImposter || myRole?.showCategory;
  $("roleCategoryWrap").classList.toggle("hidden", !showCat);
  $("roleCategory").textContent = showCat ? (myRole?.category || "—") : "—";

  if (myRole?.isImposter) {
    $("roleMain").textContent = "IMPOSTER";
    $("roleMain").style.color = "#ff546d";
    $("hintBox").classList.toggle("hidden", !myRole?.showHint);
    $("hintText").textContent = myRole?.showHint ? (myRole?.hint || "Think broad.") : "—";
  } else {
    $("roleMain").textContent = myRole?.word || "—";
    $("roleMain").style.color = "rgba(233,233,255,.95)";
    $("hintBox").classList.add("hidden");
  }
}

function renderSteps() {
  $("startVotingBtn").classList.toggle("hidden", !isHost());
  const list = $("orderList");
  list.innerHTML = "";
  room.turnOrder.forEach((p, idx) => {
    const row = document.createElement("div");
    row.className = "playerRow";
    row.innerHTML = `<div class="playerName">${idx + 1}. ${escapeHtml(p.name)}</div><div class="tag">${p.id === room.host ? "Host" : ""}</div>`;
    list.appendChild(row);
  });
}

function renderVote() {
  $("endGameBtn").classList.toggle("hidden", !isHost());
  const grid = $("voteGrid");
  grid.innerHTML = "";
  room.players.forEach(p => {
    const btn = document.createElement("button");
    btn.className = "voteBtn" + (selectedVote === p.id ? " selected" : "");
    btn.innerHTML = `<div class="playerName">${escapeHtml(p.name)}</div><div class="tag">Tap to vote</div>`;
    btn.onclick = () => { selectedVote = p.id; socket.emit("vote", { code: myRoomCode, targetId: p.id }); renderVote(); };
    grid.appendChild(btn);
  });
}

function renderResults() {
  $("playAgainBtn").classList.toggle("hidden", !isHost());
  const word = room.results?.word || "—";
  const impIds = new Set(room.results?.imposters || []);
  const impNames = room.players.filter(p => impIds.has(p.id)).map(p => p.name);

  $("resultsWord").textContent = word;
  $("resultsImposters").textContent = impNames.length ? impNames.join(", ") : "—";
}

/* Socket */
socket.on("role", (data) => { myRole = data; showScreen("word"); renderRoleCard(); });

socket.on("update", (data) => {
  room = data;
  if (!myRoomCode) myRoomCode = data.code;

  if (room.state === "lobby") showScreen("lobby");
  if (room.state === "reveal") showScreen("word");
  if (room.state === "steps") showScreen("steps");
  if (room.state === "vote") showScreen("vote");
  if (room.state === "results") showScreen("results");

  if (room.state === "lobby") renderLobby();
  if (room.state === "reveal") renderRoleCard();
  if (room.state === "steps") renderSteps();
  if (room.state === "vote") renderVote();
  if (room.state === "results") renderResults();

  renderChat();
});

socket.on("kicked", () => {
  alert("You were kicked by the host.");
  myRoomCode = null; room = null; myRole = null; selectedVote = null;
  showScreen("home");
});

showScreen("home");
