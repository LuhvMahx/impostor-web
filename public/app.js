const socket = io();

let myName = "Guest";
let myRoomCode = null;
let room = null;
let myRole = null; // {isImposter, category, hint, secretWord}
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

function setError(el, msg) {
  if (!msg) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function isHost() {
  return room && room.hostSocketId === socket.id;
}

function renderLobby() {
  if (!room) return;
  $("roomCodeLabel").textContent = room.code;

  // settings
  $("categorySelect").value = room.settings.category;
  $("impostersInput").value = room.settings.imposters;
  $("showCategoryToggle").checked = room.settings.showCategoryToImposter;
  $("showHintToggle").checked = room.settings.showHintToImposter;

  // enable start if host + enough players
  $("startBtn").disabled = !(isHost() && room.playerCount >= 3);

  // players list
  const wrap = $("playersList");
  wrap.innerHTML = "";
  room.players.forEach(p => {
    const row = document.createElement("div");
    row.className = "playerRow";

    const left = document.createElement("div");
    left.innerHTML = `<div class="playerName">${escapeHtml(p.name)} ${p.id === room.hostSocketId ? `<span class="tag">(Host)</span>` : ""}</div>
                      <div class="tag">${p.isReady ? "Ready ✅" : "Not ready"}</div>`;

    const right = document.createElement("div");
    if (isHost() && p.id !== room.hostSocketId) {
      const kick = document.createElement("button");
      kick.className = "kickBtn";
      kick.textContent = "Kick";
      kick.onclick = () => socket.emit("kickPlayer", { code: room.code, playerId: p.id });
      right.appendChild(kick);
    }

    row.appendChild(left);
    row.appendChild(right);
    wrap.appendChild(row);
  });
}

function renderRole() {
  const categoryText = myRole?.category ?? "Hidden";
  $("roleCategory").textContent = categoryText;

  const isImp = !!myRole?.isImposter;
  const roleMain = $("roleMain");
  const roleBox = $("roleBox");

  if (isImp) {
    roleMain.textContent = "Imposter";
    roleMain.className = "roleMain roleImposter";
    roleBox.style.borderColor = "rgba(255,84,109,.45)";
  } else {
    roleMain.textContent = myRole?.secretWord || "—";
    roleMain.className = "roleMain roleWord";
    roleBox.style.borderColor = "rgba(184,107,255,.35)";
  }

  if (isImp && myRole?.hint) {
    $("hintText").textContent = myRole.hint.toUpperCase();
    $("hintBox").classList.remove("hidden");
  } else {
    $("hintBox").classList.add("hidden");
  }
}

function renderSteps(startingPlayerId) {
  const starter = room.players.find(p => p.id === startingPlayerId);
  $("startingPlayerLine").textContent = starter ? `${starter.name} starts the round` : "Host starts the round";
}

function renderVote() {
  selectedVote = null;
  const wrap = $("voteList");
  wrap.innerHTML = "";

  room.players.forEach(p => {
    const btn = document.createElement("button");
    btn.className = "voteBtn";
    btn.innerHTML = `<div style="font-weight:800">${escapeHtml(p.name)}</div><div class="muted" style="font-size:12px">Tap to vote</div>`;
    btn.onclick = () => {
      selectedVote = p.id;
      [...wrap.querySelectorAll(".voteBtn")].forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      $("voteStatus").textContent = "Vote selected. Submitting…";
      socket.emit("castVote", { code: myRoomCode, voteFor: selectedVote }, (res) => {
        if (!res?.ok) $("voteStatus").textContent = res?.error || "Vote failed.";
        else $("voteStatus").textContent = "Vote submitted. Waiting for others…";
      });
    };
    wrap.appendChild(btn);
  });

  $("voteStatus").textContent = "Pick someone to vote.";
}

function renderResults(payload) {
  $("secretWord").textContent = payload.secretWord || "—";
  const impNames = payload.imposters
    .map(id => room.players.find(p => p.id === id)?.name || "Unknown")
    .join(", ");
  $("impostorNames").textContent = impNames || "—";
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

/* ---------- Home actions ---------- */
$("guestBtn").onclick = () => {
  $("nameInput").value = "Guest";
};

$("hostBtn").onclick = () => {
  myName = ($("nameInput").value || "Guest").trim() || "Guest";
  const settings = {
    category: "Locations",
    imposters: 1,
    showCategoryToImposter: true,
    showHintToImposter: true
  };
  socket.emit("createRoom", { name: myName, settings }, (res) => {
    if (!res?.ok) return setError($("homeError"), res?.error || "Failed to create room.");
    myRoomCode = res.code;
    setError($("homeError"), "");
    showScreen("lobby");
  });
};

$("joinBtn").onclick = () => {
  $("joinRow").classList.toggle("hidden");
};

$("joinConfirmBtn").onclick = () => {
  myName = ($("nameInput").value || "Guest").trim() || "Guest";
  const code = ($("codeInput").value || "").trim().toUpperCase();
  if (!code) return setError($("homeError"), "Enter a room code.");
  socket.emit("joinRoom", { code, name: myName }, (res) => {
    if (!res?.ok) return setError($("homeError"), res.error || "Join failed.");
    myRoomCode = code;
    setError($("homeError"), "");
    showScreen("lobby");
  });
};

$("leaveBtn").onclick = () => location.reload();

/* ---------- Lobby settings (host only) ---------- */
function pushSettings() {
  if (!room || !isHost()) return;
  const settings = {
    category: $("categorySelect").value,
    imposters: Number($("impostersInput").value || 1),
    showCategoryToImposter: $("showCategoryToggle").checked,
    showHintToImposter: $("showHintToggle").checked
  };
  socket.emit("updateSettings", { code: room.code, settings });
}

$("categorySelect").onchange = pushSettings;
$("impostersInput").oninput = pushSettings;
$("showCategoryToggle").onchange = pushSettings;
$("showHintToggle").onchange = pushSettings;

$("startBtn").onclick = () => {
  socket.emit("startGame", { code: myRoomCode }, (res) => {
    if (!res?.ok) alert(res?.error || "Start failed.");
  });
};

/* ---------- Word reveal ---------- */
$("readyBtn").onclick = () => {
  $("readyBtn").disabled = true;
  $("readyBtn").textContent = "Ready ✅";
  socket.emit("readyUp", { code: myRoomCode });
};

/* ---------- Steps ---------- */
$("goVoteBtn").onclick = () => {
  socket.emit("beginVoting", { code: myRoomCode });
};

$("endBtn").onclick = () => socket.emit("endGame", { code: myRoomCode });
$("endBtn2").onclick = () => socket.emit("endGame", { code: myRoomCode });

/* ---------- Results ---------- */
$("playAgainBtn").onclick = () => {
  // host ends game to reset; others wait for backToLobby
  if (isHost()) socket.emit("endGame", { code: myRoomCode });
  else alert("Waiting for host to send everyone back to lobby.");
};

/* ---------- Socket events ---------- */
socket.on("roomUpdate", (snap) => {
  room = snap;
  if (!myRoomCode) myRoomCode = room.code;

  if (room.state === "lobby") {
    showScreen("lobby");
    renderLobby();
  } else if (room.state === "wordReveal") {
    showScreen("word");
    // lobby render still useful for start button state, but not shown
  } else if (room.state === "steps") {
    showScreen("steps");
  } else if (room.state === "voting") {
    showScreen("vote");
    renderVote();
  } else if (room.state === "results") {
    showScreen("results");
  }
});

socket.on("yourRole", (payload) => {
  myRole = payload;
  renderRole();
  showScreen("word");
  $("readyBtn").disabled = false;
  $("readyBtn").textContent = "Ready";
});

socket.on("goSteps", ({ startingPlayerId }) => {
  showScreen("steps");
  renderSteps(startingPlayerId);
});

socket.on("goVoting", () => {
  showScreen("vote");
  renderVote();
});

socket.on("results", (payload) => {
  showScreen("results");
  renderResults(payload);
});

socket.on("backToLobby", () => {
  // reset UI buttons
  $("readyBtn").disabled = false;
  $("readyBtn").textContent = "Ready";
  showScreen("lobby");
});

socket.on("kicked", () => {
  alert("You were kicked from the room.");
  location.reload();
});
