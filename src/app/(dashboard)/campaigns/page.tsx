import { redirect } from 'next/navigation'

/** `/campaigns` was folded into the Reports section. Its funnel view is now
 *  `/reports?tab=funnel`; the old URL is kept as a redirect so existing
 *  bookmarks and links keep working. */
export default function CampaignsPage() {
  redirect('/reports?tab=funnel')
}
