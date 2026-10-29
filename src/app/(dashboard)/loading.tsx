// Page skeleton in the Porcelain Signal shape: title, answer line, KPI tiles, a hero and a card.
export default function DashboardLoading() {
  return (
    <div className="flex animate-pulse flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="flex items-end justify-between gap-4">
        <div className="h-8 w-44 rounded-lg bg-card shadow-[var(--card-shadow)]" />
        <div className="h-10 w-72 rounded-xl bg-card shadow-[var(--card-shadow)]" />
      </div>
      <div className="h-6 w-[min(560px,80%)] rounded-lg bg-card/70" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[118px] rounded-[18px] bg-card shadow-[var(--card-shadow)]" />
        ))}
      </div>
      <div className="h-72 rounded-[24px] bg-card shadow-[var(--card-shadow)]" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="h-60 rounded-[22px] bg-card shadow-[var(--card-shadow)]" />
        <div className="h-60 rounded-[22px] bg-card shadow-[var(--card-shadow)]" />
      </div>
    </div>
  );
}
