/**
 * Sound design: short UI cues and one-shot effects, played through Web Audio.
 */
const BASE = `${import.meta.env.BASE_URL}sfx/`;

export type Cue = "correct" | "wrong" | "flip" | "page" | "complete" | "streak" | "start" | "tap" | "key" | "twinkle" | "fly" | "ignite";

const CUE_GAIN: Record<Cue, number> = {
  correct: 0.55,
  wrong: 0.5,
  flip: 0.45,
  page: 0.4,
  complete: 0.6,
  streak: 0.5,
  start: 0.5,
  tap: 0.3,
  key: 0.18,
  twinkle: 0.22,
  fly: 0.4,
  ignite: 0.45,
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();

function audio() {
  if (!ctx) {
    const C = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function load(file: string) {
  let p = buffers.get(file);
  if (!p) {
    const c = audio();
    p = c
      ? fetch(BASE + file)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
          .then((b) => c.decodeAudioData(b))
          .catch(() => null)
      : Promise.resolve(null);
    buffers.set(file, p);
  }
  return p;
}

/** Warm the cue buffers after the first user gesture so the first answer isn't silent. */
export function primeCues() {
  (Object.keys(CUE_GAIN) as Cue[]).forEach((c) => void load(`${c}.mp3`));
}

/** Prime the cues on the first tap or key press (browsers only allow audio after a gesture). Returns a cleanup. */
export function armCues() {
  const arm = () => primeCues();
  window.addEventListener("pointerdown", arm, { once: true });
  window.addEventListener("keydown", arm, { once: true });
  return () => {
    window.removeEventListener("pointerdown", arm);
    window.removeEventListener("keydown", arm);
  };
}

/** Fetch and decode files ahead of time (decoding works before the first user gesture). */
export function preloadFiles(files: string[]) {
  files.forEach((f) => void load(f));
}

/** Play any file from the sound folder; call from a user gesture so audio is allowed. */
export async function playFile(file: string, gain = 0.6, delay = 0) {
  const c = audio();
  if (!c || !master) return;
  const buf = await load(file);
  if (!buf) return;
  const src = c.createBufferSource();
  const g = c.createGain();
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(g).connect(master);
  src.start(c.currentTime + delay);
}

export async function cue(name: Cue) {
  const c = audio();
  if (!c || !master) return;
  const buf = await load(`${name}.mp3`);
  if (!buf) return;
  const src = c.createBufferSource();
  const g = c.createGain();
  g.gain.value = CUE_GAIN[name];
  src.buffer = buf;
  src.connect(g).connect(master);
  src.start();
}
