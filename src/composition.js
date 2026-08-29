// The only production composition seam allowed to reach evaluator-owned demo data.
// Server routes receive the resulting service and remain blind to benchmark gold.
export { createServerDataService } from "./evaluation/server-data.js";
