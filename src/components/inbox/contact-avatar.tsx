"use client";

import { useState } from "react";
import { User } from "lucide-react";

import { avatarClasses, contactInitials } from "@/lib/inbox/avatar";
import { cn } from "@/lib/utils";

/**
 * The one avatar used everywhere a contact appears in the inbox — the
 * conversation list, the chat header and the contact panel.
 *
 * There are three states, and the SECOND is by far the most common:
 *
 *  1. An uploaded photo. Only ever set by hand from the contact panel;
 *     WhatsApp supplies no customer pictures (see `src/lib/inbox/avatar.ts`).
 *  2. Derived colour + initials, for a contact with a name.
 *  3. Derived colour + a person glyph, for a contact WhatsApp gave no
 *     profile name for — their `displayName` is a phone number, whose
 *     first character ("+", "9") is not an initial.
 *
 * State 1 also falls back to 2/3 if the image fails to load, so a photo
 * whose object has gone missing degrades to the same disc as everyone
 * else rather than a broken-image icon.
 */

const SIZE_CLASS = {
  /** Chat header. */
  sm: "h-9 w-9 text-xs",
  /** Conversation-list row. */
  md: "h-10 w-10 text-sm",
  /** Contact panel header. */
  lg: "h-16 w-16 text-lg",
} as const;

const GLYPH_CLASS = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-7 w-7",
} as const;

export interface ContactAvatarProps {
  /** What the row shows as the contact's name — already falling back to
   *  the phone number upstream, which is exactly what makes the glyph
   *  state necessary. */
  displayName: string;
  /** Stable colour seed. Pass `phone_normalized` (or `phone`): it does
   *  not change when the contact is renamed, so the colour stays put. */
  seed: string;
  /** Resolved photo URL, already through `resolveMediaUrl`. */
  photoUrl?: string | null;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
}

export function ContactAvatar({
  displayName,
  seed,
  photoUrl,
  size = "md",
  className,
}: ContactAvatarProps) {
  // WHICH url failed, not merely THAT one did. React reuses this instance
  // when the same tree position renders a different contact — switching
  // threads keeps one header avatar mounted — and a plain boolean would
  // stick to that slot and suppress every later contact's photo. Storing
  // the url makes the reset fall out of the comparison, with no effect to
  // synchronise (and no cascading render).
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = !!photoUrl && failedUrl === photoUrl;

  const base = cn(
    "shrink-0 overflow-hidden rounded-full",
    SIZE_CLASS[size],
    className,
  );

  if (photoUrl && !failed) {
    return (
      // Plain `<img>`, not `next/image`: a photo lives on the R2 public
      // host, and legacy rows can carry an arbitrary third-party origin,
      // so there is no fixed host set for `images.remotePatterns` (none
      // is configured) — `next/image` refuses an unlisted host at runtime
      // rather than degrading. These render at 36–64px, which is also
      // where the optimizer buys the least.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoUrl}
        // Decorative, hence empty — same reasoning as the `aria-hidden`
        // on the fallback disc below. All three call sites render the
        // contact's name immediately beside this, so a filled `alt` makes
        // a screen reader announce the same name twice per row.
        alt=""
        onError={() => setFailedUrl(photoUrl)}
        className={cn(base, "object-cover")}
      />
    );
  }

  const initials = contactInitials(displayName);

  return (
    <span
      aria-hidden="true"
      className={cn(
        base,
        "flex items-center justify-center font-medium",
        avatarClasses(seed),
      )}
    >
      {initials || <User className={GLYPH_CLASS[size]} />}
    </span>
  );
}
