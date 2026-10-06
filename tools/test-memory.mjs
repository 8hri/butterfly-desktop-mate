/**
 * Unit tests for the companion memory layer (dev only).
 *
 * Memory is deterministic by design: two event kinds, bounded counters, a
 * pure state derivation, and a storage seam injected everywhere. These checks
 * pin the model, the exact companion-state thresholds, the persistence
 * format, every failure fallback — and the promise that a stationary cursor
 * never grows memory.
 *
 * Usage: node tools/test-memory.mjs
 */
import {
  ATTACHED_SESSIONS,
  ATTACHED_SUMMONS,
  ATTACHED_TOGETHER_MS,
  COMFORTABLE_SESSIONS,
  COMFORTABLE_SUMMONS,
  COMPANION_STATES,
  CompanionMemory,
  FAMILIAR_SUMMONS,
  MAX_SESSIONS,
  MAX_SESSION_STEP_MS,
  MAX_SUMMONS,
  MAX_TOGETHER_MS,
  MEMORY_STORAGE_KEY,
  MEMORY_VERSION,
  SAVE_DELAY_MS,
  applyCompanionEvent,
  commitElapsed,
  companionRank,
  deriveCompanionState,
  emptyMemory,
  loadMemory,
  parseMemory,
  saveMemory,
  serializeMemory,
} from "../src/lib/memory.ts";
import * as memoryModule from "../src/lib/memory.ts";
import { Personality } from "../src/lib/personality.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

/** A valid record with chosen counters (valid timestamps included). */
const memoryWith = (summons, sessions, togetherMs = 0) => ({
  version: MEMORY_VERSION,
  sessions,
  summons,
  togetherMs,
  firstMetAt: 1,
  lastSeenAt: 2,
});

/** An in-memory storage seam that counts writes (and can be made to throw). */
const fakeStorage = (initial = {}) => ({
  store: { ...initial },
  writes: 0,
  throwOnWrite: false,
  throwOnRead: false,
  getItem(key) {
    if (this.throwOnRead) throw new Error("read blocked");
    return key in this.store ? this.store[key] : null;
  },
  setItem(key, value) {
    if (this.throwOnWrite) throw new Error("write blocked");
    this.writes++;
    this.store[key] = String(value);
  },
});

/** A controllable clock. */
const fakeClock = (start = 1_000_000) => {
  const clock = { t: start, now: () => clock.t };
  return clock;
};

/** A scheduler that records pending callbacks instead of running them. */
const fakeScheduler = () => {
  const pending = [];
  return {
    pending,
    delays: [],
    schedule(fn, ms) {
      const entry = { fn, cancelled: false };
      pending.push(entry);
      this.delays.push(ms);
      return () => {
        entry.cancelled = true;
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    runAll() {
      const list = pending.splice(0, pending.length);
      for (const entry of list) if (!entry.cancelled) entry.fn();
    },
  };
};

// --- Empty memory -----------------------------------------------------------
{
  const empty = emptyMemory();
  check(
    "empty memory is a zeroed v1 record",
    empty.version === MEMORY_VERSION &&
      empty.sessions === 0 &&
      empty.summons === 0 &&
      empty.togetherMs === 0 &&
      empty.firstMetAt === 0 &&
      empty.lastSeenAt === 0,
  );
  check("empty memory means the 'new' companion", deriveCompanionState(empty) === "new");
  check(
    "the states are exactly four, ordered by familiarity",
    COMPANION_STATES.join(",") === "new,familiar,comfortable,attached" &&
      companionRank("attached") > companionRank("comfortable") &&
      companionRank("comfortable") > companionRank("familiar") &&
      companionRank("familiar") > companionRank("new"),
  );
}

// --- First interaction ------------------------------------------------------
{
  const t0 = 1_700_000_000_000;
  const afterSession = applyCompanionEvent(emptyMemory(), "session_start", t0);
  check(
    "the first session is counted and stamped",
    afterSession.sessions === 1 &&
      afterSession.firstMetAt === t0 &&
      afterSession.lastSeenAt === t0,
  );
  const afterSummon = applyCompanionEvent(afterSession, "summon", t0 + 5_000);
  check(
    "the first summon is counted and re-stamped",
    afterSummon.summons === 1 && afterSummon.lastSeenAt === t0 + 5_000,
  );
  check(
    "first-met time never moves once set",
    afterSummon.firstMetAt === t0,
  );
  check(
    "one summon is not yet familiar",
    deriveCompanionState(afterSummon) === "new",
  );
}

// --- Threshold boundaries ----------------------------------------------------
{
  check(
    "just below familiar stays new",
    deriveCompanionState(memoryWith(FAMILIAR_SUMMONS - 1, 1)) === "new",
  );
  check(
    "the familiar threshold is exact",
    deriveCompanionState(memoryWith(FAMILIAR_SUMMONS, 1)) === "familiar",
  );
  check(
    "comfortable needs the summons AND the sessions (sessions gate)",
    deriveCompanionState(memoryWith(COMFORTABLE_SUMMONS, COMFORTABLE_SESSIONS - 1)) ===
      "familiar",
  );
  check(
    "comfortable needs the summons AND the sessions (summons gate)",
    deriveCompanionState(memoryWith(COMFORTABLE_SUMMONS - 1, COMFORTABLE_SESSIONS)) ===
      "familiar",
  );
  check(
    "the comfortable threshold is exact",
    deriveCompanionState(memoryWith(COMFORTABLE_SUMMONS, COMFORTABLE_SESSIONS)) ===
      "comfortable",
  );
  check(
    "attached needs time together, not just counts",
    deriveCompanionState(
      memoryWith(ATTACHED_SUMMONS, ATTACHED_SESSIONS, ATTACHED_TOGETHER_MS - 1),
    ) === "comfortable",
  );
  check(
    "the attached threshold is exact",
    deriveCompanionState(
      memoryWith(ATTACHED_SUMMONS, ATTACHED_SESSIONS, ATTACHED_TOGETHER_MS),
    ) === "attached",
  );
}

// --- Transitions only ever move forward --------------------------------------
{
  // Drive a mixed event sequence and confirm the rank never decreases.
  let memory = emptyMemory();
  let last = 0;
  let monotonic = true;
  const events = [
    ...Array.from({ length: 8 }, () => "summon"),
    "session_start",
    ...Array.from({ length: 30 }, () => "summon"),
    "session_start",
    "session_start",
    ...Array.from({ length: 60 }, () => "summon"),
    ...Array.from({ length: 6 }, () => "session_start"),
  ];
  let t = 100;
  for (const event of events) {
    t += 1_000;
    memory = applyCompanionEvent(memory, event, t);
    memory = commitElapsed(memory, 0, t);
    const rank = companionRank(deriveCompanionState(memory));
    if (rank < last) monotonic = false;
    last = rank;
  }
  check("state transitions are monotonic under any event mix", monotonic);
  check(
    "the driven sequence actually reaches the top state",
    deriveCompanionState(memory) === "attached",
  );
}

// --- Serialization round trip -------------------------------------------------
{
  const original = memoryWith(42, 4, 3_600_000);
  original.firstMetAt = 1_700_000_000_000;
  original.lastSeenAt = 1_700_100_000_000;
  const parsed = parseMemory(serializeMemory(original));
  check(
    "serialize -> parse is a lossless round trip",
    parsed.source === "stored" &&
      parsed.memory.version === original.version &&
      parsed.memory.sessions === original.sessions &&
      parsed.memory.summons === original.summons &&
      parsed.memory.togetherMs === original.togetherMs &&
      parsed.memory.firstMetAt === original.firstMetAt &&
      parsed.memory.lastSeenAt === original.lastSeenAt,
  );
  check(
    "the empty record has a stable serialization",
    serializeMemory(emptyMemory()) ===
      '{"version":1,"sessions":0,"summons":0,"togetherMs":0,"firstMetAt":0,"lastSeenAt":0}',
    serializeMemory(emptyMemory()),
  );
  check(
    "unknown extra fields never leak into storage",
    serializeMemory({ ...original, cursorX: 123, windowTitle: "secrets" }) ===
      serializeMemory(original),
  );
}

// --- Loading ------------------------------------------------------------------
{
  const stored = fakeStorage({ [MEMORY_STORAGE_KEY]: serializeMemory(memoryWith(9, 2)) });
  const loaded = loadMemory(stored);
  check(
    "a stored record loads with its source",
    loaded.source === "stored" && loaded.memory.summons === 9,
  );
  const empty = loadMemory(fakeStorage());
  check(
    "present-but-empty storage reports empty, not broken",
    empty.source === "empty" && deriveCompanionState(empty.memory) === "new",
  );
  const absent = loadMemory(null);
  check(
    "no storage at all reports unavailable and stays safe",
    absent.source === "unavailable" && deriveCompanionState(absent.memory) === "new",
  );
  const blocked = fakeStorage();
  blocked.throwOnRead = true;
  const thrown = loadMemory(blocked);
  check(
    "a storage that throws on read is treated as unavailable, never fatal",
    thrown.source === "unavailable" && thrown.memory.summons === 0,
  );
}

// --- Corrupted / invalid data ---------------------------------------------------
{
  const cases = {
    "unparseable JSON": "{not json",
    "a JSON number": "42",
    "a JSON array": "[1,2,3]",
    "missing fields": JSON.stringify({ version: 1 }),
    "non-integer counter": JSON.stringify(memoryWith(3.5, 2)),
    "negative counter": JSON.stringify(memoryWith(-1, 2)),
    "counter above its cap": JSON.stringify(memoryWith(MAX_SUMMONS + 1, 2)),
    "negative time together": JSON.stringify({ ...memoryWith(1, 1), togetherMs: -5 }),
    "time together above its cap": JSON.stringify({
      ...memoryWith(1, 1),
      togetherMs: MAX_TOGETHER_MS + 1,
    }),
    "met after seen": JSON.stringify({ ...memoryWith(1, 1), firstMetAt: 100, lastSeenAt: 50 }),
    "NaN field": JSON.stringify({ ...memoryWith(1, 1), togetherMs: null }),
  };
  for (const [name, raw] of Object.entries(cases)) {
    const parsed = parseMemory(raw);
    check(
      `corrupted record falls back safely (${name})`,
      parsed.source === "invalid" && deriveCompanionState(parsed.memory) === "new",
    );
  }
  check(
    "an empty string is empty storage, not corruption",
    parseMemory("").source === "empty" && parseMemory(null).source === "empty",
  );
}

// --- Version compatibility ------------------------------------------------------
{
  const future = parseMemory(JSON.stringify({ ...memoryWith(9, 3), version: 2 }));
  check(
    "a record from a newer schema falls back without crashing",
    future.source === "unsupported-version" && deriveCompanionState(future.memory) === "new",
  );
  const missingVersion = parseMemory(JSON.stringify({ sessions: 2, summons: 5 }));
  check(
    "a record without a version is invalid, not upgraded silently",
    missingVersion.source === "invalid",
  );
}

// --- Bounded counters -------------------------------------------------------------
{
  let memory = memoryWith(MAX_SUMMONS - 2, MAX_SESSIONS - 2, MAX_TOGETHER_MS - 10);
  for (let i = 0; i < 5; i++) memory = applyCompanionEvent(memory, "summon", 1000 + i);
  for (let i = 0; i < 5; i++) memory = applyCompanionEvent(memory, "session_start", 2000 + i);
  check(
    "counters saturate at their caps instead of growing forever",
    memory.summons === MAX_SUMMONS && memory.sessions === MAX_SESSIONS,
    `summons=${memory.summons} sessions=${memory.sessions}`,
  );
  const committed = commitElapsed(memory, 0, 10 * 365 * 24 * 60 * 60 * 1000);
  check(
    "time together is capped per commit and in total",
    committed.togetherMs === MAX_TOGETHER_MS,
    `${committed.togetherMs}`,
  );
  const stepped = commitElapsed(memoryWith(0, 0), 0, MAX_SESSION_STEP_MS * 10);
  check(
    "one commit can never account for more than one capped step",
    stepped.togetherMs === MAX_SESSION_STEP_MS,
  );
}

// --- Defensive timestamps ---------------------------------------------------------
{
  const base = memoryWith(3, 2);
  const nan = applyCompanionEvent(base, "summon", Number.NaN);
  const negative = applyCompanionEvent(base, "summon", -500);
  check(
    "a nonsensical timestamp still counts the event but corrupts no times",
    nan.summons === 4 && nan.lastSeenAt === base.lastSeenAt && negative.lastSeenAt === base.lastSeenAt,
  );
  const committedBase = memoryWith(1, 1, 500);
  const backwards = commitElapsed(committedBase, 1_000, 500);
  check(
    "a backwards clock commits nothing",
    backwards === committedBase && backwards.togetherMs === 500,
  );
}

// --- Runtime: sessions ------------------------------------------------------------
{
  const storage = fakeStorage();
  const scheduler = fakeScheduler();
  const clock = fakeClock();
  const companion = new CompanionMemory({
    storage,
    schedule: scheduler.schedule.bind(scheduler),
    now: clock.now,
  });
  companion.beginSession();
  companion.beginSession(); // StrictMode / remount safety
  check(
    "a session counts once no matter how often it is begun",
    companion.snapshot.sessions === 1,
  );
  check(
    "session start is stamped with the injected clock",
    companion.snapshot.firstMetAt === clock.t,
  );
  scheduler.runAll();
  check(
    "the session was persisted through the storage seam",
    storage.store[MEMORY_STORAGE_KEY] !== undefined && storage.writes === 1,
  );
}

// --- Runtime: debounced persistence ------------------------------------------------
{
  const storage = fakeStorage();
  const scheduler = fakeScheduler();
  const clock = fakeClock();
  const companion = new CompanionMemory({
    storage,
    schedule: scheduler.schedule.bind(scheduler),
    now: clock.now,
  });
  companion.beginSession();
  scheduler.runAll();
  companion.recordSummon();
  companion.recordSummon();
  companion.recordSummon();
  check(
    "a burst of events coalesces into at most one pending write",
    scheduler.pending.length === 1 && storage.writes === 1,
    `pending=${scheduler.pending.length} writes=${storage.writes}`,
  );
  check(
    "the debounce uses the module's own delay",
    scheduler.delays.every((d) => d === SAVE_DELAY_MS),
  );
  clock.t += 60_000;
  scheduler.runAll();
  check(
    "the debounced write lands with committed session time",
    storage.writes === 2 && companion.snapshot.togetherMs === 60_000,
    `writes=${storage.writes} together=${companion.snapshot.togetherMs}`,
  );
  companion.recordSummon();
  const flushed = companion.flush();
  const pendingAfterFlush = scheduler.pending.length;
  scheduler.runAll();
  check(
    "flush writes immediately and cancels the pending debounce",
    flushed === true && pendingAfterFlush === 0 && storage.writes === 3,
    `flushed=${flushed} writes=${storage.writes}`,
  );
}

// --- Runtime: persistence failure is never fatal -----------------------------------
{
  const storage = fakeStorage();
  storage.throwOnWrite = true;
  const scheduler = fakeScheduler();
  const clock = fakeClock();
  const companion = new CompanionMemory({
    storage,
    schedule: scheduler.schedule.bind(scheduler),
    now: clock.now,
  });
  companion.beginSession();
  for (let i = 0; i < FAMILIAR_SUMMONS + 2; i++) companion.recordSummon();
  let flushedSafely = true;
  let flushed = false;
  try {
    scheduler.runAll();
    flushed = companion.flush();
  } catch {
    flushedSafely = false;
  }
  check(
    "a failing storage never throws and never stops memory from working",
    flushedSafely && flushed === false && companion.state === "familiar",
    `flushed=${flushed} state=${companion.state}`,
  );
  const withoutStorage = new CompanionMemory({ storage: null });
  check(
    "no storage at all is also safe",
    withoutStorage.flush() === false && withoutStorage.state === "new",
  );
}

// --- Restart continuity --------------------------------------------------------------
{
  const storage = fakeStorage();
  const scheduler = fakeScheduler();
  const clock = fakeClock();
  const first = new CompanionMemory({
    storage,
    schedule: scheduler.schedule.bind(scheduler),
    now: clock.now,
  });
  first.beginSession();
  for (let i = 0; i < FAMILIAR_SUMMONS; i++) first.recordSummon();
  clock.t += 5 * 60_000;
  first.flush();

  const second = new CompanionMemory({ storage });
  check(
    "memory survives a restart (same storage, new instance)",
    second.loadSource === "stored" &&
      second.state === "familiar" &&
      second.snapshot.summons === FAMILIAR_SUMMONS &&
      second.snapshot.togetherMs === 5 * 60_000,
    `state=${second.state} summons=${second.snapshot.summons} together=${second.snapshot.togetherMs}`,
  );
  second.beginSession();
  check(
    "the next launch counts as a new session, continuing the story",
    second.snapshot.sessions === 2,
  );
}

// --- A stationary cursor never grows memory -------------------------------------------
{
  const storage = fakeStorage();
  const scheduler = fakeScheduler();
  const clock = fakeClock();
  const companion = new CompanionMemory({
    storage,
    schedule: scheduler.schedule.bind(scheduler),
    now: clock.now,
  });
  companion.beginSession();
  scheduler.runAll();
  const before = companion.snapshot;

  // The entire presence vocabulary the interaction layer can report: feed it
  // to the personality for a simulated minute, exactly as Interaction does.
  const personality = new Personality();
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 60; i++) {
    personality.onCursorProximity(1, dt);
    personality.onCrowding(dt);
    personality.step(dt);
  }

  const after = companion.snapshot;
  check(
    "presence alone changes nothing in memory",
    JSON.stringify(before) === JSON.stringify(after) &&
      companion.state === "new" &&
      scheduler.pending.length === 0,
  );
}

// --- Graceful derivation from garbage --------------------------------------------------
{
  check(
    "deriving from nonsensical counters falls back to 'new'",
    deriveCompanionState({
      version: 1,
      sessions: Number.NaN,
      summons: Number.NaN,
      togetherMs: Number.NaN,
      firstMetAt: 0,
      lastSeenAt: 0,
    }) === "new",
  );
}

// --- Module surface ---------------------------------------------------------------------
{
  const surface = Object.keys(memoryModule).sort().join(",");
  check(
    "the module surface is exactly the model, the seam and the runtime",
    surface ===
      "ATTACHED_SESSIONS,ATTACHED_SUMMONS,ATTACHED_TOGETHER_MS,COMFORTABLE_SESSIONS,COMFORTABLE_SUMMONS,COMPANION_STATES,CompanionMemory,FAMILIAR_SUMMONS,MAX_SESSIONS,MAX_SESSION_STEP_MS,MAX_SUMMONS,MAX_TOGETHER_MS,MEMORY_STORAGE_KEY,MEMORY_VERSION,SAVE_DELAY_MS,applyCompanionEvent,commitElapsed,companionRank,deriveCompanionState,emptyMemory,loadMemory,parseMemory,saveMemory,serializeMemory",
    surface,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
