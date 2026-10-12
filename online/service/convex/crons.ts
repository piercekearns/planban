import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.daily("expire idempotency records", { hourUTC: 3, minuteUTC: 0 }, internal.maintenance.expireOperations, {});
crons.daily("cancel abandoned uploads", { hourUTC: 3, minuteUTC: 15 }, internal.maintenance.cancelAbandonedTransfers, {});
crons.daily("forget used sign-in tokens", { hourUTC: 3, minuteUTC: 45 }, internal.maintenance.expireMachineExchanges, {});
export default crons;
