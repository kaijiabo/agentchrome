import type { CallToolResult, ContentBlock, SessionInfo } from "@agentchrome/protocol";
import * as cdp from "./cdp";
import { modifierBits } from "./keys";
import * as page from "./page";
import * as rec from "./recording";
import { gate, getConnection, getSettings } from "./settings";
import { agentLabel, allSessions, createTab, currentTabId, ensureInGroup, getSession, groupTabs, nameGroup, resolveTab, sessionsForTab, setPrivate, updateSession, type SessionState } from "./sessions";

const text = (t: string): ContentBlock => ({ type: "text", text: t });
const ok = (...blocks: ContentBlock[]): CallToolResult => ({ content: blocks });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Args = Record<string, any>;
type Ctx = { session: SessionState; info: SessionInfo; signal: AbortSignal };

// ---------------- overlay ----------------

const lingerTimers = new Map<number, ReturnType<typeof setTimeout>>();

async function overlayWorking(tabId: number, s: SessionState) {
  if (!(await getSettings()).showOverlay) return;
  clearTimeout(lingerTimers.get(tabId));
  const since = rec.recordingSince(tabId);
  await page.tryContent(tabId, "overlay", {
    ...rec.presentationOf(tabId),
    state: s.paused ? "paused" : "working",
    label: s.paused ? `${agentLabel(s)} is paused` : `${agentLabel(s)} is working`,
    agent: s.agent,
    rec: since ? { since } : null,
  });
}

async function overlayIdle(tabId: number, s: SessionState) {
  const since = rec.recordingSince(tabId);
  await page.tryContent(tabId, "overlay", { ...rec.presentationOf(tabId), state: "idle", label: `${agentLabel(s)} is working`, agent: s.agent, rec: since ? { since } : null, linger: 2500 });
}

// ---------------- helpers ----------------

async function moveCursor(tabId: number, s: SessionState, x: number, y: number, press = false, extra: Record<string, unknown> = {}) {
  const pres = rec.presentationOf(tabId);
  // While recording, the clip's cursor choice wins over the user's on-screen setting.
  if (!pres.clean && !(await getSettings()).showCursor) return;
  await page.tryContent(tabId, "cursorTo", { x, y, label: agentLabel(s), agent: s.agent, press, skin: pres.skin, ...extra });
}

// ---------------- side effects of an action: new tabs, downloads, file pickers ----------------

const recentTabs: { tabId: number; opener?: number; ts: number }[] = [];
const recentDownloads: { name: string; url: string; ts: number }[] = [];

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id === undefined) return;
  recentTabs.push({ tabId: tab.id, opener: tab.openerTabId, ts: Date.now() });
  if (recentTabs.length > 50) recentTabs.shift();
  if (tab.openerTabId === undefined) return;
  // A tab opened from an agent's tab joins that agent's group.
  for (const s of await allSessions()) {
    if (s.groupId === undefined) continue;
    const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
    if (opener?.groupId === s.groupId) {
      await chrome.tabs.group({ groupId: s.groupId, tabIds: [tab.id] }).catch(() => {});
      break;
    }
  }
});
chrome.downloads?.onCreated.addListener((d) => {
  recentDownloads.push({ name: (d.filename || d.finalUrl || d.url).split(/[\\/]/).pop() || "file", url: d.finalUrl || d.url, ts: Date.now() });
  if (recentDownloads.length > 50) recentDownloads.shift();
});

async function sideEffects(tabId: number, since: number): Promise<string> {
  // New tabs and downloads are reported a little after the click; wait briefly for them.
  for (let i = 0; i < 6; i++) {
    await sleep(120);
    if (recentTabs.some((x) => x.opener === tabId && x.ts >= since) || recentDownloads.some((x) => x.ts >= since)) break;
    if (cdp.openedOf(tabId).some((x) => x.ts >= since) && recentTabs.some((x) => x.ts >= since)) break;
  }
  const notes: string[] = [];
  const openedUrls = cdp.openedOf(tabId).filter((x) => x.ts >= since).map((x) => x.url);
  const session = (await allSessions()).find((s) => s.currentTabId === tabId);
  for (const t of recentTabs.filter((x) => x.ts >= since && x.tabId !== tabId)) {
    const info = await chrome.tabs.get(t.tabId).catch(() => null);
    if (!info) continue;
    const url = info.pendingUrl ?? info.url ?? "";
    if (t.opener !== tabId && !openedUrls.some((u) => u === url || url.startsWith(u))) continue;
    // Opened without an opener (noopener links): put it in the agent's group here.
    if (session?.groupId !== undefined && info.groupId !== session.groupId) await chrome.tabs.group({ groupId: session.groupId, tabIds: [t.tabId] }).catch(() => {});
    notes.push(`It opened a new tab ${t.tabId} (${url || "loading"}) in your group. Use tabs_select to switch to it.`);
  }
  const names = new Set([...recentDownloads.filter((x) => x.ts >= since).map((d) => d.name), ...cdp.downloadsOf(tabId).filter((x) => x.ts >= since).map((d) => d.name)]);
  for (const n of names) notes.push(`A download started: ${n}.`);
  const ch = cdp.chooserOf(tabId);
  if (ch && ch.ts >= since) notes.push(`The page tried to open a file picker (${ch.mode === "selectMultiple" ? "multiple files" : "one file"}). It was held back; call file_upload without ref to fill it.`);
  return notes.length ? `\n${notes.join("\n")}` : "";
}


async function tabSummary(tabId: number) {
  const t = await chrome.tabs.get(tabId);
  return { tabId: t.id, title: t.title, url: t.url ?? t.pendingUrl, status: t.status };
}

async function waitForLoad(tabId: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(150);
  while (Date.now() < deadline) {
    if (cdp.dialogOf(tabId)) return true; // e.g. a beforeunload prompt is holding the navigation
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return true;
    await sleep(150);
  }
  return false;
}

const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

function pageNotes(tabId: number, url = ""): string {
  const notes: string[] = [];
  const doc = cdp.docOf(tabId);
  if (doc?.error) notes.push(`The page failed to load: ${doc.error}.`);
  else if (doc?.status && doc.status >= 400) notes.push(`The server answered HTTP ${doc.status}.`);
  if (RESTRICTED.test(url) && !/^about:blank/.test(url)) notes.push("Chrome does not let extensions read or click on this kind of page, so only navigation works here.");
  return notes.length ? `\n${notes.join("\n")}` : "";
}

function normalizeUrl(u: string) {
  if (/^(https?|file|chrome|about|data|blob|chrome-extension):/i.test(u)) return u;
  if (/^localhost(:\d+)?(\/|$)|^127\.0\.0\.1|^\[::1\]/.test(u)) return `http://${u}`;
  return `https://${u}`;
}

async function pointFor(tabId: number, a: Args): Promise<{ x: number; y: number; label: string }> {
  if (a.ref) {
    const r = await page.content<{ cx: number; cy: number; tag: string }>(tabId, "refRect", { ref: a.ref });
    return { x: r.cx, y: r.cy, label: `${a.ref} (${r.tag})` };
  }
  if (Array.isArray(a.coordinate) && a.coordinate.length === 2) {
    const [x, y] = page.toCss(tabId, a.coordinate[0], a.coordinate[1]);
    return { x, y, label: `(${a.coordinate[0]}, ${a.coordinate[1]})` };
  }
  throw new Error("Give coordinate [x, y] or ref.");
}

async function describeAt(tabId: number, x: number, y: number) {
  const el = await page.tryContent(tabId, "elementAt", { x, y });
  return el ? ` on ${el.role !== "generic" ? el.role : el.tag}${el.name ? ` "${el.name}"` : ""}` : "";
}

function dialogNote(tabId: number) {
  const d = cdp.dialogOf(tabId);
  return d ? `\nA ${d.type} dialog is open: ${JSON.stringify(d.message)}. Use handle_dialog to accept or dismiss it.` : "";
}

async function fileFrom(f: Args): Promise<{ name: string; mimeType?: string; base64: string }> {
  if (f.base64) return { name: f.name, mimeType: f.mimeType, base64: f.base64 };
  if (f.imageId) {
    const img = page.images.get(f.imageId);
    if (!img) throw new Error(`Unknown imageId ${f.imageId}`);
    return { name: f.name, mimeType: img.mimeType, base64: img.base64 };
  }
  if (f.url) {
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`Fetching ${f.url} failed: HTTP ${res.status}`);
    const blob = await res.blob();
    return { name: f.name, mimeType: f.mimeType ?? blob.type, base64: await page.blobToB64(blob) };
  }
  throw new Error(`File ${f.name} needs base64, url or imageId`);
}

async function uploadArtifact(blob: Blob, name: string): Promise<{ url?: string; path?: string }> {
  const c = await getConnection();
  if (!c.server || !c.deviceToken) throw new Error("Not paired");
  const res = await fetch(`${c.server}/api/artifacts?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${c.deviceToken}`, "content-type": blob.type },
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
  return res.json();
}

// ---------------- tools ----------------

const handlers: Record<string, (a: Args, c: Ctx) => Promise<CallToolResult>> = {
  async tabs_context(a, { session }) {
    await setPrivate(session, a.private);
    if (a.task) await nameGroup(session, a.task);
    if (a.all) {
      const tabs = await chrome.tabs.query({});
      const groups = await chrome.tabGroups.query({});
      const gname = new Map(groups.map((g) => [g.id, g.title]));
      return ok(
        text(
          JSON.stringify(
            tabs.map((t) => ({ tabId: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active, group: t.groupId >= 0 ? gname.get(t.groupId) ?? t.groupId : undefined, sessionTab: t.id === session.currentTabId })),
            null,
            1,
          ),
        ),
      );
    }
    let tabs = await groupTabs(session);
    if (tabs.length === 0 && a.createIfEmpty !== false) {
      await createTab(session);
      tabs = await groupTabs(session);
    }
    const group = session.groupId !== undefined && tabs.length ? await chrome.tabGroups.get(session.groupId).catch(() => null) : null;
    const conn = await getConnection();
    return ok(
      text(
        JSON.stringify(
          {
            browser: conn.name,
            private: Boolean(session.private),
            group: group ? { groupId: group.id, title: group.title, color: group.color } : null,
            currentTabId: session.currentTabId,
            tabs: tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url ?? t.pendingUrl, current: t.id === session.currentTabId })),
            whenDone: "Close your tabs with tab_groups action=close when your job is finished, unless the user wants to see the result.",
          },
          null,
          1,
        ),
      ),
    );
  },

  async tabs_create(a, { session, info }) {
    const url = a.url ? normalizeUrl(String(a.url)) : "about:blank";
    await setPrivate(session, a.private);
    if (a.task) await nameGroup(session, a.task);
    if (a.url) await gate(url, agentLabel(session));
    // Open blank first and attach the debugger so console/network capture covers the first load.
    const tab = await createTab(session, "about:blank", Boolean(a.active));
    if (a.url) {
      await cdp.attach(tab.id!).catch(() => {});
      await chrome.tabs.update(tab.id!, { url });
      await waitForLoad(tab.id!);
    }
    return ok(text(JSON.stringify({ created: await tabSummary(tab.id!), groupId: session.groupId }, null, 1)));
  },

  async tabs_close(a, { session }) {
    const tab = await chrome.tabs.get(a.tabId);
    if (!a.force && tab.groupId !== session.groupId) throw new Error("That tab is not in this session's group. Pass force=true to close it anyway.");
    await chrome.tabs.remove(a.tabId);
    if (session.currentTabId === a.tabId) session.currentTabId = undefined;
    await updateSession(session);
    return ok(text(`Closed tab ${a.tabId}`));
  },

  async tabs_select(a, { session }) {
    const tab = await chrome.tabs.get(a.tabId);
    if (a.adopt) await ensureInGroup(session, a.tabId);
    session.currentTabId = a.tabId;
    await updateSession(session);
    // Show the tab inside its window, but never raise the window over what the user is doing.
    if (a.focus) await chrome.tabs.update(a.tabId, { active: true });
    return ok(text(`Current tab is now ${a.tabId}: ${tab.title}`));
  },

  async tab_groups(a, { session }) {
    const action = a.action;
    if (action === "list") {
      const groups = await chrome.tabGroups.query({});
      const out = await Promise.all(
        groups.map(async (g) => ({
          groupId: g.id,
          title: g.title,
          color: g.color,
          collapsed: g.collapsed,
          windowId: g.windowId,
          session: g.id === session.groupId,
          tabs: (await chrome.tabs.query({ groupId: g.id })).map((t) => ({ tabId: t.id, title: t.title })),
        })),
      );
      return ok(text(JSON.stringify(out, null, 1)));
    }
    if (action === "update") {
      let gid = a.groupId ?? session.groupId;
      if (gid === undefined) {
        await resolveTab(session, undefined, true);
        const tabId = session.currentTabId!;
        gid = await ensureInGroup(session, tabId);
      }
      const patch: chrome.tabGroups.UpdateProperties = {};
      if (a.title !== undefined) patch.title = String(a.title);
      if (a.color) patch.color = a.color;
      if (a.collapsed !== undefined) patch.collapsed = Boolean(a.collapsed);
      const g = await chrome.tabGroups.update(gid, patch);
      if (g && gid === session.groupId) {
        if (a.title !== undefined) {
          session.agentLabel ??= session.title;
          session.title = String(a.title);
        }
        if (a.color) session.color = a.color;
        await updateSession(session);
      }
      return ok(text(`Group ${gid} is now "${g?.title}" (${g?.color})${g?.collapsed ? ", collapsed" : ""}`));
    }
    if (action === "create" || action === "move") {
      const tabIds: number[] = a.tabIds?.length ? a.tabIds : [await resolveTab(session, undefined, true)];
      const ids = tabIds as [number, ...number[]];
      const groupId: number = await chrome.tabs.group(action === "move" && a.groupId !== undefined ? { groupId: a.groupId, tabIds: ids } : { tabIds: ids });
      const patch: chrome.tabGroups.UpdateProperties = {};
      if (a.title !== undefined) patch.title = String(a.title);
      if (a.color) patch.color = a.color;
      if (Object.keys(patch).length) await chrome.tabGroups.update(groupId, patch);
      if (a.makeSessionGroup) {
        session.groupId = groupId;
        if (a.title) {
          session.agentLabel ??= session.title;
          session.title = String(a.title);
        }
        await updateSession(session);
      }
      return ok(text(`Tabs ${tabIds.join(", ")} are in group ${groupId}`));
    }
    if (action === "close") {
      const gid = a.groupId ?? session.groupId;
      if (gid === undefined) throw new Error("This session has no tab group to close.");
      if (gid !== session.groupId && !a.force) throw new Error("That group belongs to someone else. Pass force=true to close it anyway.");
      const tabs = await chrome.tabs.query({ groupId: gid });
      if (!tabs.length) throw new Error(`Group ${gid} has no tabs.`);
      await chrome.tabs.remove(tabs.map((t) => t.id!));
      if (gid === session.groupId) {
        session.groupId = undefined;
        session.currentTabId = undefined;
        await updateSession(session);
      }
      return ok(text(`Closed group ${gid} and its ${tabs.length} tab(s).`));
    }
    if (action === "ungroup") {
      const tabIds: number[] = a.tabIds?.length ? a.tabIds : session.groupId !== undefined ? (await groupTabs(session)).map((t) => t.id!) : [];
      if (!tabIds.length) throw new Error("No tabs to ungroup");
      await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
      return ok(text(`Ungrouped tabs ${tabIds.join(", ")}`));
    }
    throw new Error(`Unknown action ${action}`);
  },

  async navigate(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    await ensureInGroupIfOwned(session, tabId);
    const url = String(a.url);
    // Navigate through the debugger: browser-side navigations raise Chrome's native "Leave site?" prompt,
    // which the debugger cannot see or answer. An agent navigation is deliberate, so it skips that prompt.
    let navError = "";
    let leftUnsaved = false;
    // An agent navigation is deliberate: if the page asks "Leave site?", leave and say so.
    const go = async (p: Promise<any>) => {
      let res: any;
      const done = p.then((x) => (res = x));
      if (await page.untilDialog(tabId, done)) {
        const d = cdp.dialogOf(tabId);
        if (d?.type === "beforeunload") {
          await cdp.send(tabId, "Page.handleJavaScriptDialog", { accept: true });
          cdp.clearDialog(tabId);
          leftUnsaved = true;
          await done.catch(() => {});
        }
      }
      return res;
    };
    const history = async (delta: number) => {
      const h = await cdp.send(tabId, "Page.getNavigationHistory");
      const entry = h.entries[h.currentIndex + delta];
      if (!entry) throw new Error(delta < 0 ? "There is no previous page." : "There is no next page.");
      await go(cdp.send(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id }));
    };
    const blocked = (e: unknown) => /Cannot control this tab/i.test(String((e as Error)?.message));
    if (url === "back") await history(-1).catch((e) => (blocked(e) ? chrome.tabs.goBack(tabId) : Promise.reject(e)));
    else if (url === "forward") await history(1).catch((e) => (blocked(e) ? chrome.tabs.goForward(tabId) : Promise.reject(e)));
    else if (url === "reload") await go(cdp.send(tabId, "Page.reload", { ignoreCache: false })).catch((e) => (blocked(e) ? chrome.tabs.reload(tabId) : Promise.reject(e)));
    else {
      const target = normalizeUrl(url);
      if (/^file:/i.test(target) && !(await chrome.extension.isAllowedFileSchemeAccess())) {
        throw new Error("Opening local files needs permission: in chrome://extensions open Agent Chrome > Details and turn on \"Allow access to file URLs\".");
      }
      await gate(target, agentLabel(session));
      const current = (await chrome.tabs.get(tabId)).url ?? "";
      // The debugger can't attach to chrome:// and similar pages, so navigate those (and away from them) through the tabs API.
      if (RESTRICTED.test(target) || /^file:/i.test(target) || (RESTRICTED.test(current) && !/^about:blank/.test(current))) await chrome.tabs.update(tabId, { url: target });
      else {
        try {
          const nav = (await go(cdp.send(tabId, "Page.navigate", { url: target }))) ?? {};
          if (nav.errorText && nav.errorText !== "net::ERR_ABORTED") navError = nav.errorText;
        } catch (e) {
          // The debugger can't attach (another extension's frame); the tabs API still navigates.
          if (!/Cannot control this tab/i.test(String((e as Error).message))) throw e;
          await chrome.tabs.update(tabId, { url: target });
        }
      }
    }
    const loaded = await waitForLoad(tabId, Math.min(a.timeoutMs ?? 30_000, 55_000));
    await overlayWorking(tabId, session);
    const t = await tabSummary(tabId);
    return ok(text(`${loaded ? "Loaded" : "Still loading (timed out waiting)"}: ${t.title}\nURL: ${t.url}\ntabId: ${tabId}${leftUnsaved ? "\nThe previous page warned about unsaved changes; the agent left it." : ""}${navError && !cdp.docOf(tabId)?.error ? `\nThe page failed to load: ${navError}.` : ""}${pageNotes(tabId, t.url)}${dialogNote(tabId)}`));
  },

  async computer(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    const tab = await chrome.tabs.get(tabId);
    await gate(tab.url, agentLabel(session));
    const mods = a.modifiers ? modifierBits(String(a.modifiers).split("+")) : 0;
    switch (a.action) {
      case "screenshot": {
        const s = await page.screenshot(tabId);
        return ok(
          { type: "image", data: s.base64, mimeType: s.mimeType },
          text(`Screenshot of tab ${tabId} (${s.width}x${s.height}, imageId ${s.imageId}). Coordinates for clicks use this image's pixels.${dialogNote(tabId)}`),
        );
      }
      case "zoom": {
        if (!Array.isArray(a.region) || a.region.length !== 4) throw new Error("zoom needs region [x0, y0, x1, y1]");
        const data = await page.zoom(tabId, a.region);
        return ok({ type: "image", data, mimeType: "image/png" }, text(`Zoomed region ${JSON.stringify(a.region)} at full resolution.`));
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const p = await pointFor(tabId, a);
        const what = await describeAt(tabId, p.x, p.y);
        const button = a.action === "right_click" ? "right" : a.action === "middle_click" ? "middle" : "left";
        const count = a.action === "double_click" ? 2 : a.action === "triple_click" ? 3 : 1;
        await moveCursor(tabId, session, p.x, p.y, true);
        page.tryContent(tabId, "ripple", { x: p.x, y: p.y });
        rec.noteClick(tabId, p.x, p.y);
        const since = Date.now();
        try {
          await page.click(tabId, p.x, p.y, { button, count, modifiers: mods });
        } catch (e) {
          // Chrome refuses the debugger while another extension's frame is on the page (e.g. a password
          // manager's autofill menu). Fall back to an in-page click, which works for ordinary buttons and links.
          if (!/chrome-extension|Cannot control this tab|not attached/i.test(String((e as Error).message))) throw e;
          await page.content(tabId, "domClick", { x: p.x, y: p.y, count, button: button === "right" ? 2 : button === "middle" ? 1 : 0 });
        }
        // Give a dialog (alert/confirm) a moment to open so the result can mention it.
        for (let i = 0; i < 4 && !cdp.dialogOf(tabId); i++) await sleep(60);
        const effects = cdp.dialogOf(tabId) ? "" : await sideEffects(tabId, since);
        return ok(text(`${a.action.replace("_", " ")} at ${p.label}${what}${effects}${dialogNote(tabId)}`));
      }
      case "hover":
      case "mouse_move": {
        const p = await pointFor(tabId, a);
        await moveCursor(tabId, session, p.x, p.y);
        await page.mouseMove(tabId, p.x, p.y, mods);
        return ok(text(`Hovering at ${p.label}${await describeAt(tabId, p.x, p.y)}`));
      }
      case "left_click_drag": {
        if (!a.start_coordinate && !a.start_ref) throw new Error("left_click_drag needs start_coordinate (or start_ref) and coordinate (or ref)");
        const start = a.start_ref ? await pointFor(tabId, { ref: a.start_ref }) : null;
        const from: [number, number] = start ? [start.x, start.y] : page.toCss(tabId, a.start_coordinate[0], a.start_coordinate[1]);
        const to = await pointFor(tabId, a);
        await moveCursor(tabId, session, from[0], from[1], true);
        rec.noteClick(tabId, from[0], from[1]);
        const dragging = moveCursor(tabId, session, to.x, to.y, false, { grab: true, durationMs: 420 });
        const mode = await page.drag(tabId, from, [to.x, to.y]);
        await dragging;
        await moveCursor(tabId, session, to.x, to.y);
        return ok(text(`Dragged from ${start ? start.label : `(${a.start_coordinate})`} to ${to.label}${mode === "html5" ? " (native drag and drop)" : ""}${dialogNote(tabId)}`));
      }
      case "type": {
        if (typeof a.text !== "string") throw new Error("type needs text");
        if (a.ref) {
          const p = await pointFor(tabId, a);
          await moveCursor(tabId, session, p.x, p.y, true);
          await page.click(tabId, p.x, p.y);
        }
        await page.typeText(tabId, a.text);
        return ok(text(`Typed ${a.text.length} characters`));
      }
      case "key": {
        if (!a.text) throw new Error("key needs text, e.g. 'Enter' or 'cmd+a'");
        const repeat = Math.min(Math.max(1, a.repeat ?? 1), 100);
        for (let i = 0; i < repeat; i++) for (const combo of String(a.text).split(/\s+/).filter(Boolean)) await page.pressCombo(tabId, combo);
        return ok(text(`Pressed ${a.text}${repeat > 1 ? ` ×${repeat}` : ""}${dialogNote(tabId)}`));
      }
      case "scroll": {
        const vp = await page.viewport(tabId);
        const p = a.coordinate || a.ref ? await pointFor(tabId, a) : { x: vp.width / 2, y: vp.height / 2, label: "center" };
        if (a.coordinate || a.ref) await moveCursor(tabId, session, p.x, p.y);
        const amount = (a.scroll_amount ?? 3) * 100;
        const dir = a.scroll_direction ?? "down";
        const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
        const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
        await page.wheel(tabId, p.x, p.y, dx, dy);
        await sleep(250);
        const after = await page.viewport(tabId);
        return ok(text(`Scrolled ${dir} by ${amount}px at ${p.label}. Page scroll is now (${Math.round(after.scrollX)}, ${Math.round(after.scrollY)}).`));
      }
      case "scroll_to": {
        if (!a.ref) throw new Error("scroll_to needs ref");
        await page.content(tabId, "refRect", { ref: a.ref });
        return ok(text(`Scrolled ${a.ref} into view`));
      }
      case "wait": {
        const secs = Math.min(Math.max(0, a.duration ?? 1), 30);
        await sleep(secs * 1000);
        return ok(text(`Waited ${secs}s`));
      }
      default:
        throw new Error(`Unknown action ${a.action}`);
    }
  },

  async screenshot(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    const s = await page.screenshot(tabId, { format: a.format, fullPage: a.fullPage });
    const blocks: ContentBlock[] = [{ type: "image", data: s.base64, mimeType: s.mimeType }];
    let note = `Screenshot of tab ${tabId} (${s.width}x${s.height}${a.fullPage ? `, full page${s.inner ? " of the page's scrolling panel, stitched" : ""}` : ""}, imageId ${s.imageId}).`;
    if (s.truncated) note += ` The page is taller than ${s.cssHeight}px, so the image stops there.`;
    if (a.save) {
      const saved = await uploadArtifact(page.b64ToBytes(s.base64).slice(0, undefined, s.mimeType), `screenshot-${Date.now()}.${a.format === "png" ? "png" : "jpg"}`);
      note += ` Saved: ${saved.url}${saved.path ? `\nFile: ${saved.path}` : ""}`;
    }
    blocks.push(text(note));
    return ok(...blocks);
  },

  async read_page(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    await gate((await chrome.tabs.get(tabId)).url, agentLabel(session));
    const out = await page.content<string>(tabId, "readPage", a);
    return ok(text(out + dialogNote(tabId)));
  },

  async find(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    const found = await page.content<any[]>(tabId, "find", { query: a.query, limit: a.limit ?? 20 });
    if (!found.length) return ok(text(`Nothing matched "${a.query}". Try read_page with filter="interactive".`));
    const lines = found.map((f) => {
      const [x, y] = page.toShot(tabId, f.rect.x + f.rect.width / 2, f.rect.y + f.rect.height / 2);
      return `- ${f.role} ${JSON.stringify(f.name)} [${f.ref}] at (${x}, ${y})`;
    });
    return ok(text(`Matches for "${a.query}":\n${lines.join("\n")}`));
  },

  async form_input(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    const box = await page.content<{ cx: number; cy: number }>(tabId, "refRect", { ref: a.ref });
    await moveCursor(tabId, session, box.cx, box.cy, true);
    const r = await page.content<string>(tabId, "formInput", { ref: a.ref, value: a.value });
    return ok(text(`${a.ref}: ${r}`));
  },

  async get_page_text(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    await gate((await chrome.tabs.get(tabId)).url, agentLabel(session));
    return ok(text(await page.content<string>(tabId, "pageText", { max_chars: a.max_chars })));
  },

  async javascript_tool(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    await gate((await chrome.tabs.get(tabId)).url, agentLabel(session));
    let r: any;
    const evaluating = cdp.send(tabId, "Runtime.evaluate", {
      expression: String(a.text),
      replMode: true,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout: 50_000,
    }).then((x) => (r = x));
    if (await page.untilDialog(tabId, evaluating)) {
      return ok(text(`The script opened a dialog and is waiting for it.${dialogNote(tabId)}`));
    }
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      return { content: [text(`JavaScript error: ${d.exception?.description ?? d.text}`)], isError: true };
    }
    const v = r.result;
    let out: string;
    if (v.type === "undefined") out = "undefined";
    else if ("value" in v) out = typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 1);
    else out = v.description ?? v.unserializableValue ?? v.type;
    if (out && out.length > 50_000) out = `${out.slice(0, 50_000)}\n… truncated`;
    return ok(text(out ?? "null"));
  },

  async read_console_messages(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    await cdp.attach(tabId);
    const all = cdp.consoleOf(tabId);
    let list = all.slice();
    if (a.onlyErrors) list = list.filter((m) => m.level === "error");
    if (a.pattern) {
      const re = new RegExp(a.pattern, "i");
      list = list.filter((m) => re.test(m.text));
    }
    list = list.slice(-(a.limit ?? 100));
    if (a.clear) all.length = 0;
    if (!list.length) return ok(text("No console messages captured yet (capture starts when the agent first uses the tab)."));
    return ok(text(list.map((m) => `[${m.level}] ${m.text}${m.url ? `  (${m.url})` : ""}`).join("\n")));
  },

  async read_network_requests(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    await cdp.attach(tabId);
    const map = cdp.networkOf(tabId);
    let list = [...map.values()];
    if (a.urlPattern) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(a.urlPattern, "i");
      } catch {}
      list = list.filter((r) => (re ? re.test(r.url) : r.url.includes(a.urlPattern)));
    }
    list = list.slice(-(a.limit ?? 100));
    const out: string[] = [];
    for (const r of list) {
      let line = `${r.method} ${r.status ?? (r.failed ? "FAILED" : "pending")} ${r.type ?? ""} ${r.url}${r.durationMs !== undefined ? ` ${r.durationMs}ms` : ""}${r.failed ? ` (${r.failed})` : ""}`;
      if (a.includeBodies && (r.type === "XHR" || r.type === "Fetch") && r.status) {
        try {
          const b = await cdp.send(tabId, "Network.getResponseBody", { requestId: r.requestId });
          const body = b.base64Encoded ? "[binary]" : String(b.body);
          line += `\n    body: ${body.length > 10_000 ? `${body.slice(0, 10_000)}…` : body}`;
        } catch {}
      }
      out.push(line);
    }
    if (a.clear) map.clear();
    return ok(text(out.length ? out.join("\n") : "No requests captured yet (capture starts when the agent first uses the tab)."));
  },

  async resize_window(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    const tab = await chrome.tabs.get(tabId);
    const w = await chrome.windows.update(tab.windowId, { state: "normal", width: Math.round(a.width), height: Math.round(a.height) });
    return ok(text(`Window ${w.id} resized to ${w.width}x${w.height}`));
  },

  async file_upload(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    const paths: string[] = Array.isArray(a.paths) ? a.paths.map(String) : [];
    const data = await Promise.all((a.files ?? []).map(fileFrom));
    if (!paths.length && !data.length) throw new Error("Give files (base64, url or imageId) or paths (absolute paths on the browser's computer).");
    if (paths.length && data.length) throw new Error("Use either paths or files in one call, not both.");
    if (paths.some((p) => !/^(\/|[A-Za-z]:[\\/])/.test(p))) throw new Error("paths must be absolute file paths on the computer running Chrome.");
    let result: string;
    if (a.ref) {
      const box = await page.content<{ cx: number; cy: number }>(tabId, "refRect", { ref: a.ref });
      await moveCursor(tabId, session, box.cx, box.cy, true);
      const mark = await page.content<{ token: string; isInput: boolean }>(tabId, "markUpload", { ref: a.ref });
      result = await page.setFilesCdp(tabId, { token: mark.token }, { paths, data });
    } else {
      const ch = cdp.chooserOf(tabId);
      if (!ch) throw new Error("No ref given and no file picker is waiting. Pass the ref of the file input (or its upload button) from read_page.");
      if (ch.mode !== "selectMultiple" && paths.length + data.length > 1) throw new Error("The waiting file picker accepts one file.");
      result = await page.setFilesCdp(tabId, { backendNodeId: ch.backendNodeId }, { paths, data });
      cdp.clearChooser(tabId);
    }
    const names = paths.length ? paths.map((p) => p.split(/[\\/]/).pop()) : data.map((f) => f.name);
    return ok(text(`${result}: ${names.join(", ")}`));
  },

  async upload_image(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    const img = page.images.get(a.imageId);
    if (!img) throw new Error(`Unknown imageId ${a.imageId}. Take a screenshot first.`);
    const name = a.filename ?? (img.mimeType === "image/png" ? "image.png" : "image.jpg");
    const files = [{ name, mimeType: img.mimeType, base64: img.base64 }];
    if (a.ref) {
      const mark = await page.content<{ token: string }>(tabId, "markUpload", { ref: a.ref });
      return ok(text(await page.setFilesCdp(tabId, { token: mark.token }, { data: files })));
    }
    if (a.coordinate) {
      const [x, y] = page.toCss(tabId, a.coordinate[0], a.coordinate[1]);
      return ok(text(await page.content<string>(tabId, "setFiles", { x, y, files })));
    }
    throw new Error("upload_image needs ref or coordinate");
  },

  async record(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    if (a.action === "status") {
      const since = rec.recordingSince(tabId);
      return ok(text(since ? `Recording tab ${tabId} for ${Math.round((Date.now() - since) / 1000)}s` : `Tab ${tabId} is not recording`));
    }
    if (a.action === "start") {
      const cursor = a.cursor === "agent" || a.cursor === "hidden" ? a.cursor : "natural";
      const r = await rec.startRecording(tabId, { kind: "video", fps: a.fps, format: a.format, showClicks: a.showClicks, cursor });
      await overlayWorking(tabId, session);
      return ok(
        text(
          `Recording tab ${tabId} (${r.mimeType}, ${r.fps} fps, ${cursor} cursor${cursor === "agent" ? "" : "; the border, status pill and name tag are hidden from the clip"}). Do the steps, then call record with action=stop.`,
        ),
      );
    }
    if (a.action === "scroll") {
      // Scrolling video: smooth, steady scroll through the page. Records a whole clip unless a recording is already running.
      const speed = Math.max(100, Math.min(4000, Number(a.speed) || 700));
      const to = a.to === "top" ? "top" : "bottom";
      const own = !rec.recordingSince(tabId);
      if (own) {
        if (a.fromStart !== false) await page.scrollerSet(tabId, to === "bottom" ? 0 : 1e9).catch(() => {});
        const cursor = a.cursor === "agent" || a.cursor === "natural" ? a.cursor : "hidden";
        await rec.startRecording(tabId, { kind: "video", fps: a.fps ?? 30, format: a.format, cursor });
        await overlayWorking(tabId, session);
        await new Promise((r) => setTimeout(r, 700));
      }
      const s = await page.smoothScroll(tabId, { to, speed, maxMs: 150_000 });
      if (!own) return ok(text(`Scrolled smoothly from ${Math.round(s.from)} to ${Math.round(s.to)} in ${(s.ms / 1000).toFixed(1)}s while recording.`));
      await new Promise((r) => setTimeout(r, 900));
      a = { ...a, action: "stop" };
    }
    if (a.action === "stop") {
      const r = await rec.stopRecording(tabId, { filename: a.filename, download: a.download });
      await overlayIdle(tabId, session);
      return ok(
        text(
          [
            `Recorded ${(r.durationMs / 1000).toFixed(1)}s, ${r.frames} frames, ${(r.bytes / 1024 / 1024).toFixed(2)} MB (${r.mimeType}).`,
            r.url ? `URL: ${r.url}` : r.uploadError ? `Upload failed: ${r.uploadError}` : "",
            r.path ? `File: ${r.path}` : "",
            r.downloadId !== undefined ? "Also saved to the browser's Downloads folder." : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    }
    throw new Error(`Unknown action ${a.action}`);
  },

  async gif_creator(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    if (a.action === "start_recording") {
      await rec.startRecording(tabId, { kind: "gif", showClicks: a.showClicks === true, cursor: a.cursor === "agent" || a.cursor === "hidden" ? a.cursor : "natural" });
      await overlayWorking(tabId, session);
      return ok(text(`GIF recording started on tab ${tabId}. Call gif_creator with action=stop_recording, then export.`));
    }
    if (a.action === "stop_recording" || a.action === "export") {
      if (!rec.isRecording(tabId)) {
        if (a.action === "export" && lastGif.has(tabId)) {
          const g = lastGif.get(tabId)!;
          return ok(...g);
        }
        throw new Error("No GIF recording on this tab");
      }
      const r = await rec.stopRecording(tabId, { filename: a.filename, download: a.download, inline: true });
      await overlayIdle(tabId, session);
      const blocks: ContentBlock[] = [];
      if (r.base64) blocks.push({ type: "image", data: r.base64, mimeType: "image/gif" });
      blocks.push(text(`GIF: ${r.frames} frames, ${(r.bytes / 1024).toFixed(0)} KB. ${r.path ?? r.url ?? r.uploadError ?? ""}`));
      lastGif.set(tabId, blocks);
      return ok(...blocks);
    }
    if (a.action === "clear") {
      if (rec.isRecording(tabId)) await rec.stopRecording(tabId, {}).catch(() => {});
      lastGif.delete(tabId);
      return ok(text("Cleared"));
    }
    throw new Error(`Unknown action ${a.action}`);
  },

  async wait_for(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    const timeout = Math.min(a.timeoutMs ?? 10_000, 60_000);
    const deadline = Date.now() + timeout;
    if (a.urlIncludes) {
      while (Date.now() < deadline) {
        if ((await chrome.tabs.get(tabId)).url?.includes(a.urlIncludes)) break;
        await sleep(200);
      }
      if (!(await chrome.tabs.get(tabId)).url?.includes(a.urlIncludes)) return { content: [text(`Timed out: URL does not include ${a.urlIncludes}`)], isError: true };
    }
    if (a.text || a.textGone || a.selector) {
      let res: { ok: boolean } | undefined;
      while (Date.now() < deadline) {
        try {
          res = await page.content(tabId, "waitFor", { ...a, timeoutMs: Math.max(0, deadline - Date.now()) });
          if (res?.ok) break;
        } catch {
          await sleep(300); // page navigating; retry
        }
      }
      if (!res?.ok) return { content: [text(`Timed out after ${timeout}ms waiting for ${JSON.stringify({ text: a.text, textGone: a.textGone, selector: a.selector })}`)], isError: true };
    }
    return ok(text("Condition met"));
  },

  async handle_dialog(a, { session }) {
    const tabId = await resolveTab(session, a.tabId);
    const d = cdp.dialogOf(tabId);
    if (!d) throw new Error("No dialog is open on this tab.");
    await cdp.send(tabId, "Page.handleJavaScriptDialog", { accept: Boolean(a.accept), promptText: a.promptText });
    cdp.clearDialog(tabId);
    return ok(text(`${a.accept ? "Accepted" : "Dismissed"} ${d ? `${d.type} "${d.message}"` : "the dialog"}`));
  },

  async history_search(a) {
    const granted = await chrome.permissions.contains({ permissions: ["history"] });
    if (!granted) throw new Error("History access is off. The user can turn it on in the Agent Chrome extension popup.");
    const items = await chrome.history.search({
      text: String(a.query),
      maxResults: Math.min(a.maxResults ?? 25, 100),
      startTime: Date.now() - (a.daysBack ?? 30) * 86_400_000,
    });
    return ok(text(JSON.stringify(items.map((i) => ({ title: i.title, url: i.url, lastVisit: i.lastVisitTime ? new Date(i.lastVisitTime).toISOString() : undefined, visits: i.visitCount })), null, 1)));
  },
};

const lastGif = new Map<number, ContentBlock[]>();

async function ensureInGroupIfOwned(session: SessionState, tabId: number) {
  // Tabs the session created or adopted stay grouped; user tabs passed explicitly are left where they are.
  if (session.currentTabId === tabId) {
    const t = await chrome.tabs.get(tabId);
    if (session.groupId === undefined || t.groupId !== session.groupId) {
      const inAnother = t.groupId >= 0 && t.groupId !== session.groupId;
      if (!inAnother) await ensureInGroup(session, tabId);
    }
  }
}

const TAB_TOOLS = new Set(["navigate", "computer", "screenshot", "read_page", "find", "form_input", "get_page_text", "javascript_tool", "file_upload", "upload_image", "wait_for", "record", "gif_creator"]);

export async function runTool(name: string, args: Args, info: SessionInfo, signal: AbortSignal): Promise<CallToolResult> {
  const session = await getSession(info);
  if (session.paused) {
    const why =
      session.pausedReason === "debugger"
        ? "The user pressed Cancel on Chrome's \"started debugging this browser\" bar, which stops agent control."
        : "The user pressed Stop in the browser, so this session is paused.";
    return {
      content: [text(`${why} Ask the user what to do; they can press Resume in the Agent Chrome popup.`)],
      isError: true,
    };
  }
  const h = handlers[name];
  if (!h) return { content: [text(`Unknown tool ${name}`)], isError: true };
  if (typeof args.tabId === "number") args.tabId = await currentTabId(args.tabId);
  let tabId: number | undefined;
  if (TAB_TOOLS.has(name)) {
    try {
      tabId = await resolveTab(session, args.tabId);
      if (args.tabId === undefined) args.tabId = tabId;
    } catch {}
    if (tabId !== undefined && cdp.crashedOf(tabId) && name !== "navigate") {
      return { content: [text(`Tab ${tabId} crashed ("Aw, Snap!"). Call navigate with url "reload" to recover it.`)], isError: true };
    }
    if (tabId !== undefined && cdp.dialogOf(tabId)) {
      // The page is frozen until the dialog is handled; anything else would hang.
      return { content: [text(`Tab ${tabId} is blocked by a ${cdp.dialogOf(tabId)!.type} dialog: ${JSON.stringify(cdp.dialogOf(tabId)!.message)}. Call handle_dialog first.`)], isError: true };
    }
    if (tabId !== undefined) {
      await overlayWorking(tabId, session).catch(() => {});
      // The pill and border stay visible but let the agent's clicks, drags and scrolls reach the page.
      await page.tryContent(tabId, "passThrough", { on: true });
    }
  }
  try {
    const result = await Promise.race([
      h(args, { session, info, signal }),
      new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(new Error("Cancelled")), { once: true })),
    ]);
    return result;
  } catch (e) {
    return { content: [text(`Error: ${(e as Error)?.message ?? String(e)}`)], isError: true };
  } finally {
    if (tabId !== undefined) {
      page.tryContent(tabId, "passThrough", { on: false }).catch(() => {});
      overlayIdle(tabId, session).catch(() => {});
    }
  }
}

export async function setSessionPaused(s: SessionState, paused: boolean, reason?: string) {
  s.paused = paused;
  s.pausedReason = paused ? reason : undefined;
  await updateSession(s);
  for (const t of await groupTabs(s)) {
    await page.tryContent(t.id!, "overlay", paused ? { state: "paused", label: `${agentLabel(s)} is paused` } : { state: "hidden" });
    if (paused) await page.tryContent(t.id!, "cursorHide");
  }
}

export async function setPaused(tabId: number | undefined, paused: boolean, reason?: string) {
  const list = tabId !== undefined ? await sessionsForTab(tabId) : await allSessions();
  for (const s of list) await setSessionPaused(s, paused, reason);
  return list.length;
}
