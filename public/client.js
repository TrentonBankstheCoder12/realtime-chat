// Minimal vanilla client for the chat protocol in src/protocol.ts.
// All rendering uses textContent (never innerHTML) so chat text can't inject HTML.
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  me: null,
  rooms: new Map(), // room -> { members: [], messages: [] }
  current: null,
  typingTimers: new Map(), // `${room}:${memberId}` -> timeout
  typingNames: new Map(), // room -> Map(memberId -> name)
  myTypingTimer: null,
  sentTyping: false,
};

// ------------------------------------------------------------ connection

function connect(name) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener("open", () => send({ type: "hello", name }));
  ws.addEventListener("message", (e) => onServerMessage(JSON.parse(e.data)));
  ws.addEventListener("close", (e) => {
    $("conn-dot").classList.remove("online");
    toast(e.reason ? `Disconnected: ${e.reason}` : "Disconnected");
    $("login-status").textContent = state.me ? "" : "Could not connect.";
  });
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

// ------------------------------------------------------------ inbound

function onServerMessage(msg) {
  switch (msg.type) {
    case "welcome":
      state.me = msg.you;
      $("me-name").textContent = msg.you.name;
      $("conn-dot").classList.add("online");
      $("login").hidden = true;
      $("app").hidden = false;
      send({ type: "join", room: "general" });
      break;

    case "joined":
      state.rooms.set(msg.room, { members: msg.members, messages: msg.history });
      switchRoom(msg.room);
      break;

    case "left":
      state.rooms.delete(msg.room);
      switchRoom(state.rooms.keys().next().value ?? null);
      break;

    case "presence": {
      const room = state.rooms.get(msg.room);
      if (!room) break;
      room.members = msg.members;
      room.messages.push({ system: `${msg.member.name} ${msg.event === "join" ? "joined" : "left"}` });
      if (msg.event === "leave") clearTyping(msg.room, msg.member.id);
      if (msg.room === state.current) render();
      break;
    }

    case "message": {
      const room = state.rooms.get(msg.message.room);
      if (!room) break;
      room.messages.push(msg.message);
      clearTyping(msg.message.room, msg.message.from.id);
      if (msg.message.room === state.current) render();
      break;
    }

    case "typing":
      if (msg.isTyping) {
        if (!state.typingNames.has(msg.room)) state.typingNames.set(msg.room, new Map());
        state.typingNames.get(msg.room).set(msg.member.id, msg.member.name);
        // Safety net: if we miss the "stopped typing" frame, expire after 5s.
        const key = `${msg.room}:${msg.member.id}`;
        clearTimeout(state.typingTimers.get(key));
        state.typingTimers.set(key, setTimeout(() => clearTyping(msg.room, msg.member.id), 5000));
      } else {
        clearTyping(msg.room, msg.member.id);
      }
      renderTyping();
      break;

    case "error":
      if (!state.me) $("login-status").textContent = msg.message;
      toast(msg.message);
      break;

    case "shutdown":
      toast(`Server: ${msg.reason}`);
      break;
  }
}

function clearTyping(room, memberId) {
  state.typingNames.get(room)?.delete(memberId);
  clearTimeout(state.typingTimers.get(`${room}:${memberId}`));
  renderTyping();
}

// ------------------------------------------------------------ rendering

function switchRoom(room) {
  state.current = room;
  render();
}

function render() {
  const roomList = $("room-list");
  roomList.replaceChildren(
    ...[...state.rooms.keys()].map((name) => {
      const li = document.createElement("li");
      li.textContent = `# ${name}`;
      if (name === state.current) li.classList.add("active");
      li.addEventListener("click", () => switchRoom(name));
      return li;
    }),
  );

  const room = state.current ? state.rooms.get(state.current) : null;
  $("room-title").textContent = room ? `# ${state.current}` : "No room joined";
  $("leave-btn").hidden = !room;
  $("send-form").hidden = !room;

  $("member-list").replaceChildren(
    ...(room ? room.members : []).map((m) => {
      const li = document.createElement("li");
      li.textContent = m.id === state.me?.id ? `${m.name} (you)` : m.name;
      return li;
    }),
  );

  const list = $("messages");
  list.replaceChildren(...(room ? room.messages : []).map(renderMessage));
  list.scrollTop = list.scrollHeight;
  renderTyping();
}

function renderMessage(m) {
  const li = document.createElement("li");
  if (m.system) {
    li.className = "system";
    li.textContent = m.system;
    return li;
  }
  li.className = m.from.id === state.me?.id ? "msg mine" : "msg";
  const meta = document.createElement("div");
  meta.className = "meta";
  const who = document.createElement("b");
  who.textContent = m.from.name;
  meta.append(who, new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = m.text;
  li.append(meta, body);
  return li;
}

function renderTyping() {
  const names = [...(state.typingNames.get(state.current)?.values() ?? [])];
  $("typing").textContent =
    names.length === 0 ? "" : names.length === 1 ? `${names[0]} is typing…` : `${names.join(", ")} are typing…`;
}

let toastTimer;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ------------------------------------------------------------ outbound UI

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  $("login-status").textContent = "";
  connect($("name").value.trim());
});

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const room = $("join-input").value.trim().toLowerCase();
  if (!room) return;
  if (state.rooms.has(room)) switchRoom(room);
  else send({ type: "join", room });
  $("join-input").value = "";
});

$("leave-btn").addEventListener("click", () => {
  if (state.current) send({ type: "leave", room: state.current });
});

function stopTyping() {
  clearTimeout(state.myTypingTimer);
  if (state.sentTyping && state.current) send({ type: "typing", room: state.current, isTyping: false });
  state.sentTyping = false;
}

// Send "typing: true" once, then "false" after 2s of no keystrokes.
// One frame per typing burst, not per keystroke, keeps us far under the rate limit.
$("send-input").addEventListener("input", () => {
  if (!state.current) return;
  if (!state.sentTyping) {
    send({ type: "typing", room: state.current, isTyping: true });
    state.sentTyping = true;
  }
  clearTimeout(state.myTypingTimer);
  state.myTypingTimer = setTimeout(stopTyping, 2000);
});

$("send-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("send-input");
  const text = input.value.trim();
  if (!text || !state.current) return;
  stopTyping();
  send({ type: "message", room: state.current, text });
  input.value = "";
});
