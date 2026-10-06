/**
 * Unit tests for the window-mode model (dev only).
 *
 * The mode model is deliberately tiny — two modes, one validator, one pure
 * description of which desktop subsystems run — but it is the single
 * vocabulary every layer gates on, so its shape and its defaults are pinned
 * here. The native transition itself (`set_window_mode`) is covered by the
 * static architecture checks in `check-desktop.mjs`.
 *
 * Usage: node tools/test-app-mode.mjs
 */
import {
  APP_MODES,
  DEFAULT_APP_MODE,
  desktopSystemsActive,
  isAppMode,
} from "../src/lib/appMode.ts";
import * as appModeModule from "../src/lib/appMode.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

// --- The vocabulary is exactly two modes -------------------------------------
check(
  "the modes are exactly desktop and garden",
  APP_MODES.length === 2 && APP_MODES[0] === "desktop" && APP_MODES[1] === "garden",
  APP_MODES.join(","),
);
check(
  "the application always launches as the desktop companion",
  DEFAULT_APP_MODE === "desktop",
);

// --- Boundary validation -------------------------------------------------------
check(
  "both modes validate at the boundary",
  isAppMode("desktop") && isAppMode("garden"),
);
check(
  "unknown values are rejected, not coerced",
  !isAppMode("Desktop") &&
    !isAppMode("garden ") &&
    !isAppMode("") &&
    !isAppMode("overlay") &&
    !isAppMode(null) &&
    !isAppMode(undefined) &&
    !isAppMode(0),
);

// --- Which desktop subsystems a mode runs ---------------------------------------
{
  const desktop = desktopSystemsActive("desktop");
  check(
    "desktop mode runs every desktop subsystem",
    desktop.cursorPolling && desktop.hitTesting && desktop.environmentRefresh &&
      desktop.foregroundAwareness,
  );
  const garden = desktopSystemsActive("garden");
  check(
    "garden mode runs none of them (DOM input replaces the overlay paths)",
    !garden.cursorPolling && !garden.hitTesting && !garden.environmentRefresh &&
      !garden.foregroundAwareness,
  );
  check(
    "the model is pure: same mode, same answer, no shared state",
    desktopSystemsActive("desktop") !== desktop &&
      JSON.stringify(desktopSystemsActive("garden")) === JSON.stringify(garden),
  );
}

// --- Module surface --------------------------------------------------------------
{
  const surface = Object.keys(appModeModule).sort().join(",");
  check(
    "the module surface is exactly the mode vocabulary",
    surface === "APP_MODES,DEFAULT_APP_MODE,desktopSystemsActive,isAppMode",
    surface,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
