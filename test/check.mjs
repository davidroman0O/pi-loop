// pi-loop self-check. Run: npx tsx test/check.mjs
// Exercises schedule parsing, store round-trip, the pure recurrence decision
// (planFire), and a live interval-firing simulation. No pi required.
import {
  parseDurationMs, validateSchedule, nextRun, inferType, describeSchedule,
} from "../src/schedule.ts";
import { LoopStore, newId, planFire, shouldArm } from "../src/store.ts";
import { formatRelative, loopScheduleLabel } from "../src/format.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

let failures = 0;
const check = (name, fn) => { try { fn(); console.log("  ✓", name); } catch (e) { failures++; console.log("  ✗", name, "→", e.message); } };

console.log("# parseDurationMs / inferType / validateSchedule");
check("5m → 300000", () => assert.equal(parseDurationMs("5m"), 300000));
check("1h30m → 5400000", () => assert.equal(parseDurationMs("1h30m"), 5400000));
check("in 10 minutes → 600000", () => assert.equal(parseDurationMs("in 10 minutes"), 600000));
check("hourly → 3600000", () => assert.equal(parseDurationMs("hourly"), 3600000));
check("'+10m' → once (relative offset)", () => assert.equal(inferType("+10m"), "once"));
check("'in 2 hours' → once", () => assert.equal(inferType("in 2 hours"), "once"));
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
      if (plan.terminal) { s.remove(id); return; }
      go();
    }, loop.intervalMs);
  };
  go();
  await new Promise((r) => setTimeout(r, 600));
  check("fired exactly 5 times", () => assert.equal(fires.length, 5));
  check("removed after 5 fires", () => assert.equal(s.get(id), undefined));
  check("recurrence held (gaps 30-200ms)", () => {
    const gaps = fires.slice(1).map((t, i) => t - fires[i]);
    assert.ok(gaps.every((g) => g > 30 && g < 200), `gaps: ${gaps.join(",")}`);
  });
}

console.log("# Scope/owner — shouldArm decision");
{
  const mk = (scope, owner) => ({ id: "x", scope, owner });
  check("global arms in any session", () => assert.equal(shouldArm(mk("global", undefined), "anyone"), true));
  check("session loop arms for owner", () => assert.equal(shouldArm(mk("session", "sessA"), "sessA"), true));
  check("session loop does NOT arm for another session", () => assert.equal(shouldArm(mk("session", "sessA"), "sessB"), false));
  check("session loop does not arm without session id", () => assert.equal(shouldArm(mk("session", "sessA"), undefined), false));
}

console.log("# Scope/owner — two-file storage round-trip");
{
  const dir = `/tmp/pi-loop-scope-${Date.now()}`;
  const g = `${dir}/loops.json`, s = `${dir}/sessA.json`;
  const st = new LoopStore(g, s);
  const sid = newId(), gid = newId();
  st.add({ action: "prompt", type: "interval", schedule: "5m", intervalMs: 300000, prompt: "mine", scope: "session", owner: "sessA" }, sid);
  st.add({ action: "notify", type: "once", schedule: "+10m", message: "all", scope: "global" }, gid);
  await st.persist();
  const gRaw = JSON.parse(readFileSync(g, "utf8"));
  const sRaw = JSON.parse(readFileSync(s, "utf8"));
  check("session loop lives only in the session file", () => {
    assert.equal(sRaw.loops.length, 1);
    assert.equal(sRaw.loops[0].scope, "session");
    assert.equal(sRaw.loops[0].owner, "sessA");
    assert.ok(gRaw.loops.every((l) => l.id !== sid));
  });
  check("global loop lives only in the global file", () => {
    assert.equal(gRaw.loops.length, 1);
    assert.equal(gRaw.loops[0].scope, "global");
    assert.ok(sRaw.loops.every((l) => l.id !== gid));
  });
  const st2 = new LoopStore(g, s);
  await st2.load();
  check("load merges global + own session file", () => assert.equal(st2.list().length, 2));
}

console.log("# Legacy back-compat — unowned records load as global");
{
  const dir = `/tmp/pi-loop-legacy-${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  const g = `${dir}/loops.json`;
  writeFileSync(g, JSON.stringify({
    version: 1, updatedAt: new Date().toISOString(),
    loops: [{ id: "loop_legacy1", action: "prompt", type: "interval", schedule: "5m", intervalMs: 300000, prompt: "old", runCount: 3, createdAt: "2025-01-01T00:00:00.000Z", status: "active" }],
  }));
  const st = new LoopStore(g, `${dir}/sessA.json`);
  await st.load();
  check("legacy record loads as global", () => {
    const l = st.get("loop_legacy1");
    assert.equal(l.scope, "global");
    assert.equal(l.owner, undefined);
  });
  check("legacy record arms in any session (today's behavior)", () => assert.equal(shouldArm(st.get("loop_legacy1"), "anyone"), true));
}

console.log("# Two-terminal probe — A's session loop never arms or appears in B");
{
  const dir = `/tmp/pi-loop-twoterm-${Date.now()}`;
  const g = `${dir}/loops.json`;
  // Terminal A starts, creates one session loop + one global loop, persists.
  const A = new LoopStore(g, `${dir}/sessA.json`);
  await A.load();
  const sidA = newId(), gid = newId();
  A.add({ action: "prompt", type: "interval", schedule: "5m", intervalMs: 300000, prompt: "A only", scope: "session", owner: "sessA" }, sidA);
  A.add({ action: "message", type: "interval", schedule: "1h", intervalMs: 3600000, message: "everyone", scope: "global" }, gid);
  await A.persist();
  // Terminal B starts on the same path: same global file, its own session file.
  const B = new LoopStore(g, `${dir}/sessB.json`);
  await B.load();
  const armedIn = (store, sid) => store.list().filter((l) => shouldArm(l, sid)).map((l) => l.id);
  check("B never even sees A's session loop", () => assert.equal(B.list().some((l) => l.id === sidA), false));
  check("B sees and arms the global loop", () => assert.deepEqual(armedIn(B, "sessB"), [gid]));
  check("A arms its own session loop + the global loop", () => assert.deepEqual(armedIn(A, "sessA").sort(), [gid, sidA].sort()));
  // B mutating the global file must not touch A's session file (single writer).
  B.remove(gid);
  await B.persist();
  const sRawA = JSON.parse(readFileSync(`${dir}/sessA.json`, "utf8"));
  check("B's persist leaves A's session file untouched", () => assert.equal(sRawA.loops.length, 1));
}

console.log(failures === 0 ? "\n✅ ALL CHECKS PASSED" : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
