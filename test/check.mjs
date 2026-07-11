// pi-loop self-check. Run: npx tsx test/check.mjs
// Exercises schedule parsing, store round-trip, the pure recurrence decision
// (planFire), and a live interval-firing simulation. No pi required.
import {
  parseDurationMs, validateSchedule, nextRun, inferType, describeSchedule,
} from "../src/schedule.ts";
import { LoopStore, newId, planFire } from "../src/store.ts";
import { formatRelative, loopScheduleLabel } from "../src/format.ts";
import assert from "node:assert/strict";

let failures = 0;
const check = (name, fn) => { try { fn(); console.log("  ✓", name); } catch (e) { failures++; console.log("  ✗", name, "→", e.message); } };

console.log("# parseDurationMs / inferType / validateSchedule");
check("5m → 300000", () => assert.equal(parseDurationMs("5m"), 300000));
check("1h30m → 5400000", () => assert.equal(parseDurationMs("1h30m"), 5400000));
check("in 10 minutes → 600000", () => assert.equal(parseDurationMs("in 10 minutes"), 600000));
check("hourly → 3600000", () => assert.equal(parseDurationMs("hourly"), 3600000));
check("'5m' → interval", () => assert.equal(inferType("5m"), "interval"));
check("'*/5 * * * *' → cron", () => assert.equal(inferType("*/5 * * * *"), "cron"));
check("interval 5m ok", () => assert.equal(validateSchedule("interval", "5m").intervalMs, 300000));
check("once past throws", () => assert.throws(() => validateSchedule("once", "2020-01-01T00:00:00Z"), /past/));
check("cron invalid throws", () => assert.throws(() => validateSchedule("cron", "nope"), /cron/i));
check("interval 5m describe", () => assert.equal(describeSchedule(validateSchedule("interval", "5m")), "every 5m"));
check("formatRelative 90s", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  assert.equal(formatRelative(new Date("2026-01-01T12:01:30Z").toISOString(), now), "in 1m 30s");
});

console.log("# LoopStore round-trip");
{
  const tmp = `/tmp/pi-loop-test-${Date.now()}.json`;
  const s = new LoopStore(tmp);
  const id = newId();
  s.add({ action: "prompt", type: "interval", schedule: "5m", intervalMs: 300000, prompt: "hi", name: "test" }, id);
  await s.persist();
  const s2 = new LoopStore(tmp); await s2.load();
  check("persist + reload", () => { assert.equal(s2.list().length, 1); assert.equal(s2.list()[0].name, "test"); });
  check("find by name", () => assert.ok(s2.find("test")));
  check("loopScheduleLabel after reload", () => assert.equal(loopScheduleLabel(s2.list()[0]), "every 5m"));
}

console.log("# planFire — recurrence decision (the jl1990 bug fix)");
{
  const s = new LoopStore(`/tmp/pf-${Date.now()}.json`);
  const id = newId();
  s.add({ action: "prompt", type: "interval", schedule: "5m", intervalMs: 300000, prompt: "x", maxFires: 3 }, id);
  check("fire #1: not terminal, nextDelayMs set", () => {
    const p = planFire(s.get(id));
    assert.equal(p.terminal, false); assert.equal(p.runCount, 1);
    assert.ok(Math.abs(p.nextDelayMs - 300000) < 1000);
  });
  s.update(id, { runCount: 2 });
  check("fire #3 (maxFires=3): TERMINAL", () => {
    const p = planFire(s.get(id));
    assert.equal(p.terminal, true); assert.equal(p.nextDelayMs, undefined);
  });
}
{
  const s = new LoopStore(`/tmp/pf2-${Date.now()}.json`);
  const id = newId();
  s.add({ action: "notify", type: "once", schedule: "+10m", intervalMs: 600000, message: "hi" }, id);
  check("once: terminal on first fire", () => assert.equal(planFire(s.get(id)).terminal, true));
}

console.log("# Live interval firing — 50ms x5, must fire exactly 5x then stop");
{
  const s = new LoopStore(`/tmp/live-${Date.now()}.json`);
  const id = newId();
  s.add({ action: "notify", type: "interval", schedule: "50ms", intervalMs: 50, message: "tick", maxFires: 5 }, id);
  const fires = []; const start = Date.now();
  const go = () => {
    const loop = s.get(id);
    if (!loop || !loop.enabled || loop.status === "done") return;
    setTimeout(() => {
      const plan = planFire(loop, new Date());
      fires.push(Date.now() - start);
      s.update(id, { runCount: plan.runCount });
      if (plan.terminal) { s.update(id, { enabled: false, status: "done", nextRun: undefined }); return; }
      go();
    }, loop.intervalMs);
  };
  go();
  await new Promise((r) => setTimeout(r, 600));
  check("fired exactly 5 times", () => assert.equal(fires.length, 5));
  check("marked done after 5", () => assert.equal(s.get(id).status, "done"));
  check("recurrence held (gaps 30-200ms)", () => {
    const gaps = fires.slice(1).map((t, i) => t - fires[i]);
    assert.ok(gaps.every((g) => g > 30 && g < 200), `gaps: ${gaps.join(",")}`);
  });
}

console.log(failures === 0 ? "\n✅ ALL CHECKS PASSED" : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
