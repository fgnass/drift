// Synthesized blizzard heard from inside, through a window.
// Everything, including mixer, fixed filters and limiter, runs in
// blizzard-worklet.js to keep the CPU load low.

const LAYERS = ["rumble", "wind", "howl", "snow"];

// Gain per layer at slider position 1
const LEVELS = { rumble: 1.0, wind: 2.8, howl: 2, snow: 0.12 };

// Slider positions of the default mix
export const DEFAULT_MIX = { rumble: 0.8, wind: 0.7, howl: 0.75, snow: 0.5 };

// The sound has almost nothing above 7 kHz, so half the usual rate is
// enough. Pass it to the AudioContext: new AudioContext({ sampleRate }).
export const SAMPLE_RATE = 24000;

export async function createSoundscape(ctx) {
  await ctx.audioWorklet.addModule(new URL("./blizzard-worklet.js", import.meta.url));

  const node = new AudioWorkletNode(ctx, "blizzard", {
    numberOfInputs: 0,
    outputChannelCount: [2],
  });

  const scape = {
    output: node,
    // Called about 15 times per second with the state of the storm, for
    // the visualization (see report() in blizzard-worklet.js)
    onState: null,
    // value in [0, 1]
    setLayer(name, value, time = 0.3) {
      if (!LAYERS.includes(name)) return;
      const v = value * value * LEVELS[name]; // perceptual curve
      node.parameters.get(name).setTargetAtTime(v, ctx.currentTime, time);
    },
  };
  node.port.onmessage = (e) => scape.onState?.(e.data);
  return scape;
}
