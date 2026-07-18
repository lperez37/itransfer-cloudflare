interface ProgressBarProps {
  value: number; // 0-100
  size?: "sm" | "md";
  color?: "primary" | "accent" | "success" | "danger";
}

export default function ProgressBar({
  value,
  size = "md",
  color = "primary",
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
      className={`w-full ${heightClass} rounded-full bg-surface-lighter overflow-hidden`}
    >
      <div
        className={`${heightClass} rounded-full ${colors[color]} transition-all duration-300 ease-out`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
