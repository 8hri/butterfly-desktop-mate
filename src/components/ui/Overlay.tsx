import { useEffect, useState } from "react";
import { isDesktop } from "../../lib/platform";

/** True on touch-first devices, where a cursor hint would be meaningless. */
function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(pointer: coarse)");
    setCoarse(query.matches);
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

/**
 * Minimal interface layer.
 *
 * Everything here is deliberately quiet: the butterfly is the experience.
 * The hints fade out once the user interacts, and never reappear.
 */
export default function Overlay() {
  const [hintVisible, setHintVisible] = useState(true);
  const coarsePointer = useCoarsePointer();

  useEffect(() => {
    const dismiss = () => setHintVisible(false);
    // Any deliberate interaction retires the hint.
    window.addEventListener("pointerdown", dismiss, { once: true });
    window.addEventListener("keydown", dismiss, { once: true });
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, []);

  return (
    <div className="overlay">
      <header className="overlay__header">
        <h1 className="overlay__title">Butterfly</h1>
      </header>

      {/* Kept at the edges so text never covers the butterfly. */}
      <div className="overlay__bottom">
        <div
          className={`overlay__hint${hintVisible ? "" : " overlay__hint--gone"}`}
          // Purely decorative guidance; the experience needs no instructions.
          aria-hidden="true"
        >
          {coarsePointer ? (
            <p>Touch anywhere to call it closer.</p>
          ) : (
            <>
              <p>Move your cursor — it notices.</p>
              <p>Click anywhere to call it closer.</p>
            </>
          )}
        </div>

        {/*
          Attribution required by the asset licence (CC BY). The model is
          "Animated Butterfly" by Artistic_side.

          Desktop mode omits it at the source: the companion window is a
          transparent layer over the user's desktop, where the only thing that
          may render is the butterfly itself. The attribution stays on the web
          presentation and in the README.
        */}
        {!isDesktop && (
          <footer className="overlay__footer">
            <p className="overlay__credit">
              3D model <strong>Animated Butterfly</strong> by <strong>Artistic_side</strong>,
              licensed under Creative Commons Attribution (CC&nbsp;BY).
            </p>
          </footer>
        )}
      </div>
    </div>
  );
}
