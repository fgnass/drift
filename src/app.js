import { createSoundscape, DEFAULT_MIX, SAMPLE_RATE } from "./soundscape.js";
import { startScene } from "./scene.js";
import { registerSW } from "virtual:pwa-register";

const $ = (s) => document.querySelector(s);

registerSW({ immediate: true });
const playBtn = $("#play");
const status = $("#status");
const remaining = $("#remaining");
const chips = [...document.querySelectorAll(".chips button")];
const layerInputs = [...document.querySelectorAll("[data-layer]")];
const bar = $(".bar");
const mixerToggle = $("#mixer-toggle");
const mixerPanel = $("#mixer-panel");
const resetBtn = $("#mixer-reset");

const defaults = {
  volume: 0.7,
  ...DEFAULT_MIX,
  timer: 60,
};

const settings = { ...defaults, ...load() };

function load() {
  try {
    return JSON.parse(localStorage.getItem("drift")) || {};
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem("drift", JSON.stringify(settings));
  } catch {}
}

// --- Audio ---

let audio = null; // Promise of { ctx, scape, play, sleep, volume }
let ready = null; // the resolved value of `audio`
let playing = false;
let playbackRequest = 0;
let timerEnd = 0;
let timerFade = 0; // length of the sleep fade in seconds
let slept = false; // the sleep timer has ended: keep the scene dark
let stopTimeout = 0;

// Audio time that is heard right now (after the output latency), so the
// scene shows each sound event when it reaches the ear
function heardTime() {
  if (!ready || !playing || ready.ctx.state !== "running") return null;
  const { ctx } = ready;
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.contextTime > 0) return ts.contextTime;
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
}

// The scene is decoration: if it fails, the player must still work.
const scene = (() => {
  try {
    return startScene($("#scene"), { now: heardTime, aurora: $("#aurora") });
  } catch (error) {
    console.error(error);
    return { receive() {}, setFade() {} };
  }
})();

// Must run inside the click handler: iOS only unlocks audio when
// resume() is called synchronously in a user gesture.
async function initAudio() {
  // Play through the iOS mute switch, like a music app
  if (navigator.audioSession) navigator.audioSession.type = "playback";
  const ctx = new AudioContext({
    latencyHint: "playback",
    sampleRate: SAMPLE_RATE,
  });
  try {
    await ctx.resume();
    return await buildGraph(ctx);
  } catch (error) {
    await ctx.close().catch(() => {});
    throw error;
  }
}

async function buildGraph(ctx) {
  const scape = await createSoundscape(ctx);
  const play = ctx.createGain(); // fade on play / pause
  const sleep = ctx.createGain(); // fade at the end of the sleep timer
  const volume = ctx.createGain();
  play.gain.value = 0;
  scape.output
    .connect(play)
    .connect(sleep)
    .connect(volume)
    .connect(ctx.destination);
  for (const name of ["rumble", "wind", "howl", "snow"]) {
    scape.setLayer(name, settings[name], 0.01);
  }
  scape.onState = (state) => scene.receive(state);
  volume.gain.value = curve(settings.volume);
  ready = { ctx, scape, play, sleep, volume };
  return ready;
}

const curve = (v) => v * v;

async function start() {
  const request = ++playbackRequest;
  playing = true;
  slept = false;
  updateSceneFade();
  render();
  let pending = audio;
  let graph;
  try {
    if (!pending) pending = audio = initAudio();
    // Keep resume() inside the user gesture, including on subsequent plays.
    const resume = ready?.ctx.resume();
    [graph] = await Promise.all([pending, resume]);
  } catch {
    if (audio !== pending) return;
    const failed = ready;
    audio = null;
    ready = null;
    stop();
    status.textContent = "Unable to start audio. Press Play to try again.";
    if (failed) await failed.ctx.close().catch(() => {});
    return;
  }
  const { ctx, play } = graph;
  // Only the latest play request may start the graph or arm the timer.
  if (request !== playbackRequest) {
    if (!playing) await ctx.suspend();
    return;
  }
  clearTimeout(stopTimeout);
  play.gain.cancelScheduledValues(ctx.currentTime);
  play.gain.setTargetAtTime(1, ctx.currentTime, 1.5);
  armTimer();
  render();
}

function stop(fade = 0.5) {
  playbackRequest++;
  playing = false;
  timerEnd = 0;
  clearTimeout(stopTimeout);
  render();
  if (!ready) return;
  const { ctx, play } = ready;
  play.gain.cancelScheduledValues(ctx.currentTime);
  play.gain.setTargetAtTime(0, ctx.currentTime, fade);
  // Suspend after the fade so the device can save power
  stopTimeout = setTimeout(() => !playing && ctx.suspend(), fade * 6000);
}

// Fade length: the last third of the timer, at most 10 minutes
function armTimer() {
  // A paused graph may still have a suspension scheduled after its fade.
  if (!playing) return;
  const { ctx, sleep } = ready;
  const g = sleep.gain;
  const now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(1, now);
  clearTimeout(stopTimeout);
  timerEnd = 0;
  if (!settings.timer) return;
  const total = settings.timer * 60;
  const fade = Math.min(total / 3, 600);
  timerFade = fade;
  g.setValueAtTime(1, now + total - fade);
  // Exponential ramp = even loudness steps, sounds like a natural fade
  g.exponentialRampToValueAtTime(0.0005, now + total);
  timerEnd = Date.now() + total * 1000;
  stopTimeout = setTimeout(() => {
    stop(0.1);
    slept = true;
    updateSceneFade();
    status.textContent = "Sleep well.";
  }, total * 1000);
}

// --- UI ---

// Keep the filled track aligned with both saved settings and live changes.
function updateRange(input) {
  const progress =
    ((Number(input.value) - Number(input.min)) /
      (Number(input.max) - Number(input.min))) *
    100;
  input.style.setProperty("--progress", `${progress}%`);
}

function render() {
  playBtn.setAttribute("aria-pressed", String(playing));
  playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  for (const c of chips) {
    c.setAttribute(
      "aria-checked",
      String(Number(c.dataset.minutes) === settings.timer),
    );
  }
  renderRemaining();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }
}

function renderRemaining() {
  if (!timerEnd) {
    remaining.textContent = "";
    return;
  }
  const s = Math.max(0, Math.round((timerEnd - Date.now()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  remaining.textContent = h
    ? `${h}:${pad(m)}:${pad(s % 60)}`
    : `${m}:${pad(s % 60)}`;
}
setInterval(() => {
  renderRemaining();
  updateSceneFade();
}, 1000);

// The scene goes dark together with the sleep fade of the sound
function updateSceneFade() {
  if (slept) return scene.setFade(0);
  if (!timerEnd || !timerFade) return scene.setFade(1);
  const remaining = Math.max(0, (timerEnd - Date.now()) / 1000);
  scene.setFade(Math.min(1, remaining / timerFade) ** 1.5);
}

playBtn.addEventListener("click", () => {
  status.innerHTML = "&nbsp;";
  playing ? stop() : start();
});

const volumeInput = $("#volume");
volumeInput.value = settings.volume;
updateRange(volumeInput);
volumeInput.addEventListener("input", () => {
  updateRange(volumeInput);
  settings.volume = Number(volumeInput.value);
  ready?.volume.gain.setTargetAtTime(
    curve(settings.volume),
    ready.ctx.currentTime,
    0.05,
  );
  save();
});

function setLayer(name, value) {
  settings[name] = value;
  ready?.scape.setLayer(name, value);
}

function renderReset() {
  resetBtn.disabled = layerInputs.every(
    (input) => settings[input.dataset.layer] === DEFAULT_MIX[input.dataset.layer],
  );
}

for (const input of layerInputs) {
  const name = input.dataset.layer;
  input.value = settings[name];
  updateRange(input);
  input.addEventListener("input", () => {
    updateRange(input);
    setLayer(name, Number(input.value));
    renderReset();
    save();
  });
}
renderReset();

resetBtn.addEventListener("click", () => {
  for (const input of layerInputs) {
    const name = input.dataset.layer;
    input.value = DEFAULT_MIX[name];
    updateRange(input);
    setLayer(name, DEFAULT_MIX[name]);
  }
  renderReset();
  save();
});

// The panel is a popover (top layer, closes on a click outside and on
// Escape), so it is placed above the bar by hand.
// Only the bar rect is used: the viewport size is unreliable on mobile,
// where the browser toolbar comes and goes.
function placeMixer() {
  const r = bar.getBoundingClientRect();
  const narrow = matchMedia("(max-width: 760px)").matches;
  // Narrow: as wide as the bar, aligned with its outer border
  const width = narrow ? r.width + 2 : 300;
  mixerPanel.style.width = `${width}px`;
  mixerPanel.style.left = `${r.right + (narrow ? 1 : 0) - width}px`;
  mixerPanel.style.top = `${r.top - 12}px`;
}
mixerPanel.addEventListener("beforetoggle", (e) => {
  const open = e.newState === "open";
  mixerToggle.setAttribute("aria-expanded", String(open));
  if (open) placeMixer();
});

// The info panel opens below its button, aligned with its right edge
const infoToggle = $("#info-toggle");
const infoPanel = $("#info-panel");
function placeInfo() {
  const r = infoToggle.getBoundingClientRect();
  infoPanel.style.top = `${r.bottom + 12}px`;
  infoPanel.style.right = `${document.documentElement.clientWidth - r.right}px`;
}
infoPanel.addEventListener("beforetoggle", (e) => {
  const open = e.newState === "open";
  infoToggle.setAttribute("aria-expanded", String(open));
  if (open) placeInfo();
});
addEventListener("resize", () => {
  if (mixerPanel.matches(":popover-open")) placeMixer();
  if (infoPanel.matches(":popover-open")) placeInfo();
});

for (const chip of chips) {
  chip.addEventListener("click", () => {
    settings.timer = Number(chip.dataset.minutes);
    save();
    if (ready) armTimer();
    render();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target === document.body) {
    e.preventDefault();
    playBtn.click();
  }
});

// Dim the controls when nobody touches the screen for a while
let idleTimeout = 0;
function wake() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimeout);
  idleTimeout = setTimeout(() => {
    if (!playing) return;
    document.body.classList.add("idle");
    // The top layer does not dim with the rest
    mixerPanel.hidePopover();
    infoPanel.hidePopover();
  }, 15000);
}
for (const type of ["pointermove", "pointerdown", "keydown", "focusin"]) {
  addEventListener(type, wake, { passive: true });
}

// --- Install ---

// The button shows only while the app can be installed and is not yet.
const installBtn = $("#install");
const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
let installPrompt = null; // the deferred beforeinstallprompt event (Chromium)
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isSafari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  installBtn.hidden = installed;
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  installBtn.hidden = true;
  status.textContent = "Installed. Find drift on your home screen.";
});
// iOS has no install prompt: the button explains the manual way instead.
if (!installed && isIOS && isSafari) installBtn.hidden = false;

installBtn.addEventListener("click", async () => {
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    installBtn.hidden = true;
    // Each event can prompt only once; a dismissal gets a new event later.
    prompt.prompt();
    await prompt.userChoice;
    return;
  }
  status.textContent = "Tap Share, then \u201cAdd to Home Screen\u201d.";
});

if ("mediaSession" in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: "A blizzard outside",
    artist: "drift",
  });
  navigator.mediaSession.setActionHandler("play", () => start());
  navigator.mediaSession.setActionHandler("pause", () => stop());
}

render();
wake();
