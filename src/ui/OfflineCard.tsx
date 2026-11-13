import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { listInstalled, supportsPacks } from "../packs/install";

const KEY = "phemor:offline-card";
const WEEK = 7 * 24 * 3600 * 1000;

/** A gentle nudge on the home page until the learner has added a word pack. */
export function OfflineCard() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!supportsPacks()) return;
    try {
      if (Date.now() - Number(localStorage.getItem(KEY) || 0) < WEEK) return;
    } catch {
      /* private mode: show it */
    }
    let live = true;
    listInstalled().then(
      (l) => live && setShow(l.length === 0),
      () => null,
    );
    return () => {
      live = false;
    };
  }, []);
  if (!show) return null;
  const later = () => {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setShow(false);
  };
  return (
    <div className="offline-card" role="note">
      <Download size={22} />
      <span>
        <b>下载单词包，学习不再等待</b>
        <small>插画和发音存到手机，没网也能学。</small>
      </span>
      <a className="link" href="#/packs">
        去下载
      </a>
      <button className="link" onClick={later} aria-label="一周内不再提示">
        稍后
      </button>
    </div>
  );
}
