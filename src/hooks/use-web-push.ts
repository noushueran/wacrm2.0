"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { urlBase64ToUint8Array } from "@/lib/push/vapid";
import { isIOS, isStandalone } from "@/lib/push/platform";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export function useWebPush() {
  const subscribeMut = useMutation(api.push.subscribe);
  const unsubscribeMut = useMutation(api.push.unsubscribe);

  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [iosNeedsInstall, setIosNeedsInstall] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    setSupported(ok);
    if (!ok) {
      // iOS Safari only exposes PushManager once installed to the home screen.
      if (typeof navigator !== "undefined" && isIOS(navigator.userAgent, navigator.maxTouchPoints) && !isStandalone()) {
        setIosNeedsInstall(true);
      }
      return;
    }
    setPermission(Notification.permission);
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setIsSubscribed(!!sub))
      .catch(() => {});
  }, []);

  const enable = useCallback(async () => {
    if (!supported || !VAPID_PUBLIC_KEY) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          // Uint8Array is a valid applicationServerKey at runtime; the cast
          // sidesteps the lib.dom ArrayBufferLike-vs-ArrayBuffer generic
          // mismatch (see src/lib/whatsapp/meta-api.ts for the same idiom).
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as unknown as BufferSource,
        }));
      const json = sub.toJSON();
      const p256dh = json.keys?.p256dh;
      const auth = json.keys?.auth;
      // A userVisibleOnly subscription always carries both keys; bail instead
      // of persisting an un-encryptable (empty-key) subscription if it doesn't.
      if (!p256dh || !auth) return;
      await subscribeMut({
        endpoint: sub.endpoint,
        p256dh,
        auth,
        userAgent: navigator.userAgent,
      });
      setIsSubscribed(true);
    } finally {
      setBusy(false);
    }
  }, [supported, subscribeMut]);

  const disable = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribeMut({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setIsSubscribed(false);
    } finally {
      setBusy(false);
    }
  }, [supported, unsubscribeMut]);

  return { supported, permission, isSubscribed, iosNeedsInstall, busy, enable, disable };
}
