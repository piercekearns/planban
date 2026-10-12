/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as attachments from "../attachments.js";
import type * as boards from "../boards.js";
import type * as connections from "../connections.js";
import type * as copies from "../copies.js";
import type * as crons from "../crons.js";
import type * as historyMaintenance from "../historyMaintenance.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as live from "../live.js";
import type * as maintenance from "../maintenance.js";
import type * as members from "../members.js";
import type * as model_access from "../model/access.js";
import type * as model_auth from "../model/auth.js";
import type * as model_blobs from "../model/blobs.js";
import type * as model_cardChanges from "../model/cardChanges.js";
import type * as model_clerk from "../model/clerk.js";
import type * as model_codec from "../model/codec.js";
import type * as model_errors from "../model/errors.js";
import type * as model_history from "../model/history.js";
import type * as model_indexRules from "../model/indexRules.js";
import type * as model_liveToken from "../model/liveToken.js";
import type * as model_mcp from "../model/mcp.js";
import type * as model_rows from "../model/rows.js";
import type * as model_sha256 from "../model/sha256.js";
import type * as model_transfer from "../model/transfer.js";
import type * as people from "../people.js";
import type * as signingKeys from "../signingKeys.js";
import type * as transfers from "../transfers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  attachments: typeof attachments;
  boards: typeof boards;
  connections: typeof connections;
  copies: typeof copies;
  crons: typeof crons;
  historyMaintenance: typeof historyMaintenance;
  http: typeof http;
  invites: typeof invites;
  live: typeof live;
  maintenance: typeof maintenance;
  members: typeof members;
  "model/access": typeof model_access;
  "model/auth": typeof model_auth;
  "model/blobs": typeof model_blobs;
  "model/cardChanges": typeof model_cardChanges;
  "model/clerk": typeof model_clerk;
  "model/codec": typeof model_codec;
  "model/errors": typeof model_errors;
  "model/history": typeof model_history;
  "model/indexRules": typeof model_indexRules;
  "model/liveToken": typeof model_liveToken;
  "model/mcp": typeof model_mcp;
  "model/rows": typeof model_rows;
  "model/sha256": typeof model_sha256;
  "model/transfer": typeof model_transfer;
  people: typeof people;
  signingKeys: typeof signingKeys;
  transfers: typeof transfers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
