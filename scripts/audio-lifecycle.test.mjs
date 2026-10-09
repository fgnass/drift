import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "");

function setup({ defer = false, fail = false } = {}) {
  const timers = new Map();
  const contexts = [];
  let nextId = 0;
  let attempts = 0;
  let resolveScape;
  let markLoading;
  const loading = new Promise(resolve => { markLoading = resolve; });
  const element = () => ({
    dataset: {}, min: 0, max: 1,
    style: { setProperty() {} },
    setAttribute() {}, addEventListener() {},
  });
  const elements = new Map();
  const scape = { output: { connect(node) { return node; } }, setLayer() {} };
  const sandbox = {
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      querySelectorAll() { return []; }, addEventListener() {},
      body: { classList: { remove() {}, add() {} } },
    },
    navigator: {}, localStorage: { getItem() { return null; }, setItem() {} },
    registerSW() {}, startScene() { return { receive() {}, setFade() {} }; },
    DEFAULT_MIX: { rumble: 0.8, wind: 0.7, howl: 0.75, snow: 0.5 },
    SAMPLE_RATE: 24000,
    createSoundscape() {
      attempts++;
      markLoading();
      if (fail && attempts === 1) return Promise.reject(new Error("Worklet failed"));
      return defer ? new Promise(resolve => { resolveScape = resolve; }) : Promise.resolve(scape);
    },
    AudioContext: class {
      constructor() {
        this.state = "suspended";
        this.currentTime = 0;
        contexts.push(this);
      }
      async resume() { this.state = "running"; }
      async suspend() { this.state = "suspended"; }
      async close() { this.state = "closed"; }
      createGain() {
        return {
          gain: {
            value: 1, cancelScheduledValues() {}, setTargetAtTime() {},
            setValueAtTime() {}, exponentialRampToValueAtTime() {},
          },
          connect(node) { return node; },
        };
      }
    },
    setTimeout(fn, ms) {
      const id = ++nextId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }, setInterval() {}, addEventListener() {},
    performance, Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    run: code => vm.runInContext(code, sandbox), timers, contexts, elements, loading,
    resolve: () => resolveScape(scape), attempts: () => attempts,
  };
}

test("changing the timer during a pause preserves the pending suspension", async () => {
  const app = setup();
  await app.run("start()");
  app.run("stop()");
  app.run("settings.timer = 15; armTimer()");
  const suspension = [...app.timers.values()].find(timer => timer.ms === 3000);
  assert.ok(suspension);
  await suspension.fn();
  assert.equal(app.contexts[0].state, "suspended");
  await app.run("start()");
  assert.equal(app.contexts[0].state, "running");
  assert.ok(app.run("timerEnd > Date.now()"));
});

test("pausing while the worklet loads suspends the completed context", async () => {
  const app = setup({ defer: true });
  const starting = app.run("start()");
  await app.loading;
  app.run("stop()");
  app.resolve();
  await starting;
  assert.equal(app.contexts[0].state, "suspended");
  assert.equal(app.run("playing"), false);
  assert.equal(app.run("timerEnd"), 0);
});

test("play-pause-play while loading arms only one sleep timer", async () => {
  const app = setup({ defer: true });
  const first = app.run("start()");
  await app.loading;
  app.run("stop()");
  const second = app.run("start()");
  app.resolve();
  await Promise.all([first, second]);
  assert.equal(app.contexts[0].state, "running");
  assert.equal(app.run("playing"), true);
  assert.equal([...app.timers.values()].filter(timer => timer.ms === 3600000).length, 1);
});

test("a worklet failure closes the context, resets playback, and permits retry", async () => {
  const app = setup({ fail: true });
  await app.run("start()");
  assert.equal(app.contexts[0].state, "closed");
  assert.equal(app.run("playing"), false);
  assert.equal(app.run("audio"), null);
  assert.match(app.elements.get("#status").textContent, /try again/);
  await app.run("start()");
  assert.equal(app.attempts(), 2);
  assert.equal(app.contexts[1].state, "running");
  assert.equal(app.run("playing"), true);
});
