import type { Doc } from "../../_generated/dataModel";

/** The contact columns the qualification engine may fill. */
type Target = "email" | "nationality" | "preferredDestination" | "travelDates" | "travelers" | "budget";

type ExtractedField = {
  key: string;
  label?: string;
  value: string;
  confidence: "high" | "medium" | "low";
};

/**
 * Normalised alias -> contact column.
 *
 * Deliberately a conservative allowlist, not a best-effort guess list:
 * the caller only ever fills blanks, so an alias that fires wrongly
 * writes a permanent wrong value into a field nothing will later
 * correct. An unmapped key just stays in the session, visible to the
 * rep — strictly better than a mis-mapped one. Entries are added only
 * when grounded in the observed checklist/config vocabulary, not merely
 * because they seem plausible (a bare `when` could just as easily mean
 * a visa-approval deadline as a travel date; a bare `mail` could mean a
 * physical mailing address as easily as an email).
 *
 * `country` is deliberately absent: in a travel CRM "country" reads as
 * the DESTINATION at least as often as the customer's residence, and a
 * wrong guess here is permanent — the caller only ever fills blanks, so
 * nothing would later correct it. `looking_for` is absent too; it names
 * the service, which already lands on `session.serviceName`.
 */
const ALIASES: Record<string, Target> = {
  email: "email", emailaddress: "email",
  nationality: "nationality", citizenship: "nationality",
  destination: "preferredDestination",
  destinationcountry: "preferredDestination",
  preferreddestination: "preferredDestination",
  travellingto: "preferredDestination",
  destinationorinterest: "preferredDestination", // Ladies-Only Group Tours checklist key
  traveldates: "travelDates", dates: "travelDates",
  travelmonth: "travelDates",
  travelers: "travelers", travellers: "travelers",
  pax: "travelers", passengers: "travelers", numberoftravelers: "travelers",
  groupsize: "travelers", // Ladies-Only Group Tours checklist key
  budget: "budget", budgetperperson: "budget",
  perpersonbudget: "budget", tripbudget: "budget",
};

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Pure mapping of a session's extracted fields onto a contact patch.
 *
 * Returns ONLY what should be written: blanks-only (never overwrites a
 * value a human may have corrected), `low` confidence excluded to match
 * the engine's existing convention, empty-string values skipped. An
 * empty object means "write nothing".
 */
export function mapFieldsToContact(
  fields: ExtractedField[],
  contact: Doc<"contacts">,
): Partial<Doc<"contacts">> {
  const patch: Partial<Record<Target, string>> = {};
  for (const f of fields) {
    if (f.confidence === "low") continue;
    const value = f.value.trim();
    if (!value) continue;
    // Key beats label: the key is the extractor's own identifier, while
    // a label is human prose that may mention another field in passing.
    const target = ALIASES[normalize(f.key)] ?? (f.label ? ALIASES[normalize(f.label)] : undefined);
    if (!target) continue;
    // `email` is the one mapped column with downstream semantics —
    // contactSearch.ts matches on it and the /contacts table displays it —
    // and a wrong write here is permanent under blanks-only. Reject obvious
    // prose ("I don't have one") with the cheapest structural check; this
    // is not meant to enforce full RFC-compliant email syntax.
    if (target === "email" && !value.includes("@")) continue;
    if (patch[target] !== undefined) continue; // first field wins
    if (contact[target]) continue; // blanks only — a human's value stands
    patch[target] = value;
  }
  return patch;
}
