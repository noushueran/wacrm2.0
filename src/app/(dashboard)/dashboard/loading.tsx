import { DashboardSectionSkeleton } from "@/components/layout/section-skeletons";

// Shown instantly on navigation to /dashboard while the route's RSC
// payload + client data load. See section-skeletons.tsx for why.
export default function Loading() {
  return <DashboardSectionSkeleton />;
}
