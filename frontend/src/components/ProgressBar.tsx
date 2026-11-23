interface ProgressBarProps {
  value: number; // 0-100
  size?: "sm" | "md";
  color?: "primary" | "accent" | "success" | "danger";
  label?: string;
  valueText?: string;
}

export default function ProgressBar({
  value,
  size = "md",
  color = "primary",
  label,
  valueText,
}: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value));

  const heightClass = size === "sm" ? "h-1" : "h-2";

  const colors = {
    primary: "bg-primary",
    accent: "bg-accent",
    success: "bg-success",
    danger: "bg-danger",
  };

  return (
    <div
      role={label === undefined ? undefined : "progressbar"}
      aria-label={label}
      aria-valuenow={label === undefined ? undefined : Math.round(clamped)}
      aria-valuetext={valueText}
      className={`w-full ${heightClass} rounded-full bg-surface-lighter overflow-hidden`}
    >
      <div
        className={`${heightClass} rounded-full ${colors[color]} transition-[width] duration-300 ease-out motion-reduce:transition-none`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
