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
import type * as adReferrals from "../adReferrals.js";
import type * as aiConfig from "../aiConfig.js";
import type * as aiKnowledge from "../aiKnowledge.js";
import type * as aiReply from "../aiReply.js";
import type * as aiTagging from "../aiTagging.js";
import type * as aiUsage from "../aiUsage.js";
import type * as apiKeys from "../apiKeys.js";
import type * as apiV1 from "../apiV1.js";
import type * as attribution from "../attribution.js";
import type * as auth from "../auth.js";
import type * as automations from "../automations.js";
import type * as automationsEngine from "../automationsEngine.js";
import type * as broadcasts from "../broadcasts.js";
import type * as campaignAds from "../campaignAds.js";
import type * as campaigns from "../campaigns.js";
import type * as contactNotes from "../contactNotes.js";
import type * as contacts from "../contacts.js";
import type * as conversations from "../conversations.js";
import type * as conversionEvents from "../conversionEvents.js";
import type * as cronSchedules from "../cronSchedules.js";
import type * as crons from "../crons.js";
import type * as customFields from "../customFields.js";
import type * as dashboard from "../dashboard.js";
import type * as deals from "../deals.js";
import type * as files from "../files.js";
import type * as flows from "../flows.js";
import type * as flowsEngine from "../flowsEngine.js";
import type * as funnel from "../funnel.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as invitations from "../invitations.js";
import type * as leadCharges from "../leadCharges.js";
import type * as lib_ai_chunk from "../lib/ai/chunk.js";
import type * as lib_ai_classify from "../lib/ai/classify.js";
import type * as lib_ai_context from "../lib/ai/context.js";
import type * as lib_ai_defaults from "../lib/ai/defaults.js";
import type * as lib_ai_embeddings from "../lib/ai/embeddings.js";
import type * as lib_ai_generate from "../lib/ai/generate.js";
import type * as lib_ai_media from "../lib/ai/media.js";
import type * as lib_ai_providers_anthropic from "../lib/ai/providers/anthropic.js";
import type * as lib_ai_providers_openai from "../lib/ai/providers/openai.js";
import type * as lib_ai_providers_shared from "../lib/ai/providers/shared.js";
import type * as lib_ai_query from "../lib/ai/query.js";
import type * as lib_ai_types from "../lib/ai/types.js";
import type * as lib_apiKey from "../lib/apiKey.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_automations_stepsTree from "../lib/automations/stepsTree.js";
import type * as lib_automations_validate from "../lib/automations/validate.js";
import type * as lib_contactSearch from "../lib/contactSearch.js";
import type * as lib_conversationAccess from "../lib/conversationAccess.js";
import type * as lib_cronSummary from "../lib/cronSummary.js";
import type * as lib_dashboardDate from "../lib/dashboardDate.js";
import type * as lib_flows_edges from "../lib/flows/edges.js";
import type * as lib_flows_fallback from "../lib/flows/fallback.js";
import type * as lib_flows_layout from "../lib/flows/layout.js";
import type * as lib_flows_shared from "../lib/flows/shared.js";
import type * as lib_flows_types from "../lib/flows/types.js";
import type * as lib_flows_validate from "../lib/flows/validate.js";
import type * as lib_funnel from "../lib/funnel.js";
import type * as lib_inviteToken from "../lib/inviteToken.js";
import type * as lib_leadCharge from "../lib/leadCharge.js";
import type * as lib_phone from "../lib/phone.js";
import type * as lib_pushPayload from "../lib/pushPayload.js";
import type * as lib_pushRecipients from "../lib/pushRecipients.js";
import type * as lib_qualification_analyze from "../lib/qualification/analyze.js";
import type * as lib_qualification_defaults from "../lib/qualification/defaults.js";
import type * as lib_qualification_schedule from "../lib/qualification/schedule.js";
import type * as lib_qualification_staffReply from "../lib/qualification/staffReply.js";
import type * as lib_qualification_track from "../lib/qualification/track.js";
import type * as lib_qualification_validate from "../lib/qualification/validate.js";
import type * as lib_roles from "../lib/roles.js";
import type * as lib_whatsapp_interactive from "../lib/whatsapp/interactive.js";
import type * as lib_whatsapp_metaApi from "../lib/whatsapp/metaApi.js";
import type * as lib_whatsapp_templateComponents from "../lib/whatsapp/templateComponents.js";
import type * as lib_whatsapp_webhookParse from "../lib/whatsapp/webhookParse.js";
import type * as lib_whatsappEncryption from "../lib/whatsappEncryption.js";
import type * as memberTags from "../memberTags.js";
import type * as members from "../members.js";
import type * as messages from "../messages.js";
import type * as metaSend from "../metaSend.js";
import type * as metaTemplates from "../metaTemplates.js";
import type * as notifications from "../notifications.js";
import type * as pipelines from "../pipelines.js";
import type * as presence from "../presence.js";
import type * as push from "../push.js";
import type * as pushSend from "../pushSend.js";
import type * as qualification from "../qualification.js";
import type * as qualificationEngine from "../qualificationEngine.js";
import type * as quickReplies from "../quickReplies.js";
import type * as reactions from "../reactions.js";
import type * as send from "../send.js";
import type * as tagGroups from "../tagGroups.js";
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
  adReferrals: typeof adReferrals;
  aiConfig: typeof aiConfig;
  aiKnowledge: typeof aiKnowledge;
  aiReply: typeof aiReply;
  aiTagging: typeof aiTagging;
  aiUsage: typeof aiUsage;
  apiKeys: typeof apiKeys;
  apiV1: typeof apiV1;
  attribution: typeof attribution;
  auth: typeof auth;
  automations: typeof automations;
  automationsEngine: typeof automationsEngine;
  broadcasts: typeof broadcasts;
  campaignAds: typeof campaignAds;
  campaigns: typeof campaigns;
  contactNotes: typeof contactNotes;
  contacts: typeof contacts;
  conversations: typeof conversations;
  conversionEvents: typeof conversionEvents;
  cronSchedules: typeof cronSchedules;
  crons: typeof crons;
  customFields: typeof customFields;
  dashboard: typeof dashboard;
  deals: typeof deals;
  files: typeof files;
  flows: typeof flows;
  flowsEngine: typeof flowsEngine;
  funnel: typeof funnel;
  http: typeof http;
  ingest: typeof ingest;
  invitations: typeof invitations;
  leadCharges: typeof leadCharges;
  "lib/ai/chunk": typeof lib_ai_chunk;
  "lib/ai/classify": typeof lib_ai_classify;
  "lib/ai/context": typeof lib_ai_context;
  "lib/ai/defaults": typeof lib_ai_defaults;
  "lib/ai/embeddings": typeof lib_ai_embeddings;
  "lib/ai/generate": typeof lib_ai_generate;
  "lib/ai/media": typeof lib_ai_media;
  "lib/ai/providers/anthropic": typeof lib_ai_providers_anthropic;
  "lib/ai/providers/openai": typeof lib_ai_providers_openai;
  "lib/ai/providers/shared": typeof lib_ai_providers_shared;
  "lib/ai/query": typeof lib_ai_query;
  "lib/ai/types": typeof lib_ai_types;
  "lib/apiKey": typeof lib_apiKey;
  "lib/auth": typeof lib_auth;
  "lib/automations/stepsTree": typeof lib_automations_stepsTree;
  "lib/automations/validate": typeof lib_automations_validate;
  "lib/contactSearch": typeof lib_contactSearch;
  "lib/conversationAccess": typeof lib_conversationAccess;
  "lib/cronSummary": typeof lib_cronSummary;
  "lib/dashboardDate": typeof lib_dashboardDate;
  "lib/flows/edges": typeof lib_flows_edges;
  "lib/flows/fallback": typeof lib_flows_fallback;
  "lib/flows/layout": typeof lib_flows_layout;
  "lib/flows/shared": typeof lib_flows_shared;
  "lib/flows/types": typeof lib_flows_types;
  "lib/flows/validate": typeof lib_flows_validate;
  "lib/funnel": typeof lib_funnel;
  "lib/inviteToken": typeof lib_inviteToken;
  "lib/leadCharge": typeof lib_leadCharge;
  "lib/phone": typeof lib_phone;
  "lib/pushPayload": typeof lib_pushPayload;
  "lib/pushRecipients": typeof lib_pushRecipients;
  "lib/qualification/analyze": typeof lib_qualification_analyze;
  "lib/qualification/defaults": typeof lib_qualification_defaults;
  "lib/qualification/schedule": typeof lib_qualification_schedule;
  "lib/qualification/staffReply": typeof lib_qualification_staffReply;
  "lib/qualification/track": typeof lib_qualification_track;
  "lib/qualification/validate": typeof lib_qualification_validate;
  "lib/roles": typeof lib_roles;
  "lib/whatsapp/interactive": typeof lib_whatsapp_interactive;
  "lib/whatsapp/metaApi": typeof lib_whatsapp_metaApi;
  "lib/whatsapp/templateComponents": typeof lib_whatsapp_templateComponents;
  "lib/whatsapp/webhookParse": typeof lib_whatsapp_webhookParse;
  "lib/whatsappEncryption": typeof lib_whatsappEncryption;
  memberTags: typeof memberTags;
  members: typeof members;
  messages: typeof messages;
  metaSend: typeof metaSend;
  metaTemplates: typeof metaTemplates;
  notifications: typeof notifications;
  pipelines: typeof pipelines;
  presence: typeof presence;
  push: typeof push;
  pushSend: typeof pushSend;
  qualification: typeof qualification;
  qualificationEngine: typeof qualificationEngine;
  quickReplies: typeof quickReplies;
  reactions: typeof reactions;
  send: typeof send;
  tagGroups: typeof tagGroups;
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
