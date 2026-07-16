// Pure platform detection for the push/install UX. `maxTouchPoints` is
// passed in so the iPadOS-masquerading-as-Mac case is testable without a
// real navigator.
export function isIOS(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPod/.test(userAgent)) return true;
  if (/iPad/.test(userAgent)) return true;
  // iPadOS 13+ reports a Mac UA; disambiguate by touch support.
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return true;
  return false;
}

// True when the app is running as an installed PWA (home-screen / standalone).
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    // iOS Safari legacy flag.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}
