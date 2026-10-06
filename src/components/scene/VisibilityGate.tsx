import { useEffect } from "react";
import { useThree } from "@react-three/fiber";

/**
 * Stops rendering while the tab is hidden, so a backgrounded experience costs
 * nothing in battery or CPU. Rendering resumes automatically on return.
 */
export default function VisibilityGate() {
  const setFrameloop = useThree((state) => state.setFrameloop);

  useEffect(() => {
    const sync = () => setFrameloop(document.hidden ? "never" : "always");
    document.addEventListener("visibilitychange", sync);
    // Safety net: an embedded webview can miss a visibility event, which
    // would otherwise leave the scene loop stopped for good. Any focus
    // re-reads the flag, so rendering always has a path back to "always".
    window.addEventListener("focus", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  }, [setFrameloop]);

  return null;
}
