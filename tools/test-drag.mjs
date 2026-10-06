/**
 * Unit tests for the chrome-less window drag gesture (dev only).
 *
 * The gesture has one job: turn a *moved* press into a window drag while
 * leaving a plain press completely alone. These tests pin the decisions that
 * matter — the threshold, the single fire per gesture, and the click
 * suppression, which is what keeps dragging from accidentally summoning the
 * butterfly.
 *
 * Usage: node tools/test-drag.mjs
 */
import { DragGesture, DRAG_THRESHOLD, attachWindowDrag } from "../src/lib/desktop/drag.ts";
import { startDragging } from "../src/lib/desktop/window.ts";
import { isDesktop } from "../src/lib/platform.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

// --- Environment: none of this may touch a real window outside Tauri ---
check("drag is disabled outside the desktop shell", isDesktop === false);

const detach = attachWindowDrag();
check(
  "installing the gesture without a DOM is a safe no-op",
  typeof detach === "function",
);
detach();

await startDragging();
check("startDragging outside Tauri resolves instead of throwing", true);

check(
  "threshold is small enough to feel immediate, large enough to be deliberate",
  DRAG_THRESHOLD >= 2 && DRAG_THRESHOLD <= 12,
  `${DRAG_THRESHOLD}px`,
);

// --- A plain press must never become a drag ---
{
  const gesture = new DragGesture();
  gesture.begin(100, 100);
  gesture.move(102, 101); // finger jitter below the threshold
  gesture.end();
  check("press without movement is not a drag", gesture.consumeClick() === false);
  check("no click is swallowed for a plain press", gesture.consumeClick() === false);
}

{
  const gesture = new DragGesture();
  gesture.begin(0, 0);
  const fired = gesture.move(DRAG_THRESHOLD - 0.01, 0);
  gesture.end();
  check("movement just under the threshold does not drag", fired === false);
}

// --- Crossing the threshold ---
{
  const gesture = new DragGesture();
  gesture.begin(0, 0);
  const fired = gesture.move(0, DRAG_THRESHOLD);
  check(
    "movement exactly at the threshold drags",
    fired === true,
    `threshold=${DRAG_THRESHOLD}px`,
  );

  // Further movement must not re-hand the window to the OS mid-gesture.
  const again = gesture.move(400, 400);
  check("drag fires only once per gesture", again === false);

  // The click that ends the gesture arrives after pointer up: it must still
  // be swallowed, exactly once, so the scene never sees it.
  gesture.end();
  check("click after the drag is swallowed", gesture.consumeClick() === true);
  check("swallowing happens exactly once", gesture.consumeClick() === false);
}

{
  // Diagonal movement is measured with true distance, not per-axis.
  const gesture = new DragGesture();
  gesture.begin(0, 0);
  check(
    "diagonal movement under the threshold does not drag",
    gesture.move(4, 4) === false,
    `distance=${Math.hypot(4, 4).toFixed(2)}`,
  );
}

// --- Lifecycle: suppression must never leak into a later gesture ---
{
  const gesture = new DragGesture();
  // A drag whose click never arrives (the OS consumed the gesture).
  gesture.begin(0, 0);
  gesture.move(50, 0);
  gesture.end();
  check("suppression survives until the click arrives", gesture.consumeClick() === true);

  // Starting the next gesture clears anything still pending.
  gesture.begin(0, 0);
  check(
    "a stale suppression cannot swallow the next plain click",
    gesture.consumeClick() === false,
  );
}

{
  const gesture = new DragGesture();
  gesture.begin(0, 0);
  gesture.move(50, 0);
  gesture.cancel(); // pointer cancelled / window blurred mid-gesture
  check("cancel drops the suppression", gesture.consumeClick() === false);
  check("movement after cancel is ignored", gesture.move(50, 0) === false);
}

check(
  "move() before begin() is ignored",
  new DragGesture().move(50, 0) === false,
);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
