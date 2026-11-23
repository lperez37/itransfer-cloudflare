import type { ReactNode } from "react";

type TransferCoverProps = {
  variant?: "share" | "request";
  title: ReactNode;
  children?: ReactNode;
  className?: string;
  headingLevel?: 1 | 2;
};

export default function TransferCover({
  variant = "share",
  title,
  children,
  className = "",
  headingLevel = 1,
}: TransferCoverProps) {
  const Heading = headingLevel === 2 ? "h2" : "h1";

  return (
    <div className={`transfer-cover transfer-cover--${variant} ${className}`}>
      <div className="transfer-cover__layout">
        <div className="transfer-cover__content">
          <Heading className="transfer-cover__title">{title}</Heading>
          {children}
        </div>
        <svg
          className="transfer-cover__artwork"
          viewBox="0 0 174 132"
          width="174"
          height="132"
          aria-hidden="true"
          focusable="false"
        >
          {/* Postmark, flight path and paper folds from Android's TransferCover. */}
          <g fill="none" stroke="#fff" strokeOpacity=".11" strokeWidth=".9">
            <circle cx="152" cy="4" r="46" />
            <circle cx="152" cy="4" r="57" />
            <circle cx="152" cy="4" r="68" />
          </g>
          <path
            d="M-4 113 C29 123 63 103 45 93 C31 87 28 111 56 105 Q65 103 76 94"
            fill="none"
            stroke="#fff"
            strokeOpacity=".57"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray="3 5"
          />
          {variant === "request" ? (
            <g transform="rotate(-10 97 67)">
              <path d="M44 57 96 19 147 57Z" fill="#7bbeaa" />
              <rect x="44" y="57" width="103" height="46" fill="#7bbeaa" />
              <rect x="57" y="36" width="78" height="51" rx="3" fill="#fff7e5" />
              <rect x="116" y="42" width="11" height="12" rx="1" fill="#e9aa63" />
              <path d="M65 50H92" stroke="#819d99" strokeWidth="2" strokeLinecap="round" />
              <path d="M65 56H84" stroke="#a6bab1" strokeWidth="2" strokeLinecap="round" />
              <path d="M44 57 96 81 44 103Z" fill="#afe2ce" />
              <path d="M147 57 147 103 96 81Z" fill="#bfebd9" />
              <path d="M44 103 96 72 147 103Z" fill="#e2f3e8" />
            </g>
          ) : (
            <>
              <path d="M15 54 157 22 72 72Z" fill="#fbf6e6" />
              <path d="M72 72 157 22 75 99Z" fill="#91b1ea" />
              <path d="M75 99 157 22 92 81Z" fill="#617fc2" />
              <path d="M83 77 157 22 125 108Z" fill="#dce8ff" />
              <path d="M83 77 157 22" stroke="#fff" strokeOpacity=".68" strokeWidth=".9" />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}
