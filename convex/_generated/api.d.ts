/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin_backfillNeedsResponse from "../admin/backfillNeedsResponse.js";
import type * as admin_refresh3Months from "../admin/refresh3Months.js";
import type * as admin_rescoreAllOpen from "../admin/rescoreAllOpen.js";
import type * as ai_chat from "../ai/chat.js";
import type * as ai_chatData from "../ai/chatData.js";
import type * as ai_chatHistory from "../ai/chatHistory.js";
import type * as ai_classifier from "../ai/classifier.js";
import type * as ai_classifierData from "../ai/classifierData.js";
import type * as ai_commitments from "../ai/commitments.js";
import type * as ai_costAlerts from "../ai/costAlerts.js";
import type * as ai_draft from "../ai/draft.js";
import type * as ai_draftData from "../ai/draftData.js";
import type * as ai_followUp from "../ai/followUp.js";
import type * as ai_followUpData from "../ai/followUpData.js";
import type * as ai_http from "../ai/http.js";
import type * as ai_learn from "../ai/learn.js";
import type * as ai_learnData from "../ai/learnData.js";
import type * as ai_meetingDetector from "../ai/meetingDetector.js";
import type * as ai_meetingDetectorData from "../ai/meetingDetectorData.js";
import type * as ai_needsResponse from "../ai/needsResponse.js";
import type * as ai_needsResponseData from "../ai/needsResponseData.js";
import type * as ai_promptGuidelines from "../ai/promptGuidelines.js";
import type * as ai_styleProfile from "../ai/styleProfile.js";
import type * as ai_styleProfileData from "../ai/styleProfileData.js";
import type * as ai_taskExtractor from "../ai/taskExtractor.js";
import type * as ai_taskExtractorData from "../ai/taskExtractorData.js";
import type * as ai_usageData from "../ai/usageData.js";
import type * as ai_vacationReply from "../ai/vacationReply.js";
import type * as ai_vacationReplyData from "../ai/vacationReplyData.js";
import type * as aiFilters from "../aiFilters.js";
import type * as attachmentsHttp from "../attachmentsHttp.js";
import type * as auth from "../auth.js";
import type * as blockedSenders from "../blockedSenders.js";
import type * as classifications from "../classifications.js";
import type * as commitments from "../commitments.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as devices from "../devices.js";
import type * as drafts from "../drafts.js";
import type * as emails from "../emails.js";
import type * as erp from "../erp.js";
import type * as followUps from "../followUps.js";
import type * as handoffs from "../handoffs.js";
import type * as http from "../http.js";
import type * as inboxSplits from "../inboxSplits.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_emailPreprocess from "../lib/emailPreprocess.js";
import type * as lib_inboxStamp from "../lib/inboxStamp.js";
import type * as lib_nameExtraction from "../lib/nameExtraction.js";
import type * as lib_personMerge from "../lib/personMerge.js";
import type * as lib_promiseDetector from "../lib/promiseDetector.js";
import type * as lib_safeScan from "../lib/safeScan.js";
import type * as lib_searchText from "../lib/searchText.js";
import type * as lib_styleContext from "../lib/styleContext.js";
import type * as lib_threadAccessCheck from "../lib/threadAccessCheck.js";
import type * as lib_threadContext from "../lib/threadContext.js";
import type * as lib_trackingInject from "../lib/trackingInject.js";
import type * as lib_workspace from "../lib/workspace.js";
import type * as mailAccounts from "../mailAccounts.js";
import type * as meetings from "../meetings.js";
import type * as needsResponse from "../needsResponse.js";
import type * as notificationPreferences from "../notificationPreferences.js";
import type * as notifications from "../notifications.js";
import type * as oauth_attachments from "../oauth/attachments.js";
import type * as oauth_gmail from "../oauth/gmail.js";
import type * as oauth_http from "../oauth/http.js";
import type * as oauth_microsoft from "../oauth/microsoft.js";
import type * as oauth_tokenManager from "../oauth/tokenManager.js";
import type * as oauth_tokenStore from "../oauth/tokenStore.js";
import type * as ooo from "../ooo.js";
import type * as persons from "../persons.js";
import type * as push_deliver from "../push/deliver.js";
import type * as push_deliverData from "../push/deliverData.js";
import type * as push_onNotification from "../push/onNotification.js";
import type * as retention from "../retention.js";
import type * as scheduledEmails from "../scheduledEmails.js";
import type * as searchProvider from "../searchProvider.js";
import type * as searchProviderData from "../searchProviderData.js";
import type * as signatures from "../signatures.js";
import type * as snippets from "../snippets.js";
import type * as sync_bodyRetention from "../sync/bodyRetention.js";
import type * as sync_cleanup from "../sync/cleanup.js";
import type * as sync_gmail from "../sync/gmail.js";
import type * as sync_gmailData from "../sync/gmailData.js";
import type * as sync_gmailHistorical from "../sync/gmailHistorical.js";
import type * as sync_gmailPush from "../sync/gmailPush.js";
import type * as sync_legacySweep from "../sync/legacySweep.js";
import type * as sync_microsoft from "../sync/microsoft.js";
import type * as sync_microsoftData from "../sync/microsoftData.js";
import type * as sync_microsoftHistorical from "../sync/microsoftHistorical.js";
import type * as sync_onDemandBody from "../sync/onDemandBody.js";
import type * as sync_onDemandBodyData from "../sync/onDemandBodyData.js";
import type * as sync_storageSweep from "../sync/storageSweep.js";
import type * as tasks from "../tasks.js";
import type * as team from "../team.js";
import type * as threadAccess from "../threadAccess.js";
import type * as threadComments from "../threadComments.js";
import type * as threads from "../threads.js";
import type * as tracking_http from "../tracking/http.js";
import type * as tracking_links from "../tracking/links.js";
import type * as tracking_pixel from "../tracking/pixel.js";
import type * as trackingExclusions from "../trackingExclusions.js";
import type * as triage from "../triage.js";
import type * as usage from "../usage.js";
import type * as users from "../users.js";
import type * as workspaces from "../workspaces.js";
import type * as writingPreferences from "../writingPreferences.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "admin/backfillNeedsResponse": typeof admin_backfillNeedsResponse;
  "admin/refresh3Months": typeof admin_refresh3Months;
  "admin/rescoreAllOpen": typeof admin_rescoreAllOpen;
  "ai/chat": typeof ai_chat;
  "ai/chatData": typeof ai_chatData;
  "ai/chatHistory": typeof ai_chatHistory;
  "ai/classifier": typeof ai_classifier;
  "ai/classifierData": typeof ai_classifierData;
  "ai/commitments": typeof ai_commitments;
  "ai/costAlerts": typeof ai_costAlerts;
  "ai/draft": typeof ai_draft;
  "ai/draftData": typeof ai_draftData;
  "ai/followUp": typeof ai_followUp;
  "ai/followUpData": typeof ai_followUpData;
  "ai/http": typeof ai_http;
  "ai/learn": typeof ai_learn;
  "ai/learnData": typeof ai_learnData;
  "ai/meetingDetector": typeof ai_meetingDetector;
  "ai/meetingDetectorData": typeof ai_meetingDetectorData;
  "ai/needsResponse": typeof ai_needsResponse;
  "ai/needsResponseData": typeof ai_needsResponseData;
  "ai/promptGuidelines": typeof ai_promptGuidelines;
  "ai/styleProfile": typeof ai_styleProfile;
  "ai/styleProfileData": typeof ai_styleProfileData;
  "ai/taskExtractor": typeof ai_taskExtractor;
  "ai/taskExtractorData": typeof ai_taskExtractorData;
  "ai/usageData": typeof ai_usageData;
  "ai/vacationReply": typeof ai_vacationReply;
  "ai/vacationReplyData": typeof ai_vacationReplyData;
  aiFilters: typeof aiFilters;
  attachmentsHttp: typeof attachmentsHttp;
  auth: typeof auth;
  blockedSenders: typeof blockedSenders;
  classifications: typeof classifications;
  commitments: typeof commitments;
  contacts: typeof contacts;
  crons: typeof crons;
  dashboard: typeof dashboard;
  devices: typeof devices;
  drafts: typeof drafts;
  emails: typeof emails;
  erp: typeof erp;
  followUps: typeof followUps;
  handoffs: typeof handoffs;
  http: typeof http;
  inboxSplits: typeof inboxSplits;
  "lib/auth": typeof lib_auth;
  "lib/emailPreprocess": typeof lib_emailPreprocess;
  "lib/inboxStamp": typeof lib_inboxStamp;
  "lib/nameExtraction": typeof lib_nameExtraction;
  "lib/personMerge": typeof lib_personMerge;
  "lib/promiseDetector": typeof lib_promiseDetector;
  "lib/safeScan": typeof lib_safeScan;
  "lib/searchText": typeof lib_searchText;
  "lib/styleContext": typeof lib_styleContext;
  "lib/threadAccessCheck": typeof lib_threadAccessCheck;
  "lib/threadContext": typeof lib_threadContext;
  "lib/trackingInject": typeof lib_trackingInject;
  "lib/workspace": typeof lib_workspace;
  mailAccounts: typeof mailAccounts;
  meetings: typeof meetings;
  needsResponse: typeof needsResponse;
  notificationPreferences: typeof notificationPreferences;
  notifications: typeof notifications;
  "oauth/attachments": typeof oauth_attachments;
  "oauth/gmail": typeof oauth_gmail;
  "oauth/http": typeof oauth_http;
  "oauth/microsoft": typeof oauth_microsoft;
  "oauth/tokenManager": typeof oauth_tokenManager;
  "oauth/tokenStore": typeof oauth_tokenStore;
  ooo: typeof ooo;
  persons: typeof persons;
  "push/deliver": typeof push_deliver;
  "push/deliverData": typeof push_deliverData;
  "push/onNotification": typeof push_onNotification;
  retention: typeof retention;
  scheduledEmails: typeof scheduledEmails;
  searchProvider: typeof searchProvider;
  searchProviderData: typeof searchProviderData;
  signatures: typeof signatures;
  snippets: typeof snippets;
  "sync/bodyRetention": typeof sync_bodyRetention;
  "sync/cleanup": typeof sync_cleanup;
  "sync/gmail": typeof sync_gmail;
  "sync/gmailData": typeof sync_gmailData;
  "sync/gmailHistorical": typeof sync_gmailHistorical;
  "sync/gmailPush": typeof sync_gmailPush;
  "sync/legacySweep": typeof sync_legacySweep;
  "sync/microsoft": typeof sync_microsoft;
  "sync/microsoftData": typeof sync_microsoftData;
  "sync/microsoftHistorical": typeof sync_microsoftHistorical;
  "sync/onDemandBody": typeof sync_onDemandBody;
  "sync/onDemandBodyData": typeof sync_onDemandBodyData;
  "sync/storageSweep": typeof sync_storageSweep;
  tasks: typeof tasks;
  team: typeof team;
  threadAccess: typeof threadAccess;
  threadComments: typeof threadComments;
  threads: typeof threads;
  "tracking/http": typeof tracking_http;
  "tracking/links": typeof tracking_links;
  "tracking/pixel": typeof tracking_pixel;
  trackingExclusions: typeof trackingExclusions;
  triage: typeof triage;
  usage: typeof usage;
  users: typeof users;
  workspaces: typeof workspaces;
  writingPreferences: typeof writingPreferences;
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
