import { useCallback, useEffect, useRef, useState } from "react";
import { SCENE } from "../../config/experience";
import { createButterflyChase, type ButterflyChaseGame } from "../../lib/butterflyChase";
import type { FlightController } from "../../lib/flight";
import type { MiniGameRuntime, MiniGameState } from "../../lib/minigame";

/**
 * The Butterfly Chase HUD (Phase 16.1).
 *
 * The smallest UI that can carry the game: an unobtrusive start affordance
 * while idle, a score and a countdown while playing, a one-line result when
 * the game ends, and a quiet way out. No menu, no panels, no persistence, no
 * currency — nothing that pretends to be a system.
 *
 * Every number on screen is a fact the game published: the HUD reads the
 * definition's public getters (`score`, `remainingSeconds`) and re-renders on
 * the game's own change notifications and the runtime's state transitions. It
 * never tracks game state of its own — the single exception is holding the
 * *result* after teardown, because the runtime returns the game object on
 * completion and the score has to live somewhere for one more moment.
 */
export default function ChaseHud({
  runtime,
  flight,
}: {
  runtime: MiniGameRuntime;
  flight: FlightController;
}) {
  // Initialised from the runtime: a game may already be active when this HUD
  // first mounts (also under StrictMode's double-mount), and the transition
  // listener below only fires on *changes*.
  const [state, setState] = useState<MiniGameState>(runtime.currentState);
  const [game, setGame] = useState<ButterflyChaseGame | null>(
    () => runtime.activeGame as ButterflyChaseGame | null,
  );
  /** The result of the last completed game, held one moment past teardown. */
  const result = useRef<{ score: number; hits: number; misses: number } | null>(null);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const offState = runtime.onStateChange((next) => {
      // Capture the result the moment a game completes: the runtime tears down
      // and releases the game object, so this is the only honest place the
      // final score can be read from.
      if (next === "completed") {
        const finished = runtime.activeGame as ButterflyChaseGame | null;
        if (finished) {
          result.current = { score: finished.score, hits: finished.hits, misses: finished.misses };
        }
      }
      if (next === "inactive" && runtime.activeGame === null) {
        setGame(null);
      } else {
        setGame(runtime.activeGame as ButterflyChaseGame | null);
      }
      setState(next);
    });
    return offState;
  }, [runtime]);

  // The game's own change notifications (score, target, second ticks).
  useEffect(() => {
    if (!game) return;
    const off = game.onChange(() => forceRender((n) => n + 1));
    return () => {
      off();
    };
  }, [game]);

  const startGame = useCallback(() => {
    result.current = null;
    // Targets keep clear of everything that is already a landmark: the five
    // flowers, the three stones and the limb.
    const garden = SCENE.garden;
    const landmarks: ReadonlyArray<readonly [number, number]> = [
      ...garden.flowers.map((flower) => flower.position),
      ...garden.stones.map((stone) => stone.position),
      garden.log.position,
    ];
    runtime.start(
      createButterflyChase({
        seed: garden.seed,
        area: flight.area,
        landmarks,
        tuning: garden.chase,
      }),
    );
  }, [runtime, flight]);

  const stopGame = useCallback(() => {
    runtime.cancel();
  }, [runtime]);

  // While idle with a fresh result, show the result line once.
  if (state === "inactive") {
    const done = result.current;
    return (
      <div className="chase-hud">
        {done && (
          <p className="chase-hud__result" aria-live="polite">
            {done.score} {done.score === 1 ? "hit" : "hits"}
            {done.misses > 0 ? `, ${done.misses} escaped` : ""}
          </p>
        )}
        <button type="button" className="chase-hud__start" onClick={startGame}>
          {done ? "Again" : "Butterfly chase"}
        </button>
      </div>
    );
  }

  return (
    <div className="chase-hud">
      {game && (
        <div className="chase-hud__live" aria-live="polite">
          <span className="chase-hud__score" aria-label="Score">
            ✦ {game.score}
          </span>
          <span className="chase-hud__time" aria-label="Time remaining">
            {Math.ceil(game.remainingSeconds)}s
          </span>
          {state === "paused" && <span className="chase-hud__paused">paused</span>}
        </div>
      )}
      <button
        type="button"
        className="chase-hud__stop"
        onClick={stopGame}
        aria-label="End the game"
      >
        End
      </button>
    </div>
  );
}
