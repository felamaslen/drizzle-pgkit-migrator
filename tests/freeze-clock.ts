import { afterAll, beforeAll, vi } from "vitest";

/**
 * Freeze `Date` (and only `Date`) so that timestamp-derived values such as the
 * migration filename produced by `createMigration` are deterministic across
 * runs and can be captured as inline snapshots.
 *
 * `setTimeout`/`setInterval` are left on real time so that the `pg` driver's
 * internal timers continue to work. `TZ` is forced to UTC so that the
 * local-time methods (`getHours`, etc.) used to format timestamps yield the
 * same value on every machine and in CI.
 */
process.env.TZ = "UTC";

const FROZEN = new Date("2026-01-15T12:34:56Z");

beforeAll(() => {
  vi.useFakeTimers({ now: FROZEN, toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
});
