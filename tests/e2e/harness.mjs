// Shared harness: fixture web server, Chromium with the extension, pairing and MCP clients.
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = join(here, "../../packages/extension/dist");
export const SERVER = process.env.ACM_SERVER ?? "http://127.0.0.1:8787";

export function startFixture() {
  const html = readFileSync(join(here, "fixtures/app.html"));
  const srv = createServer((req, res) => {
    if (req.url?.startsWith("/api/data")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, n: 7 }));
    }
    if (req.url === "/long") {
      res.setHeader("content-type", "text/html");
      // A tall document with a lazy section at the bottom that only fills in once scrolled into view.
      return res.end(`<!doctype html><title>Long</title><body style="margin:0;font:20px sans-serif">${Array.from({ length: 30 }, (_, i) => `<section style="height:200px;background:hsl(${i * 12},70%,80%)">Section ${i + 1}</section>`).join("")}<div id="lazy" style="height:300px">waiting</div><script>new IntersectionObserver((e)=>{if(e[0].isIntersecting){lazy.textContent="loaded";lazy.dataset.loaded="1"}}).observe(lazy)</script></body>`);
    }
    if (req.url === "/panel") {
      res.setHeader("content-type", "text/html");
      // An app layout: fixed header, and the content scrolls inside a panel, not the document (like Gmail or Notion).
      return res.end(`<!doctype html><title>Panel</title><body style="margin:0;height:100vh;overflow:hidden;display:flex;flex-direction:column;font:20px sans-serif"><header style="height:60px;background:#111;color:#fff">App header</header><main id="m" style="flex:1;overflow:auto">${Array.from({ length: 25 }, (_, i) => `<div style="height:240px;background:hsl(${i * 14},70%,80%)">Row ${i + 1}</div>`).join("")}</main></body>`);
    }
    if (req.url === "/edge") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(readFileSync(join(here, "fixtures/edge.html")));
    }
    if (req.url === "/file.txt") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="report.txt"' });
      return res.end("report");
    }
    if (req.url === "/missing") {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<title>Not found</title><h1>404</h1>");
    }
    if (req.url === "/leave") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<title>Leave</title><h1>Unsaved</h1><script>addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; });</script>");
    }
    if (req.url?.split("?")[0] === "/second") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<title>Second page</title><h1>Second page</h1><p>Hello from page two.</p>");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

export async function api(path, { key, method = "GET", body } = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export async function signup() {
  const info = await api("/api/info");
  if (info.mode === "local") {
    // Local server: the account key is created by `agentchrome setup --local` and kept in the test config dir.
    const cfg = JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME, "agentchrome", "config.json"), "utf8"));
    return { apiKey: cfg.apiKey, accountId: "local" };
  }
  return api("/api/signup", { method: "POST" });
}

/** Launch a fresh Chromium profile with the extension and pair it to the account. */
export async function launchBrowser(apiKey, name, opts = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), "acm-e2e-"));
  const headless = process.env.HEADED !== "1"; // windowless by default so test runs never pop over the user's work
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    channel: "chromium",
    viewport: null,
    args: [`--disable-extensions-except=${[EXT_DIR, ...(opts.extraExtensions ?? [])].join(",")}`, `--load-extension=${[EXT_DIR, ...(opts.extraExtensions ?? [])].join(",")}`, "--window-size=1280,900", "--no-first-run"],
  });
  const ours = (w) => w.url().endsWith("/background.js");
  let sw = context.serviceWorkers().find(ours);
  if (!sw) sw = await context.waitForEvent("serviceworker", { predicate: ours, timeout: 15_000 });
  // Close the welcome tab the extension opens on install, keep one normal tab.
  await new Promise((r) => setTimeout(r, 800));
  for (const p of context.pages()) if (p.url().includes("welcome.html")) await p.close();
  const { code } = await api("/api/pair/new", { key: apiKey, method: "POST" });
  const deviceId = await sw.evaluate(async ([server, code, name]) => globalThis.__acmPair(server, code, name), [SERVER, code, name]);
  // Wait until the server sees it online.
  for (let i = 0; i < 50; i++) {
    const me = await api("/api/me", { key: apiKey });
    if (me.devices.find((d) => d.id === deviceId)?.online) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    context,
    sw,
    deviceId,
    async close() {
      await context.close().catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

export async function mcpClient(apiKey, clientName = "claude-code") {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${SERVER}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { ...r, text, images: r.content.filter((c) => c.type === "image") };
  };
  return { client, call, close: () => client.close() };
}

/** Find the tab in the browser context that matches a URL substring. */
export function pageFor(context, sub) {
  return context.pages().find((p) => p.url().includes(sub));
}
