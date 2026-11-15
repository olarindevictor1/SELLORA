import React from 'react';

interface SelloraLogoProps {
  variant?: 'light' | 'dark' | 'mono' | 'icon';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const SelloraLogo: React.FC<SelloraLogoProps> = ({
  variant = 'light',
  size = 'md',
  className = '',
}) => {
  const markSize = size === 'sm' ? 28 : size === 'lg' ? 40 : 32;
  const textSize =
    size === 'sm' ? 'text-base' : size === 'lg' ? 'text-2xl' : 'text-lg';

  const bgFill =
    variant === 'dark'
      ? '#FFFFFF'
      : variant === 'mono'
        ? '#1E293B'
        : '#172554';
  const handleStroke = variant === 'mono' ? '#FFFFFF' : '#B7F36B';
  const innerBg = variant === 'dark' ? '#172554' : '#FFFFFF';
  const sStroke =
    variant === 'dark'
      ? '#FFFFFF'
      : variant === 'mono'
        ? '#1E293B'
        : '#172554';
  const accentDot = variant === 'mono' ? '#1E293B' : '#B7F36B';

  const mark = (
    <svg
      width={markSize}
      height={markSize}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="64" height="64" rx="14" fill={bgFill} />
      <path
        d="M22.5 22C22.5 16.7533 26.7533 12.5 32 12.5C37.2467 12.5 41.5 16.7533 41.5 22"
        stroke={handleStroke}
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <rect x="14.5" y="21" width="35" height="30.5" rx="6" fill={innerBg} />
      <path
        d="M37.5 30C37.5 27.8 35.4 26.2 32 26.2C28.6 26.2 26.5 27.8 26.5 30C26.5 32.4 29 33.3 32.3 34C35.8 34.8 38.2 36 38.2 39.3C38.2 42.1 35.6 44.2 32 44.2C28.4 44.2 25.8 42.1 25.8 39.3"
        stroke={sStroke}
        strokeWidth="3.8"
        strokeLinecap="round"
      />
      <circle cx="41.5" cy="26.5" r="2.2" fill={accentDot} />
    </svg>
  );

  if (variant === 'icon') {
    return <span className={`inline-flex items-center ${className}`}>{mark}</span>;
  }

  return (
    <span className={`inline-flex items-center gap-2.5 whitespace-nowrap shrink-0 ${className}`}>
      {mark}
      <span
        className={`font-display font-extrabold tracking-[0.08em] uppercase ${textSize} ${
          variant === 'dark' ? 'text-white' : 'text-[#172554]'
        }`}
      >
        SELLORA
      </span>
    </span>
  );
};
