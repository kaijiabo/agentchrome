// Tool catalog shared by the Cloudflare server, the local server and the extension.
// Names follow Claude in Chrome where a counterpart exists so prompts and skills transfer.

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean | string>;
  /** Handled by the server itself instead of being relayed to a browser. */
  server?: boolean;
  /** Per-call timeout in ms when relayed to the browser. */
  timeoutMs?: number;
  /**
   * Which tool set it belongs to. "agent": coding agents (Claude in Chrome parity, incl. computer/javascript_tool).
   * "directory": chat apps listed in the Claude and ChatGPT directories (one tool per action). Unset: both.
   */
  profile?: "agent" | "directory";
  /** Directory tools run as an existing tool: map their arguments onto it. */
  via?: { tool: string; map: (a: Record<string, any>) => Record<string, unknown> };
}

export type Profile = "agent" | "directory";

const browser = {
  type: "string",
  description:
    "Which connected Chrome profile to use (id or name from list_browsers). Optional: defaults to the browser selected with select_browser, else the most recently active one.",
};
const tabId = {
  type: "number",
  description:
    "Tab ID from tabs_context. Optional: defaults to this session's current tab (created inside the session tab group if none exists).",
};
const coord = {
  type: "array",
  items: { type: "number" },
  minItems: 2,
  maxItems: 2,
  description: "[x, y] in screenshot pixels (same space as the last screenshot of this tab).",
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: { ...properties, browser },
  required,
  additionalProperties: false,
});

export const TOOLS: ToolDef[] = [
  {
    name: "list_browsers",
    title: "List connected browsers",
    server: true,
    description:
      "List the Chrome profiles paired with this account, with online status. Each Chrome profile that installs the extension and pairs shows up as its own browser.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "select_browser",
    title: "Select browser",
    server: true,
    description:
      "Choose which paired Chrome profile this session controls by default. Pass the id or name from list_browsers.",
    inputSchema: {
      type: "object",
      properties: { browser: { type: "string", description: "Browser id or name." } },
      required: ["browser"],
      additionalProperties: false,
    },
  },
  {
    name: "pairing_code",
    title: "Get a pairing code",
    server: true,
    description:
      "Get a one-time code that connects a Chrome profile to this account. The result has the code, the extension download link and the steps the user follows: install the extension, click its toolbar icon, paste the code and press Connect.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tabs_context",
    title: "Get session tabs",
    description:
      "Get the tabs in this session's Chrome tab group (id, url, title, active). Returns the tabIds the other tab tools accept. Each agent session gets its own tab group in a background Chrome window, so its work stays separate from the user's tabs and never interrupts them. Set createIfEmpty to open a blank tab in a new group when there is none. Set all=true to list every open tab in the browser.",
    inputSchema: obj({
      createIfEmpty: { type: "boolean", description: "Create the group with a new tab if the session has none. Default true." },
      task: { type: "string", description: "A 2-4 word name for what you are doing, such as \"Fix checkout bug\" or \"Compare flight prices\". Your tab group is renamed to it so the user can tell your tabs apart. Pass it on your first call." },
      all: { type: "boolean", description: "List every tab in the browser, not only this session's group." },
      private: { type: "boolean", description: "true: work in a private (incognito) window with no cookies or logins, for logged-out browsing such as asking chatgpt.com a question as an anonymous visitor. false: go back to the normal window with the user's logins. Switching starts a new tab group. Omit to keep the current mode." },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "tabs_create",
    title: "Open tab",
    description:
      "Open a new tab in the user's own Chrome, inside this session's tab group, and make it the session's current tab. Optionally load a URL there, the same as typing it in the address bar (this is not an API call).",
    inputSchema: obj({
      url: { type: "string", description: "URL to open. Default about:blank." },
      active: { type: "boolean", description: "Make it the visible tab in your agent window. Default false. It never raises the window over the user's work." },
      private: { type: "boolean", description: "true: work in a private (incognito) window with no cookies or logins, for logged-out browsing such as asking chatgpt.com a question as an anonymous visitor. false: go back to the normal window with the user's logins. Switching starts a new tab group. Omit to keep the current mode." },
      task: { type: "string", description: "A 2-4 word name for what you are doing, such as \"Fix checkout bug\" or \"Compare flight prices\". Your tab group is renamed to it so the user can tell your tabs apart. Pass it on your first call." },
    }),
  },
  {
    name: "tabs_close",
    title: "Close tab",
    description: "Close a tab. Only tabs in this session's group can be closed unless force is true.",
    inputSchema: obj({ tabId: { ...tabId, description: "Tab to close." }, force: { type: "boolean" } }, ["tabId"]),
    annotations: { destructiveHint: true },
  },
  {
    name: "tabs_select",
    title: "Switch tab",
    description:
      "Make a tab this session's current tab. Pass adopt=true to move a user's tab into the session group. Pass focus=true to also make it the visible tab in its window (the window is never raised over the user's work).",
    inputSchema: obj({ tabId: { ...tabId, description: "Tab to switch to." }, adopt: { type: "boolean" }, focus: { type: "boolean" } }, ["tabId"]),
  },
  {
    name: "tab_groups",
    title: "Manage tab groups",
    description:
      "List, create, rename, recolor, collapse or ungroup Chrome tab groups. action=list returns every group. action=update changes title/color/collapsed of a group (defaults to this session's group). action=create groups the given tabIds (or the current tab) into a new group. action=ungroup removes tabs from their group. action=move moves tabIds into a group. action=close closes every tab in a group (default: this session's group). Call action=close when your job is done so your tabs stop using memory.",
    inputSchema: obj(
      {
        action: { type: "string", enum: ["list", "create", "update", "ungroup", "move", "close"] },
        groupId: { type: "number", description: "Target group. Default: this session's group." },
        tabIds: { type: "array", items: { type: "number" } },
        title: { type: "string", description: "New group name." },
        color: { type: "string", enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] },
        collapsed: { type: "boolean" },
        makeSessionGroup: { type: "boolean", description: "With create/move: make this the session's group from now on." },
        force: { type: "boolean", description: "With close: allow closing a group that is not this session's." },
      },
      ["action"],
    ),
  },
  {
    name: "navigate",
    title: "Navigate",
    description:
      "Load a URL in a tab of the user's own Chrome and wait for it to finish loading, the same as typing it in the address bar (this is not an API call). Use 'back' or 'forward' for history navigation, 'reload' to reload.",
    inputSchema: obj({ url: { type: "string" }, tabId, timeoutMs: { type: "number", description: "Max wait for load. Default 30000." } }, ["url"]),
    timeoutMs: 60_000,
  },
  {
    name: "computer",
    title: "Mouse, keyboard and screenshots",
    description: [
      "Use a mouse and keyboard to interact with the page, and take screenshots.",
      "Coordinates are in the pixel space of the latest screenshot of that tab. Take a screenshot first.",
      "Clicks accept a ref (from read_page or find) or coordinates.",
      "Actions: screenshot, left_click, right_click, middle_click, double_click, triple_click, hover or mouse_move (moves the pointer without clicking), left_click_drag (start_coordinate or start_ref -> coordinate or ref; native HTML5 drag and drop works), type (text), key (text like 'Enter', 'cmd+a', 'ctrl+shift+t'; space-separated for sequences), scroll (scroll_direction, scroll_amount), scroll_to (ref), wait (duration seconds), zoom (region screenshot at full resolution).",
    ].join(" "),
    inputSchema: obj(
      {
        action: {
          type: "string",
          enum: [
            "screenshot",
            "left_click",
            "right_click",
            "middle_click",
            "double_click",
            "triple_click",
            "hover",
            "mouse_move",
            "left_click_drag",
            "type",
            "key",
            "scroll",
            "scroll_to",
            "wait",
            "zoom",
          ],
        },
        coordinate: coord,
        start_coordinate: { ...coord, description: "[x, y] drag start for left_click_drag." },
        start_ref: { type: "string", description: "Element ref to start a drag from (alternative to start_coordinate)." },
        ref: { type: "string", description: "Element ref from read_page/find, e.g. 'ref_12'. Alternative to coordinate." },
        text: { type: "string", description: "Text to type (type) or keys to press (key)." },
        modifiers: { type: "string", description: "Modifier keys held during a click: ctrl, shift, alt, cmd; combine with '+'." },
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "number", minimum: 1, maximum: 20, description: "Scroll ticks. Default 3." },
        duration: { type: "number", minimum: 0, maximum: 30, description: "Seconds to wait." },
        repeat: { type: "number", minimum: 1, maximum: 100, description: "Repeat count for key." },
        region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x0, y0, x1, y1] for zoom." },
        tabId,
      },
      ["action"],
    ),
    timeoutMs: 60_000,
  },
  {
    name: "screenshot",
    title: "Screenshot",
    description:
      "Capture a screenshot of a tab. fullPage=true captures one long image of the whole page: it scrolls through first so lazy images load, and on apps that scroll inside a panel (Gmail, Notion, dashboards) it stitches that panel. Up to 16,000 CSS px tall. Set save=true to also store it and get a download URL.",
    inputSchema: obj({
      tabId,
      fullPage: { type: "boolean" },
      format: { type: "string", enum: ["jpeg", "png"], description: "Default jpeg." },
      save: { type: "boolean", description: "Upload and return a download URL (cloud) or a file path (local)." },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_page",
    title: "Read accessibility tree",
    description:
      "Get an accessibility-tree view of the page: each element's role, name and a ref like 'ref_12' that other tools accept to act on that element. filter='interactive' returns only buttons, links and inputs. Output is limited to max_chars (default 50000).",
    inputSchema: obj({
      tabId,
      filter: { type: "string", enum: ["interactive", "all"], description: "Default all." },
      depth: { type: "number", description: "Max tree depth. Default 25." },
      ref_id: { type: "string", description: "Scope to the subtree under this ref." },
      max_chars: { type: "number" },
      viewportOnly: { type: "boolean", description: "Only elements visible in the viewport." },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "find",
    title: "Find elements",
    description:
      "Find elements matching a description, e.g. 'search box', 'Sign in button', 'price of the first result'. Returns up to 20 matches with refs and screenshot coordinates.",
    inputSchema: obj({ query: { type: "string" }, tabId, limit: { type: "number" } }, ["query"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "form_input",
    title: "Set form value",
    description:
      "Set the value of a form control by ref: text inputs and textareas (string), checkboxes and radios (boolean), selects (option value or visible text), contenteditable (string). Fires input and change events like a user would.",
    inputSchema: obj(
      { ref: { type: "string" }, value: { type: ["string", "number", "boolean"] }, tabId },
      ["ref", "value"],
    ),
  },
  {
    name: "get_page_text",
    title: "Get page text",
    description: "Get the readable text of the page (article or main content when present), plus title and URL.",
    inputSchema: obj({ tabId, max_chars: { type: "number", description: "Default 50000." } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "javascript_tool",
    title: "Run JavaScript",
    description:
      "Run JavaScript in the page's main world and return the value of the last expression (await is allowed). Runs even on pages with a strict CSP. Do not return huge objects.",
    inputSchema: obj(
      {
        text: { type: "string", description: "JavaScript code." },
        action: { type: "string", enum: ["javascript_exec"], description: "Optional, for Claude in Chrome compatibility." },
        tabId,
      },
      ["text"],
    ),
    timeoutMs: 60_000,
  },
  {
    name: "read_console_messages",
    title: "Read console",
    description:
      "Read console messages and uncaught errors from a tab, captured since the agent first touched it. Filter with a regex pattern.",
    inputSchema: obj({
      tabId,
      pattern: { type: "string" },
      onlyErrors: { type: "boolean" },
      clear: { type: "boolean" },
      limit: { type: "number", description: "Default 100." },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_network_requests",
    title: "Read network requests",
    description:
      "Read HTTP requests made by a tab (url, method, status, type, timing), captured since the agent first touched it. Filter by urlPattern (substring or regex).",
    inputSchema: obj({
      tabId,
      urlPattern: { type: "string" },
      clear: { type: "boolean" },
      limit: { type: "number", description: "Default 100." },
      includeBodies: { type: "boolean", description: "Include response bodies of up to 10 KB for XHR/fetch requests." },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "resize_window",
    title: "Resize window",
    description: "Resize the browser window that holds the tab.",
    inputSchema: obj({ width: { type: "number" }, height: { type: "number" }, tabId }, ["width", "height"]),
  },
  {
    name: "file_upload",
    title: "Upload files",
    description:
      "Put files into a file input or a drop zone without the native file picker. Give ref (the file input, its upload button or a drop zone from read_page), or leave ref out to fill a file picker the page just tried to open (click results tell you when). Pass paths (absolute paths on the computer running Chrome; the page gets real files) or files (each with base64, url or a screenshot imageId).",
    inputSchema: obj({
      ref: { type: "string", description: "File input, upload button or drop zone. Omit to fill a file picker that a click opened." },
      paths: { type: "array", items: { type: "string" }, description: "Absolute file paths on the computer running Chrome." },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            mimeType: { type: "string" },
            base64: { type: "string" },
            url: { type: "string" },
            imageId: { type: "string", description: "id returned by a screenshot." },
          },
          required: ["name"],
        },
      },
      tabId,
    }),
    timeoutMs: 60_000,
  },
  {
    name: "upload_image",
    title: "Upload screenshot",
    description:
      "Upload a captured screenshot (imageId) into a file input (ref) or drop it on a target (coordinate).",
    inputSchema: obj(
      { imageId: { type: "string" }, ref: { type: "string" }, coordinate: coord, filename: { type: "string" }, tabId },
      ["imageId"],
    ),
  },
  {
    name: "record",
    title: "Record video",
    description:
      "Record a video clip of a tab. action=start begins, action=stop finishes and returns a download URL (cloud) or file path (local) for an MP4 or WebM file, action=status reports progress. action=scroll makes a scrolling video in one call: it goes to the top, records a smooth, steady scroll to the bottom (to, speed in px per second, default 700) and returns the clip; during a running recording it only does the smooth scroll. The clip looks like a person using the page: the blue border, status pill and the cursor's name tag are left out, and the cursor is a normal arrow that turns into a hand over links and an I-beam over text (cursor=natural, the default). Use cursor=agent to show the agent cursor and indicators, or cursor=hidden for no cursor. The toolbar icon shows REC meanwhile. Max length 10 minutes.",
    inputSchema: obj(
      {
        action: { type: "string", enum: ["start", "stop", "status", "scroll"] },
        tabId,
        fps: { type: "number", description: "Frames per second, default 15 (30 for action=scroll)." },
        to: { type: "string", enum: ["bottom", "top"], description: "action=scroll: direction. Default bottom." },
        speed: { type: "number", minimum: 100, maximum: 4000, description: "action=scroll: pixels per second. Default 700." },
        fromStart: { type: "boolean", description: "action=scroll: jump to the top (or bottom) first. Default true." },
        format: { type: "string", enum: ["mp4", "webm"], description: "Default mp4 when Chrome supports it." },
        filename: { type: "string" },
        download: { type: "boolean", description: "Also save into the browser's Downloads folder." },
        cursor: { type: "string", enum: ["natural", "agent", "hidden"], description: "How the cursor looks in the clip. Default natural (hidden for action=scroll)." },
        showClicks: { type: "boolean", description: "Draw a soft ripple where clicks land. Default false." },
      },
      ["action"],
    ),
    timeoutMs: 200_000,
  },
  {
    name: "gif_creator",
    title: "Record GIF",
    description:
      "Record browser actions and export an animated GIF. action=start_recording, stop_recording, export (returns the GIF), clear.",
    inputSchema: obj(
      {
        action: { type: "string", enum: ["start_recording", "stop_recording", "export", "clear"] },
        cursor: { type: "string", enum: ["natural", "agent", "hidden"], description: "How the cursor looks in the GIF. Default natural." },
        showClicks: { type: "boolean", description: "Draw click ripples. Default false." },
        tabId,
        filename: { type: "string" },
        download: { type: "boolean" },
      },
      ["action"],
    ),
    timeoutMs: 120_000,
  },
  {
    name: "wait_for",
    title: "Wait for page condition",
    description:
      "Wait until text appears, a CSS selector matches, text disappears, or the URL matches. Returns as soon as the condition holds or fails after timeoutMs.",
    inputSchema: obj({
      tabId,
      text: { type: "string" },
      textGone: { type: "string" },
      selector: { type: "string" },
      urlIncludes: { type: "string" },
      timeoutMs: { type: "number", description: "Default 10000, max 60000." },
    }),
    timeoutMs: 70_000,
    annotations: { readOnlyHint: true },
  },
  {
    name: "handle_dialog",
    title: "Handle dialog",
    description:
      "Accept or dismiss a JavaScript alert/confirm/prompt/beforeunload dialog on a tab. Dialogs block the page until handled; tool results mention an open dialog.",
    inputSchema: obj({ accept: { type: "boolean" }, promptText: { type: "string" }, tabId }, ["accept"]),
  },
  {
    name: "history_search",
    title: "Search browsing history",
    description:
      "Search this Chrome profile's browsing history. Works only when the user turned on history access in the extension popup.",
    inputSchema: obj({ query: { type: "string" }, maxResults: { type: "number" }, daysBack: { type: "number" } }, ["query"]),
    annotations: { readOnlyHint: true },
  },
];

const target = {
  ref: { type: "string", description: "Element ref from read_page or find, e.g. 'ref_12'. Preferred." },
  coordinate: { ...coord, description: "[x, y] in the pixels of the latest screenshot, when there is no ref." },
};
const pick = (a: Record<string, any>, ...keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

// One tool per action for chat-app directories (Claude, ChatGPT): no generic executor, honest side-effect hints.
TOOLS.push(
  {
    name: "click",
    title: "Click",
    profile: "directory",
    description: "Click an element (by ref) or a point (by coordinate). A click can submit forms, buy things or send messages.",
    inputSchema: obj({ ...target, button: { type: "string", enum: ["left", "right", "middle"] }, clicks: { type: "number", enum: [1, 2, 3], description: "2 for double click, 3 for triple click." }, tabId }),
    via: { tool: "computer", map: (a) => ({ ...pick(a, "ref", "coordinate", "tabId", "browser"), action: a.button === "right" ? "right_click" : a.button === "middle" ? "middle_click" : a.clicks === 2 ? "double_click" : a.clicks === 3 ? "triple_click" : "left_click" }) },
  },
  {
    name: "type_text",
    title: "Type text",
    profile: "directory",
    description: "Type text into the focused field, or into the field given by ref (it is clicked first). It does not press Enter.",
    inputSchema: obj({ text: { type: "string" }, ref: target.ref, tabId }, ["text"]),
    via: { tool: "computer", map: (a) => ({ ...pick(a, "ref", "tabId", "browser"), action: "type", text: a.text }) },
  },
  {
    name: "press_key",
    title: "Press keys",
    profile: "directory",
    description: "Press a key or shortcut, e.g. 'Enter', 'Escape', 'Tab', 'cmd+a'. Space-separate several keys. Enter can submit forms.",
    inputSchema: obj({ keys: { type: "string" }, repeat: { type: "number", minimum: 1, maximum: 20 }, tabId }, ["keys"]),
    via: { tool: "computer", map: (a) => ({ ...pick(a, "repeat", "tabId", "browser"), action: "key", text: a.keys }) },
  },
  {
    name: "scroll",
    title: "Scroll",
    profile: "directory",
    description: "Scroll the page, or the element at ref/coordinate, in a direction. Use ref with scrollIntoView=true to bring an element into view.",
    inputSchema: obj({ direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number", minimum: 1, maximum: 20, description: "Default 3." }, ...target, scrollIntoView: { type: "boolean" }, tabId }),
    via: { tool: "computer", map: (a) => (a.scrollIntoView ? { ...pick(a, "ref", "tabId", "browser"), action: "scroll_to" } : { ...pick(a, "ref", "coordinate", "tabId", "browser"), action: "scroll", scroll_direction: a.direction ?? "down", scroll_amount: a.amount ?? 3 }) },
  },
  {
    name: "hover",
    title: "Hover",
    profile: "directory",
    description: "Move the pointer over an element or point, e.g. to open a menu or show a tooltip. Does not click.",
    inputSchema: obj({ ...target, tabId }),
    via: { tool: "computer", map: (a) => ({ ...pick(a, "ref", "coordinate", "tabId", "browser"), action: "hover" }) },
  },
  {
    name: "drag",
    title: "Drag and drop",
    profile: "directory",
    description: "Drag from one element or point to another. Works for HTML5 drag and drop and for sliders.",
    inputSchema: obj({ fromRef: { type: "string" }, from: { ...coord }, toRef: { type: "string" }, to: { ...coord }, tabId }),
    via: { tool: "computer", map: (a) => ({ ...pick(a, "tabId", "browser"), action: "left_click_drag", start_ref: a.fromRef, start_coordinate: a.from, ref: a.toRef, coordinate: a.to }) },
  },
  {
    name: "wait",
    title: "Wait",
    profile: "directory",
    description: "Wait a number of seconds (max 30), e.g. for an animation.",
    inputSchema: obj({ seconds: { type: "number", minimum: 0, maximum: 30 }, tabId }, ["seconds"]),
    via: { tool: "computer", map: (a) => ({ ...pick(a, "tabId", "browser"), action: "wait", duration: a.seconds }) },
  },
  {
    name: "zoom",
    title: "Zoom into a region",
    profile: "directory",
    description: "Take a full-resolution screenshot of a region [x0, y0, x1, y1] of the latest screenshot, to read small text.",
    inputSchema: obj({ region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 }, tabId }, ["region"]),
    via: { tool: "computer", map: (a) => ({ ...pick(a, "region", "tabId", "browser"), action: "zoom" }) },
  },
);
// Group management split into read, write and destructive tools for directories (no mixed read/write tool).
const groupProps = { groupId: { type: "number", description: "Default: this session's group." } };
TOOLS.push(
  {
    name: "list_tab_groups",
    title: "List tab groups",
    profile: "directory",
    description: "List the Chrome tab groups in this profile with their titles, colors and tabs. Shows which one is this session's group.",
    inputSchema: obj({}),
    via: { tool: "tab_groups", map: (a) => ({ ...pick(a, "browser"), action: "list" }) },
  },
  {
    name: "update_tab_group",
    title: "Rename or recolor a tab group",
    profile: "directory",
    description: "Rename, recolor, collapse or expand a tab group (default: this session's group).",
    inputSchema: obj({ ...groupProps, title: { type: "string" }, color: { type: "string", enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] }, collapsed: { type: "boolean" } }),
    via: { tool: "tab_groups", map: (a) => ({ ...pick(a, "groupId", "title", "color", "collapsed", "browser"), action: "update" }) },
  },
  {
    name: "close_tab_group",
    title: "Close a tab group",
    profile: "directory",
    description: "Close every tab in this session's tab group. Unsaved work in those tabs is lost.",
    inputSchema: obj({}),
    via: { tool: "tab_groups", map: (a) => ({ ...pick(a, "browser"), action: "close" }) },
  },
);
for (const t of TOOLS) if (["computer", "javascript_tool", "history_search", "tab_groups"].includes(t.name)) t.profile = "agent";

// Hints for clients that ask before running tools with side effects (ChatGPT, Claude). Every tool acts on the open web.
// Not read-only: tabs_context can open a tab and renames the group; scroll and hover can load content or open menus.
const READ_ONLY = new Set(["list_tab_groups", "list_browsers", "screenshot", "read_page", "find", "get_page_text", "read_console_messages", "read_network_requests", "wait_for", "history_search", "wait", "zoom"]);
// Actions whose effects may not be undoable: closing tabs or groups, clicks and keys that can submit, scripts, uploads.
const DESTRUCTIVE = new Set(["handle_dialog", "tabs_close", "tab_groups", "close_tab_group", "click", "press_key", "computer", "javascript_tool", "file_upload", "upload_image"]);
for (const t of TOOLS) {
  t.annotations = {
    title: t.title,
    readOnlyHint: READ_ONLY.has(t.name),
    destructiveHint: DESTRUCTIVE.has(t.name),
    idempotentHint: READ_ONLY.has(t.name),
    openWorldHint: !t.server,
  };
}

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const inProfile = (t: ToolDef, profile: Profile) => !t.profile || t.profile === profile;

export function publicTools(profile: Profile = "agent") {
  return TOOLS.filter((t) => inProfile(t, profile)).map(({ name, title, description, inputSchema, annotations }) => {
    // Chat apps get a strictly read-only screenshot: saving uploads a file, which is a side effect.
    if (profile === "directory" && name === "screenshot") {
      const { save: _save, ...properties } = (inputSchema as any).properties ?? {};
      inputSchema = { ...(inputSchema as any), properties };
      description = description.replace(/ Set save=true[^.]*\./, "");
    }
    // Clearing the capture buffer is a write, so read-only log tools drop it for chat apps.
    if (profile === "directory" && (name === "read_console_messages" || name === "read_network_requests")) {
      const { clear: _clear, ...properties } = (inputSchema as any).properties ?? {};
      inputSchema = { ...(inputSchema as any), properties };
    }
    return {
    name,
    title,
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
    // Every tool needs the signed-in user (OpenAI per-tool auth declaration).
    securitySchemes: [{ type: "oauth2", scopes: ["browser"] }],
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["browser"] }] },
    };
  });
}
