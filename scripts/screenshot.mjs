/**
 * Portfolio screenshot generator
 *
 * Starts the Vite dev server and captures the real app at an iPhone-class
 * viewport scaled 2× → exactly 780 × 1688. Math.random is seeded, so the
 * snow, the aurora and the storm look the same on each run. Each shot waits
 * until the first aurora episode has grown (see updateEpisode in scene.js).
 *
 * They land in public/screenshots/, so the deployed site serves them at
 * https://drift.gnass.buzz/screenshots/*.png.
 *
 *   public/screenshots/start.png   playing, the main screen
 *   public/screenshots/mixer.png   playing, with the sound mixer open
 *   public/screenshots/og.png      the link preview (og:image): the wordmark
 *                                  and two short phones (360 × 700), idle and
 *                                  with the mixer open, on the aurora teal,
 *                                  2400 × 1260
 *
 * Re-run any time the UI changes:  npm run screenshot
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { shape } from "./lettering.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "public", "screenshots");

// Target output is 780 × 1688: half that on a high-DPI viewport, captured at
// the native device pixels.
const VIEWPORT = { width: 390, height: 844 };
const SCALE = 2;

const PORT = 5172;
const BASE = `http://127.0.0.1:${PORT}/`;

// Viewport of the phones in the link preview
const PREVIEW_VIEWPORT = { width: 360, height: 700 };

// The first aurora starts after 1–3 s and grows with a time constant of 3 s
const AURORA_MS = 12_000;

// Frame colors: the night of the app on the teal of the aurora
const ACCENT = "#4af0c4";
const FRAME = "#080b12";

/** Replaces Math.random with a seeded PRNG (mulberry32), before any app code runs. */
function seedRandom(seed) {
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wait = (page, ms) => page.waitForTimeout(ms);

async function play(page) {
  await page.click("#play");
  await page.waitForSelector('#play[aria-pressed="true"]');
}

// The link preview (og:image) for LinkedIn, Slack etc., which use 1.91:1
const OG = { width: 1200, height: 630 };

/** A phone screenshot in a dark frame, like the windows on gnass.buzz/projects. */
function phone(png, { x, y, width }) {
  return `<div class="phone" style="left:${x}px; top:${y}px; width:${width}px">
    <img src="data:image/png;base64,${png.toString("base64")}" />
  </div>`;
}

/** The wordmark in Economica Italic, the same glyphs as in the app header. */
function wordmark(width) {
  const { d, x, y, width: w, height: h } = shape("drift");
  return `<svg viewBox="${x} ${y} ${w} ${h}" width="${width}" height="${(width * h) / w}">
    <path fill="${FRAME}" d="${d}"/></svg>`;
}

/** Link previews, composed from the phone shots on the accent color. */
const PREVIEWS = {
  // The wordmark with the tagline, and two short phones that fit
  // completely: the quiet scene and all the controls
  og: ({ idle, controls }) => `
    <div class="side">
      ${wordmark(240)}
      <p>A blizzard outside your window, synthesized live.</p>
    </div>
    ${phone(idle, { x: 530, y: 50, width: 273 })}
    ${phone(controls, { x: 837, y: 50, width: 273 })}`,
};

async function compose(browser, name, body) {
  const html = `<!doctype html>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${OG.width}px; height: ${OG.height}px; background: ${ACCENT}; overflow: hidden; }
  .phone {
    position: absolute; padding: 10px; border-radius: 44px;
    background: ${FRAME}; box-shadow: 0 10px #00000038;
  }
  .phone img { display: block; width: 100%; border-radius: 34px; }
  .side { position: absolute; left: 90px; top: 50%; transform: translateY(-50%); width: 380px; }
  .side p { margin-top: 28px; color: ${FRAME}; font: 500 28px/1.35 system-ui, sans-serif; }
</style>
${body}`;
  const context = await browser.newContext({ viewport: OG, deviceScaleFactor: SCALE });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const out = resolve(outDir, `${name}.png`);
    await writeFile(out, await page.screenshot());
    console.log(`Saved ${out} (${OG.width * SCALE} × ${OG.height * SCALE})`);
  } finally {
    await context.close();
  }
}

/** Each shot: how to bring the app into its state. */
const SHOTS = {
  // Before play there is only the sky, so every shot plays first.
  start: {
    async stage(page) {
      await play(page);
      await wait(page, AURORA_MS);
    },
  },
  mixer: {
    async stage(page) {
      await play(page);
      await page.click("#mixer-toggle");
      await wait(page, AURORA_MS);
    },
  },
  // For the link preview only: shorter, narrower phones, so two of them
  // fit completely. The quiet scene, after the controls have dimmed:
  idle: {
    viewport: PREVIEW_VIEWPORT,
    tries: 4,
    save: false,
    async stage(page) {
      await play(page);
      await wait(page, AURORA_MS);
      // Nobody touches the screen for 15 s; the dimming takes 4 s
      await page.evaluate(() => document.body.classList.add("idle"));
      await wait(page, 4500);
    },
  },
  // All the controls, with the sound mixer open:
  controls: {
    viewport: PREVIEW_VIEWPORT,
    tries: 4,
    save: false,
    async stage(page) {
      await play(page);
      await page.click("#mixer-toggle");
      await wait(page, AURORA_MS);
    },
  },
};

function startServer() {
  return createServer({
    root,
    logLevel: "warn",
    server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  }).then((server) => server.listen());
}

/** Light of the aurora canvas: the sum of its color, weighted by alpha. */
function auroraLight() {
  const c = document.querySelector("#aurora");
  const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += ((data[i] + data[i + 1] + data[i + 2]) * data[i + 3]) / 255;
  }
  return sum / (c.width * c.height) * Number(getComputedStyle(c).opacity);
}

/**
 * Capture a shot `tries` times and keep the one with the brightest aurora.
 * The seed only reaches the page: the storm in the audio worklet, which
 * sets the strength of the aurora, is different on each run.
 */
async function captureBest(browser, name, shot) {
  const { tries = 1 } = shot;
  const runs = await Promise.all(
    Array.from({ length: tries }, (_, i) => capture(browser, name, shot, 7 + i)),
  );
  const best = runs.reduce((a, b) => (b.light > a.light ? b : a));
  const { viewport = VIEWPORT, save = true } = shot;
  if (save) {
    const out = resolve(outDir, `${name}.png`);
    await writeFile(out, best.png);
    console.log(`Saved ${out} (${viewport.width * SCALE} × ${viewport.height * SCALE})`);
  }
  return best.png;
}

/** Capture one shot in its own context (own localStorage), then dispose it. */
async function capture(browser, name, shot, seed) {
  const { viewport = VIEWPORT } = shot;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
  });
  try {
    await context.addInitScript(seedRandom, seed);
    const page = await context.newPage();
    page.on("pageerror", (err) => console.log(`  [page] ${err.message}`));
    console.log(`Opening ${BASE} for ${name}`);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await shot.stage(page);
    const light = await page.evaluate(auroraLight);
    return { png: await page.screenshot(), light };
  } finally {
    await context.close();
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = await startServer();
  // The audio must run, because the storm it reports drives the scene
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const names = Object.keys(SHOTS);
    const pngs = await Promise.all(names.map((name) => captureBest(browser, name, SHOTS[name])));
    const shots = Object.fromEntries(names.map((name, i) => [name, pngs[i]]));
    for (const [name, body] of Object.entries(PREVIEWS)) {
      await compose(browser, name, body(shots));
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
