import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Retry attribution conversion signals that failed to reach Platform A
// (landingResult "error"/"pending"). Rows that exhaust MAX_ATTEMPTS
// retries are retired to a terminal "abandoned" state and no longer
// swept. Bounded, best-effort.
crons.interval(
  "retry-attribution-signals",
  { minutes: 15 },
  internal.attribution.retryPending,
  {},
);

export default crons;
