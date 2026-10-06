import {
  BUTTERFLY_SPECIES,
  type ButterflySpecies,
  type ButterflySpeciesId,
} from "../../config/experience";

/**
 * The garden's minimal chrome (Phase 15.2).
 *
 * The desktop overlay renders no UI at all by design; the garden is a normal
 * interactive window, so a small exit affordance is allowed — one button,
 * one hint, plus the butterfly selector (final phase): two buttons that swap
 * the companion's visual and nothing else. The container is click-transparent
 * so it never blocks the scene; only the buttons take pointer events.
 */
export default function GardenChrome({
  onExit,
  species,
  onSelectSpecies,
}: {
  onExit: () => void;
  /** The active butterfly visual — the selector only reflects and reports. */
  species: ButterflySpecies;
  onSelectSpecies: (id: ButterflySpeciesId) => void;
}) {
  return (
    <div className="garden-chrome">
      {/* The selector changes which asset the same companion wears. It is not
          a shop: two peers, one active, no unlocks, no progression. */}
      <div className="garden-chrome__species" role="group" aria-label="Butterfly">
        {BUTTERFLY_SPECIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={
              entry.id === species.id
                ? "garden-chrome__species-button is-active"
                : "garden-chrome__species-button"
            }
            aria-pressed={entry.id === species.id}
            onClick={() => onSelectSpecies(entry.id)}
          >
            {entry.name}
          </button>
        ))}
      </div>
      {/* The hint exists to say how to leave, and nothing else. It used to read
          "The garden — a first look", which described the place as a prototype;
          it is a place now, and the copy says so. */}
      <p className="garden-chrome__hint" aria-hidden="true">
        Esc to leave.
      </p>
      <button type="button" className="garden-chrome__exit" onClick={onExit}>
        ← Back to desktop
      </button>
    </div>
  );
}
