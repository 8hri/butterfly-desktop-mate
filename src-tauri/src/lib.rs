/// Desktop runtime entry point.
///
/// The native layer owns the desktop surface itself: on startup the overlay
/// window is resized and repositioned to cover the primary monitor's work
/// area, and it starts fully click-through so applications underneath are
/// never blocked. The frontend (`src/`) selectively re-enables interaction
/// around the butterfly and owns everything visual and behavioural — no 3D
/// logic, animation or flight behaviour lives here.
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize};

/// Desktop-space rectangle of the external foreground window, in **physical**
/// pixels: `(x, y, width, height)`, or `None` when there is none.
///
/// `x` / `y` are Win32 virtual-desktop coordinates, so they may be negative on
/// a multi-monitor desktop. The frontend converts to logical desktop pixels with
/// the scale factor the environment snapshot already carries; no DPI handling
/// happens here, and per-window DPI is explicitly out of scope for this phase.
pub type ForegroundWindowRect = Option<(i32, i32, u32, u32)>;

/// Reports the window that currently has focus, excluding our own overlay.
///
/// This is a *fact*, not an instruction: nothing in the frontend acts on it yet.
/// Two details matter for correctness:
///
/// - **Self-exclusion.** The overlay is always-on-top and transparent, so it can
///   itself be reported as the foreground window (for instance while the
///   hit-test zone has interaction enabled). It is excluded by comparing native
///   window identity — the handle from `WebviewWindow::hwnd()` — never by title
///   or executable name.
/// - **A missing or degenerate window is not an error.** No foreground window,
///   or one with an empty rectangle (minimised), is reported as "no external
///   foreground window". Only a genuinely failed query returns `Err`.
#[tauri::command]
fn foreground_window(window: tauri::WebviewWindow) -> Result<ForegroundWindowRect, String> {
  #[cfg(target_os = "windows")]
  {
    use windows::Win32::Foundation::{RECT, HWND};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect};

    // SAFETY: both calls are plain read-only queries; the RECT we hand over is
    // a live local that the callee only writes into.
    let foreground: HWND = unsafe { GetForegroundWindow() };
    if foreground.is_invalid() {
      // Nothing holds focus right now: a legitimate answer, not a failure.
      return Ok(None);
    }

    // Our own overlay is never an "external application".
    let own = window.hwnd().map_err(|error| error.to_string())?;
    if foreground == own {
      return Ok(None);
    }

    let mut rect = RECT::default();
    unsafe { GetWindowRect(foreground, &mut rect) }
      .map_err(|error| error.to_string())?;

    // A minimised (or zero-sized) window has no usable rectangle: report the
    // absence of an external foreground window rather than a 0x0 fact.
    let width = (rect.right - rect.left).max(0) as u32;
    let height = (rect.bottom - rect.top).max(0) as u32;
    if width == 0 || height == 0 {
      return Ok(None);
    }

    return Ok(Some((rect.left, rect.top, width, height)));
  }

  #[cfg(not(target_os = "windows"))]
  Err("the foreground-window fact is only available on Windows".to_string())
}

/// Switches the window between its two profiles, atomically (Phase 15.2).
///
/// `desktop` restores the overlay exactly as startup created it — and always
/// from a *fresh* work-area read, so a display change that happened while in
/// the garden is picked up on return. Click-through is restored last, so the
/// window never sits overlay-sized and interactive at once.
///
/// `garden` turns the overlay into a normal interactive window: borderless
/// (as configured at creation), centered on the current work area at the
/// logical size the frontend passes in, no longer always-on-top, no longer
/// click-through, and focused so keyboard input (Esc) reaches it.
///
/// Both profiles are applied entirely here: the frontend declares a mode,
/// this command makes the window match it, and any failure is reported
/// before anything half-applies.
#[tauri::command]
fn set_window_mode(
  window: tauri::WebviewWindow,
  mode: &str,
  garden_width: f64,
  garden_height: f64,
) -> Result<(), String> {
  let monitor = window
    .primary_monitor()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "no primary monitor available".to_string())?;
  let area = monitor.work_area();

  match mode {
    "desktop" => {
      window
        .set_size(tauri::Size::Physical(PhysicalSize::new(
          area.size.width,
          area.size.height,
        )))
        .map_err(|error| error.to_string())?;
      window
        .set_position(tauri::Position::Physical(PhysicalPosition::new(
          area.position.x,
          area.position.y,
        )))
        .map_err(|error| error.to_string())?;
      window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
      window
        .set_ignore_cursor_events(true)
        .map_err(|error| error.to_string())?;
      Ok(())
    }
    "garden" => {
      if garden_width <= 0.0 || garden_height <= 0.0 {
        return Err("garden mode requires a positive window size".to_string());
      }
      let scale = monitor.scale_factor();
      let center_x =
        area.position.x + (area.size.width as i32 - (garden_width * scale).round() as i32) / 2;
      let center_y =
        area.position.y + (area.size.height as i32 - (garden_height * scale).round() as i32) / 2;

      window
        .set_ignore_cursor_events(false)
        .map_err(|error| error.to_string())?;
      window
        .set_always_on_top(false)
        .map_err(|error| error.to_string())?;
      window
        .set_size(tauri::Size::Logical(LogicalSize::new(
          garden_width,
          garden_height,
        )))
        .map_err(|error| error.to_string())?;
      window
        .set_position(tauri::Position::Physical(PhysicalPosition::new(
          center_x, center_y,
        )))
        .map_err(|error| error.to_string())?;
      window.set_focus().map_err(|error| error.to_string())?;
      Ok(())
    }
    _ => Err(format!("unknown window mode: {mode}")),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![foreground_window, set_window_mode])
    .setup(|app| {
      let window = app
        .get_webview_window("main")
        .expect("the main window is declared in tauri.conf.json");

      // The overlay is the desktop: cover the primary monitor's work area.
      // (Multi-monitor support is a later phase.)
      if let Ok(Some(monitor)) = window.primary_monitor() {
        let area = monitor.work_area();
        let _ = window.set_size(tauri::Size::Physical(PhysicalSize::new(
          area.size.width,
          area.size.height,
        )));
        let _ = window.set_position(tauri::Position::Physical(PhysicalPosition::new(
          area.position.x,
          area.position.y,
        )));
        // Start click-through; the frontend toggles interaction around the
        // butterfly (with hysteresis) from the global cursor position.
        let _ = window.set_ignore_cursor_events(true);
      }

      // tauri.conf.json keeps the window hidden so its placeholder creation
      // size is never visible; show it only once it covers the work area.
      let _ = window.show();
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
