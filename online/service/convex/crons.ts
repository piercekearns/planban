import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { makeFunctionReference } from "convex/server";
import { usageEnabled } from "./model/providerUsage";

const crons = cronJobs();
// Registration requires a coordinated deployment; runtime flag is also checked.
if (usageEnabled(process.env)) crons.hourly("Planban included usage warnings", { minuteUTC: 17 }, makeFunctionReference<"action">("providerUsage:poll"), {});
crons.daily("expire idempotency records", { hourUTC: 3, minuteUTC: 0 }, internal.maintenance.expireOperations, {});
crons.daily("cancel abandoned uploads", { hourUTC: 3, minuteUTC: 15 }, internal.maintenance.cancelAbandonedTransfers, {});
crons.daily("forget old daily usage", { hourUTC: 4, minuteUTC: 0 }, internal.maintenance.expireUsage, {});
crons.daily("forget used sign-in tokens", { hourUTC: 3, minuteUTC: 45 }, internal.maintenance.expireMachineExchanges, {});
export default crons;
