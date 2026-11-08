// Service worker entry: keeps one authenticated WebSocket to the relay server and runs tool calls.

import { WS_SUBPROTOCOL, WS_TOKEN_PREFIX, type ServerToExtension } from "@agentchrome/protocol";
import { getConnection, getSettings, resolvePrompt, setConnection, setSettings } from "./settings";
import { allSessions, updateSession } from "./sessions";
import { runTool, setPaused, setSessionPaused } from "./tools";
import { onUserCancel } from "./cdp";

const VERSION = chrome.runtime.getManifest().version;

type Status = "unpaired" | "connecting" | "connected" | "disconnected" | "revoked";
let ws: WebSocket | null = null;
let status: Status = "unpaired";
let lastError = "";
let backoff = 1000;
let connectStartedAt = 0;
let lastServerTraffic = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let activeCalls = 0;
const inflight = new Map<string, AbortController>();
const callSession = new Map<string, string>();

function setStatus(s: Status, err = "") {
  status = s;
  lastError = err;
  const badge: Record<Status, [string, string]> = {
    unpaired: ["!", "#F5A524"],
    connecting: ["…", "#6366F1"],
    connected: ["", "#22C55E"],
    disconnected: ["off", "#71717A"],
    revoked: ["!", "#E5484D"],
  };
  const [text, color] = badge[s];
  chrome.action.setBadgeText({ text: activeCalls > 0 && s === "connected" ? "●" : text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: activeCalls > 0 ? "#8B5CF6" : color }).catch(() => {});
  chrome.runtime.sendMessage({ type: "acm:status-changed" }).catch(() => {});
}

async function profileName() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" as chrome.identity.AccountStatus });
    return info.email || undefined;
  } catch {
    return undefined;
  }
}

async function connect() {
  clearTimeout(reconnectTimer);
  const c = await getConnection();
  if (!c.server || !c.deviceToken) {
    setStatus("unpaired");
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setStatus("connecting");
  const url = `${c.server.replace(/^http/, "ws")}/ws`;
  let sock: WebSocket;
  try {
    sock = new WebSocket(url, [WS_SUBPROTOCOL, `${WS_TOKEN_PREFIX}${c.deviceToken}`]);
  } catch (e) {
    setStatus("disconnected", String(e));
    scheduleReconnect();
    return;
  }
  ws = sock;
  connectStartedAt = Date.now();
  sock.onopen = async () => {
    backoff = 1000;
    lastServerTraffic = Date.now();
    setStatus("connected");
    sock.send(JSON.stringify({ t: "hello", name: c.name ?? "Chrome", email: await profileName(), version: VERSION, userAgent: navigator.userAgent }));
    clearInterval(pingTimer);
    // Traffic every 20s keeps the MV3 service worker alive while connected.
    pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('{"t":"ping"}'), 20_000);
  };
  sock.onmessage = (ev) => {
    lastServerTraffic = Date.now();
    onMessage(sock, ev.data);
  };
  sock.onclose = async (ev) => {
    if (ws === sock) ws = null;
    clearInterval(pingTimer);
    for (const ac of inflight.values()) ac.abort();
    if (ev.code === 4001) {
      setStatus("revoked", "This browser was removed from the account. Pair it again.");
      const cur = await getConnection();
      await setConnection({ server: cur.server, name: cur.name });
      return;
    }
    if (ev.code === 4000) return; // replaced by a newer connection of this same profile
    setStatus("disconnected", ev.reason || `Connection closed (${ev.code})`);
    scheduleReconnect();
  };
  sock.onerror = () => {
    lastError = "Cannot reach the server";
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30_000);
}

async function onMessage(sock: WebSocket, raw: unknown) {
  if (typeof raw !== "string") return;
  let msg: ServerToExtension;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.t === "welcome") {
    const c = await getConnection();
    if (c.deviceId !== msg.deviceId) await setConnection({ ...c, deviceId: msg.deviceId });
    return;
  }
  if (msg.t === "cancel") {
    inflight.get(msg.id)?.abort();
    return;
  }
  if (msg.t !== "call") return;
  const ac = new AbortController();
  inflight.set(msg.id, ac);
  callSession.set(msg.id, msg.session?.id);
  activeCalls++;
  setStatus(status);
  try {
    const result = await runTool(msg.tool, msg.args ?? {}, msg.session, ac.signal);
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "result", id: msg.id, result }));
  } finally {
    inflight.delete(msg.id);
    callSession.delete(msg.id);
    activeCalls--;
    setStatus(status);
  }
}

// ---------------- browser sign-in (cloud) ----------------
// The popup opens <server>/connect?cid=… in a tab; we poll until the user has signed in there, then connect.

interface PendingConnect {
  cid: string;
  server: string;
  tabId?: number;
  until: number;
}

async function pendingConnect(): Promise<PendingConnect | undefined> {
  const { pendingConnect: p } = await chrome.storage.session.get("pendingConnect");
  return p as PendingConnect | undefined;
}

let polling = false;
async function pollConnect() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const p = await pendingConnect();
      if (!p) return;
      if (Date.now() > p.until) {
        await chrome.storage.session.remove("pendingConnect");
        return;
      }
      const res = await fetch(`${p.server}/api/connect/poll?cid=${encodeURIComponent(p.cid)}`, { cache: "no-store" }).catch(() => null);
      if (res?.status === 200) {
        const body = await res.json();
        await chrome.storage.session.remove("pendingConnect");
        const cur = await getConnection();
        ws?.close(1000);
        ws = null;
        await setConnection({ server: p.server, deviceToken: body.deviceToken, deviceId: body.deviceId, accountId: body.accountId, name: cur.name });
        await connect();
        if (p.tabId !== undefined) setTimeout(() => chrome.tabs.remove(p.tabId!).catch(() => {}), 1800);
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    polling = false;
  }
}

async function startConnect(server: string, name: string) {
  const base = server.replace(/\/+$/, "");
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const cid = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const cur = await getConnection();
  await setConnection({ ...cur, name });
  const tab = await chrome.tabs.create({ url: `${base}/connect?cid=${cid}&name=${encodeURIComponent(name)}`, active: true });
  await chrome.storage.session.set({ pendingConnect: { cid, server: base, tabId: tab.id, until: Date.now() + 15 * 60_000 } satisfies PendingConnect });
  pollConnect();
}

// ---------------- popup / page messages ----------------

async function pair(server: string, code: string, name: string) {
  const base = server.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name, email: await profileName(), version: VERSION }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Pairing failed (HTTP ${res.status})`);
  ws?.close(1000);
  ws = null;
  await setConnection({ server: base, deviceToken: body.deviceToken, deviceId: body.deviceId, accountId: body.accountId, name });
  await connect();
  return body.deviceId as string;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "offscreen") return false;
  (async () => {
    switch (msg?.type) {
      case "acm:status": {
        const c = await getConnection();
        const s = await getSettings();
        const sessions = await allSessions();
        const history = await chrome.permissions.contains({ permissions: ["history"] });
        return { status, lastError, server: c.server, name: c.name, deviceId: c.deviceId, settings: s, history, sessions, activeCalls, version: VERSION, connectPending: Boolean(await pendingConnect()) };
      }
      case "acm:connect-start":
        await startConnect(msg.server, msg.name || "Chrome");
        return { ok: true };
      case "acm:pair":
        return { deviceId: await pair(msg.server, msg.code, msg.name) };
      case "acm:unpair": {
        const c = await getConnection();
        ws?.close(1000);
        ws = null;
        await setConnection({ server: c.server, name: c.name });
        setStatus("unpaired");
        return { ok: true };
      }
      case "acm:rename": {
        const c = await getConnection();
        await setConnection({ ...c, name: msg.name });
        if (c.server && c.deviceToken) {
          await fetch(`${c.server}/api/devices/rename`, {
            method: "POST",
            headers: { authorization: `Bearer ${c.deviceToken}`, "content-type": "application/json" },
            body: JSON.stringify({ name: msg.name }),
          }).catch(() => {});
          ws?.send(JSON.stringify({ t: "hello", name: msg.name, email: await profileName(), version: VERSION }));
        }
        return { ok: true };
      }
      case "acm:pair-new": {
        const c = await getConnection();
        if (!c.server || !c.deviceToken) return { error: "Connect this profile first." };
        const res = await fetch(`${c.server}/api/pair/new`, { method: "POST", headers: { authorization: `Bearer ${c.deviceToken}` } }).catch(() => null);
        const body = res ? await res.json().catch(() => ({})) : {};
        if (!res?.ok) return { error: (body as any).error ?? "Couldn't create a pairing code. Check your connection and try again." };
        return { code: (body as any).code, expiresAt: (body as any).expiresAt };
      }
      case "acm:reconnect":
        ws?.close(1000);
        ws = null;
        backoff = 1000;
        await connect();
        return { ok: true };
      case "acm:settings":
        return setSettings(msg.patch);
      case "acm:stop":
        return { paused: await setPaused(sender.tab?.id, true) };
      case "acm:resume":
        return { resumed: await setPaused(sender.tab?.id, false) };
      case "acm:resume-all":
        return { resumed: await setPaused(undefined, false) };
      case "acm:stop-all":
        for (const ac of inflight.values()) ac.abort();
        return { paused: await setPaused(undefined, true) };
      case "acm:session-pause": {
        const s = (await allSessions()).find((x) => x.id === msg.id);
        if (!s) return { ok: false };
        if (msg.paused) for (const [id, ac] of inflight) if (callSession.get(id) === s.id) ac.abort();
        await setSessionPaused(s, Boolean(msg.paused));
        return { ok: true };
      }
      case "acm:focus-session": {
        const s = (await allSessions()).find((x) => x.id === msg.id);
        const tabId = s?.currentTabId;
        const tab = tabId !== undefined ? await chrome.tabs.get(tabId).catch(() => null) : null;
        if (!tab) return { ok: false };
        await chrome.tabs.update(tab.id!, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        if (s?.groupId !== undefined) await chrome.tabGroups.update(s.groupId, { collapsed: false }).catch(() => {});
        return { ok: true };
      }
      case "acm:forget-session": {
        const list = await allSessions();
        const s = list.find((x) => x.id === msg.id);
        if (s) {
          s.paused = false;
          s.groupId = undefined;
          s.currentTabId = undefined;
          await updateSession(s);
        }
        return { ok: true };
      }
      case "acm:prompt-answer":
        resolvePrompt(msg.id, msg.answer);
        return { ok: true };
    }
    return undefined;
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});

// The debugging bar's Cancel button detaches every tab: treat it like Stop all.
onUserCancel(() => {
  for (const ac of inflight.values()) ac.abort();
  setPaused(undefined, true, "debugger");
});

// ---------------- lifecycle ----------------

chrome.alarms.create("acm-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "acm-keepalive") {
    // Watchdog: a socket can hang in CONNECTING, or stay "open" after the network dropped without a close event.
    const stuck =
      ws &&
      ((ws.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt > 20_000) ||
        (ws.readyState === WebSocket.OPEN && lastServerTraffic && Date.now() - lastServerTraffic > 90_000) ||
        ws.readyState === WebSocket.CLOSING);
    if (stuck) {
      const old = ws!;
      ws = null;
      try {
        old.close();
      } catch {}
    }
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      backoff = 1000;
      connect();
    }
  }
  if (a.name === "acm-keepalive") pollConnect(); // resume after the service worker was suspended
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  connect();
});
connect();
// Reconnect as soon as the network comes back.
self.addEventListener("online", () => {
  backoff = 1000;
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
});

// Test hook: lets automated end-to-end tests pair without the popup.
(globalThis as any).__acmPair = pair;
(globalThis as any).__acmStatus = () => ({ status, lastError });
