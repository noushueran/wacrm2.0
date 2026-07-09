/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as auth from "../auth.js";
import type * as broadcasts from "../broadcasts.js";
import type * as contactNotes from "../contactNotes.js";
import type * as contacts from "../contacts.js";
import type * as conversations from "../conversations.js";
import type * as customFields from "../customFields.js";
import type * as dashboard from "../dashboard.js";
import type * as deals from "../deals.js";
import type * as http from "../http.js";
import type * as invitations from "../invitations.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_dashboardDate from "../lib/dashboardDate.js";
import type * as lib_inviteToken from "../lib/inviteToken.js";
import type * as lib_phone from "../lib/phone.js";
import type * as lib_roles from "../lib/roles.js";
import type * as members from "../members.js";
import type * as messages from "../messages.js";
import type * as pipelines from "../pipelines.js";
import type * as quickReplies from "../quickReplies.js";
import type * as reactions from "../reactions.js";
import type * as tags from "../tags.js";
import type * as templates from "../templates.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  auth: typeof auth;
  broadcasts: typeof broadcasts;
  contactNotes: typeof contactNotes;
  contacts: typeof contacts;
  conversations: typeof conversations;
  customFields: typeof customFields;
  dashboard: typeof dashboard;
  deals: typeof deals;
  http: typeof http;
  invitations: typeof invitations;
  "lib/auth": typeof lib_auth;
  "lib/dashboardDate": typeof lib_dashboardDate;
  "lib/inviteToken": typeof lib_inviteToken;
  "lib/phone": typeof lib_phone;
  "lib/roles": typeof lib_roles;
  members: typeof members;
  messages: typeof messages;
  pipelines: typeof pipelines;
  quickReplies: typeof quickReplies;
  reactions: typeof reactions;
  tags: typeof tags;
  templates: typeof templates;
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
