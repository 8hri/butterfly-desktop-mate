/**
 * Butterfly selection (final phase).
 *
 * The companion is one creature; the species only swaps the rendered asset.
 * This module owns the small runtime seam selection needs and nothing else:
 *
 * - the definitions live in `config/experience.ts` (the single tuning
 *   source); here they are only *resolved* by id;
 * - the active id is remembered in `localStorage` through the same guarded,
 *   never-throwing seam style as the companion memory. Losing the record
 *   costs nothing but the choice itself — the default is always valid.
 *
 * Selection is presentation-only: no behaviour module (flight, personality,
 * memory, interaction, mini-game) may read it, and `check-desktop.mjs`
 * enforces that boundary.
 */
import {
  BUTTERFLY_SPECIES,
  type ButterflySpecies,
  type ButterflySpeciesId,
} from "../config/experience.ts";

/** The single storage key the selection occupies. */
export const SPECIES_STORAGE_KEY = "butterfly.companion.species";
/** Absent or unreadable storage always means the original butterfly. */
export const DEFAULT_SPECIES_ID: ButterflySpeciesId = "classic";

/** The minimal storage seam: `localStorage` satisfies it, so do test fakes. */
export interface SpeciesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The browser's `localStorage` if one exists — the only persistence this
 * feature uses. Access itself can throw (storage disabled), so it is guarded.
 */
function browserSpeciesStorage(): SpeciesStorage | null {
  try {
    return (globalThis as { localStorage?: SpeciesStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function isButterflySpeciesId(value: unknown): value is ButterflySpeciesId {
  return (
    typeof value === "string" &&
    BUTTERFLY_SPECIES.some((species) => species.id === value)
  );
}

/** Resolves an id to its definition; an unknown id is the default species. */
export function speciesById(id: ButterflySpeciesId): ButterflySpecies {
  return (
    BUTTERFLY_SPECIES.find((species) => species.id === id) ?? BUTTERFLY_SPECIES[0]
  );
}

/** Loads the remembered selection. Never throws; absence is not an error. */
export function loadSpeciesId(
  storage: SpeciesStorage | null = browserSpeciesStorage(),
): ButterflySpeciesId {
  if (!storage) return DEFAULT_SPECIES_ID;
  try {
    const raw = storage.getItem(SPECIES_STORAGE_KEY);
    return isButterflySpeciesId(raw) ? raw : DEFAULT_SPECIES_ID;
  } catch {
    return DEFAULT_SPECIES_ID;
  }
}

/** Remembers the selection. Never throws; reports success only. */
export function saveSpeciesId(
  id: ButterflySpeciesId,
  storage: SpeciesStorage | null = browserSpeciesStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SPECIES_STORAGE_KEY, id);
    return true;
  } catch {
    // Quota, private mode, disabled storage: selection just stops persisting.
    return false;
  }
}
