export type ScanTone = "success" | "warning" | "error";

// [frequency Hz, start s, duration s]
const TONES: Record<ScanTone, { type: OscillatorType; notes: [number, number, number][] }> = {
  success: { type: "sine", notes: [[880, 0, 0.09], [1320, 0.1, 0.12]] },
  warning: { type: "triangle", notes: [[660, 0, 0.12], [660, 0.18, 0.12]] },
  error: { type: "sawtooth", notes: [[200, 0, 0.35]] },
};

let ctx: AudioContext | null = null;

export function playScanTone(tone: ScanTone) {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const { type, notes } = TONES[tone];
    const t0 = ctx.currentTime;
    for (const [freq, start, dur] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.02);
    }
  } catch {
    // Audio is a nicety; a blocked or missing audio device must not break scanning.
  }
}
