// End-to-end: real Chromium + extension + relay server + official MCP SDK client. Every tool is exercised.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { api, launchBrowser, mcpClient, pageFor, signup, startFixture, SERVER } from "./harness.mjs";

let fixture, account, browser, mcp, tabId;

before(async () => {
  fixture = await startFixture();
  account = await signup();
  browser = await launchBrowser(account.apiKey, "E2E Work");
  mcp = await mcpClient(account.apiKey, "claude-code");
});

after(async () => {
  await mcp?.close().catch(() => {});
  await browser?.close();
  fixture?.close();
});

test("tools/list exposes the full catalog", async () => {
  const { tools } = await mcp.client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["list_browsers", "select_browser", "tabs_context", "tabs_create", "tabs_close", "tabs_select", "tab_groups", "navigate", "computer", "screenshot", "read_page", "find", "form_input", "get_page_text", "javascript_tool", "read_console_messages", "read_network_requests", "resize_window", "file_upload", "upload_image", "record", "gif_creator", "wait_for", "handle_dialog", "history_search"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

test("list_browsers shows the paired profile online", async () => {
  const r = await mcp.call("list_browsers");
  assert.match(r.text, /E2E Work/);
  assert.match(r.text, /"online": true/);
});

test("tabs_context creates a session tab group named after the agent", async () => {
  const r = await mcp.call("tabs_context");
  const ctx = JSON.parse(r.text);
  assert.equal(ctx.group.title, "Claude Code");
  assert.equal(ctx.tabs.length, 1);
  tabId = ctx.tabs[0].tabId;
  assert.equal(ctx.currentTabId, tabId);
});

test("navigate loads the page and shows the pulsing border overlay", async () => {
  const r = await mcp.call("navigate", { url: fixture.url });
  assert.match(r.text, /Loaded: ACM Test App/);
  const page = pageFor(browser.context, fixture.url);
  assert.ok(page, "tab exists");
  const hasOverlay = await page.evaluate(() => Boolean(document.getElementById("__acm_overlay_host")));
  assert.ok(hasOverlay, "overlay host injected");
});

test("tabs_context task names the session group and keeps the agent label", async () => {
  const ctx = JSON.parse((await mcp.call("tabs_context", { task: "  Check   pricing page " })).text);
  assert.equal(ctx.group.title, "Check pricing page");
  const list = JSON.parse((await mcp.call("tab_groups", { action: "list" })).text);
  assert.equal(list.find((g) => g.session).title, "Check pricing page");
});

test("tab_groups renames and recolors the session group", async () => {
  const r = await mcp.call("tab_groups", { action: "update", title: "Checkout QA", color: "green" });
  assert.match(r.text, /"Checkout QA" \(green\)/);
  const list = JSON.parse((await mcp.call("tab_groups", { action: "list" })).text);
  const mine = list.find((g) => g.session);
  assert.equal(mine.title, "Checkout QA");
  assert.equal(mine.color, "green");
  assert.ok(mine.tabs.some((t) => t.tabId === tabId));
});

test("get_page_text returns the article text", async () => {
  const r = await mcp.call("get_page_text");
  assert.match(r.text, /quick brown fox/);
  assert.match(r.text, /Title: ACM Test App/);
});

test("read_page returns an accessibility tree with refs", async () => {
  const r = await mcp.call("read_page", { filter: "interactive" });
  assert.match(r.text, /textbox "Email address" \[ref_\d+\]/);
  assert.match(r.text, /button "Sign up now" \[ref_\d+\]/);
  assert.match(r.text, /combobox "Plan" \[ref_\d+\]/);
  assert.match(r.text, /checkbox "I agree to the terms" \[ref_\d+\] unchecked/);
  assert.match(r.text, /link "About us" \[ref_\d+\]/);
  const all = await mcp.call("read_page", {});
  assert.match(all.text, /heading "ACM Test App" \[ref_\d+\] level=1/);
});

const refOf = (text, re) => text.match(re)?.[1];

test("find + form_input + click by ref submits the form", async () => {
  const tree = (await mcp.call("read_page", { filter: "interactive" })).text;
  const email = refOf(tree, /textbox "Email address" \[(ref_\d+)\]/);
  const plan = refOf(tree, /combobox "Plan" \[(ref_\d+)\]/);
  const agree = refOf(tree, /checkbox "I agree to the terms" \[(ref_\d+)\]/);
  const f = await mcp.call("find", { query: "sign up button" });
  const submit = refOf(f.text, /button "Sign up now" \[(ref_\d+)\]/);
  assert.ok(submit, `find result: ${f.text}`);
  assert.match((await mcp.call("form_input", { ref: email, value: "kai@example.com" })).text, /Set value/);
  assert.match((await mcp.call("form_input", { ref: plan, value: "Pro plan" })).text, /Selected "Pro plan"/);
  assert.match((await mcp.call("form_input", { ref: agree, value: true })).text, /checked/);
  await mcp.call("computer", { action: "left_click", ref: submit });
  const page = pageFor(browser.context, fixture.url);
  await page.waitForFunction(() => document.getElementById("out").textContent.startsWith("submitted"));
  assert.equal(await page.textContent("#out"), "submitted:kai@example.com:pro:agreed");
});

test("screenshot returns an image and coordinate clicks land on the element", async () => {
  const shot = await mcp.call("computer", { action: "screenshot" });
  assert.equal(shot.images.length, 1);
  assert.equal(shot.images[0].mimeType, "image/jpeg");
  assert.ok(shot.images[0].data.length > 5000);
  const [, w, h] = shot.text.match(/\((\d+)x(\d+)/);
  assert.ok(+w > 300 && +h > 200, shot.text);
  const f = await mcp.call("find", { query: "Click me" });
  const [, x, y] = f.text.match(/button "Click me" \[ref_\d+\] at \((\d+), (\d+)\)/);
  const r = await mcp.call("computer", { action: "left_click", coordinate: [+x, +y] });
  assert.match(r.text, /on button "Click me"/);
  const page = pageFor(browser.context, fixture.url);
  assert.equal(await page.textContent("#counter"), "Clicked 1");
});

test("double_click, hover, type and key work", async () => {
  const f = await mcp.call("find", { query: "Double click me" });
  const ref = refOf(f.text, /button "Double click me" \[(ref_\d+)\]/);
  await mcp.call("computer", { action: "double_click", ref });
  const page = pageFor(browser.context, fixture.url);
  assert.equal(await page.textContent("#dbl"), "Double clicked");
  const keyRef = refOf((await mcp.call("find", { query: "Key test" })).text, /textbox "Key test" \[(ref_\d+)\]/);
  await mcp.call("computer", { action: "left_click", ref: keyRef });
  await mcp.call("computer", { action: "type", text: "hello world" });
  assert.equal(await page.inputValue("#keys"), "hello world");
  await mcp.call("computer", { action: "key", text: "cmd+a" });
  await mcp.call("computer", { action: "key", text: "Backspace" });
  assert.equal(await page.inputValue("#keys"), "");
  await mcp.call("computer", { action: "type", text: "abc" });
  await mcp.call("computer", { action: "key", text: "Enter" });
  assert.equal(await page.getAttribute("#keys", "data-enter"), "yes");
  const hover = await mcp.call("computer", { action: "hover", ref });
  assert.match(hover.text, /Hovering/);
});

test("scroll, scroll_to and zoom", async () => {
  const s = await mcp.call("computer", { action: "scroll", scroll_direction: "down", scroll_amount: 5 });
  assert.match(s.text, /Page scroll is now \(0, [1-9]\d*\)/);
  const bottom = refOf((await mcp.call("read_page", {})).text, /contentinfo "?[^\[]*\[(ref_\d+)\]/);
  assert.ok(bottom);
  await mcp.call("computer", { action: "scroll_to", ref: bottom });
  const page = pageFor(browser.context, fixture.url);
  assert.ok((await page.evaluate(() => scrollY)) > 1000);
  await mcp.call("javascript_tool", { text: "scrollTo(0,0)" });
  await mcp.call("computer", { action: "screenshot" });
  const z = await mcp.call("computer", { action: "zoom", region: [0, 0, 300, 120] });
  assert.equal(z.images[0].mimeType, "image/png");
});

test("javascript_tool returns the last expression, supports await, reports errors", async () => {
  assert.equal((await mcp.call("javascript_tool", { text: "document.title" })).text, "ACM Test App");
  const r = await mcp.call("javascript_tool", { text: "const r = await fetch('/api/data').then(r => r.json()); r.n * 6" });
  assert.equal(r.text, "42");
  const obj = await mcp.call("javascript_tool", { text: "({a: 1, b: [1,2]})" });
  assert.deepEqual(JSON.parse(obj.text), { a: 1, b: [1, 2] });
  const e = await mcp.call("javascript_tool", { text: "throw new Error('boom')" });
  assert.equal(e.isError, true);
  assert.match(e.text, /boom/);
});

test("read_console_messages and read_network_requests", async () => {
  await mcp.call("navigate", { url: "reload" });
  await new Promise((r) => setTimeout(r, 400));
  const c = await mcp.call("read_console_messages", {});
  assert.match(c.text, /\[log\] app booted 42/);
  assert.match(c.text, /\[warn\] a warning/);
  assert.match(c.text, /\[error\] delayed error/);
  const errs = await mcp.call("read_console_messages", { onlyErrors: true });
  assert.doesNotMatch(errs.text, /app booted/);
  const n = await mcp.call("read_network_requests", { urlPattern: "/api/data", includeBodies: true });
  assert.match(n.text, /GET 200 Fetch .*\/api\/data\?x=1/);
  assert.match(n.text, /"ok":true/);
});

test("wait_for text and selector", async () => {
  await mcp.call("navigate", { url: "reload" });
  const w = await mcp.call("wait_for", { text: "Loaded later", timeoutMs: 5000 });
  assert.equal(w.text, "Condition met");
  const t = await mcp.call("wait_for", { selector: "#does-not-exist", timeoutMs: 600 });
  assert.equal(t.isError, true);
});

test("handle_dialog accepts a confirm()", async () => {
  // Playwright auto-dismisses dialogs on pages without a listener; keep it out of the way.
  pageFor(browser.context, fixture.url).on("dialog", () => {});
  const ref = refOf((await mcp.call("find", { query: "Open confirm" })).text, /button "Open confirm" \[(ref_\d+)\]/);
  const r = await mcp.call("computer", { action: "left_click", ref });
  assert.match(r.text, /confirm dialog is open: "Proceed\?"/);
  const h = await mcp.call("handle_dialog", { accept: true });
  assert.match(h.text, /Accepted confirm/);
  assert.equal((await mcp.call("javascript_tool", { text: "window.__confirmed" })).text, "true");
});

test("file_upload and upload_image fill a file input", async () => {
  const ref = refOf((await mcp.call("read_page", { filter: "interactive" })).text, /"Upload file" \[(ref_\d+)\]/);
  assert.ok(ref);
  const r = await mcp.call("file_upload", { ref, files: [{ name: "notes.txt", mimeType: "text/plain", base64: Buffer.from("hello file").toString("base64") }] });
  assert.match(r.text, /Attached 1 file/);
  const page = pageFor(browser.context, fixture.url);
  assert.equal(await page.textContent("#fileOut"), "notes.txt:10");
  const shot = await mcp.call("computer", { action: "screenshot" });
  const imageId = shot.text.match(/imageId (img_\d+)/)[1];
  const u = await mcp.call("upload_image", { imageId, ref, filename: "shot.jpg" });
  assert.match(u.text, /Attached 1 file/);
  assert.match(await page.textContent("#fileOut"), /^shot\.jpg:\d+/);
});

test("screenshot fullPage + save returns a download URL", async () => {
  const r = await mcp.call("screenshot", { fullPage: true, save: true });
  assert.equal(r.images.length, 1);
  const url = r.text.match(/Saved: (\S+)/)?.[1];
  assert.ok(url, r.text);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
});

test("screenshot fullPage loads lazy content and stitches pages that scroll inside a panel", async () => {
  await mcp.call("navigate", { url: `${fixture.url}/long` });
  const long = await mcp.call("screenshot", { fullPage: true });
  const [, lw, lh] = long.text.match(/\((\d+)x(\d+), full page/).map(Number);
  assert.ok(lh / lw > 4, `long page image should be tall: ${long.text}`);
  const lazy = await mcp.call("javascript_tool", { text: "lazy.dataset.loaded + ':' + scrollY" });
  assert.match(lazy.text, /1:0/, "lazy section loaded and scroll restored");

  await mcp.call("navigate", { url: `${fixture.url}/panel` });
  const panel = await mcp.call("screenshot", { fullPage: true });
  assert.match(panel.text, /stitched/, panel.text);
  const [, pw, ph] = panel.text.match(/\((\d+)x(\d+), full page/).map(Number);
  assert.ok(ph / pw > 3, `panel image should include all 25 rows: ${panel.text}`);
});

test("record action=scroll returns a smooth scrolling video of the whole page", async () => {
  await mcp.call("navigate", { url: `${fixture.url}/long` });
  const r = await mcp.call("record", { action: "scroll", speed: 2500 });
  assert.match(r.text, /Recorded \d+\.\ds/, r.text);
  const secs = Number(r.text.match(/Recorded (\d+\.\d)s/)[1]);
  assert.ok(secs >= 2, `clip covers the scroll: ${secs}s`);
  const url = r.text.match(/URL: (\S+)/)?.[1];
  assert.ok(url, r.text);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  assert.ok(buf.length > 10_000, `video bytes ${buf.length}`);
  const pos = await mcp.call("javascript_tool", { text: "Math.round(scrollY + innerHeight) >= document.documentElement.scrollHeight - 2" });
  assert.match(pos.text, /true/, "ended at the bottom");
  await mcp.call("navigate", { url: fixture.url });
});

test("tabs_create, tabs_select, tabs_close stay inside the group", async () => {
  const r = await mcp.call("tabs_create", { url: `${fixture.url}/second` });
  const created = JSON.parse(r.text).created;
  assert.equal(created.title, "Second page");
  const ctx = JSON.parse((await mcp.call("tabs_context")).text);
  assert.equal(ctx.tabs.length, 2);
  assert.equal(ctx.currentTabId, created.tabId);
  await mcp.call("tabs_select", { tabId });
  assert.equal(JSON.parse((await mcp.call("tabs_context")).text).currentTabId, tabId);
  await mcp.call("tabs_close", { tabId: created.tabId });
  assert.equal(JSON.parse((await mcp.call("tabs_context")).text).tabs.length, 1);
  const all = JSON.parse((await mcp.call("tabs_context", { all: true })).text);
  assert.ok(all.length >= 1);
});

test("resize_window", async () => {
  const r = await mcp.call("resize_window", { width: 1100, height: 800 });
  assert.match(r.text, /resized to 1100x800/);
});

test("record produces a playable video file", async () => {
  const start = await mcp.call("record", { action: "start", fps: 10 });
  assert.match(start.text, /Recording tab/, start.text);
  const st = await mcp.call("record", { action: "status" });
  assert.match(st.text, /Recording tab/);
  for (let i = 0; i < 3; i++) {
    await mcp.call("computer", { action: "scroll", scroll_direction: i % 2 ? "up" : "down", scroll_amount: 4 });
    await new Promise((r) => setTimeout(r, 400));
  }
  const ref = refOf((await mcp.call("find", { query: "Click me" })).text, /button "Click me" \[(ref_\d+)\]/);
  await mcp.call("computer", { action: "left_click", ref });
  await new Promise((r) => setTimeout(r, 600));
  const stop = await mcp.call("record", { action: "stop" });
  assert.match(stop.text, /Recorded \d+\.\ds/, stop.text);
  const url = stop.text.match(/URL: (\S+)/)?.[1];
  assert.ok(url, stop.text);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 10_000, `video bytes ${buf.length}`);
  const isMp4 = buf.subarray(4, 8).toString() === "ftyp";
  const isWebm = buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  assert.ok(isMp4 || isWebm, "mp4 or webm container");
});

test("gif_creator records and exports an animated GIF", async () => {
  await mcp.call("gif_creator", { action: "start_recording" });
  await mcp.call("computer", { action: "scroll", scroll_direction: "down", scroll_amount: 3 });
  await new Promise((r) => setTimeout(r, 800));
  await mcp.call("computer", { action: "scroll", scroll_direction: "up", scroll_amount: 3 });
  await new Promise((r) => setTimeout(r, 800));
  const r = await mcp.call("gif_creator", { action: "export" });
  assert.equal(r.images[0]?.mimeType, "image/gif", r.text);
  const gif = Buffer.from(r.images[0].data, "base64");
  assert.equal(gif.subarray(0, 6).toString(), "GIF89a");
  assert.match(r.text, /GIF: \d+ frames/);
});

test("agent tabs live in a background window and never change the user's tab", async () => {
  const state = () =>
    browser.sw.evaluate(async () => {
      const { agentWindowId } = await chrome.storage.local.get("agentWindowId");
      const wins = await chrome.windows.getAll({ populate: true });
      const user = wins.find((w) => w.id !== agentWindowId && !w.incognito);
      return { agentWindowId, userWindowId: user?.id, userActive: user?.tabs.find((t) => t.active)?.id, userTabs: user?.tabs.length };
    });
  const before = await state();
  assert.ok(before.agentWindowId !== undefined, "agent window exists");
  assert.notEqual(before.agentWindowId, before.userWindowId);
  const created = JSON.parse((await mcp.call("tabs_create", { url: `${fixture.url}/second` })).text).created;
  const t0 = Date.now();
  const shot = await mcp.call("computer", { action: "screenshot" });
  assert.equal(shot.images.length, 1);
  assert.ok(Date.now() - t0 < 3000, `background-tab screenshot took ${Date.now() - t0}ms`);
  await mcp.call("tabs_select", { tabId: created.tabId, focus: true });
  const groupWindow = await browser.sw.evaluate(async (id) => (await chrome.tabs.get(id)).windowId, created.tabId);
  assert.equal(groupWindow, before.agentWindowId);
  const after = await state();
  assert.equal(after.userActive, before.userActive, "user's active tab unchanged");
  assert.equal(after.userTabs, before.userTabs, "no tabs opened in the user's window");
  await mcp.call("tabs_close", { tabId: created.tabId });
  await mcp.call("tabs_select", { tabId });
});

test("a new tab the user opens next to an agent tab stays out of the agent's group", async () => {
  const groupId = JSON.parse((await mcp.call("tabs_context")).text).group.groupId;
  // Chrome puts a Cmd+T tab into the active tab's group; simulate that placement.
  const result = await browser.sw.evaluate(async (gid) => {
    const g = await chrome.tabGroups.get(gid);
    const t = await chrome.tabs.create({ url: "chrome://newtab/", windowId: g.windowId, active: false });
    await chrome.tabs.group({ groupId: gid, tabIds: [t.id] });
    await new Promise((r) => setTimeout(r, 500));
    const after = await chrome.tabs.get(t.id);
    await chrome.tabs.remove(t.id);
    return after.groupId;
  }, groupId);
  assert.equal(result, -1);
  const ctx = JSON.parse((await mcp.call("tabs_context")).text);
  assert.ok(ctx.tabs.every((t) => !/newtab/.test(t.url ?? "")));
});

test("Stop in the browser pauses the session until resumed", async () => {
  const extId = browser.sw.url().split("/")[2];
  const popup = await browser.context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click("#stopAll");
  const r = await mcp.call("get_page_text");
  assert.equal(r.isError, true);
  assert.match(r.text, /paused/);
  await popup.click("#resumeAll");
  const ok = await mcp.call("get_page_text");
  assert.ok(!ok.isError, ok.text);
  await popup.close();
});

test("a second agent session gets its own tab group", async () => {
  const codex = await mcpClient(account.apiKey, "codex-mcp-client");
  try {
    const ctx = JSON.parse((await codex.call("tabs_context")).text);
    assert.equal(ctx.group.title, "Codex");
    const mine = JSON.parse((await mcp.call("tabs_context")).text);
    assert.notEqual(ctx.group.groupId, mine.group.groupId);
    await codex.call("navigate", { url: `${fixture.url}/second` });
    assert.match((await codex.call("get_page_text")).text, /Hello from page two/);
    assert.match((await mcp.call("get_page_text")).text, /quick brown fox/);
  } finally {
    await codex.close();
  }
});

test("multiple Chrome profiles: list, select and target by name", async () => {
  const second = await launchBrowser(account.apiKey, "E2E Personal");
  try {
    const list = (await mcp.call("list_browsers")).text;
    assert.match(list, /E2E Work/);
    assert.match(list, /E2E Personal/);
    const r = await mcp.call("tabs_context", { browser: "E2E Personal" });
    const ctx = JSON.parse(r.text);
    assert.equal(ctx.browser, "E2E Personal");
    await mcp.call("navigate", { url: `${fixture.url}/second`, browser: "E2E Personal" });
    assert.ok(pageFor(second.context, "/second"), "navigated in the second profile");
    await mcp.call("select_browser", { browser: "E2E Personal" });
    assert.equal(JSON.parse((await mcp.call("tabs_context")).text).browser, "E2E Personal");
    await mcp.call("select_browser", { browser: "E2E Work" });
    assert.equal(JSON.parse((await mcp.call("tabs_context")).text).browser, "E2E Work");
  } finally {
    await second.close();
  }
});

test("revoking a browser disconnects it", async () => {
  const third = await launchBrowser(account.apiKey, "E2E Temp");
  try {
    await api(`/api/devices/${third.deviceId}`, { key: account.apiKey, method: "DELETE" });
    await new Promise((r) => setTimeout(r, 800));
    const st = await third.sw.evaluate(() => globalThis.__acmStatus());
    assert.equal(st.status, "revoked");
    const me = await api("/api/me", { key: account.apiKey });
    assert.ok(!me.devices.find((d) => d.id === third.deviceId));
  } finally {
    await third.close();
  }
});

test("bad credentials are rejected", async () => {
  const res = await fetch(`${SERVER}/mcp`, { method: "POST", headers: { authorization: "Bearer acm_sk_nope", "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  await assert.rejects(api("/api/pair/redeem", { method: "POST", body: { code: "AAAAA-BBBBB", name: "x" } }));
});
