const BASE = import.meta.env.BASE_URL;

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <img
      src={`${BASE}icon-192.png`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className="mark"
      style={{ borderRadius: Math.round(size * 0.22), display: "block" }}
    />
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="logo">
      <Mark />
      <span className="logo-text">
        <b>非莫</b>
        {!compact && <small>phemor</small>}
      </span>
    </span>
  );
}
