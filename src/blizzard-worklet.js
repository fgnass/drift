// The whole blizzard as one AudioWorklet. Everything evolves on its own;
// timings and depths come from an analysis of a 10 h blizzard recording.
//
// Why a worklet: BiquadFilterNode updates its coefficients only once per
// 128-sample block, so a moving filter frequency produces an audible buzz
// at sampleRate / 128. Here moving filters glide their coefficients on
// every sample.
//
// CPU budget:
// - Meant to run at 24 kHz (the sound has almost nothing above 7 kHz).
// - Slow controls (drifts, events, filter frequencies) are computed once
//   per BLOCK samples; coefficients and gains glide linearly in between.
// - Fixed filters compute their coefficients once.
// - Mixer, fixed output filters and limiter run here instead of as nodes.
//
// Parameters (k-rate): rumble, wind, howl, snow = layer gains.

const BLOCK = 32;

// Fast xorshift32 noise in [-1, 1)
let seed = (Math.random() * 4294967296) | 0 || 1;
function white() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed / 2147483648;
}
const rand = () => (white() + 1) / 2; // [0, 1)
const between = (a, b) => a + (b - a) * rand();
// Waiting time of a Poisson process with the given mean
const poisson = (mean) => -Math.log(1 - rand()) * mean;
const coef = (freq) => Math.tan((Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate);

// White noise power per Hz depends on the sample rate. Pink noise from the
// Kellet filter does not (its curve scales with the rate), brown and white
// noise do: this factor keeps their level at the 48 kHz calibration.
const WHITE_SCALE = Math.sqrt(sampleRate / 48000);

// Smooth random curve in [-1, 1]: new target every `step` seconds
// (with jitter), joined by cosine interpolation. Never repeats.
class Drift {
  constructor(step) {
    this.step = step;
    this.from = between(-1, 1);
    this.to = between(-1, 1);
    this.t = 0;
    this.len = this.nextLength();
  }
  nextLength() {
    return this.step * between(0.5, 1.5) * sampleRate;
  }
  // Advance by n samples
  next(n) {
    this.t += n;
    if (this.t >= this.len) {
      this.t -= this.len;
      this.from = this.to;
      this.to = between(-1, 1);
      this.len = this.nextLength();
    }
    const x = this.t / this.len;
    return this.from + ((this.to - this.from) * (1 - Math.cos(Math.PI * x))) / 2;
  }
}

// Random events with a smooth sin² shape. Returns 0 between events.
class Events {
  constructor(meanGap, minLen, maxLen, firstAfter = meanGap) {
    this.meanGap = meanGap;
    this.minLen = minLen;
    this.maxLen = maxLen;
    this.wait = poisson(firstAfter) * sampleRate;
    this.t = 0;
    this.len = 0;
    this.amp = 0;
  }
  // Fixed gap range instead of Poisson (for regular gusts)
  static regular(minGap, maxGap, minLen, maxLen) {
    const e = new Events(0, minLen, maxLen);
    e.gap = [minGap, maxGap];
    e.wait = between(10, maxGap) * sampleRate;
    return e;
  }
  next(n) {
    if (this.len) {
      this.t += n;
      const x = this.t / this.len;
      if (x < 1) {
        const s = Math.sin(Math.PI * x);
        return this.amp * s * s;
      }
      this.len = 0;
      this.wait = (this.gap ? between(...this.gap) : poisson(this.meanGap)) * sampleRate;
    }
    this.wait -= n;
    if (this.wait <= 0) {
      this.t = 0;
      this.len = between(this.minLen, this.maxLen) * sampleRate;
      this.amp = between(0.6, 1);
    }
    return 0;
  }
}

// Paul Kellet's refined pink noise filter
class Pink {
  b0 = 0; b1 = 0; b2 = 0; b3 = 0; b4 = 0; b5 = 0; b6 = 0;
  next(w) {
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return out * 0.11;
  }
}

// Leaky integrator with a fixed corner frequency, so the sound does not
// depend on the sample rate (151 Hz = the 48 kHz behavior it was tuned at)
class Brown {
  last = 0;
  p = Math.exp((-2 * Math.PI * 151) / sampleRate);
  next(w) {
    this.last = this.p * this.last + (1 - this.p) * w;
    return this.last * 3.5;
  }
}

const LP = 0;
const BP = 1;
const HP = 2;

// Stereo topology-preserving state variable filter (Andrew Simper) with
// shared coefficients for both channels. Stays clean when the frequency
// changes on every sample. `glide` moves the coefficients linearly over
// n samples. Results are in yl / yr.
class SVF2 {
  l1 = 0; l2 = 0; r1 = 0; r2 = 0;
  a1 = 0; a2 = 0; a3 = 0;
  d1 = 0; d2 = 0; d3 = 0;
  yl = 0; yr = 0;
  constructor(mode, freq, q) {
    this.mode = mode;
    this.k = 1 / q;
    this.set(coef(freq));
  }
  set(g) {
    const a1 = 1 / (1 + g * (g + this.k));
    this.a1 = a1;
    this.a2 = g * a1;
    this.a3 = g * this.a2;
    this.d1 = this.d2 = this.d3 = 0;
  }
  glide(g, n) {
    const a1 = 1 / (1 + g * (g + this.k));
    const a2 = g * a1;
    this.d1 = (a1 - this.a1) / n;
    this.d2 = (a2 - this.a2) / n;
    this.d3 = (g * a2 - this.a3) / n;
  }
  run(xl, xr) {
    const a1 = (this.a1 += this.d1);
    const a2 = (this.a2 += this.d2);
    const a3 = (this.a3 += this.d3);
    const k = this.k;
    let v3 = xl - this.l2;
    let v1 = a1 * this.l1 + a2 * v3;
    let v2 = this.l2 + a2 * this.l1 + a3 * v3;
    this.l1 = 2 * v1 - this.l1;
    this.l2 = 2 * v2 - this.l2;
    this.yl = this.mode === LP ? v2 : this.mode === BP ? k * v1 : xl - k * v1 - v2;
    v3 = xr - this.r2;
    v1 = a1 * this.r1 + a2 * v3;
    v2 = this.r2 + a2 * this.r1 + a3 * v3;
    this.r1 = 2 * v1 - this.r1;
    this.r2 = 2 * v2 - this.r2;
    this.yr = this.mode === LP ? v2 : this.mode === BP ? k * v1 : xr - k * v1 - v2;
  }
}

// A value that glides linearly to a new target over n samples
class Ramp {
  v = 0;
  d = 0;
  constructor(v = 0) {
    this.v = v;
  }
  to(target, n) {
    this.d = (target - this.v) / n;
  }
  next() {
    return (this.v += this.d);
  }
}

// Stereo noise with a given L/R correlation
let wl = 0;
let wr = 0;
function stereoWhite(s) {
  const c = s[0] * white();
  wl = c + s[1] * white();
  wr = c + s[1] * white();
}
const stereo = (correlation) => [Math.sqrt(correlation), Math.sqrt(1 - correlation)];

// L/R correlation per layer, like the recording: nearly mono rumble, very
// wide and diffuse wind and howl at 250–1600 Hz
const CORRELATION = { rumble: 0.85, wind: 0.3, howl: 0.3, snow: 0.55, air: 0.45 };

// Soft-knee compressor curve like DynamicsCompressorNode
// (threshold -6 dB, knee 6 dB, ratio 8), with its automatic makeup gain
const T = -6;
const KNEE = 6;
const RATIO = 8;
function compress(db) {
  if (db <= T) return db;
  if (db < T + KNEE) return db + ((1 / RATIO - 1) * (db - T) ** 2) / (2 * KNEE);
  return T + KNEE / 2 + KNEE / (2 * RATIO) + (db - T - KNEE) / RATIO;
}
// The extra 0.7 dB match the level of Chrome's DynamicsCompressorNode,
// which an earlier version used
const MAKEUP = 10 ** ((-compress(0) * 0.6 + 0.7) / 20);

const LAYERS = ["rumble", "wind", "howl", "snow"];

// Level of the air layer, relative to the wind mixer
const AIR_LEVEL = 0.075;
// Depth (dB) of each of the two drifts that move the air level
const AIR_MOTION = 2.0;

const db = (v) => 10 ** (v / 20);

class Blizzard extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return LAYERS.map((name) => ({ name, defaultValue: 0, minValue: 0, automationRate: "k-rate" }));
  }

  constructor() {
    super();
    this.sRumble = stereo(CORRELATION.rumble);
    this.sWind = stereo(CORRELATION.wind);
    this.sHowl = stereo(CORRELATION.howl);
    this.sSnow = stereo(CORRELATION.snow);
    this.sAir = stereo(CORRELATION.air);
    // The recording has a broad resonance around 400 Hz (about +3 dB)
    this.body = new SVF2(BP, 400, 1.2);
    this.bodyGain = 10 ** (3 / 20) - 1;
    // Ticks: in the recording, 1–2 kHz is smooth. Keep ticks above 2.5 kHz.
    this.tickHP = new SVF2(HP, 2500, 0.7);
    // Air: a steady rush at 0.9–4.5 kHz. In the recording this band is
    // always there; without it, 1–4 kHz is only filled during gusts.
    this.airPink = [new Pink(), new Pink()];
    this.airHP = new SVF2(HP, 900, 0.7);
    this.airLP = new SVF2(LP, 4500, 0.7);
    this.airAmp = new Ramp(AIR_LEVEL);
    // In the recording, this band moves on its own (about ±2 dB at
    // 2–60 s), nearly independent of the gusts
    this.airFast = new Drift(2.5);
    this.airSlow = new Drift(8);
    // The wind band (around 630 Hz) also has some motion of its own
    this.windOwn = new Drift(4);

    // --- Weather: the slowly changing strength of the storm ---
    this.weather = new Drift(900); // 15 min
    this.slow = new Drift(180); // 1–10 min band of the recording
    this.breath = new Drift(25); // loudness change over 10–60 s
    this.swell = new Drift(5); // the 6–10 s brightness waves
    this.flutter = new Drift(1.5); // 2–10 s band
    this.gusts = Events.regular(35, 65, 3, 5); // bright gusts
    // Deep pushes against the walls. Soft and slow: about +1 dB like the
    // recording; stronger, faster pushes sound like sudden bursts.
    this.buffets = new Events(60, 1, 2, 20);
    this.gust = 0.4;

    // Layer gains (mixer)
    this.mix = LAYERS.map(() => new Ramp());

    // --- Rumble ---
    this.brown = [new Brown(), new Brown()];
    this.rumbleLP = new SVF2(LP, 160, 0.6);
    this.rumbleAmp = new Ramp(0.75);

    // --- Wind: gusts open the filter, the sound gets brighter ---
    this.windPink = [new Pink(), new Pink()];
    this.windHP = new SVF2(HP, 180, 1 / 1.4);
    this.windLP1 = new SVF2(LP, 800, 1 / 1.4);
    this.windLP2 = new SVF2(LP, 800, 1 / 1.4);
    this.windAmp = new Ramp(0.5);

    // --- Howl: soft resonances drifting between 150 and 550 Hz ---
    // Low Q on purpose: higher Q gives near-pure tones that hurt the ear.
    this.howlPink = [new Pink(), new Pink()];
    this.voices = [
      [175, 7, 3.5],
      [230, 8, 4.5],
      [370, 9, 3.0],
      [440, 9, 5.5],
    ].map(([freq, q, step]) => ({
      freq,
      pitch: new Drift(step),
      level: new Drift(step * 0.6),
      amp: new Ramp(0.6),
      filter: new SVF2(BP, freq, q),
    }));
    this.howlAmp = new Ramp(1);

    // --- Whistles: rare, short narrow-band glides (0.7 per minute) ---
    this.whistle = null;
    this.whistleWait = poisson(40) * sampleRate;
    // Pink noise and two bandpasses in series: one bandpass on white noise
    // has flat skirts that add a hissing burst at 1–4 kHz to each whistle.
    this.whistlePink = [new Pink(), new Pink()];
    this.whistleBP = new SVF2(BP, 600, 25);
    this.whistleBP2 = new SVF2(BP, 600, 6);
    this.whistleEnv = new Ramp(0);

    // --- Snow: single ticks of blown snow, plus a faint hiss ---
    this.tickL = 0;
    this.tickR = 0;
    this.tickDecay = 0.99;
    this.tickWait = 0;
    this.tickBP = new SVF2(BP, 3500, 1 / 1.2);
    this.hissHP = new SVF2(HP, 1500, 1 / 1.4);
    this.hissLP = new SVF2(LP, 7000, 1 / 1.4);
    this.hissAmp = new Ramp(0.45);

    // --- Output: fixed filters and limiter ---
    // The recording has almost nothing below 40 Hz. These Q values come
    // from the first version, which used BiquadFilterNode: it reads Q of
    // lowpass and highpass filters in dB. The resulting slight resonances
    // (around 50 Hz and 2 kHz) are part of the calibrated sound.
    const dbQ = (db) => 10 ** (db / 20);
    this.hp = [new SVF2(HP, 45, dbQ(0.52)), new SVF2(HP, 45, dbQ(0.71)), new SVF2(HP, 45, dbQ(1.93))];
    this.muffle = new SVF2(LP, 2200, dbQ(0.5)); // heard through snow walls
    this.env = 0; // limiter envelope (linear peak)
    this.limGain = new Ramp(MAKEUP);
    this.attack = 1 - Math.exp(-BLOCK / (0.01 * sampleRate));
    this.release = 1 - Math.exp(-BLOCK / (0.5 * sampleRate));

    // State for the visualization, sent about 15 times per second
    this.reportEvery = Math.round(sampleRate / 15);
    this.reportIn = 0;
    this.view = { base: 0.4, g: 0, b: 0, breath: 0, air: 0 };
  }

  startWhistle() {
    // Like the recording: 500–750 Hz only. Higher whistles and a fast
    // attack sounded like sudden hissing bursts that can wake you up.
    this.whistle = {
      t: 0,
      len: between(0.4, 1.0) * sampleRate,
      f0: between(500, 750),
      glide: between(-40, 60),
      amp: between(1, 1.6),
    };
  }

  report() {
    const w = this.whistle;
    this.port.postMessage({
      t: currentTime,
      gust: this.gust,
      ...this.view,
      voices: this.voices.map((v) => [v.freq, v.p || 0, v.lv || 0]),
      mix: this.mix.map((m) => m.v),
      // Whistle progress (0–1) and frequency
      whistle: w ? [w.t / w.len, w.f0 + (w.glide * w.t) / w.len] : null,
    });
  }

  // Slow controls, once per block. Targets are the values at block end.
  control(params) {
    const n = BLOCK;
    LAYERS.forEach((name, i) => this.mix[i].to(params[name][0], n));

    // --- Storm state. `gust` is about 0.1 (calm) to 1 (strong gust) ---
    const base = 0.4 + 0.1 * this.weather.next(n) + 0.08 * this.slow.next(n);
    const g = this.gusts.next(n);
    const b = this.buffets.next(n);
    let gust = base + 0.08 * this.swell.next(n) + 0.03 * this.flutter.next(n) + 0.35 * g;
    if (gust < 0) gust = 0;
    this.gust = gust;
    const breath = this.breath.next(n);
    const loud = 1 + 0.08 * breath;
    const view = this.view;
    view.base = base;
    view.g = g;
    view.b = b;
    view.breath = breath;

    this.rumbleAmp.to(loud * 0.75 * (1 + 0.9 * (base - 0.4) + 0.1 * (gust - base)) * (1 + 0.2 * b), n);

    // Gusts open the filter only moderately: the air layer already fills
    // 1–4 kHz, and wide openings made this band come and go (not steady
    // like in the recording)
    const cut = coef(500 + 800 * gust + 450 * g + 150 * b);
    this.windLP1.glide(cut, n);
    this.windLP2.glide(cut, n);
    const windOwn = db(1.2 * this.windOwn.next(n));
    this.windAmp.to(windOwn * loud * 0.65 * (0.6 + 0.8 * gust) * (1 + 0.15 * b), n);

    const depth = 0.6 + 0.6 * gust;
    for (const v of this.voices) {
      v.p = depth * v.pitch.next(n); // pitch drift, about -1.2 to 1.2
      v.lv = depth * v.level.next(n); // level drift
      v.filter.glide(coef(v.freq * (1 + 0.2 * v.p)), n);
      v.amp.to(0.6 + 0.1 * v.lv, n);
    }
    this.howlAmp.to(loud * (0.85 + 0.3 * gust), n);

    const s = this.whistle;
    if (s) {
      s.t += n;
      const x = Math.min(s.t / s.len, 1);
      this.whistleEnv.to(s.amp * Math.sin(Math.PI * x) ** 2, n);
      const gw = coef(s.f0 + s.glide * x);
      this.whistleBP.glide(gw, n);
      this.whistleBP2.glide(gw, n);
      if (x >= 1) {
        this.whistle = null;
        this.whistleWait = poisson(60) * sampleRate;
      }
    } else if ((this.whistleWait -= n) <= 0) {
      this.startWhistle();
      this.whistleEnv.v = this.whistleEnv.d = 0;
      const gw = coef(this.whistle.f0);
      this.whistleBP.set(gw);
      this.whistleBP2.set(gw);
    }

    // Snow follows the gusts only a little: in the recording, the
    // 1.6–6 kHz band is nearly independent of the gusts
    this.tickRate = 4 + 8 * gust; // per second
    const air = (this.airFast.next(n) + this.airSlow.next(n)) / 2; // -1 to 1
    view.air = air;
    this.airAmp.to(AIR_LEVEL * db(2 * AIR_MOTION * air) * (0.9 + 0.2 * gust), n);
    this.hissAmp.to(0.5 * (0.8 + 0.4 * gust), n);
  }

  process(_inputs, outputs, params) {
    const L = outputs[0][0];
    const R = outputs[0][1];
    const [mRumble, mWind, mHowl, mSnow] = this.mix;
    const voices = this.voices;

    for (let i0 = 0; i0 < L.length; i0 += BLOCK) {
      this.control(params);
      const whistling = this.whistle !== null;
      let peak = 0;

      for (let i = i0; i < i0 + BLOCK; i++) {
        // --- Rumble ---
        stereoWhite(this.sRumble);
        this.rumbleLP.run(this.brown[0].next(wl * WHITE_SCALE), this.brown[1].next(wr * WHITE_SCALE));
        const ra = this.rumbleAmp.next() * mRumble.next();
        let l = ra * this.rumbleLP.yl;
        let r = ra * this.rumbleLP.yr;

        // --- Wind ---
        stereoWhite(this.sWind);
        this.windHP.run(this.windPink[0].next(wl), this.windPink[1].next(wr));
        this.windLP1.run(this.windHP.yl, this.windHP.yr);
        this.windLP2.run(this.windLP1.yl, this.windLP1.yr);
        const wa = this.windAmp.next() * mWind.next();
        l += wa * this.windLP2.yl;
        r += wa * this.windLP2.yr;

        // --- Howl ---
        stereoWhite(this.sHowl);
        const nl = this.howlPink[0].next(wl);
        const nr = this.howlPink[1].next(wr);
        let hl = 0;
        let hr = 0;
        for (let v = 0; v < voices.length; v++) {
          const voice = voices[v];
          voice.filter.run(nl, nr);
          const a = voice.amp.next();
          hl += a * voice.filter.yl;
          hr += a * voice.filter.yr;
        }

        // --- Whistle ---
        if (whistling) {
          stereoWhite(this.sHowl);
          this.whistleBP.run(this.whistlePink[0].next(wl) * 2, this.whistlePink[1].next(wr) * 2);
          this.whistleBP2.run(this.whistleBP.yl, this.whistleBP.yr);
          const e = this.whistleEnv.next();
          hl += e * this.whistleBP2.yl;
          hr += e * this.whistleBP2.yr;
        }
        const ha = this.howlAmp.next() * mHowl.next();
        l += ha * hl;
        r += ha * hr;

        // --- Fixed output filters (rumble, wind, howl) ---
        this.hp[0].run(l, r);
        this.hp[1].run(this.hp[0].yl, this.hp[0].yr);
        this.hp[2].run(this.hp[1].yl, this.hp[1].yr);
        this.muffle.run(this.hp[2].yl, this.hp[2].yr);
        l = this.muffle.yl;
        r = this.muffle.yr;
        this.body.run(l, r);
        l += this.bodyGain * this.body.yl;
        r += this.bodyGain * this.body.yr;

        // --- Air, after the muffle filter ---
        stereoWhite(this.sAir);
        this.airHP.run(this.airPink[0].next(wl), this.airPink[1].next(wr));
        this.airLP.run(this.airHP.yl, this.airHP.yr);
        const aa = this.airAmp.next() * mWind.v;
        l += aa * this.airLP.yl;
        r += aa * this.airLP.yr;

        // --- Snow ticks: density follows the wind ---
        if (--this.tickWait <= 0) {
          this.tickWait = poisson(1 / this.tickRate) * sampleRate;
          const a = Math.min(poisson(1), 2.5); // no single loud ticks
          const pan = rand();
          this.tickL = Math.max(this.tickL, a * (1 - pan * 0.7));
          this.tickR = Math.max(this.tickR, a * (0.3 + pan * 0.7));
          this.tickDecay = Math.exp(-1 / (between(0.002, 0.008) * sampleRate));
        }
        stereoWhite(this.sSnow);
        this.tickBP.run(wl * this.tickL * WHITE_SCALE, wr * this.tickR * WHITE_SCALE);
        this.tickHP.run(this.tickBP.yl, this.tickBP.yr);
        const tl = this.tickHP.yl;
        const tr = this.tickHP.yr;
        this.tickL *= this.tickDecay;
        this.tickR *= this.tickDecay;
        this.hissHP.run(wr * WHITE_SCALE, wl * WHITE_SCALE);
        this.hissLP.run(this.hissHP.yl, this.hissHP.yr);
        const sa = mSnow.next();
        const ha2 = this.hissAmp.next();
        l += sa * (tl * 0.35 + this.hissLP.yl * ha2);
        r += sa * (tr * 0.35 + this.hissLP.yr * ha2);

        // --- Limiter ---
        const lg = this.limGain.next();
        l *= lg;
        r *= lg;
        const p = Math.max(Math.abs(l), Math.abs(r)) / lg;
        if (p > peak) peak = p;
        L[i] = l;
        R[i] = r;
      }

      // Limiter gain for the next block from this block's peak (pre-gain)
      this.env += (peak - this.env) * (peak > this.env ? this.attack : this.release);
      const db = 20 * Math.log10(this.env + 1e-9);
      this.limGain.to(MAKEUP * 10 ** ((compress(db) - db) / 20), BLOCK);
    }

    if ((this.reportIn -= L.length) <= 0) {
      this.reportIn = this.reportEvery;
      this.report();
    }
    return true;
  }
}

registerProcessor("blizzard", Blizzard);
