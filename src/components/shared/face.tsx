// A person's face (D, 2026-10-28: Slack profile photos on their accounts, lib/people-photos.ts): their photo, else their initials.
// Server-safe; the image loads from Slack's image host without sending our address.
export function Face({ name, url, size = 28, className = '' }: { name: string; url?: string | null; size?: number; className?: string }) {
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const box = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  return url
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={url} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" style={box} className={`shrink-0 rounded-full object-cover ring-1 ring-foreground/10 ${className}`} />
    : <span aria-hidden style={box} className={`grid shrink-0 place-items-center rounded-full bg-[#8E8E93] font-semibold text-white ${className}`}>{initials}</span>;
}
