// Private (incognito) sessions: the agent works in an incognito window without the profile's cookies.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, mcpClient, signup, startFixture } from "./harness.mjs";

let fixture, account, browser, mcp;

before(async () => {
  fixture = await startFixture();
  account = await signup();
  browser = await launchBrowser(account.apiKey, "E2E Private");
  mcp = await mcpClient(account.apiKey, "claude-code");
});

after(async () => {
  await mcp?.close().catch(() => {});
  await browser?.close();
  fixture?.close();
});

async function callUntilOnline(name, args, tries = 60) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await mcp.call(name, args);
    if (!r.isError || !/offline|not connected|no browser/i.test(r.text)) return r;
    await new Promise((res) => setTimeout(res, 500));
  }
  return r;
}

test("private=true explains how to turn on incognito access when it is off", async () => {
  const r = await mcp.call("tabs_context", { private: true, task: "Ask ChatGPT" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Allow in Incognito/);
  assert.match(r.text, /chrome:\/\/extensions\/\?id=/);
});

test("private=true works in an incognito window without the profile's cookies", async () => {
  // Normal session sets a cookie on the fixture origin.
  await mcp.call("tabs_context", { private: false });
  await mcp.call("navigate", { url: fixture.url });
  await mcp.call("javascript_tool", { text: "document.cookie = 'who=profile; path=/'; document.cookie" });

  // Turn on "Allow in Incognito" the way the user would. Chrome reloads the extension, which keeps an
  // unpacked copy enabled only in developer mode (Web Store installs don't need it).
  const extId = browser.sw.url().split("/")[2];
  const page = await browser.context.newPage();
  await page.goto("chrome://extensions/");
  await page.locator("#devMode").click();
  await page.goto(`chrome://extensions/?id=${extId}`);
  await page.locator("#allow-incognito").click();
  await page.close();

  const r = await callUntilOnline("tabs_context", { private: true });
  assert.ok(!r.isError, r.text);
  const ctx = JSON.parse(r.text);
  assert.equal(ctx.private, true);
  await mcp.call("navigate", { url: fixture.url });
  const cookie = await mcp.call("javascript_tool", { text: "document.cookie" });
  assert.doesNotMatch(cookie.text, /who=profile/);
  const shot = await mcp.call("computer", { action: "screenshot" });
  assert.equal(shot.images.length, 1);
  const text = await mcp.call("get_page_text");
  assert.match(text.text, /ACM Test App|Click me/);

  const back = JSON.parse((await mcp.call("tabs_context", { private: false })).text);
  assert.equal(back.private, false);
  await mcp.call("navigate", { url: fixture.url });
  const mine = await mcp.call("javascript_tool", { text: "document.cookie" });
  assert.match(mine.text, /who=profile/);
});
