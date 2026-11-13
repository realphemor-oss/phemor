/** Environment detection and the "add to home screen" prompt. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface Env {
  standalone: boolean;
  /** WeChat, QQ, DingTalk and similar in-app browsers cannot add a page to the home screen. */
  inApp: boolean;
  ios: boolean;
  android: boolean;
  /** iOS Safari proper (the only iOS browser that reliably offers "Add to Home Screen" for everyone). */
  iosSafari: boolean;
}

export function detectEnv(): Env {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const inApp = /MicroMessenger|MQQBrowser|\bQQ\//i.test(ua) || /DingTalk|AlipayClient|Weibo|NewsArticle|Feishu|Lark/i.test(ua);
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const iosSafari = ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|MicroMessenger|QQ|Baidu|UCBrowser/i.test(ua);
  return { standalone, inApp, ios, android, iosSafari };
}

let deferred: InstallPromptEvent | null = null;
const subs = new Set<() => void>();

export function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    subs.forEach((f) => f());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    subs.forEach((f) => f());
  });
}

export const canPromptInstall = () => deferred !== null;
export function onInstallChange(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

export async function promptInstall() {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  subs.forEach((f) => f());
  return outcome === "accepted";
}

export const appLink = () => `${location.origin}${location.pathname}`;

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      /* ignore */
    }
    ta.remove();
    return ok;
  }
}
