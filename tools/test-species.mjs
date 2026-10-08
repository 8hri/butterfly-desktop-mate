/**
 * Unit tests for butterfly selection (dev only).
 *
 * Selection is presentation-only: two asset definitions in the config and a
 * one-key persistence seam. What is pinned here is exactly that smallness —
 * the definitions, the default, the storage failure paths — plus the one fact
 * the visuals depend on: every clip name in the mapping really exists in the
 * GLB it points at (verified against the actual files, via the same fuzzy
 * resolution the renderer uses).
 *
 * Usage: node tools/test-species.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUTTERFLY_ASSET,
  BUTTERFLY_SPECIES,
  CLOWN_ASSET,
  ULYSSES_ASSET,
} from "../src/config/experience.ts";
import { resolveClip } from "../src/lib/animation.ts";
import {
  DEFAULT_SPECIES_ID,
  SPECIES_STORAGE_KEY,
  isButterflySpeciesId,
  loadSpeciesId,
  saveSpeciesId,
  speciesById,
} from "../src/lib/species.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

/** Reads a GLB's JSON chunk — the ground truth. */
function glbJson(path) {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
}
function glbClipNames(path) {
  return (glbJson(path).animations ?? []).map((a) => ({ name: a.name }));
}

// --- The definitions are exactly three ------------------------------------------
check(
  "the species list is exactly classic, ulysses and clown",
  BUTTERFLY_SPECIES.length === 3 &&
    BUTTERFLY_SPECIES[0].id === "classic" &&
    BUTTERFLY_SPECIES[1].id === "ulysses" &&
    BUTTERFLY_SPECIES[2].id === "clown",
  BUTTERFLY_SPECIES.map((s) => s.id).join(","),
);
check("the default species is the original butterfly", DEFAULT_SPECIES_ID === "classic");

// --- The original asset definition is untouched ----------------------------------
check(
  "the default asset is byte-for-byte the pre-selection definition",
  BUTTERFLY_ASSET.url === "/assets/animated_butterfly.glb" &&
    BUTTERFLY_ASSET.clips.idle === "Idle" &&
    BUTTERFLY_ASSET.clips.flying === "Flying" &&
    BUTTERFLY_ASSET.clips.hover === "Flying" &&
    BUTTERFLY_ASSET.hoverTimeScale === 0.55 &&
    BUTTERFLY_ASSET.targetSize === 1.35 &&
    BUTTERFLY_ASSET.yawOffset === 0,
);

// --- The Ulysses mapping is honest -------------------------------------------------
check(
  "ulysses uses the fixed GLB and maps its one clip to both airborne states",
  ULYSSES_ASSET.url === "/assets/ulysses_butterfly.fixed.glb" &&
    ULYSSES_ASSET.clips.flying === "fly" &&
    ULYSSES_ASSET.clips.hover === "fly",
);
check(
  "ulysses corrects its facing with a 180° yaw (measured: it models -Z forward)",
  Math.abs(ULYSSES_ASSET.yawOffset - Math.PI) < 1e-9,
);
check(
  "both species present at the same size and hover rate",
  ULYSSES_ASSET.targetSize === BUTTERFLY_ASSET.targetSize &&
    ULYSSES_ASSET.hoverTimeScale === BUTTERFLY_ASSET.hoverTimeScale,
);

// --- The Clown mapping is honest ----------------------------------------------------
check(
  "clown maps its GLB's own Flying/Idle clips, hover reusing Flying like the default",
  CLOWN_ASSET.url === "/assets/clown_butterfly.fixed.glb" &&
    CLOWN_ASSET.clips.idle === "Idle" &&
    CLOWN_ASSET.clips.flying === "Flying" &&
    CLOWN_ASSET.clips.hover === "Flying",
);
check(
  "clown is the original model's repaint: same facing, size and hover rate",
  CLOWN_ASSET.yawOffset === BUTTERFLY_ASSET.yawOffset &&
    CLOWN_ASSET.targetSize === BUTTERFLY_ASSET.targetSize &&
    CLOWN_ASSET.hoverTimeScale === BUTTERFLY_ASSET.hoverTimeScale,
);
{
  // The source export contained a visible Blender default cube; the fix
  // detached that node from the scene graph. Pin that it stays detached.
  const gltf = glbJson(resolve("public/assets/clown_butterfly.fixed.glb"));
  const cubeIndex = gltf.nodes.findIndex((n) => n.name === "Cube");
  const rooted = (gltf.scenes ?? []).some((s) => (s.nodes ?? []).includes(cubeIndex));
  const childed = gltf.nodes.some((n) => (n.children ?? []).includes(cubeIndex));
  check(
    "the accidental cube stays detached from the clown GLB's scene graph",
    cubeIndex >= 0 && !rooted && !childed,
  );
}

// --- The mapped clips really exist in the files --------------------------------------
for (const species of BUTTERFLY_SPECIES) {
  const clips = glbClipNames(resolve("public", species.asset.url.replace(/^\//, "")));
  const wanted = [species.asset.clips.flying, species.asset.clips.hover];
  if (species.asset.clips.idle) wanted.push(species.asset.clips.idle);
  check(
    `${species.id}: every mapped clip resolves against the real GLB`,
    wanted.every((name) => resolveClip(clips, name) !== null),
    clips.map((c) => c.name).join(",") || "no clips",
  );
}

// --- Resolution -------------------------------------------------------------------------
check(
  "all ids resolve to their own definitions",
  speciesById("classic").asset === BUTTERFLY_ASSET &&
    speciesById("ulysses").asset === ULYSSES_ASSET &&
    speciesById("clown").asset === CLOWN_ASSET,
);
check(
  "id validation rejects everything that is not a known id",
  isButterflySpeciesId("classic") &&
    isButterflySpeciesId("ulysses") &&
    isButterflySpeciesId("clown") &&
    !isButterflySpeciesId("Classic") &&
    !isButterflySpeciesId("") &&
    !isButterflySpeciesId(null) &&
    !isButterflySpeciesId(undefined) &&
    !isButterflySpeciesId(0),
);

// --- Persistence seam ------------------------------------------------------------------------
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    map,
  };
}
{
  const storage = fakeStorage();
  check(
    "an empty store yields the default species",
    loadSpeciesId(storage) === "classic",
  );
  check(
    "a selection round-trips through storage",
    saveSpeciesId("ulysses", storage) === true &&
      storage.map.get(SPECIES_STORAGE_KEY) === "ulysses" &&
      loadSpeciesId(storage) === "ulysses",
  );
  check(
    "switching back round-trips too",
    saveSpeciesId("classic", storage) === true && loadSpeciesId(storage) === "classic",
  );
}
check(
  "a corrupt or unknown stored value falls back to the default, never crashes",
  loadSpeciesId(fakeStorage({ [SPECIES_STORAGE_KEY]: "parrot" })) === "classic" &&
    loadSpeciesId(fakeStorage({ [SPECIES_STORAGE_KEY]: "ULYSSES" })) === "classic",
);
{
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  check(
    "a throwing storage seam degrades to no persistence, never an error",
    loadSpeciesId(throwing) === "classic" && saveSpeciesId("ulysses", throwing) === false,
  );
  check(
    "absent storage is valid: default in, no-op out",
    loadSpeciesId(null) === "classic" && saveSpeciesId("ulysses", null) === false,
  );
}

console.log(failures === 0 ? "\nAll species checks passed." : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
