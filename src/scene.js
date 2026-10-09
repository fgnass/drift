// Night window: aurora, snow and the reflection of a candle on the glass.
// Everything follows the state of the storm that the audio worklet reports
// (see report() in blizzard-worklet.js):
//
//   howl voices    → aurora: each voice colors one band of the sky
//                    (pitch = hue toward violet, level = light)
//   whistle        → a bright wave runs once across the aurora
//   gust, gusts    → wind on the snow: drift, turbulence, gusts sweep it away
//   air            → fine snow dust with its own motion
//   buffets        → the candle flickers in the draft
//   breath         → the candle light slowly rises and falls
//   snow mixer     → brightness of the candle light
//   weather        → strength of the aurora, amount of snow
//
// The aurora is not always there: it comes in episodes every few minutes,
// grows over half a minute, stays for a while and fades again. The first
// episode starts a few seconds after play and grows faster, so that the
// aurora is visible within the first 10 s.
//
// While the sound is paused there is only the sky and the candle: snow and
// aurora fade out, all motion eases out and the drawing stops, until the
// sound plays again.

import { simplex3 } from "./noise.js";

const FPS = 30;
// The aurora is a flow field (after "Northern Lights" by Aerlynn on CodePen):
// a coarse grid of tiles, each colored from a 3D simplex noise vector, drawn
// one pixel per tile on a tiny canvas that CSS scales up and blurs.
const TILE_W = 16;
const TILE_H = 32;

// Typical layer gains of the default mix, to normalize the mixer values
const MIX_NORM = [0.64, 1.37, 1.125, 0.03];
// Gain of the snow layer at slider position 1 (LEVELS.snow in soundscape.js)
const SNOW_LEVEL = 0.12;

// What the scene shows while the sound is paused
const CALM = {
  gust: 0.3,
  base: 0.35,
  g: 0,
  b: 0,
  breath: 0,
  air: 0,
  voices: [
    [175, 0, 0],
    [230, 0, 0],
    [370, 0, 0],
    [440, 0, 0],
  ],
  mix: MIX_NORM.map((m) => m * 0.6),
  whistle: null,
};

// Aurora palette: teal at low pitch, violet at high pitch, green in the glow
const TEAL = [74, 240, 196];
const VIOLET = [142, 108, 255];
const GREEN = [155, 247, 166];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

export function startScene(canvas, { now, aurora }) {
  const ctx = canvas.getContext("2d");
  const actx = aurora.getContext("2d");
  let field = null; // ImageData of the aurora, one pixel per tile
  let noiseTime = Math.random() * 1000;
  // Aurora episode: phase "off" | "rise" | "hold" | "fall", seconds left in it
  const episode = { phase: "off", left: 1 + Math.random() * 2, level: 0, strength: 1, first: true };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  let width = 0;
  let height = 0;
  let flakes = [];
  let dust = [];
  let fade = 1;
  let fadeTarget = 1;
  let time = 0; // scene time, only runs while the scene moves
  let lastFrame = 0;
  let motion = 0; // 0 = still (paused), 1 = moving (sound plays)
  let presence = 0; // 0 = only the sky (paused), 1 = snow and aurora shown
  let resized = false; // draw at least once after a resize

  // Messages from the worklet, applied when their sound is heard
  const queue = [];
  let latest = null;
  let lastMessage = -Infinity;

  // Smoothed values that the drawing uses
  const s = {
    live: 0, // 0 = paused (calm), 1 = following the sound
    gust: CALM.gust,
    base: CALM.base,
    g: 0,
    b: 0,
    breath: 0,
    air: 0,
    voices: CALM.voices.map(([, p, lv]) => ({ p, lv })),
    mix: [...CALM.mix],
    shimmer: 0,
    shimmerX: 0,
  };
  const flicker = { slow: 0, fast: 0, fastTarget: 0, next: 0 };

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    // Not laid out yet (cold start of the installed app): frame() tries again
    if (!width || !height) return;
    resized = true;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    aurora.width = Math.ceil(width / TILE_W);
    aurora.height = Math.ceil(height / TILE_H);
    field = actx.createImageData(aurora.width, aurora.height);
    const area = width * height;
    flakes = Array.from({ length: Math.round(area / 6000) }, () => flake(true));
    dust = Array.from({ length: Math.round(area / 9000) }, () => mote());
  }

  function flake(anywhere) {
    const depth = Math.random();
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : -8,
      r: 0.5 + depth * 1.8,
      depth,
      fall: 8 + depth * 30, // own falling speed, px/s
      vx: 0,
      vy: 0,
      seed: Math.random() * 100,
      alpha: 0.15 + depth * 0.45,
      rank: Math.random(), // flakes with a low rank show first
    };
  }

  function mote() {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.3 + Math.random() * 0.5,
      speed: 0.6 + Math.random() * 0.8,
      phase: Math.random() * Math.PI * 2,
    };
  }

  // --- State ---

  function receive(msg) {
    queue.push(msg);
  }

  function applyMessages(heard) {
    while (queue.length && (heard === null || queue[0].t <= heard)) {
      const msg = queue.shift();
      latest = msg;
      lastMessage = performance.now();
    }
  }

  // Returns the time step of the scene motion
  function update(dt) {
    const heard = now();
    applyMessages(heard);
    const live = heard !== null && latest && performance.now() - lastMessage < 1500;
    const src = live ? latest : CALM;
    const playing = heard !== null;
    motion = lerp(motion, playing ? 1 : 0, 1 - Math.exp(-dt / 0.8));
    presence = lerp(presence, playing ? 1 : 0, 1 - Math.exp(-dt / 1.5));
    const mdt = dt * motion;
    time += mdt;
    // Smoothing: about 0.4 s for the storm, slower for the weather
    const k = 1 - Math.exp(-dt / 0.4);
    const kSlow = 1 - Math.exp(-dt / 2);
    s.live = lerp(s.live, live ? 1 : 0, kSlow);
    s.gust = lerp(s.gust, src.gust, k);
    s.base = lerp(s.base, src.base, kSlow);
    s.g = lerp(s.g, src.g, 1 - Math.exp(-dt / 0.2));
    s.b = lerp(s.b, src.b, 1 - Math.exp(-dt / 0.15));
    s.breath = lerp(s.breath, src.breath, k);
    s.air = lerp(s.air, src.air, k);
    src.voices.forEach(([, p, lv], i) => {
      s.voices[i].p = lerp(s.voices[i].p, p, k);
      s.voices[i].lv = lerp(s.voices[i].lv, lv, k);
    });
    src.mix.forEach((m, i) => (s.mix[i] = lerp(s.mix[i], m, k)));

    // Whistle: a bright wave runs across the aurora
    if (src.whistle) {
      const [x] = src.whistle;
      s.shimmer = Math.sin(Math.PI * clamp(x, 0, 1)) ** 2;
      s.shimmerX = 0.1 + 0.8 * x;
    } else {
      s.shimmer = lerp(s.shimmer, 0, k);
    }

    fade = lerp(fade, fadeTarget, 1 - Math.exp(-dt / 1.5));
    updateEpisode(mdt);

    // Candle flicker: a slow wave plus a faster, random part. Buffets
    // (deep pushes of the storm) make it flicker like in a draft.
    if (!reduced.matches) {
      flicker.slow = Math.sin(time * 0.9) * 0.6 + Math.sin(time * 1.7 + 1) * 0.4;
      if (time > flicker.next) {
        flicker.fastTarget = Math.random() * 2 - 1;
        flicker.next = time + 0.06 + Math.random() * 0.12;
      }
      flicker.fast = lerp(flicker.fast, flicker.fastTarget, 1 - Math.exp(-mdt / 0.05));
    }
    return mdt;
  }

  // Aurora episodes: a few minutes apart, each one different in strength
  function updateEpisode(dt) {
    const e = episode;
    if (reduced.matches) {
      e.level = 0.35;
      return;
    }
    e.left -= dt;
    if (e.left <= 0) {
      if (e.phase === "off") {
        e.phase = "rise";
        e.left = 25 + Math.random() * 25;
        e.strength = 0.6 + Math.random() * 0.5;
      } else if (e.phase === "rise") {
        e.phase = "hold";
        e.left = 60 + Math.random() * 120;
        e.first = false;
      } else if (e.phase === "hold") {
        e.phase = "fall";
        e.left = 40 + Math.random() * 40;
      } else {
        e.phase = "off";
        e.left = 120 + Math.random() * 240;
      }
    }
    const target = e.phase === "rise" || e.phase === "hold" ? e.strength : 0;
    // Slow, smooth approach: about 20 s to rise, 25 s to fade.
    // The first rise is faster: about 3 s.
    const tau = e.phase === "fall" ? 25 : e.first ? 3 : 20;
    e.level = lerp(e.level, target, 1 - Math.exp(-dt / tau));
  }

  // --- Drawing ---

  const mixOf = (i) => clamp(s.mix[i] / MIX_NORM[i], 0, 1.6);

  function drawAurora(dt) {
    const W = aurora.width;
    const H = aurora.height;
    // Weather: a stronger storm gives a stronger aurora (base is about 0.2–0.6)
    const weather = clamp(0.6 + 1.2 * (s.base - 0.4), 0.35, 1.1);
    const light = 1.1 * mixOf(2) * weather * episode.level * (1 + 0.25 * s.g) * presence;
    if (light < 0.004) {
      actx.clearRect(0, 0, W, H);
      return;
    }
    if (!reduced.matches) noiseTime += dt * (0.035 + 0.09 * s.gust);
    const t = noiseTime;
    const data = field.data;
    const voices = s.voices;
    // Two wavy bands high in the sky, like real aurora. Their height and
    // thickness drift slowly; the flow field gives the structure inside.
    const centers = new Float32Array(W * 2);
    for (let x = 0; x < W; x++) {
      const u = x / W;
      centers[x * 2] = 0.2 + 0.05 * simplex3(x / 50, 7, t * 0.4) + 0.03 * Math.sin(u * 4 + t * 0.2);
      centers[x * 2 + 1] = 0.34 + 0.05 * simplex3(x / 40, 19, t * 0.3) - 0.03 * Math.sin(u * 3 - t * 0.25);
    }
    let i = 0;
    for (let y = 0; y < H; y++) {
      const v = y / (H - 1); // 0 = top
      for (let x = 0; x < W; x++, i += 4) {
        const u = x / W;
        // Each howl voice owns a quarter of the width, low pitch left
        const voice = voices[Math.min(3, Math.floor(u * 4))];
        const lift = 0.02 * voice.p; // high pitch lifts the band a little
        const d1 = (v - centers[x * 2] + lift) / 0.075;
        const d2 = (v - centers[x * 2 + 1] + lift) / 0.055;
        const envelope = Math.exp(-d1 * d1) + 0.55 * Math.exp(-d2 * d2);
        if (envelope < 0.01) {
          data[i + 3] = 0;
          continue;
        }
        const bandLight = 0.75 + 0.35 * voice.lv;
        const angle = simplex3(x / 70, y / 16, t) * Math.PI * 2;
        const len = simplex3(x / 36 + 400, y / 8 + 400, t * 0.8) + 0.12 * s.air;
        const l2 = len * len;
        const xm = l2 * Math.abs(Math.cos(angle));
        const ym = l2 * Math.abs(Math.sin(angle));
        // Teal in the body of the band, violet toward its upper edge and
        // with high pitch, green where the flow is strong and horizontal
        const edge = clamp((centers[x * 2] - v) / 0.1, 0, 1);
        const hue = clamp(0.1 + 0.8 * ym - 0.4 * xm + 0.3 * voice.p + 0.5 * edge, 0, 1);
        const glow = clamp(1.2 * xm - 0.3, 0, 1);
        const wave = s.shimmer * Math.exp(-(((u - s.shimmerX) / 0.07) ** 2));
        const a = clamp(light * envelope * bandLight * (0.25 + 1.2 * (xm + ym) + 0.8 * wave), 0, 1);
        data[i] = lerp(lerp(TEAL[0], VIOLET[0], hue), GREEN[0], glow);
        data[i + 1] = lerp(lerp(TEAL[1], VIOLET[1], hue), GREEN[1], glow);
        data[i + 2] = lerp(lerp(TEAL[2], VIOLET[2], hue), GREEN[2], glow);
        data[i + 3] = a * 255;
      }
    }
    actx.putImageData(field, 0, 0);
    aurora.style.opacity = fade;
  }

  function drawSnow(dt) {
    if (presence < 0.002) return;
    const snowMix = clamp(mixOf(3) * 0.5 + mixOf(1) * 0.5, 0, 1.3) * presence;
    // Amount of snow: weather and bright gusts
    const amount = clamp(0.45 + 0.8 * (s.base - 0.4) + 0.45 * s.g, 0.2, 1);
    const move = !reduced.matches;
    // Wind: a steady drift that grows with the storm, and gusts that sweep
    // the flakes away sideways and lift them a little
    const wind = 15 + 110 * s.gust + 420 * s.g;
    const lift = 70 * s.g;
    const turbulence = 35 + 60 * s.gust + 120 * s.g;
    const inertia = 1 - Math.exp(-dt / 0.35);
    ctx.fillStyle = "#dbe7f5";
    for (const f of flakes) {
      if (move) {
        // Each flake dances in a slowly changing turbulence field
        const n1 = simplex3(f.x / 260 + f.seed, f.y / 260, time * 0.25);
        const n2 = simplex3(f.x / 180 - f.seed, f.y / 180 + 50, time * 0.3);
        const near = 0.35 + 0.65 * f.depth; // near flakes feel the wind more
        const tx = (wind + turbulence * n1) * near;
        const ty = f.fall * (1 + 0.3 * s.g) + turbulence * 0.7 * n2 * near - lift * near;
        f.vx += (tx - f.vx) * inertia;
        f.vy += (ty - f.vy) * inertia;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.y > height + 8) Object.assign(f, flake(false));
        else if (f.y < -40) f.y = height + 4;
        if (f.x > width + 10) f.x = -10;
        else if (f.x < -10) f.x = width + 10;
      }
      if (f.rank > amount) continue;
      ctx.globalAlpha = f.alpha * fade * snowMix;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }

    const drift = wind * 0.5;
    // Fine dust: follows the air layer, which moves on its own
    const dustAlpha = clamp(0.1 + 0.08 * s.air, 0, 0.25) * fade * mixOf(1) * s.live;
    if (dustAlpha > 0.003) {
      ctx.globalAlpha = dustAlpha;
      for (const d of dust) {
        if (move) {
          d.x += drift * 1.6 * d.speed * dt;
          d.y += Math.sin(time * 0.7 + d.phase) * 6 * dt;
          if (d.x > width + 2) {
            d.x = -2;
            d.y = Math.random() * height;
          }
        }
        ctx.fillRect(d.x, d.y, d.r * 2, d.r * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawCandle() {
    // Reflection of a candle on the glass, centered along the bottom
    const draft = 0.04 + 0.35 * s.b * s.live;
    const f = reduced.matches ? 1 : 1 + 0.05 * flicker.slow + draft * flicker.fast;
    // Snow mixer: back to the slider position (gain = position² · level),
    // so that the light follows the slider linearly. Default 0.5 → 1.
    const snow = Math.sqrt(clamp(s.mix[3] / SNOW_LEVEL, 0, 1));
    const light = 0.16 * (0.2 + 1.6 * snow) * (1 + 0.12 * s.breath * s.live) * f * fade;
    const cx = width * 0.5;
    const cy = height * 1.02;
    const r = Math.max(width, height) * 0.6 * (1 + 0.02 * flicker.slow);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(255, 176, 96, ${light})`);
    grad.addColorStop(0.35, `rgba(255, 140, 70, ${light * 0.45})`);
    grad.addColorStop(1, "rgba(255, 120, 60, 0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  function frame(t) {
    requestAnimationFrame(frame);
    if (!field) {
      resize();
      if (!field) return;
    }
    if (t - lastFrame < 1000 / FPS - 2) return;
    const dt = Math.min((t - lastFrame) / 1000, 0.1);
    lastFrame = t;
    const mdt = update(dt);
    // Paused and settled: keep the last frame, save the battery
    const still =
      motion < 0.001 && presence < 0.001 && s.live < 0.001 && Math.abs(fade - fadeTarget) < 0.001;
    if (still && !resized) return;
    resized = false;
    ctx.clearRect(0, 0, width, height);
    drawAurora(mdt);
    drawSnow(mdt);
    drawCandle();
  }

  addEventListener("resize", resize);
  resize();
  requestAnimationFrame(frame);

  return {
    // State message from the worklet
    receive,
    // 0–1: the scene goes dark together with the sound (sleep timer)
    setFade(value) {
      fadeTarget = value;
    },
  };
}
