// Analytics skeleton in the page's own shape: title, answer line, fleet tiles, stability table +
// messages card, then the throughput hero.
export default function AnalyticsLoading() {
  const card = 'rounded-[22px] bg-card shadow-[var(--card-shadow)]';
  return (
    <div className="flex animate-pulse flex-col gap-6" aria-busy="true" aria-label="Loading analytics">
      <div className="h-8 w-40 rounded-lg bg-card shadow-[var(--card-shadow)]" />
      <div className="h-6 w-[min(560px,80%)] rounded-lg bg-card/70" />
      <div className="h-3.5 w-full rounded bg-card/50" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-[116px] rounded-[18px] bg-card shadow-[var(--card-shadow)]" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className={`h-72 ${card}`} />
        <div className={`h-72 ${card}`} />
      </div>
      <div className="h-80 rounded-[24px] bg-card shadow-[var(--card-shadow)]" />
    </div>
  );
}
