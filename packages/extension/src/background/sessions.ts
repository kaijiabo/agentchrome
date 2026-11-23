// Each MCP session owns one Chrome tab group per browser profile. State lives in storage.session
// so it survives service-worker restarts but not a browser restart.

import { agentFor, type SessionInfo } from "@agentchrome/protocol";

export interface SessionState {
  id: string;
  client: string;
  /** Icon key of the agent (claude, codex, gemini, …) or "" when unknown. */
  agent: string;
  /** Group title: the agent's short task name once it sets one, else the agent name. */
  title: string;
  /** Agent name shown on the page overlay and approval prompts, e.g. "Claude Code 2". */
  agentLabel?: string;
  color: `${chrome.tabGroups.Color}`;
  groupId?: number;
  windowId?: number;
  currentTabId?: number;
  /** Work in a private (incognito) window: no cookies or logins from the profile. */
  private?: boolean;
  paused?: boolean;
  /** "stop" (Stop button) or "debugger" (Cancel on Chrome's debugging bar). */
  pausedReason?: string;
  lastActive: number;
}

const COLORS: `${chrome.tabGroups.Color}`[] = ["blue", "cyan", "purple", "green", "orange", "pink", "yellow", "red"];

export function prettyClient(client: string): string {
  return agentFor(client).name;
}

let cache: Record<string, SessionState> | null = null;

// Sessions live in storage.local so they survive extension updates, reloads and Chrome restarts.
// Entries are removed when their tab group closes, when idle for a day, or when their group is gone at startup.
async function load(): Promise<Record<string, SessionState>> {
  if (!cache) {
    cache = ((await chrome.storage.local.get("sessions")).sessions as Record<string, SessionState>) ?? {};
    await reconcile(cache);
  }
  return cache;
}

async function save() {
  if (cache) await chrome.storage.local.set({ sessions: cache });
}

/** Drop stale entries and forget groups/tabs that no longer exist. */
async function reconcile(all: Record<string, SessionState>) {
  for (const [id, s] of Object.entries(all)) {
    if (Date.now() - s.lastActive > 86_400_000) {
      delete all[id];
      continue;
    }
    if (s.groupId !== undefined && !(await groupAlive(s.groupId))) s.groupId = undefined;
    if (s.currentTabId !== undefined && !(await chrome.tabs.get(s.currentTabId).catch(() => null))) s.currentTabId = undefined;
  }
  await chrome.storage.local.set({ sessions: all });
}

chrome.tabGroups.onRemoved.addListener(async (group) => {
  const all = await load();
  let changed = false;
  for (const s of Object.values(all)) {
    if (s.groupId === group.id) {
      s.groupId = undefined;
      s.currentTabId = undefined;
      changed = true;
    }
  }
  if (changed) await save();
});

export async function getSession(info: SessionInfo): Promise<SessionState> {
  const all = await load();
  let s = all[info.id];
  if (!s) {
    const pretty = prettyClient(info.client);
    const sameClient = Object.values(all).filter((x) => x.client === info.client).length;
    s = {
      id: info.id,
      client: info.client,
      agent: agentFor(info.client).key,
      title: sameClient ? `${pretty} ${sameClient + 1}` : pretty,
      agentLabel: sameClient ? `${pretty} ${sameClient + 1}` : pretty,
      color: COLORS[Object.keys(all).length % COLORS.length]!,
      lastActive: Date.now(),
    };
    all[info.id] = s;
    // After an update that lost state, reuse an unclaimed group with this agent's name instead of opening a duplicate.
    const claimed = new Set(Object.values(all).map((x) => x.groupId).filter((g) => g !== undefined));
    const orphan = (await chrome.tabGroups.query({ title: s.title })).find((g) => !claimed.has(g.id));
    if (orphan) {
      s.groupId = orphan.id;
      s.windowId = orphan.windowId;
      s.currentTabId = (await chrome.tabs.query({ groupId: orphan.id }))[0]?.id;
    }
    // Forget sessions idle for more than a day.
    for (const [k, v] of Object.entries(all)) if (Date.now() - v.lastActive > 86_400_000) delete all[k];
  }
  s.lastActive = Date.now();
  await save();
  return s;
}

export function agentLabel(s: SessionState): string {
  return s.agentLabel ?? s.title;
}

/** Name the session's tab group after the agent's task ("Fix checkout bug"). */
export async function nameGroup(s: SessionState, task: unknown): Promise<void> {
  const name = String(task ?? "").replace(/\s+/g, " ").trim().slice(0, 32);
  if (!name || name === s.title) return;
  s.agentLabel ??= s.title;
  s.title = name;
  if (await groupAlive(s.groupId)) await chrome.tabGroups.update(s.groupId!, { title: name }).catch(() => {});
  await updateSession(s);
}

export async function updateSession(s: SessionState) {
  const all = await load();
  all[s.id] = s;
  await save();
}

export async function allSessions(): Promise<SessionState[]> {
  return Object.values(await load());
}

export async function sessionsForTab(tabId: number): Promise<SessionState[]> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return (await allSessions()).filter((s) => s.currentTabId === tabId || (tab && s.groupId !== undefined && tab.groupId === s.groupId));
}

async function groupAlive(groupId?: number) {
  if (groupId === undefined || groupId < 0) return false;
  return chrome.tabGroups.get(groupId).then(() => true, () => false);
}

// Agents work in one shared background window, so they never swap the tab the user is looking at
// and never pull Chrome in front of other apps. It is a normal window of this profile, so it has the same logins.
// Sessions that ask for privacy get a second shared window that is incognito.
const creating = new Map<boolean, Promise<chrome.windows.Window>>();
const windowKey = (priv: boolean) => (priv ? "privateWindowId" : "agentWindowId");

export async function isAgentWindow(windowId: number): Promise<boolean> {
  const st = await chrome.storage.local.get(["agentWindowId", "privateWindowId"]);
  return windowId === st.agentWindowId || windowId === st.privateWindowId;
}

async function agentWindow(priv: boolean): Promise<{ id: number; blankTabId?: number }> {
  const key = windowKey(priv);
  const stored = (await chrome.storage.local.get(key))[key] as number | undefined;
  if (stored !== undefined) {
    const w = await chrome.windows.get(stored).catch(() => null);
    if (w && w.type === "normal" && w.incognito === priv) return { id: w.id! };
  }
  if (priv && !(await chrome.extension.isAllowedIncognitoAccess())) {
    throw new Error(
      `Private windows are turned off for Agent Chrome. Ask the user to open chrome://extensions/?id=${chrome.runtime.id} and turn on "Allow in Incognito", then try again.`,
    );
  }
  let p = creating.get(priv);
  if (!p) {
    p = chrome.windows
      .create({ focused: false, state: "normal", incognito: priv, url: "about:blank" })
      .then(async (w) => {
        await chrome.storage.local.set({ [key]: w!.id });
        return w!;
      })
      .finally(() => creating.delete(priv));
    creating.set(priv, p);
  }
  const w = await p;
  return { id: w.id!, blankTabId: w.tabs?.[0]?.id };
}

async function targetWindow(s: SessionState): Promise<{ id: number; blankTabId?: number }> {
  if (s.windowId !== undefined) {
    const w = await chrome.windows.get(s.windowId).catch(() => null);
    if (w && w.type === "normal" && w.incognito === Boolean(s.private)) return { id: w.id! };
  }
  return agentWindow(Boolean(s.private));
}

/** Switch a session between normal and private browsing. Switching starts a fresh tab group in the other window. */
export async function setPrivate(s: SessionState, want: unknown): Promise<void> {
  if (want === undefined || Boolean(want) === Boolean(s.private)) return;
  s.private = Boolean(want);
  s.groupId = undefined;
  s.windowId = undefined;
  s.currentTabId = undefined;
  await updateSession(s);
}

/** Put a tab into the session's group, creating and naming the group when needed. */
export async function ensureInGroup(s: SessionState, tabId: number): Promise<number> {
  const tab = await chrome.tabs.get(tabId);
  if (await groupAlive(s.groupId)) {
    if (tab.groupId !== s.groupId) {
      const g = await chrome.tabGroups.get(s.groupId!);
      if (g.windowId !== tab.windowId) await chrome.tabs.move(tabId, { windowId: g.windowId, index: -1 });
      await chrome.tabs.group({ groupId: s.groupId!, tabIds: [tabId] });
    }
  } else {
    s.groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(s.groupId, { title: s.title, color: s.color, collapsed: false });
  }
  s.windowId = tab.windowId;
  await updateSession(s);
  return s.groupId!;
}

export async function createTab(s: SessionState, url = "about:blank", active = false): Promise<chrome.tabs.Tab> {
  let { id: windowId, blankTabId } = await targetWindow(s);
  if (await groupAlive(s.groupId)) {
    windowId = (await chrome.tabGroups.get(s.groupId!)).windowId;
    blankTabId = undefined;
  }
  // A new agent window opens with one blank tab: use it rather than leaving it behind.
  const tab = blankTabId !== undefined
    ? await chrome.tabs.update(blankTabId, { url, active: true }).then((t) => t!)
    : await chrome.tabs.create({ url, active, windowId });
  await ensureInGroup(s, tab.id!);
  s.currentTabId = tab.id!;
  await updateSession(s);
  return tab;
}

export async function groupTabs(s: SessionState): Promise<chrome.tabs.Tab[]> {
  if (!(await groupAlive(s.groupId))) return [];
  return chrome.tabs.query({ groupId: s.groupId });
}

async function addAlias(from: number, to: number) {
  const { tabAliases = {} } = (await chrome.storage.local.get("tabAliases")) as { tabAliases?: Record<string, number> };
  for (const k of Object.keys(tabAliases)) if (tabAliases[k] === from) tabAliases[k] = to;
  tabAliases[from] = to;
  const keys = Object.keys(tabAliases);
  for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete tabAliases[k];
  await chrome.storage.local.set({ tabAliases });
}

/** The tab's current id, following ids Chrome replaced when it unloaded the tab. */
export async function currentTabId(id: number): Promise<number> {
  if (await chrome.tabs.get(id).then(() => true, () => false)) return id;
  const { tabAliases = {} } = (await chrome.storage.local.get("tabAliases")) as { tabAliases?: Record<string, number> };
  return tabAliases[id] ?? id;
}

/** A tab unloaded by the idle sweep reloads before the agent uses it again. */
async function wake(t: chrome.tabs.Tab): Promise<number> {
  if (t.discarded) {
    await chrome.tabs.reload(t.id!);
    for (let i = 0; i < 100; i++) {
      const now = await chrome.tabs.get(t.id!).catch(() => null);
      if (!now || now.status === "complete") break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return t.id!;
}

/** Resolve which tab a call targets. */
export async function resolveTab(s: SessionState, tabId: unknown, createIfEmpty = true): Promise<number> {
  if (typeof tabId === "number") {
    const t = await chrome.tabs.get(await currentTabId(tabId)).catch(() => {
      throw new Error(`Tab ${tabId} does not exist. Call tabs_context for valid tab IDs.`);
    });
    return wake(t);
  }
  if (s.currentTabId !== undefined) {
    const t = await chrome.tabs.get(s.currentTabId).catch(() => null);
    if (t) return wake(t);
  }
  const inGroup = await groupTabs(s);
  if (inGroup[0]) {
    s.currentTabId = inGroup[0].id!;
    await updateSession(s);
    return s.currentTabId;
  }
  if (!createIfEmpty) throw new Error("This session has no tabs yet. Call tabs_create or navigate first.");
  return (await createTab(s)).id!;
}

// ---------------- cleanup ----------------
// Agents often finish without closing their tabs. Idle groups are put to sleep, then closed, so stale pages
// don't pile up and eat memory. A group the user is looking at, or a paused one (the user took over), is left alone.
export const IDLE = {
  /** Unload idle agent tabs from memory (they reload when used again). */
  discardAfterMs: 10 * 60_000,
  /** Close idle agent tab groups. */
  closeAfterMs: 60 * 60_000,
};

async function userIsViewing(groupId: number): Promise<boolean> {
  const w = await chrome.windows.getLastFocused({ populate: true }).catch(() => null);
  return Boolean(w?.focused && w.tabs?.some((t) => t.active && t.groupId === groupId));
}

async function closeGroup(s: SessionState) {
  const tabs = await chrome.tabs.query({ groupId: s.groupId! });
  if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id!)).catch(() => {});
  s.groupId = undefined;
  s.currentTabId = undefined;
  await updateSession(s);
}

/** Returns what it did, for tests and logs. */
export async function sweepIdle(now = Date.now()): Promise<{ discarded: number; closed: string[] }> {
  const out = { discarded: 0, closed: [] as string[] };
  const live: SessionState[] = [];
  for (const s of await allSessions()) if (await groupAlive(s.groupId)) live.push(s);
  for (const s of live) {
    if (await userIsViewing(s.groupId!)) continue;
    const idle = now - s.lastActive;
    if (!s.paused && idle > IDLE.closeAfterMs) {
      out.closed.push(s.title);
      await closeGroup(s);
      continue;
    }
    if (idle > IDLE.discardAfterMs) {
      for (const t of await chrome.tabs.query({ groupId: s.groupId! })) {
        if (t.active || t.discarded || t.audible) continue;
        const d = await chrome.tabs.discard(t.id!).catch(() => undefined);
        if (!d) continue;
        out.discarded++;
        // Chrome can give an unloaded tab a new id: keep the agent's old id working.
        if (d.id !== t.id) {
          await addAlias(t.id!, d.id!);
          if (s.currentTabId === t.id) {
            s.currentTabId = d.id;
            await updateSession(s);
          }
        }
      }
    }
  }
  return out;
}
