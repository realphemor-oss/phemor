let current: HTMLAudioElement | null = null;
// Reuse one media element. Mobile Chrome/Safari can block a fresh Audio()
// instance on every automatic card transition after the first word.
let player: HTMLAudioElement | null = null;
let token = 0;

export function stopAudio() {
  token++;
  current?.pause();
  current = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** Play a recording, falling back to the device voice. Resolves when playback ends. */
export async function play(url: string | null | undefined, text: string, accent: "uk" | "us" = "uk", rate = 1) {
  return speak(url, text, accent, rate);
}

async function speak(url: string | null | undefined, text: string, accent: "uk" | "us", rate: number) {
  stopAudio();
  const mine = ++token;
  if (url) {
    const a = player || (player = new Audio());
    a.pause();
    a.src = url;
    a.currentTime = 0;
    a.playbackRate = rate;
    a.volume = 1;
    a.preload = "auto";
    current = a;
    const ended = new Promise<void>((resolve) => {
      a.onended = () => resolve();
      a.onpause = () => resolve();
    });
    try {
      await a.play();
      await ended;
      if (mine !== token) return "stopped" as const;
      if (current === a) current = null;
      return "recorded" as const;
    } catch {
      if (mine !== token) return "stopped" as const;
      if (current === a) current = null;
    }
  }
  if (!("speechSynthesis" in window)) return "unsupported" as const;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = accent === "uk" ? "en-GB" : "en-US";
  u.rate = rate * 0.95;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace("_", "-") === u.lang);
  const best = voices.find((v) => /premium|enhanced|natural|google/i.test(v.name)) || voices[0];
  if (best) u.voice = best;
  await new Promise<void>((r) => {
    u.onend = () => r();
    u.onerror = () => r();
    speechSynthesis.speak(u);
  });
  return "device" as const;
}
