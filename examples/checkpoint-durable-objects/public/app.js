let ws = null;
let currentCheckpointId = null;
let pendingParent = null;
let historyData = [];

const messagesEl = document.getElementById("messages");
const sidebarEl = document.getElementById("sidebar");
const treeEl = document.getElementById("tree-svg");
const msgInput = document.getElementById("msg-input");
const sendBtn = document.getElementById("send-btn");

function connectThread() {
  if (ws) ws.close();
  const threadId =
    document.getElementById("thread-id").value.trim() || "default";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/thread/" + threadId);

  ws.onopen = () => {
    sendBtn.disabled = false;
    currentCheckpointId = null;
    pendingParent = null;
    addSystemMsg("Connected to thread: " + threadId);
    ws.send(JSON.stringify({ type: "get_messages" }));
    ws.send(JSON.stringify({ type: "get_history" }));
  };

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    switch (data.type) {
      case "response":
        addMsg("user", data.userMessage.content);
        addMsg("assistant", data.assistantMessage.content);
        currentCheckpointId = data.checkpointId;
        pendingParent = null;
        ws.send(JSON.stringify({ type: "get_history" }));
        break;
      case "messages":
        messagesEl.innerHTML = "";
        (data.messages || []).forEach((m) => addMsg(m.role, m.content));
        break;
      case "forked":
        messagesEl.innerHTML = "";
        (data.messages || []).forEach((m) => addMsg(m.role, m.content));
        addSystemMsg(
          "Forked to " +
            data.checkpointId.slice(0, 8) +
            " (" +
            data.messageCount +
            " msgs). Next message will branch."
        );
        pendingParent = data.checkpointId;
        currentCheckpointId = data.checkpointId;
        renderTree();
        break;
      case "history":
        historyData = data.history || [];
        renderSidebar();
        renderTree();
        break;
      case "error":
        addSystemMsg("Error: " + data.error);
        break;
    }
  };

  ws.onclose = () => {
    sendBtn.disabled = true;
    addSystemMsg("Disconnected");
  };
}

function sendMsg() {
  const content = msgInput.value.trim();
  if (!content || !ws) return;
  const payload = { type: "message", content };
  if (pendingParent) payload.parentCheckpointId = pendingParent;
  ws.send(JSON.stringify(payload));
  msgInput.value = "";
}

function forkTo(checkpointId) {
  if (!ws) return;
  ws.send(JSON.stringify({ type: "fork", checkpointId }));
}

function addMsg(role, content) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = content;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystemMsg(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// --- Sidebar ---

function renderSidebar() {
  sidebarEl.innerHTML =
    '<div style="padding:8px;font-weight:600;font-size:13px;color:#888">Checkpoints</div>';
  historyData.forEach((h) => {
    const div = document.createElement("div");
    div.className =
      "cp" + (h.checkpointId === currentCheckpointId ? " active" : "");
    div.innerHTML =
      '<div class="step">Step ' +
      h.step +
      '</div><div class="meta">' +
      h.messageCount +
      " msgs &middot; " +
      h.checkpointId.slice(0, 8) +
      "</div>";
    div.onclick = () => forkTo(h.checkpointId);
    sidebarEl.appendChild(div);
  });
}

// --- Tree visualization ---

function renderTree() {
  if (!historyData.length) {
    treeEl.innerHTML = "";
    return;
  }

  // Build adjacency: parent -> children
  const byId = new Map();
  historyData.forEach((h) => byId.set(h.checkpointId, h));

  const children = new Map();
  let roots = [];
  historyData.forEach((h) => {
    if (h.parentCheckpointId && byId.has(h.parentCheckpointId)) {
      if (!children.has(h.parentCheckpointId))
        children.set(h.parentCheckpointId, []);
      children.get(h.parentCheckpointId).push(h.checkpointId);
    } else {
      roots.push(h.checkpointId);
    }
  });

  // Layout: assign (x, y) to each node via DFS
  const nodeX = 40;
  const nodeY = 36;
  const radius = 8;
  const positions = new Map();
  let leafCol = 0;

  function layout(id, depth) {
    const kids = children.get(id) || [];
    if (kids.length === 0) {
      positions.set(id, { x: leafCol * nodeX + 20, y: depth * nodeY + 20 });
      leafCol++;
      return;
    }
    kids.forEach((kid) => layout(kid, depth + 1));
    // Center parent over children
    const childPositions = kids.map((k) => positions.get(k));
    const avgX =
      childPositions.reduce((s, p) => s + p.x, 0) / childPositions.length;
    positions.set(id, { x: avgX, y: depth * nodeY + 20 });
  }

  roots.forEach((r) => layout(r, 0));

  // SVG dimensions
  const maxX = Math.max(...[...positions.values()].map((p) => p.x)) + 40;
  const maxY = Math.max(...[...positions.values()].map((p) => p.y)) + 40;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX}" height="${maxY}" id="tree-svg">`;

  // Edges
  historyData.forEach((h) => {
    if (h.parentCheckpointId && positions.has(h.parentCheckpointId)) {
      const from = positions.get(h.parentCheckpointId);
      const to = positions.get(h.checkpointId);
      if (from && to) {
        svg += `<line class="edge" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/>`;
      }
    }
  });

  // Nodes
  historyData.forEach((h) => {
    const pos = positions.get(h.checkpointId);
    if (!pos) return;
    const active = h.checkpointId === currentCheckpointId ? " active" : "";
    svg += `<g class="node${active}" onclick="forkTo('${h.checkpointId}')">`;
    svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${radius}"/>`;
    svg += `<text x="${pos.x}" y="${pos.y - radius - 4}" text-anchor="middle">${h.step}</text>`;
    svg += `</g>`;
  });

  svg += `</svg>`;
  treeEl.innerHTML = svg;
}

// Auto-connect
connectThread();
msgInput.focus();
