let ws = null;
let currentCheckpointId = null;
let pendingParent = null;
let historyData = [];

// Pagination state
const PAGE_SIZE = 50;
let totalMessages = 0;
let loadedOffset = 0; // how far back from the end we've loaded
let loadingMore = false;
let hasMore = false;

const messagesEl = document.getElementById("messages");
const sidebarEl = document.getElementById("sidebar");
const treeEl = document.getElementById("tree-svg");
const threadSelect = document.getElementById("thread-select");
const threadInput = document.getElementById("thread-id");
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
    totalMessages = 0;
    loadedOffset = 0;
    hasMore = false;
    messagesEl.innerHTML = "";
    addSystemMsg("Connected to thread: " + threadId);
    ws.send(JSON.stringify({ type: "get_messages", limit: PAGE_SIZE, offset: 0 }));
    ws.send(JSON.stringify({ type: "get_history" }));
  };

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    switch (data.type) {
      case "response":
        addMsg("user", data.userMessage.content);
        addMsg("assistant", data.assistantMessage.content);
        totalMessages += 2;
        currentCheckpointId = data.checkpointId;
        pendingParent = null;
        ws.send(JSON.stringify({ type: "get_history" }));
        break;
      case "messages":
        handleMessages(data);
        break;
      case "forked":
        messagesEl.innerHTML = "";
        totalMessages = 0;
        loadedOffset = 0;
        hasMore = false;
        (data.messages || []).forEach((m) => addMsg(m.role, m.content));
        totalMessages = (data.messages || []).length;
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

function handleMessages(data) {
  const msgs = data.messages || [];
  totalMessages = data.total ?? msgs.length;
  hasMore = data.hasMore ?? false;

  if (data.offset === 0 || data.offset == null) {
    // Initial load — replace content, scroll to bottom
    loadedOffset = msgs.length;
    messagesEl.innerHTML = "";
    if (hasMore) {
      addLoadMoreSentinel();
    }
    msgs.forEach((m) => addMsg(m.role, m.content));
    messagesEl.scrollTop = messagesEl.scrollHeight;
    addSystemMsg(totalMessages + " messages total" + (hasMore ? " — scroll up for more" : ""));
  } else {
    // Prepending older messages
    loadingMore = false;
    loadedOffset += msgs.length;

    const prevHeight = messagesEl.scrollHeight;
    const prevScroll = messagesEl.scrollTop;

    // Remove old sentinel
    const oldSentinel = messagesEl.querySelector(".load-more-sentinel");
    if (oldSentinel) oldSentinel.remove();

    // Build a fragment with older messages
    const frag = document.createDocumentFragment();
    if (data.hasMore) {
      frag.appendChild(makeLoadMoreSentinel());
    }
    msgs.forEach((m) => {
      frag.appendChild(makeMsgEl(m.role, m.content));
    });

    messagesEl.prepend(frag);

    // Restore scroll position so it doesn't jump
    messagesEl.scrollTop = prevScroll + (messagesEl.scrollHeight - prevHeight);
  }
}

function loadMore() {
  if (loadingMore || !hasMore || !ws) return;
  loadingMore = true;
  ws.send(JSON.stringify({ type: "get_messages", limit: PAGE_SIZE, offset: loadedOffset }));
}

function makeLoadMoreSentinel() {
  const div = document.createElement("div");
  div.className = "load-more-sentinel";
  div.textContent = "Loading...";
  div.style.cssText = "text-align:center;padding:8px;color:#888;font-size:12px";
  return div;
}

function addLoadMoreSentinel() {
  messagesEl.prepend(makeLoadMoreSentinel());
}

// Scroll listener for lazy loading
messagesEl.addEventListener("scroll", () => {
  if (messagesEl.scrollTop < 200 && hasMore && !loadingMore) {
    loadMore();
  }
});

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

function makeMsgEl(role, content) {
  const div = document.createElement("div");
  div.className = "msg " + role;

  // content is either a string (legacy) or an array of blocks
  if (typeof content === "string") {
    div.textContent = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const blockEl = document.createElement("div");
      blockEl.className = "block block-" + block.type;
      switch (block.type) {
        case "text":
          blockEl.textContent = block.text;
          break;
        case "thinking":
          blockEl.textContent = block.thinking;
          break;
        case "tool_use":
          blockEl.appendChild(makeToolCallEl(block));
          break;
        default:
          blockEl.textContent = JSON.stringify(block);
      }
      div.appendChild(blockEl);
    }
  }

  return div;
}

function makeToolCallEl(block) {
  const wrapper = document.createElement("details");
  wrapper.className = "tool-call";

  const summary = document.createElement("summary");
  const nameSpan = document.createElement("span");
  nameSpan.className = "tool-name";
  nameSpan.textContent = block.name || "tool";
  summary.appendChild(nameSpan);

  // Show a compact summary of the input
  const inputHint = document.createElement("span");
  inputHint.className = "tool-hint";
  inputHint.textContent = compactInput(block.input);
  summary.appendChild(inputHint);

  // Status indicator
  if (block.result != null) {
    const status = document.createElement("span");
    status.className = block.is_error ? "tool-status tool-status-error" : "tool-status tool-status-ok";
    status.textContent = block.is_error ? "error" : "done";
    summary.appendChild(status);
  }

  wrapper.appendChild(summary);

  // Expandable body: input + result
  const body = document.createElement("div");
  body.className = "tool-body";

  const inputPre = document.createElement("pre");
  inputPre.className = "tool-input";
  inputPre.textContent = formatInput(block.input);
  body.appendChild(inputPre);

  if (block.result != null) {
    const resultPre = document.createElement("pre");
    resultPre.className = block.is_error ? "tool-output tool-output-error" : "tool-output";
    resultPre.textContent = truncate(block.result, 3000);
    body.appendChild(resultPre);
  }

  wrapper.appendChild(body);
  return wrapper;
}

function compactInput(input) {
  if (!input) return "";
  if (typeof input === "string") return truncate(input, 60);
  // For common tool shapes, show the most useful field
  if (input.command) return truncate(String(input.command), 80);
  if (input.file_path) return truncate(String(input.file_path), 80);
  if (input.pattern) return truncate(String(input.pattern), 80);
  if (input.query) return truncate(String(input.query), 80);
  if (input.content) return truncate(String(input.content), 60);
  const s = JSON.stringify(input);
  return truncate(s, 80);
}

function addMsg(role, content) {
  messagesEl.appendChild(makeMsgEl(role, content));
}

function escapeHtml(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

function formatInput(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n... (" + s.length + " chars)";
}

function addSystemMsg(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  messagesEl.appendChild(div);
}

// --- Sidebar ---

function renderSidebar() {
  sidebarEl.replaceChildren();
  const header = document.createElement("div");
  header.style.cssText = "padding:8px;font-weight:600;font-size:13px;color:#888";
  header.textContent = "Checkpoints";
  sidebarEl.appendChild(header);

  historyData.forEach((h) => {
    const div = document.createElement("div");
    div.className =
      "cp" + (h.checkpointId === currentCheckpointId ? " active" : "");

    const stepDiv = document.createElement("div");
    stepDiv.className = "step";
    stepDiv.textContent = "Step " + h.step;

    const metaDiv = document.createElement("div");
    metaDiv.className = "meta";
    metaDiv.textContent = h.messageCount + " msgs \u00b7 " + String(h.checkpointId).slice(0, 8);

    div.appendChild(stepDiv);
    div.appendChild(metaDiv);
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

  const NS = "http://www.w3.org/2000/svg";
  const maxX = Math.max(...[...positions.values()].map((p) => p.x)) + 40;
  const maxY = Math.max(...[...positions.values()].map((p) => p.y)) + 40;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", maxX);
  svg.setAttribute("height", maxY);

  // Edges
  historyData.forEach((h) => {
    if (h.parentCheckpointId && positions.has(h.parentCheckpointId)) {
      const from = positions.get(h.parentCheckpointId);
      const to = positions.get(h.checkpointId);
      if (from && to) {
        const line = document.createElementNS(NS, "line");
        line.setAttribute("class", "edge");
        line.setAttribute("x1", from.x);
        line.setAttribute("y1", from.y);
        line.setAttribute("x2", to.x);
        line.setAttribute("y2", to.y);
        svg.appendChild(line);
      }
    }
  });

  // Nodes
  historyData.forEach((h) => {
    const pos = positions.get(h.checkpointId);
    if (!pos) return;
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "node" + (h.checkpointId === currentCheckpointId ? " active" : ""));
    g.addEventListener("click", () => forkTo(h.checkpointId));

    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("cx", pos.x);
    circle.setAttribute("cy", pos.y);
    circle.setAttribute("r", radius);
    g.appendChild(circle);

    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", pos.x);
    text.setAttribute("y", pos.y - radius - 4);
    text.setAttribute("text-anchor", "middle");
    text.textContent = h.step;
    g.appendChild(text);

    svg.appendChild(g);
  });

  treeEl.replaceChildren(svg);
}

// --- Thread picker ---

async function loadThreads() {
  try {
    const res = await fetch("/threads");
    const threads = await res.json();
    threadSelect.innerHTML = '<option value="">-- select thread --</option>';
    for (const t of threads) {
      const opt = document.createElement("option");
      opt.value = t.thread_id;
      const label = t.label && t.label !== t.thread_id ? t.label : t.thread_id.slice(0, 12);
      opt.textContent = label + " (" + t.message_count + " msgs)";
      threadSelect.appendChild(opt);
    }
  } catch {
    // threads endpoint not available, hide dropdown
  }
}

function newThread() {
  const id = crypto.randomUUID();
  threadInput.value = id;
  threadSelect.value = "";
  location.hash = id;
  connectThread();
}

threadSelect.addEventListener("change", () => {
  if (threadSelect.value) {
    threadInput.value = threadSelect.value;
    location.hash = threadSelect.value;
    connectThread();
  }
});

// Auto-connect — use hash as thread ID if present
if (location.hash.length > 1) {
  threadInput.value = decodeURIComponent(location.hash.slice(1));
}
loadThreads().then(() => {
  // Pre-select in dropdown if hash matches
  if (threadInput.value && threadSelect.querySelector('option[value="' + CSS.escape(threadInput.value) + '"]')) {
    threadSelect.value = threadInput.value;
  }
  if (threadInput.value && threadInput.value !== "default") {
    connectThread();
  }
});
msgInput.focus();
