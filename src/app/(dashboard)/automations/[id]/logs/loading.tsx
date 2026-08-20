import { ListSectionSkeleton } from "@/components/layout/section-skeletons";

/**
 * Route-level fallback for `/automations/[id]/logs`. The section root
 * (`../../loading.tsx`) does not cover nested routes, so navigating from
 * the list into a detail page previously left the old screen up until
 * this route's client bundle AND its queries had both resolved — a
 * couple of round trips against the self-hosted backend with no
 * feedback. The page renders a header plus a stack of log rows, which is
 * what `ListSectionSkeleton` already draws.
 */
export default function Loading() {
  return <ListSectionSkeleton rows={5} />;
}
