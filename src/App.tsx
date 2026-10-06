import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import Overlay from "./components/ui/Overlay";
import Loader from "./components/ui/Loader";
import ErrorBoundary from "./components/ui/ErrorBoundary";
import GardenChrome from "./components/garden/GardenChrome";
import { SCENE, type ButterflySpeciesId } from "./config/experience";
import {
  loadSpeciesId,
  saveSpeciesId,
  speciesById,
} from "./lib/species";
import { preloadGLTF } from "./lib/gltf";
import { DEFAULT_APP_MODE, type AppMode } from "./lib/appMode";
import { applyWindowMode } from "./lib/desktop/mode";

// The 3D runtime is loaded as a separate chunk, so the loading veil and the
// interface paint immediately instead of waiting on the renderer bundle.
const Experience = lazy(() => import("./components/scene/Experience"));

/** Shown only if the scene or the model cannot load at all. */
function Failure() {
  return (
    <div className="failure" role="status">
      <p className="failure__title">The butterfly could not be found.</p>
      <p className="failure__hint">Please reload the page to try again.</p>
    </div>
  );
}

/**
 * Application root.
 *
 * The 3D environment fills the viewport; the minimal interface sits above it.
 *
 * The app has two window modes (`lib/appMode.ts`): the desktop overlay — the
 * default and core experience — and the garden, a temporary windowed visit.
 * The mode is owned here, above the scene, and changes never remount it: the
 * companion's flight, personality and memory instances live through every
 * transition. A mode is only adopted once the native window has actually
 * followed (see `desktop/mode.ts`), so scene and window can never disagree.
 */
export default function App() {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<AppMode>(DEFAULT_APP_MODE);
  /**
   * The selected butterfly visual (final phase). Owned here, above the scene,
   * for the same reason as the mode: changing it must never recreate the
   * companion. Persisted best-effort; forgetting it just means the default.
   */
  const [speciesId, setSpeciesId] = useState<ButterflySpeciesId>(() => loadSpeciesId());
  const species = useMemo(() => speciesById(speciesId), [speciesId]);
  const selectSpecies = useCallback((id: ButterflySpeciesId) => {
    saveSpeciesId(id);
    // Warm the cache before the swap so the new model suspends briefly or
    // not at all; the first selection of a never-loaded species loads once.
    preloadGLTF(speciesById(id).asset.url);
    setSpeciesId(id);
  }, []);

  const enterGarden = useCallback(async () => {
    if (await applyWindowMode("garden", SCENE.garden.windowSize)) setMode("garden");
  }, []);
  const exitGarden = useCallback(async () => {
    if (await applyWindowMode("desktop")) setMode("desktop");
  }, []);

  // Esc leaves the garden: the garden window holds focus, so a plain key
  // listener works — no global hotkey, no native hook.
  useEffect(() => {
    if (mode !== "garden") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void exitGarden();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, exitGarden]);

  return (
    <div className="app">
      <ErrorBoundary fallback={<Failure />}>
        <Suspense fallback={null}>
          <Experience
            mode={mode}
            species={species}
            onEnterGarden={enterGarden}
            onReady={() => setReady(true)}
          />
        </Suspense>
      </ErrorBoundary>
      {mode === "garden" && (
        <GardenChrome
          onExit={() => void exitGarden()}
          species={species}
          onSelectSpecies={selectSpecies}
        />
      )}
      <Overlay />
      <Loader ready={ready} />
    </div>
  );
}
