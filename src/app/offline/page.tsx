export const dynamic = "force-static";

export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-background p-6 text-center">
      <h1 className="text-lg font-semibold text-foreground">You&apos;re offline</h1>
      <p className="text-sm text-muted-foreground">
        Reconnect to load the latest conversations.
      </p>
    </div>
  );
}
