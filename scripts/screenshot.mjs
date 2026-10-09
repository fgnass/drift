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
 *   public/screenshots/og.png      the link preview (og:image): playing on a
 *                                  desktop viewport, in a browser window on
 *                                  the aurora teal, 2400 × 1260
 *
 * Re-run any time the UI changes:  npm run screenshot
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "public", "screenshots");

// Target output is 780 × 1688: half that on a high-DPI viewport, captured at
// the native device pixels.
const VIEWPORT = { width: 390, height: 844 };
const SCALE = 2;

const PORT = 5172;
const BASE = `http://127.0.0.1:${PORT}/`;

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

const BAR = 40;
const BORDER = 2;

/**
 * A shot in a stylized browser window on the accent color, like the link
 * previews of the other projects on gnass.buzz/projects. `canvas` is the image
 * size in CSS pixels, `window` the place of the window in it. The app
 * viewport is the window minus its border and title bar.
 */
function framedShot(canvas, window, stage) {
  const content = {
    width: window.width - 2 * BORDER,
    height: window.height - BAR - 2 * BORDER,
  };
  return {
    viewport: content,
    mobile: false,
    stage,
    compose: (browser, png) =>
      frameInBrowser(browser, png, canvas, window, content),
  };
}

async function frameInBrowser(browser, png, canvas, w, content) {
  const html = `<!doctype html>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${canvas.width}px; height: ${canvas.height}px; background: ${ACCENT}; overflow: hidden; }
  .window {
    position: absolute; left: ${w.x}px; top: ${w.y}px; width: ${w.width}px; height: ${w.height}px;
    border: ${BORDER}px solid ${FRAME}; border-radius: 16px; overflow: hidden;
    background: ${FRAME}; box-shadow: 0 10px #00000038;
  }
  .bar { position: relative; height: ${BAR}px; display: flex; align-items: center; padding-left: 16px; gap: 8px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: ${ACCENT}; opacity: 0.6; }
  .url {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: 360px; height: 26px; border-radius: 13px; background: #ffffff1a;
    color: #d6fff3; font: 500 13px/26px system-ui, sans-serif; text-align: center; letter-spacing: 0.02em;
  }
  img { display: block; width: ${content.width}px; height: ${content.height}px; }
</style>
<div class="window">
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">drift.gnass.buzz</span></div>
  <img src="data:image/png;base64,${png.toString("base64")}" />
</div>`;
  const context = await browser.newContext({
    viewport: canvas,
    deviceScaleFactor: SCALE,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return {
      png: await page.screenshot(),
      size: { width: canvas.width * SCALE, height: canvas.height * SCALE },
    };
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
  // Link preview for LinkedIn, Slack etc., which use 1.91:1.
  og: framedShot(
    { width: 1200, height: 630 },
    { x: 60, y: 40, width: 1080, height: 534 },
    async (page) => {
      await play(page);
      await wait(page, AURORA_MS);
    },
  ),
};

function startServer() {
  return createServer({
    root,
    logLevel: "warn",
    server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  }).then((server) => server.listen());
}

/** Capture one shot in its own context (own localStorage), then dispose it. */
async function capture(browser, name, shot) {
  const { viewport = VIEWPORT, scale = SCALE, mobile = true } = shot;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    isMobile: mobile,
    hasTouch: mobile,
  });
  try {
    await context.addInitScript(seedRandom, 7);
    const page = await context.newPage();
    page.on("pageerror", (err) => console.log(`  [page] ${err.message}`));
    console.log(`Opening ${BASE} for ${name}`);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await shot.stage(page);
    let png = await page.screenshot();
    let size = {
      width: viewport.width * scale,
      height: viewport.height * scale,
    };
    if (shot.compose) ({ png, size } = await shot.compose(browser, png));
    const out = resolve(outDir, `${name}.png`);
    await writeFile(out, png);
    console.log(`Saved ${out} (${size.width} × ${size.height})`);
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
    await Promise.all(
      Object.entries(SHOTS).map(([name, shot]) => capture(browser, name, shot)),
    );
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
