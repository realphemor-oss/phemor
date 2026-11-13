import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  activate,
  getDevice,
  LICENSES_CHANGED,
  licensingEnabled,
  listLicenses,
  removeLicense,
  type Device,
  type StoredLicense,
} from "../packs/license";
import { PackError } from "../packs/spec";
import { copyText } from "../packs/pwa";
import { toast } from "../ui/Toast";

const KNOWN: Record<string, string> = {
  "list-junior": "初中包",
  "list-senior": "高中包",
  "list-college": "大学包",
  "list-advanced": "雅思进阶包",
  "list-travel": "旅游包",
};
const day = (sec: number) => new Date(sec * 1000).toLocaleDateString("zh-CN");

/** 「授权」面板：复制本机设备码、粘贴激活码、查看和移除已激活的授权。 */
export function LicensePanel({
  packNames,
}: {
  packNames: Record<string, string>;
}) {
  const [list, setList] = useState<StoredLicense[]>([]);
  const [device, setDevice] = useState<Device | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    () => listLicenses().then(setList, () => setList([])),
    [],
  );
  useEffect(() => {
    void refresh();
    window.addEventListener(LICENSES_CHANGED, refresh);
    return () => window.removeEventListener(LICENSES_CHANGED, refresh);
  }, [refresh]);
  useEffect(() => {
    getDevice().then(setDevice, () => setDevice(null));
  }, []);

  if (!licensingEnabled()) return null;

  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    try {
      const rec = await activate(code);
      setCode("");
      toast(`已激活：${rec.cust}`, "ok");
    } catch (e) {
      toast(
        e instanceof PackError ? e.message : "激活失败，请检查激活码是否完整。",
        "warn",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel license-panel">
      <h3 className="eyebrow">授权 · 高中包、大学包等需要激活码</h3>
      <p className="muted packs-tip">
        初中包免费使用。其他包需要老师发给你的激活码：先把下面的「设备码」发给老师，老师回复激活码后粘贴到这里。
        iPhone 请在<b>主屏幕上的 App</b> 里操作，不要在 Safari 里。
      </p>
      <div className="license-device">
        <span className="muted">本机设备码</span>
        <code>{device ? device.fp : "…"}</code>
        <button
          className="btn btn-ghost"
          disabled={!device}
          onClick={() =>
            device &&
            void copyText(device.code).then((ok) =>
              toast(
                ok
                  ? "设备码已复制，发给老师即可"
                  : "复制失败，请长按选中后复制",
                ok ? "ok" : "warn",
              ),
            )
          }
        >
          <Copy size={18} /> 复制设备码
        </button>
      </div>
      <div className="license-paste">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="粘贴激活码（PHEMOR1.…）"
          aria-label="激活码"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          className="btn btn-primary"
          disabled={busy || !code.trim()}
          onClick={() => void submit()}
        >
          <KeyRound size={18} /> 激活
        </button>
      </div>
      {list.length > 0 && (
        <ul className="license-list">
          {list.map((l) => {
            const expired = l.exp !== null && l.exp * 1000 < Date.now();
            return (
              <li key={l.id}>
                <div>
                  <b>{l.cust}</b>
                  <span className="muted">
                    {" · "}
                    {l.packs
                      .map((p) => packNames[p] ?? KNOWN[p] ?? p)
                      .join("、")}
                    {l.dev ? " · 仅限本机" : ""}
                    {l.exp
                      ? ` · ${expired ? "已于" : "有效至"} ${day(l.exp)}${expired ? "过期（已安装的内容不受影响）" : ""}`
                      : ""}
                  </span>
                </div>
                <button
                  className="icon-btn"
                  aria-label="移除这个激活码"
                  onClick={() => void removeLicense(l.id)}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
