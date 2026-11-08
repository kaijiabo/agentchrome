declare const __DEFAULT_SERVER__: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T = any>(msg: Record<string, unknown>) => chrome.runtime.sendMessage<any, T>(msg);

const GROUP_COLORS: Record<string, string> = {
  grey: "#9AA0A6", blue: "#2F6BFF", red: "#E5484D", yellow: "#E8A33D", green: "#30A46C", pink: "#D6409F", purple: "#8E4EC6", cyan: "#0EA5C6", orange: "#F76B15",
};
const STATUS_TEXT: Record<string, string> = { unpaired: "Not connected", connecting: "Connecting", connected: "Connected", disconnected: "Offline", revoked: "Removed" };

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 1800);
}

const shortHost = (u?: string) => (u ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "active now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

function formatCode(v: string) {
  const raw = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return raw.length > 5 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : raw;
}

let firstRender = true;

async function render() {
  const s = await send<any>({ type: "acm:status" }).catch(() => null);
  if (!s) return;
  $("version").textContent = s.version;
  const st = $("status");
  st.className = `status ${s.status}`;
  $("statusText").textContent = s.activeCalls > 0 && s.status === "connected" ? "Working" : STATUS_TEXT[s.status] ?? s.status;
  if (s.activeCalls > 0) st.classList.add("busy");
  const paired = s.status !== "unpaired" && s.status !== "revoked";
  $("unpaired").hidden = paired;
  $("paired").hidden = !paired;
  const server = s.server || __DEFAULT_SERVER__;
  $<HTMLAnchorElement>("docsLink").href = server;

  if (!paired) {
    const pname = $<HTMLInputElement>("pname");
    if (!pname.value && s.name) pname.value = s.name;
    const serverInput = $<HTMLInputElement>("server");
    if (!serverInput.value) serverInput.value = s.server && s.server !== __DEFAULT_SERVER__ ? s.server : "http://127.0.0.1:47823";
    $("waiting").hidden = !s.connectPending;
    $<HTMLButtonElement>("signin").disabled = Boolean(s.connectPending);
    $("signin").textContent = s.connectPending ? "Waiting for sign-in…" : "Sign in to connect";
    if (s.status === "revoked" && s.lastError && firstRender) showError("pairError", s.lastError);
    firstRender = false;
    return;
  }
  firstRender = false;

  const name = $<HTMLInputElement>("name");
  if (document.activeElement !== name) name.value = s.name ?? "Chrome";
  $("avatar").textContent = (name.value.trim()[0] ?? "C").toUpperCase();
  $("serverLabel").textContent = s.status === "connected" ? `Connected · ${shortHost(s.server)}` : s.status === "connecting" ? `Connecting to ${shortHost(s.server)}…` : `Can't reach ${shortHost(s.server)}`;
  $<HTMLInputElement>("showOverlay").checked = s.settings.showOverlay;
  $<HTMLInputElement>("showCursor").checked = s.settings.showCursor !== false;
  $<HTMLInputElement>("askNewSites").checked = s.settings.askNewSites;
  $<HTMLInputElement>("history").checked = s.history;
  const blocked = $<HTMLTextAreaElement>("blocked");
  if (document.activeElement !== blocked) blocked.value = s.settings.blockedHosts.join("\n");
  const n = s.settings.blockedHosts.length;
  $("blockedCount").textContent = n ? `${n} site${n > 1 ? "s" : ""}` : "None";
  const err = $("lastError");
  err.hidden = !(s.status === "disconnected" && s.lastError);
  err.textContent = s.lastError;

  const sessions = (s.sessions as any[]).filter((x) => Date.now() - x.lastActive < 86_400_000).sort((a, b) => b.lastActive - a.lastActive).slice(0, 6);
  const anyPaused = sessions.some((x) => x.paused);
  const active = sessions.filter((x) => !x.paused && Date.now() - x.lastActive < 120_000).length;
  $("activeCount").textContent = sessions.length ? `${active} active` : "";
  $("stopAll").hidden = !sessions.length || sessions.every((x) => x.paused);
  $("resumeAll").hidden = !anyPaused;
  const box = $("sessions");
  if (!sessions.length) return;
  box.replaceChildren(
    ...sessions.map((x) => {
      const row = document.createElement("div");
      row.className = `row session${x.paused ? " paused" : ""}`;
      row.title = "Show this agent's tabs";
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = GROUP_COLORS[x.color] ?? "#2F6BFF";
      const info = document.createElement("span");
      info.className = "sinfo";
      const b = document.createElement("b");
      b.textContent = x.title;
      const meta = document.createElement("small");
      meta.textContent = x.paused ? "Paused" : ago(x.lastActive);
      info.append(b, meta);
      const btn = document.createElement("button");
      btn.className = `chip${x.paused ? " primary" : ""}`;
      btn.textContent = x.paused ? "Resume" : "Pause";
      btn.onclick = async (e) => {
        e.stopPropagation();
        await send({ type: "acm:session-pause", id: x.id, paused: !x.paused });
        toast(x.paused ? `${x.title} resumed` : `${x.title} paused`);
        render();
      };
      row.onclick = () => send({ type: "acm:focus-session", id: x.id });
      row.append(sw, info, btn);
      return row;
    }),
  );
}

function showError(id: string, msg: string) {
  const err = $(id);
  err.hidden = false;
  err.textContent = msg;
}

// Cloud (default): sign in on the web, the extension connects itself.
$("signin").onclick = async () => {
  $("pairError").hidden = true;
  const r = await send<any>({ type: "acm:connect-start", server: __DEFAULT_SERVER__, name: $<HTMLInputElement>("pname").value.trim() || "Chrome" });
  if (r?.error) showError("pairError", r.error);
  render();
};

// Local server: pairing code from `agentchrome pair --local`.
const showLocal = (on: boolean) => {
  $("cloudView").hidden = on;
  $("localView").hidden = !on;
  if (on) $("code").focus();
};
$("toLocal").onclick = () => showLocal(true);
$("toCloud").onclick = () => showLocal(false);

function bindCode(input: HTMLInputElement, errorId: string) {
  input.addEventListener("input", () => {
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.length;
    input.value = formatCode(input.value);
    const delta = input.value.length - before;
    input.setSelectionRange(pos + delta, pos + delta);
    $(errorId).hidden = true;
    input.classList.toggle("complete", input.value.length === 11);
  });
}

/** Pairs with a code from `agentchrome setup` / `agentchrome pair`, against the cloud server or a local one. */
function bindPairForm(opts: { form: string; input: HTMLInputElement; button: string; error: string; label: string; server: () => string; name: () => string }) {
  bindCode(opts.input, opts.error);
  $(opts.form).addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $<HTMLButtonElement>(opts.button);
    const code = formatCode(opts.input.value);
    if (code.length !== 11) {
      showError(opts.error, "Pairing codes have 10 characters, like ABCDE-FGHJK.");
      opts.input.focus();
      return;
    }
    $(opts.error).hidden = true;
    btn.disabled = true;
    btn.classList.add("loading");
    btn.textContent = "Connecting";
    try {
      const r = await send<any>({ type: "acm:pair", server: opts.server(), code, name: opts.name() || "Chrome" });
      if (r?.error) throw new Error(r.error);
      toast("Connected");
    } catch (err) {
      showError(opts.error, String((err as Error).message ?? err).replace(/^Error: /, ""));
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
      btn.textContent = opts.label;
      render();
    }
  });
}

bindPairForm({
  form: "codeForm",
  input: $<HTMLInputElement>("cloudCode"),
  button: "cloudPair",
  error: "codeError",
  label: "Connect with code",
  server: () => __DEFAULT_SERVER__,
  name: () => $<HTMLInputElement>("pname").value.trim(),
});
bindPairForm({
  form: "localView",
  input: $<HTMLInputElement>("code"),
  button: "pair",
  error: "localError",
  label: "Connect",
  server: () => $<HTMLInputElement>("server").value.trim(),
  name: () => $<HTMLInputElement>("pnameLocal").value.trim(),
});

const nameInput = $<HTMLInputElement>("name");
nameInput.addEventListener("change", async () => {
  await send({ type: "acm:rename", name: nameInput.value.trim() || "Chrome" });
  toast("Profile renamed");
  render();
});
nameInput.addEventListener("keydown", (e) => e.key === "Enter" && nameInput.blur());

// Pairing code for another Chrome profile on the same account (made with this profile's device token).
$("pairNew").onclick = async () => {
  const btn = $<HTMLButtonElement>("pairNew");
  $("pairNewError").hidden = true;
  btn.disabled = true;
  try {
    const r = await send<any>({ type: "acm:pair-new" });
    if (r?.error || !r?.code) throw new Error(r?.error ?? "Couldn't create a pairing code.");
    $("pairCode").textContent = formatCode(r.code);
    const mins = Math.max(1, Math.round((new Date(r.expiresAt).getTime() - Date.now()) / 60_000));
    $("pairExpiry").textContent = `in ${mins} minute${mins === 1 ? "" : "s"}`;
    $("pairBox").hidden = false;
    btn.textContent = "New code";
  } catch (err) {
    showError("pairNewError", String((err as Error).message ?? err));
  } finally {
    btn.disabled = false;
  }
};
$("copyPair").onclick = async () => {
  await navigator.clipboard.writeText($("pairCode").textContent ?? "");
  toast("Code copied");
};

$("unpair").onclick = async () => {
  if (!confirm("Disconnect this Chrome profile? Agents will no longer be able to use it until you pair it again.")) return;
  await send({ type: "acm:unpair" });
  firstRender = true;
  render();
};
$("reconnect").onclick = async () => {
  await send({ type: "acm:reconnect" });
  toast("Reconnecting");
  setTimeout(render, 700);
};
$("stopAll").onclick = async () => {
  await send({ type: "acm:stop-all" });
  toast("All agents paused");
  render();
};
$("resumeAll").onclick = async () => {
  await send({ type: "acm:resume-all" });
  toast("Agents resumed");
  render();
};
const setting = (id: string, key: string) =>
  ($<HTMLInputElement>(id).onchange = async (e) => {
    await send({ type: "acm:settings", patch: { [key]: (e.target as HTMLInputElement).checked } });
    toast("Saved");
  });
setting("showOverlay", "showOverlay");
setting("showCursor", "showCursor");
setting("askNewSites", "askNewSites");
$<HTMLTextAreaElement>("blocked").onchange = async (e) => {
  const hosts = (e.target as HTMLTextAreaElement).value
    .split(/\s+/)
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  await send({ type: "acm:settings", patch: { blockedHosts: [...new Set(hosts)] } });
  toast("Blocked sites saved");
  render();
};
$<HTMLInputElement>("history").onchange = async (e) => {
  const box = e.target as HTMLInputElement;
  if (box.checked) box.checked = await chrome.permissions.request({ permissions: ["history"] });
  else await chrome.permissions.remove({ permissions: ["history"] });
  toast(box.checked ? "History access on" : "History access off");
};

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "acm:status-changed") render();
});
render();
setInterval(render, 2500);
export {};
