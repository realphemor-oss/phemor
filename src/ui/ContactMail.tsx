import { Mail, MessageCircle } from "lucide-react";
import { CONTACT_EMAIL, CONTACT_WECHAT } from "../config";
import { copyText } from "../packs/pwa";
import { toast } from "./Toast";

/**
 * 联系方式：微信号和邮箱，点文字就复制；点邮箱旁的「发邮件」会直接打开手机的邮箱。
 * 邮箱：点邮箱文字就复制（很多人没有邮箱 App，复制后可以在微信里发给老师或粘贴到任何邮箱），
 * 点「发邮件」会直接打开手机的邮箱。
 */
export function ContactMail({ label, subject, body }: { label?: string; subject?: string; body?: string }) {
  const query = [subject && `subject=${encodeURIComponent(subject)}`, body && `body=${encodeURIComponent(body)}`].filter(Boolean).join("&");
  return (
    <span className="contact-mail">
      {label && <span className="muted">{label}</span>}
      <button
        type="button"
        className="link"
        title="点击复制微信号"
        onClick={() =>
          void copyText(CONTACT_WECHAT).then((ok) => toast(ok ? "微信号已复制，去微信里添加" : "复制失败，请长按微信号手动复制", ok ? "ok" : "warn"))
        }
      >
        <MessageCircle size={15} /> 微信 {CONTACT_WECHAT}
      </button>
      <button
        type="button"
        className="link"
        title="点击复制邮箱"
        onClick={() =>
          void copyText(CONTACT_EMAIL).then((ok) => toast(ok ? "邮箱已复制" : "复制失败，请长按邮箱文字手动复制", ok ? "ok" : "warn"))
        }
      >
        <Mail size={15} /> {CONTACT_EMAIL}
      </button>
      <a className="link" href={`mailto:${CONTACT_EMAIL}${query ? `?${query}` : ""}`}>
        发邮件
      </a>
    </span>
  );
}
