// Settings pages sit in a centred column (D, 2026-10-15: "they are held to the left").
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1080px]">{children}</div>;
}
