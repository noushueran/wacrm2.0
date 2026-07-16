"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";

type PushPayload = { title: string; body: string; url: string; tag: string };

// Older Safari exposed a vendor-prefixed ctor; the ambient DOM lib doesn't
// type it, so this narrows just enough to feature-detect it without `any`.
type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };

// Synthesizes a short two-note chime with the Web Audio API — no audio
// asset to source/license. Uses a lazily-created AudioContext (created on
// first use, then reused) so we never spin one up before it's needed.
// Best-effort only: autoplay policies can silently block playback without
// a prior user gesture on the page, and Web Audio may simply be
// unavailable, so every failure path here is swallowed — a missing chime
// must never break the toast itself.
function playChime(ctxRef: { current: AudioContext | null }) {
  try {
    const AudioContextCtor =
      window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!AudioContextCtor) return;

    const ctx = ctxRef.current ?? new AudioContextCtor();
    ctxRef.current = ctx;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});

    const playNote = (freq: number, startAt: number, duration: number) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(freq, startAt);
      // Fast attack, exponential decay toward silence — a soft "pluck"
      // rather than a flat beep. (Exponential ramps can't target exactly
      // 0, so this aims at a near-inaudible floor instead.)
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(0.2, startAt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + duration);
    };

    // Short rising two-note "ding-ding", ~220ms total.
    const now = ctx.currentTime;
    playNote(880, now, 0.1); // A5
    playNote(1318.51, now + 0.1, 0.12); // E6
  } catch {
    // Ignore — the chime is a nice-to-have, never block the toast.
  }
}

// Headless. While a tab is VISIBLE, shows an in-app toast + chime for a
// new inbound message (the SW hands off instead of firing an OS
// notification when a client is visible). Each push delivers exactly one
// `wa-push` event per tab (ServiceWorkerManager registers a single
// SW-message listener, and the SW sends one postMessage per push), so no
// de-dupe is needed here. Skips the conversation currently open in the
// inbox (that message is already streaming in live).
export function InboxNotifier() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const openConversationId = pathname.startsWith("/inbox") ? searchParams.get("c") : null;

    const onPush = (e: Event) => {
      const payload = (e as CustomEvent<PushPayload>).detail;
      if (!payload?.tag) return;
      // Skip if the user is already looking at this conversation — the
      // message is already streaming in live via the reactive query.
      if (payload.tag === openConversationId) return;

      playChime(audioCtxRef);
      toast(payload.title, {
        description: payload.body,
        action: { label: "Open", onClick: () => router.push(payload.url) },
      });
    };

    window.addEventListener("wa-push", onPush);
    return () => window.removeEventListener("wa-push", onPush);
  }, [pathname, searchParams, router]);

  // Release the shared AudioContext when the notifier itself unmounts
  // (e.g. sign-out), not on every navigation — the listener effect above
  // re-runs per route change and would otherwise tear this down constantly.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: audioCtxRef is a lazily-created AudioContext, not a React-managed node, and is still null at mount time (created on first chime); snapshotting .current here would always close null instead of the real context.
      void audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  return null;
}
