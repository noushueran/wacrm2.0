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
import type * as aiConfig from "../aiConfig.js";
import type * as aiUsage from "../aiUsage.js";
import type * as apiKeys from "../apiKeys.js";
import type * as auth from "../auth.js";
import type * as automationsEngine from "../automationsEngine.js";
import type * as broadcasts from "../broadcasts.js";
import type * as contactNotes from "../contactNotes.js";
import type * as contacts from "../contacts.js";
import type * as conversations from "../conversations.js";
import type * as customFields from "../customFields.js";
import type * as dashboard from "../dashboard.js";
import type * as deals from "../deals.js";
import type * as files from "../files.js";
import type * as flowsEngine from "../flowsEngine.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as invitations from "../invitations.js";
import type * as lib_apiKey from "../lib/apiKey.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_automations_stepsTree from "../lib/automations/stepsTree.js";
import type * as lib_automations_validate from "../lib/automations/validate.js";
import type * as lib_dashboardDate from "../lib/dashboardDate.js";
import type * as lib_flows_edges from "../lib/flows/edges.js";
import type * as lib_flows_fallback from "../lib/flows/fallback.js";
import type * as lib_flows_layout from "../lib/flows/layout.js";
import type * as lib_flows_shared from "../lib/flows/shared.js";
import type * as lib_flows_types from "../lib/flows/types.js";
import type * as lib_flows_validate from "../lib/flows/validate.js";
import type * as lib_inviteToken from "../lib/inviteToken.js";
import type * as lib_phone from "../lib/phone.js";
import type * as lib_roles from "../lib/roles.js";
import type * as lib_whatsapp_interactive from "../lib/whatsapp/interactive.js";
import type * as lib_whatsapp_metaApi from "../lib/whatsapp/metaApi.js";
import type * as lib_whatsappEncryption from "../lib/whatsappEncryption.js";
import type * as members from "../members.js";
import type * as messages from "../messages.js";
import type * as metaSend from "../metaSend.js";
import type * as notifications from "../notifications.js";
import type * as pipelines from "../pipelines.js";
import type * as presence from "../presence.js";
import type * as quickReplies from "../quickReplies.js";
import type * as reactions from "../reactions.js";
import type * as tags from "../tags.js";
import type * as templates from "../templates.js";
import type * as webhookDelivery from "../webhookDelivery.js";
import type * as webhookEndpoints from "../webhookEndpoints.js";
import type * as whatsappConfig from "../whatsappConfig.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  aiConfig: typeof aiConfig;
  aiUsage: typeof aiUsage;
  apiKeys: typeof apiKeys;
  auth: typeof auth;
  automationsEngine: typeof automationsEngine;
  broadcasts: typeof broadcasts;
  contactNotes: typeof contactNotes;
  contacts: typeof contacts;
  conversations: typeof conversations;
  customFields: typeof customFields;
  dashboard: typeof dashboard;
  deals: typeof deals;
  files: typeof files;
  flowsEngine: typeof flowsEngine;
  http: typeof http;
  ingest: typeof ingest;
  invitations: typeof invitations;
  "lib/apiKey": typeof lib_apiKey;
  "lib/auth": typeof lib_auth;
  "lib/automations/stepsTree": typeof lib_automations_stepsTree;
  "lib/automations/validate": typeof lib_automations_validate;
  "lib/dashboardDate": typeof lib_dashboardDate;
  "lib/flows/edges": typeof lib_flows_edges;
  "lib/flows/fallback": typeof lib_flows_fallback;
  "lib/flows/layout": typeof lib_flows_layout;
  "lib/flows/shared": typeof lib_flows_shared;
  "lib/flows/types": typeof lib_flows_types;
  "lib/flows/validate": typeof lib_flows_validate;
  "lib/inviteToken": typeof lib_inviteToken;
  "lib/phone": typeof lib_phone;
  "lib/roles": typeof lib_roles;
  "lib/whatsapp/interactive": typeof lib_whatsapp_interactive;
  "lib/whatsapp/metaApi": typeof lib_whatsapp_metaApi;
  "lib/whatsappEncryption": typeof lib_whatsappEncryption;
  members: typeof members;
  messages: typeof messages;
  metaSend: typeof metaSend;
  notifications: typeof notifications;
  pipelines: typeof pipelines;
  presence: typeof presence;
  quickReplies: typeof quickReplies;
  reactions: typeof reactions;
  tags: typeof tags;
  templates: typeof templates;
  webhookDelivery: typeof webhookDelivery;
  webhookEndpoints: typeof webhookEndpoints;
  whatsappConfig: typeof whatsappConfig;
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
