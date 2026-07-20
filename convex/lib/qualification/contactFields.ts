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
 * `country` is deliberately absent: in a travel CRM "country" reads as
 * the DESTINATION at least as often as the customer's residence, and a
 * wrong guess here is permanent — the caller only ever fills blanks, so
 * nothing would later correct it. `looking_for` is absent too; it names
 * the service, which already lands on `session.serviceName`.
 */
const ALIASES: Record<string, Target> = {
  email: "email", emailaddress: "email", mail: "email",
  nationality: "nationality", citizenship: "nationality",
  destination: "preferredDestination",
  destinationcountry: "preferredDestination",
  preferreddestination: "preferredDestination",
  travellingto: "preferredDestination",
  traveldates: "travelDates", dates: "travelDates",
  travelmonth: "travelDates", when: "travelDates",
  travelers: "travelers", travellers: "travelers",
  pax: "travelers", passengers: "travelers", numberoftravelers: "travelers",
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
    if (patch[target] !== undefined) continue; // first field wins
    if (contact[target]) continue; // blanks only — a human's value stands
    patch[target] = value;
  }
  return patch;
}
