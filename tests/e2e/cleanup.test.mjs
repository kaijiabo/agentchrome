// Idle agent groups are unloaded, then closed, and the number of open agent groups is capped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, mcpClient, signup, startFixture } from "./harness.mjs";

let fixture, account, browser, mcp;
const extra = [];
const MIN = 60_000;
const sweep = (aheadMs) => browser.sw.evaluate((ms) => globalThis.__acmSweep(Date.now() + ms), aheadMs);
const groupCount = () => browser.sw.evaluate(async () => (await chrome.tabGroups.query({})).length);

before(async () => {
  fixture = await startFixture();
  account = await signup();
  browser = await launchBrowser(account.apiKey, "E2E Cleanup");
  mcp = await mcpClient(account.apiKey, "claude-code");
});

after(async () => {
  for (const c of [mcp, ...extra]) await c?.close().catch(() => {});
  await browser?.close();
  fixture?.close();
});

test("idle tabs are unloaded and wake up when the agent uses them again", async () => {
  await mcp.call("tabs_context", { task: "Idle check" });
  await mcp.call("navigate", { url: fixture.url });
  const second = JSON.parse((await mcp.call("tabs_create", { url: `${fixture.url}/second` })).text).created;
  assert.equal((await sweep(0)).discarded, 0, "nothing happens to fresh groups");
  const r = await sweep(11 * MIN);
  assert.ok(r.discarded >= 1, JSON.stringify(r));
  assert.equal(r.closed.length, 0);
  const discarded = await browser.sw.evaluate(async (id) => {
    const { tabAliases = {} } = await chrome.storage.local.get("tabAliases");
    return (await chrome.tabs.get(tabAliases[id] ?? id)).discarded;
  }, second.tabId);
  assert.equal(discarded, true);
  const text = await mcp.call("get_page_text", { tabId: second.tabId });
  assert.ok(!text.isError, text.text);
  assert.match(text.text, /Second/);
});

test("groups idle for an hour are closed and the agent gets a fresh one", async () => {
  const before = await groupCount();
  assert.ok(before >= 1);
  const r = await sweep(61 * MIN);
  assert.deepEqual(r.closed, ["Idle check"]);
  assert.equal(await groupCount(), before - 1);
  // The agent can carry on: it gets a fresh group.
  const ctx = JSON.parse((await mcp.call("tabs_context")).text);
  assert.equal(ctx.tabs.length, 1);
});

test("many busy agents in parallel keep all their groups", async () => {
  for (let i = 0; i < 7; i++) {
    const c = await mcpClient(account.apiKey, `agent-${i}`);
    extra.push(c);
    await c.call("tabs_context", { task: `Job ${i}` });
  }
  const before = await groupCount();
  assert.ok(before >= 8);
  const r = await sweep(30 * MIN);
  assert.equal(r.closed.length, 0, JSON.stringify(r));
  assert.equal(await groupCount(), before);
});
