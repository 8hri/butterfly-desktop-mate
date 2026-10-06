/**
 * Dev verification harness: launches headless Chrome via CDP, captures all
 * console messages / page errors / failed requests, waits for the scene to
 * settle, then writes a screenshot and prints a summary.
 *
 * Usage: node tools/verify.mjs [url] [outPng] [width] [height] [waitMs]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findButterfly } from "./butterfly-centroid.mjs";

const CHROME =
  process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const [, , url = "http://localhost:4173/", out = "shot.png", w = "1280", h = "800", waitMs = "9000"] =
  process.argv;

const profile = mkdtempSync(join(tmpdir(), "cdp-"));
const port = 9222 + Math.floor(Math.random() * 400);

const chrome = spawn(CHROME, [
  "--headless=new",
  `--user-data-dir=${profile}`,
  "--enable-unsafe-swiftshader",
  "--no-first-run",
  "--disable-extensions",
  "--window-size=" + w + "," + h,
  `--remote-debugging-port=${port}`,
  "about:blank",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome DevTools endpoint never became available");
}

const messages = [];
const failures = [];

const page = await findTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case "Runtime.consoleAPICalled":
      messages.push({
        type: msg.params.type,
        text: msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "),
      });
      break;
    case "Runtime.exceptionThrown": {
      const d = msg.params.exceptionDetails;
      failures.push("EXCEPTION: " + (d.exception?.description ?? d.text));
      break;
    }
    case "Log.entryAdded": {
      const e = msg.params.entry;
      if (e.level === "error") failures.push(`LOG[${e.source}]: ${e.text}`);
      break;
    }
    case "Network.loadingFailed":
      failures.push(`NET FAIL: ${msg.params.errorText} (${msg.params.type})`);
      break;
  }
});

const send = (method, params = {}) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: Number(w),
  height: Number(h),
  deviceScaleFactor: 1,
  mobile: process.env.MOBILE === "1",
});

// Accessibility emulation: prefers-reduced-motion and touch/coarse pointer.
if (process.env.REDUCED_MOTION === "1") {
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
}
if (process.env.MOBILE === "1") {
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}

// Desktop simulation: Tauri injects its marker into the webview before any app
// code runs, which is exactly what `src/lib/platform.ts` looks for.
if (process.env.DESKTOP === "1") {
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__TAURI_INTERNALS__ = { __simulated: true };",
  });
}

await send("Page.navigate", { url });
await sleep(Number(waitMs));

// Page transparency, asserted from computed styles before anything (below)
// paints over the stylesheet.
let bgResult = null;
if (process.env.BG_CHECK === "1") {
  bgResult = await runBackgroundCheck();
}

// Optional: paint a probe colour behind the page. In desktop mode the canvas
// is transparent, so this colour shows through wherever the scene does not
// paint, which makes transparency verifiable from the screenshot.
if (process.env.PROBE_BG === "1") {
  await send("Runtime.evaluate", {
    expression: `document.documentElement.style.background = "rgb(255,0,0)";
                 document.body.style.background = "rgb(255,0,0)";`,
  });
  await sleep(400);
}

// Probe the live scene state so verification is more than a pixel guess.
const probe = await send("Runtime.evaluate", {
  expression: `(() => {
    const c = document.querySelector("canvas");
    const loader = document.querySelector(".loader");
    return JSON.stringify({
      canvas: c ? { engine: c.dataset.engine, w: c.width, h: c.height } : null,
      loaderDone: loader ? loader.classList.contains("loader--done") : null,
      rootHtmlLen: document.getElementById("root")?.innerHTML.length ?? 0,
    });
  })()`,
  returnByValue: true,
});

const shots = [];

/**
 * Click-targeting assertion.
 *
 * Locates the butterfly before and after a click at a known screen position
 * and checks that it actually travels toward that region. This is what
 * distinguishes real targeting from merely turning toward the click and
 * staying centred.
 *
 * TARGET_CHECK=right|left|upper|lower|center|topleft|topright|bottomleft|bottomright
 */
/** Screen point of a named click region, in CSS pixels. */
function clickPoint(kind, width, height) {
  const points = {
    right: [Math.round(width * 0.88), Math.round(height * 0.5)],
    left: [Math.round(width * 0.12), Math.round(height * 0.5)],
    upper: [Math.round(width * 0.5), Math.round(height * 0.14)],
    lower: [Math.round(width * 0.5), Math.round(height * 0.86)],
    center: [Math.round(width * 0.5), Math.round(height * 0.5)],
    topleft: [Math.round(width * 0.12), Math.round(height * 0.14)],
    topright: [Math.round(width * 0.88), Math.round(height * 0.14)],
    bottomleft: [Math.round(width * 0.12), Math.round(height * 0.86)],
    bottomright: [Math.round(width * 0.88), Math.round(height * 0.86)],
  };
  return points[kind];
}

async function runTargetCheck(kind) {
  const width = Number(w);
  const height = Number(h);
  const [clickX, clickY] = clickPoint(kind, width, height);

  const sample = async () => {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (!shot?.data) return null;
    return findButterfly(Buffer.from(shot.data, "base64"));
  };

  // Baseline: two samples before the click.
  const baseline = [await sample(), await (sleep(700), sample())];
  const usable = baseline.filter((s) => s && s.count > 0);
  if (usable.length < 2) return { ok: false, reason: "butterfly not visible before click" };
  const baseX = usable.reduce((s, p) => s + p.cx / p.width, 0) / usable.length;
  const baseY = usable.reduce((s, p) => s + p.cy / p.height, 0) / usable.length;

  await mouse("mouseMoved", clickX, clickY);
  await sleep(80);
  await mouse("mousePressed", clickX, clickY);
  await mouse("mouseReleased", clickX, clickY);

  // Sample the directed flight itself; the framing returns to normal once the
  // butterfly has arrived, by design. The window is long enough to catch the
  // peak excursion, which lags the click because of the camera damping — and
  // dense enough not to miss it between samples: the follow camera absorbs
  // most of the travel, so the measurable shift is the lean peak, which is
  // brief relative to the flight.
  const samples = [];
  for (let i = 0; i < 12; i++) {
    await sleep(480);
    const s = await sample();
    if (s && s.count > 0) samples.push(s);
  }
  if (!samples.length) return { ok: false, reason: "butterfly not visible after click" };

  const nx = samples.map((s) => s.cx / s.width);
  const ny = samples.map((s) => s.cy / s.height);
  const peakX = Math.max(...nx);
  const troughX = Math.min(...nx);
  const peakY = Math.min(...ny); // smaller y = higher on screen
  const troughY = Math.max(...ny);
  // Where it rests at the end of the window (the live pointer target keeps it
  // parked near the clicked region once it has arrived).
  const tail = Math.min(2, nx.length);
  const endX = nx.slice(-tail).reduce((s, v) => s + v, 0) / tail;
  const endY = ny.slice(-tail).reduce((s, v) => s + v, 0) / tail;
  const clickNx = clickX / width;
  const clickNy = clickY / height;
  // Continuity: the largest jump between consecutive samples (a teleport
  // would dwarf any real per-sample motion).
  let maxStep = 0;
  for (let i = 1; i < nx.length; i++) {
    maxStep = Math.max(maxStep, Math.hypot(nx[i] - nx[i - 1], ny[i] - ny[i - 1]));
  }

  const horizontal = {
    right: peakX - baseX,
    left: baseX - troughX,
    topright: peakX - baseX,
    bottomright: peakX - baseX,
    topleft: baseX - troughX,
    bottomleft: baseX - troughX,
  }[kind];
  const signedVertical = {
    upper: baseY - peakY,
    lower: troughY - baseY,
    topright: baseY - peakY,
    topleft: baseY - peakY,
    bottomright: troughY - baseY,
    bottomleft: troughY - baseY,
  }[kind];

  // Centre: the butterfly may start anywhere (fixed desktop framing), so the
  // contract is arrival + continuity: it must end up in the centre region
  // without any teleport-sized jump along the way.
  if (kind === "center") {
    const arrived = Math.abs(endX - 0.5) < 0.22 && Math.abs(endY - 0.5) < 0.25;
    const continuous = maxStep < 0.35;
    const ok = arrived && continuous;
    console.log(
      `TARGET(center) click=(${clickX},${clickY}) base=(${baseX.toFixed(3)},${baseY.toFixed(3)})` +
        ` end=(${endX.toFixed(3)},${endY.toFixed(3)}) arrived=${arrived}` +
        ` maxStep=${maxStep.toFixed(3)} limit=0.35`,
    );
    return {
      ok,
      shift: Math.abs(endX - 0.5),
      reason: ok
        ? ""
        : !arrived
          ? "centre click did not bring the butterfly to the centre region"
          : "butterfly jumped discontinuously between samples",
    };
  }

  // Corners: full-window travel must reach BOTH the clicked side and the
  // clicked height — either measurably travelling that way, or arriving in
  // the region (it may have started on the far side of either axis).
  if (kind.startsWith("top") || kind.startsWith("bottom")) {
    const travelledX = horizontal > 0.04;
    const arrivedX = Math.abs(endX - clickNx) < 0.2;
    const travelledY = signedVertical > 0.02;
    const arrivedY = Math.abs(endY - clickNy) < 0.24;
    const ok = (travelledX || arrivedX) && (travelledY || arrivedY);
    console.log(
      `TARGET(${kind}) click=(${clickX},${clickY}) base=(${baseX.toFixed(3)},${baseY.toFixed(3)})` +
        ` end=(${endX.toFixed(3)},${endY.toFixed(3)})` +
        ` hShift=${horizontal.toFixed(3)}${travelledX ? "+" : ""}${arrivedX ? " arrivedX" : ""}` +
        ` vShift=${signedVertical.toFixed(3)}${travelledY ? "+" : ""}${arrivedY ? " arrivedY" : ""}`,
    );
    return {
      ok,
      shift: Math.min(horizontal, signedVertical),
      reason: ok ? "" : "butterfly did not reach the clicked corner region",
    };
  }

  // Horizontal: the click resolves to a target left/right of the butterfly,
  // so it must travel that way — or rest in the clicked region, which also
  // covers starting beyond the click (it then travels *back* to the region).
  if (horizontal !== undefined) {
    const threshold = 0.04;
    const travelled = horizontal > threshold;
    const arrived =
      kind === "right" ? endX >= clickNx - 0.2 : endX <= clickNx + 0.2;
    const ok = travelled || arrived;
    console.log(
      `TARGET(${kind}) click=(${clickX},${clickY}) base=(${baseX.toFixed(3)},${baseY.toFixed(3)})` +
        ` peakX=${peakX.toFixed(3)} troughX=${troughX.toFixed(3)} shift=${horizontal.toFixed(3)}` +
        ` threshold=${threshold} endX=${endX.toFixed(3)}${arrived ? " arrived" : ""}`,
    );
    return {
      ok,
      shift: horizontal,
      reason: ok ? "" : "butterfly did not travel toward the click",
    };
  }

  // Vertical: altitude is an absolute world value, so a high click maps to a
  // high *place* rather than a climb. If the butterfly is already above that
  // altitude it descends instead, and the on-screen sign flips. The mapping
  // itself is verified deterministically in test-targeting.mjs; here we only
  // assert that the click produced a clearly distinct screen position.
  const magnitude = Math.max(Math.abs(baseY - peakY), Math.abs(baseY - troughY));
  const direction =
    signedVertical > 0.01 ? "toward" : signedVertical < -0.01 ? "away from" : "level with";
  console.log(
    `TARGET(${kind}) click=(${clickX},${clickY}) base=(${baseX.toFixed(3)},${baseY.toFixed(3)})` +
      ` peakY=${peakY.toFixed(3)} troughY=${troughY.toFixed(3)}` +
      ` signedShift=${signedVertical.toFixed(3)} (${direction} the click)` +
      ` magnitude=${magnitude.toFixed(3)} threshold=0.02`,
  );
  return {
    ok: magnitude > 0.02,
    shift: magnitude,
    reason: magnitude > 0.02 ? "" : "butterfly barely changed its vertical position",
  };
}

/**
 * Long-horizon movement trace (TRACK_CHECK=<kind>, TRACK_MS=<ms>).
 *
 * Clicks a known point, then records — several times a second — three
 * independent signals:
 *
 *   1. the butterfly's on-screen position (where it actually is)
 *   2. its wing-pixel area (whether the animation is still advancing)
 *   3. a raw requestAnimationFrame counter (whether the page animates at all)
 *
 * Together they separate the ways "it froze" can happen: a stalled frame
 * counter means the page stopped (visibility throttling); a running counter
 * with a still butterfly means the scene loop or the flight state machine
 * stopped; a healthy trajectory means click -> flight -> idle -> wander keeps
 * cycling. Diagnostic: prints, and never gates the exit code.
 */
async function runTrackCheck(kind) {
  const width = Number(w);
  const height = Number(h);
  const [clickX, clickY] = clickPoint(kind, width, height);
  const totalMs = Number(process.env.TRACK_MS ?? 30000);
  const interval = 400;

  // Independent of the app: counts every animation frame the page delivers.
  await send("Runtime.evaluate", {
    expression:
      "if (!window.__frameProbe) { window.__frameProbe = 0;" +
      "(function tick() { window.__frameProbe++; requestAnimationFrame(tick); })(); }",
  });
  const readFrames = async () => {
    const r = await send("Runtime.evaluate", {
      expression: "window.__frameProbe",
      returnByValue: true,
    });
    return Number(r?.result?.value ?? 0);
  };
  const sample = async () => {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (!shot?.data) return null;
    const s = findButterfly(Buffer.from(shot.data, "base64"));
    if (!s.count) return null;
    return { x: s.cx / s.width, y: s.cy / s.height, wings: s.count };
  };

  // The click itself: identical geometry to the targeting check.
  await mouse("mouseMoved", clickX, clickY);
  await sleep(80);
  await mouse("mousePressed", clickX, clickY);
  await mouse("mouseReleased", clickX, clickY);

  const rows = [];
  let prevFrames = await readFrames();
  let prev = null;
  const started = Date.now();
  while (Date.now() - started < totalMs) {
    await sleep(interval);
    const current = await sample();
    const frames = await readFrames();
    const row = {
      t: (Date.now() - started) / 1000,
      s: current,
      df: frames - prevFrames,
      dx: null,
      dw: null,
    };
    prevFrames = frames;
    if (current && prev) {
      row.dx = Math.hypot((current.x - prev.x) * width, (current.y - prev.y) * height);
      row.dw = Math.abs(current.wings - prev.wings);
    }
    rows.push(row);
    if (current) prev = current;
  }

  for (const row of rows) {
    console.log(
      `TRACK t=${row.t.toFixed(1)}s` +
        ` pos=${row.s ? `(${row.s.x.toFixed(2)},${row.s.y.toFixed(2)})` : "lost"}` +
        ` move=${row.dx == null ? "-" : `${row.dx.toFixed(1)}px`}` +
        ` wings=${row.s ? row.s.wings : "-"}${row.dw == null ? "" : ` (d${row.dw})`}` +
        ` frames=+${row.df}`,
    );
  }

  const measured = rows.filter((row) => row.dx != null);
  const late = measured.filter((row) => row.t > 5); // past a typical arrival
  const lateMoving = late.filter((row) => row.dx > 0.8).length;
  const tail = measured.slice(-12);
  const tailMoving = tail.filter((row) => row.dx > 0.8).length;
  const tailWings = tail.reduce((sum, row) => sum + (row.dw ?? 0), 0);

  console.log(
    `TRACK SUMMARY: samples=${rows.length} lost=${rows.filter((r) => !r.s).length}` +
      ` frameStalls=${rows.filter((r) => r.df === 0).length}` +
      ` lateMoved=${lateMoving}/${late.length}` +
      ` tailMoved=${tailMoving}/${tail.length}` +
      ` tailWingDelta=${tailWings}`,
  );
}

/**
 * Autonomous edge-preference observation (EDGE_CHECK=1).
 *
 * Unlike the click checks, this one never clicks: it lets the butterfly pick
 * its own destinations for a while and records how close to the frame edges it
 * chooses to come. That is exactly the decision the Phase 13A.2 preference
 * touches.
 *
 * It asserts only what one browser run can honestly assert — the butterfly
 * stays inside the viewport, keeps moving, keeps flapping, never stalls a
 * frame. Whether the preference reads as *subtle* rather than theatrical is a
 * judgement for a human on real hardware; the statistical side of the effect
 * is pinned deterministically by `tools/test-flight.mjs`, which averages over
 * hundreds of simulated runs instead of one.
 */
async function runEdgeCheck() {
  const width = Number(w);
  const height = Number(h);
  const totalMs = Number(process.env.EDGE_MS ?? 60000);
  const interval = 500;
  const shortSide = Math.min(width, height);

  await send("Runtime.evaluate", {
    expression:
      "if (!window.__frameProbe) { window.__frameProbe = 0;" +
      "(function tick() { window.__frameProbe++; requestAnimationFrame(tick); })(); }",
  });
  const readFrames = async () => {
    const r = await send("Runtime.evaluate", {
      expression: "window.__frameProbe",
      returnByValue: true,
    });
    return Number(r?.result?.value ?? 0);
  };
  const sample = async () => {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (!shot?.data) return null;
    const s = findButterfly(Buffer.from(shot.data, "base64"));
    if (!s.count) return null;
    return { x: s.cx / s.width, y: s.cy / s.height, wings: s.count };
  };

  const rows = [];
  let prevFrames = await readFrames();
  let prev = null;
  const started = Date.now();
  while (Date.now() - started < totalMs) {
    await sleep(interval);
    const current = await sample();
    const frames = await readFrames();
    rows.push({
      t: (Date.now() - started) / 1000,
      s: current,
      df: frames - prevFrames,
      dx: prev && current
        ? Math.hypot((current.x - prev.x) * width, (current.y - prev.y) * height)
        : null,
      dw: prev && current ? Math.abs(current.wings - prev.wings) : null,
    });
    prevFrames = frames;
    if (current) prev = current;
  }

  const seen = rows.filter((row) => row.s);
  const edgePx = (row) =>
    Math.min(row.s.x, 1 - row.s.x, row.s.y, 1 - row.s.y) * shortSide;
  const distances = seen.map(edgePx);
  const pressed = seen.filter((row) => edgePx(row) < 0.05 * shortSide);
  const moving = rows.filter((row) => row.dx != null && row.dx > 0.8).length;
  const wingDelta = rows.reduce((sum, row) => sum + (row.dw ?? 0), 0);
  const outside = seen.filter(
    (row) => row.s.x < 0 || row.s.x > 1 || row.s.y < 0 || row.s.y > 1,
  );
  const min = distances.length ? Math.min(...distances) : 0;
  const mean = distances.length
    ? distances.reduce((a, b) => a + b, 0) / distances.length
    : 0;
  const share = (pressed.length / Math.max(1, seen.length)) * 100;

  console.log(
    `EDGE SUMMARY: samples=${seen.length}/${rows.length}` +
      ` frameStalls=${rows.filter((r) => r.df === 0).length}` +
      ` moved=${moving}/${rows.length - 1}` +
      ` wingDelta=${wingDelta}` +
      ` minEdgePx=${min.toFixed(1)} meanEdgePx=${mean.toFixed(1)}` +
      ` pressedShare=${share.toFixed(1)}%` +
      ` outsideViewport=${outside.length}`,
  );

  const problems = [];
  const fail = (message) => {
    problems.push(message);
    console.log(`EDGE PROBLEM: ${message}`);
  };
  if (seen.length < rows.length / 2) fail("the butterfly was lost for most samples");
  if (rows.some((row) => row.df === 0)) fail("a frame stalled");
  if (moving < (rows.length - 1) * 0.5) fail("the butterfly stopped moving");
  if (wingDelta === 0) fail("the wings stopped moving");
  if (outside.length) fail("the butterfly left the viewport");
  if (min <= 0) fail("the butterfly touched the frame edge");
  edgeResult = {
    problems: problems.length,
    notes: [
      `nearest approach to a frame edge ${min.toFixed(1)}px (mean ${mean.toFixed(1)}px); ` +
        `${share.toFixed(1)}% of samples within 5% of an edge`,
    ],
  };
}

/**
 * Page-transparency assertion (BG_CHECK=1).
 *
 * The native window is transparent, so nothing in the page may paint a
 * background on the desktop: not the html root, not the body, not the
 * loading veil, not the failure state. Computed styles are what decide this
 * — which is exactly what PROBE_BG cannot see, because it replaces the
 * stylesheet with an inline colour before it looks, proving only that the
 * *canvas* is transparent.
 *
 * Web mode is asserted in reverse: the theme background and the loader must
 * still be there, so the desktop rules can never leak into the browser.
 */
async function runBackgroundCheck() {
  const probe = await send("Runtime.evaluate", {
    expression: `(() => {
      const style = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, display: s.display };
      };
      return JSON.stringify({
        html: style("html"),
        body: style("body"),
        app: style(".app"),
        loader: style(".loader"),
        failure: style(".failure"),
        // The attribution line is omitted at the source on the desktop.
        credit: !!document.querySelector(".overlay__credit"),
        markers: [
          document.documentElement.classList.contains("is-desktop"),
          document.body.classList.contains("is-desktop"),
        ],
      });
    })()`,
    returnByValue: true,
  });

  let value = {};
  try {
    value = JSON.parse(probe?.result?.value ?? "{}");
  } catch {
    value = {};
  }

  const desktop = process.env.DESKTOP === "1";
  const clear = (surface) =>
    surface && (surface.bg === "rgba(0, 0, 0, 0)" || surface.bg === "transparent");
  const problems = [];

  if (desktop) {
    for (const key of ["html", "body", "app"]) {
      if (!value[key]) problems.push(`${key} missing`);
      else if (!clear(value[key])) problems.push(`${key} paints ${value[key].bg}`);
    }
    if (value.loader?.display !== "none") {
      problems.push(`loader display=${value.loader?.display ?? "missing"}, expected none`);
    }
    if (value.markers?.[0] !== true || value.markers?.[1] !== true) {
      problems.push(`is-desktop markers=${JSON.stringify(value.markers)}`);
    }
    // The failure state only exists when it renders; judge it if it does.
    if (value.failure && !clear(value.failure)) {
      problems.push(`failure paints ${value.failure.bg}`);
    }
    if (value.credit !== false) {
      problems.push("attribution line is still rendered on the desktop");
    }
  } else {
    if (value.body?.bg !== "rgb(234, 242, 240)") {
      problems.push(`web body paints ${value.body?.bg ?? "missing"}, expected the theme colour`);
    }
    if (value.loader?.display === "none") problems.push("web loader is hidden (desktop rule leaked)");
    if (value.markers?.[0] || value.markers?.[1]) problems.push("is-desktop markers set in web mode");
    if (value.credit !== true) problems.push("attribution line missing in web mode (licence)");
  }

  console.log(`BG(${desktop ? "desktop" : "web"}): ${JSON.stringify(value)}`);
  for (const problem of problems) console.log(`  ${problem}`);
  return { ok: problems.length === 0 };
}

const shotCount = Number(process.env.SHOTS ?? 1);
const shotGap = Number(process.env.SHOT_GAP_MS ?? 2500);

// Optional scripted input, e.g. ACTIONS="move:600,300;wait:800;click:220,420"
const actions = (process.env.ACTIONS ?? "").split(";").filter(Boolean);
const mouse = async (type, x, y) => {
  await send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons: type === "mouseMoved" ? 0 : 1,
    clickCount: 1,
  });
};
for (const action of actions) {
  const [kind, raw] = action.split(":");
  if (kind === "move") {
    const [x, y] = raw.split(",").map(Number);
    await mouse("mouseMoved", x, y);
  } else if (kind === "click") {
    const [x, y] = raw.split(",").map(Number);
    await mouse("mouseMoved", x, y);
    await sleep(80);
    await mouse("mousePressed", x, y);
    await mouse("mouseReleased", x, y);
  } else if (kind === "wait") {
    await sleep(Number(raw));
  }
}

// Click-targeting assertion runs after the scripted input helpers exist.
let targetResult = null;
let edgeResult = null;
if (process.env.TARGET_CHECK) {
  targetResult = await runTargetCheck(process.env.TARGET_CHECK);
}

// Long-horizon movement trace: click, then watch the butterfly for several
// seconds to see whether it keeps living after the flight.
if (process.env.TRACK_CHECK) {
  await runTrackCheck(process.env.TRACK_CHECK);
}

// Autonomous edge-preference observation: no clicks, so every destination is
// the butterfly's own choice.
if (process.env.EDGE_CHECK === "1") {
  await runEdgeCheck();
}

for (let i = 0; i < shotCount; i++) {
  if (i > 0) await sleep(shotGap);
  const file = shotCount > 1 ? out.replace(/\.png$/, `-${i + 1}.png`) : out;
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot?.data) {
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    shots.push(file);
  }
}

const probe2 = await send("Runtime.evaluate", {
  expression: `(() => {
    const c = document.querySelector("canvas");
    const loader = document.querySelector(".loader");
    let lost = null;
    try { const gl = c && c.getContext("webgl2"); lost = gl ? gl.isContextLost() : "no-context"; } catch (e) { lost = "err:" + e.message; }
    return JSON.stringify({
      canvasPresent: !!c,
      canvasSize: c ? [c.width, c.height] : null,
      contextLost: lost,
      desktopClass: document.documentElement.classList.contains("is-desktop"),
      loaderClass: loader ? loader.className : null,
      appChildren: document.querySelector(".app")?.children.length ?? -1,
      html: document.getElementById("root")?.innerHTML.slice(0, 260) ?? "",
    });
  })()`,
  returnByValue: true,
});

console.log("PROBE:", probe?.result?.value ?? JSON.stringify(probe));
console.log("PROBE2:", probe2?.result?.value ?? JSON.stringify(probe2));
console.log("CONSOLE:", messages.length);
for (const m of messages) console.log(`  [${m.type}] ${m.text}`);
console.log("PROBLEMS:", failures.length);
for (const f of [...new Set(failures)]) console.log("  " + f);
if (edgeResult) {
  console.log("EDGE RESULT:", edgeResult.problems === 0 ? "PASS" : "FAIL");
  for (const note of edgeResult.notes) console.log("  " + note);
  for (const problem of failures) console.log("  " + problem);
}
console.log("SCREENSHOTS:", shots.join(", ") || "(none)");

let targetOk = true;
if (targetResult) {
  targetOk = targetResult.ok;
  console.log(
    `TARGET RESULT: ${targetOk ? "PASS" : "FAIL"}${targetResult.reason ? "  — " + targetResult.reason : ""}`,
  );
}

let bgOk = true;
if (bgResult) {
  bgOk = bgResult.ok;
  console.log(`BG RESULT: ${bgOk ? "PASS" : "FAIL"}`);
}

ws.close();
chrome.kill();
process.exit(failures.length || !targetOk || !bgOk ? 1 : 0);
