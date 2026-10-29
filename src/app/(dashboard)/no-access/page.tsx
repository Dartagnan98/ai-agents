export const dynamic = 'force-dynamic';

export default function NoAccessPage() {
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-2 pt-10">
      <h1 className="font-heading text-2xl font-semibold tracking-[-0.02em]">Nothing open yet</h1>
      <p className="text-[15px] leading-relaxed text-muted-foreground">
        This account does not have a business or an AI page yet. An owner can grant those in Settings, under Users.
      </p>
    </div>
  );
}
