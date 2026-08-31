import { BuilderSectionSkeleton } from "@/components/layout/section-skeletons";

/**
 * Route-level fallback for `/automations/[id]/edit` — see the sibling
 * `logs/loading.tsx` for why the section root's own `loading.tsx` does
 * not cover this route. The builder is a full-height canvas rather than
 * a list, so it gets its own skeleton shape.
 */
export default function Loading() {
  return <BuilderSectionSkeleton />;
}
