/**
 * This module adds the Alloy provider to the real time data module.
 * The {@link module:modules/realTimeData} module is required.
 * It loads the Alloy SDK, tracks page views with it, and passes Alloy's contextual and audience
 * segments to the configured bidders.
 * @module modules/alloyRtdProvider
 * @requires module:modules/realTimeData
 */

import { submodule } from '../src/hook.js';
import { deepClone, logError, mergeDeep } from '../src/utils.js';
import { MODULE_TYPE_RTD } from '../src/activities/modules.js';
import {
  ALLOY_GVLID,
  alloyWindow,
  callAlloySdk,
  hasAlloyConsent,
  loadAlloySdk,
  queueAlloyCommand
} from '../libraries/alloyUtils/sdk.ts';

import type { AlloySdkParams } from '../libraries/alloyUtils/sdk.ts';
import type { RtdProviderSpec } from './rtdModule/spec.ts';

const MODULE_NAME = 'alloy' as const;
const LOG_PREFIX = 'Alloy RTD: ';

// how long the auction waits for Alloy at most
const DEFAULT_TIMEOUT = 1000;
// Alloy data is first-party data of Ringier Advertising: it only goes to bidders the publisher names
const DEFAULT_BIDDERS = ['ringier'];

export type AlloyRtdParams = {
  /**
   * How to configure and load the Alloy SDK.
   */
  sdk?: AlloySdkParams;
  /**
   * Bidders that get the Alloy data. Defaults to `['ringier']`.
   */
  bidders?: string[];
  /**
   * Milliseconds to wait for the Alloy SDK to load and answer. Defaults to 1000.
   */
  timeout?: number;
  /**
   * Fetch the audience segments of the user. Defaults to true.
   */
  audiences?: boolean;
  /**
   * Track a page view once per URL. Defaults to true; ignored if the SDK tracks page views on its own.
   */
  trackPageViews?: boolean;
  /**
   * Logical path of the page for the page view, for example `examplech_de_web/desktop/sport`.
   */
  logicalPath?: string;
  /**
   * ID of the article in the CMS. Defaults to `window.alloyDataLayer.context.contentId`.
   */
  contentId?: string | number;
};

declare module './rtdModule/spec' {
  interface ProviderConfig {
    alloy: {
      params?: AlloyRtdParams;
    };
  }
}

type AlloySpec = RtdProviderSpec<typeof MODULE_NAME>;
type ContentId = string | number | undefined;

// the URL of the page view tracked last
let trackedUrl: string | undefined;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * IDs are passed on as they are, never coerced: a rewritten ID no longer matches on Alloy's side.
 */
function usableContentId(value: unknown): ContentId {
  if (typeof value === 'string') {
    return value.trim() === '' ? undefined : value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  return undefined;
}

function resolveContentId(params: AlloyRtdParams): ContentId {
  return usableContentId(params.contentId) ?? usableContentId(alloyWindow().alloyDataLayer?.context?.contentId);
}

function resolveBidders(params: AlloyRtdParams): string[] {
  return Array.isArray(params.bidders) ? params.bidders.filter(isNonEmptyString) : DEFAULT_BIDDERS;
}

function trackPageView(params: AlloyRtdParams, url: string, contentId: ContentId): void {
  // The global and not params.sdk says how the running SDK was configured: it may have been started by
  // the Alloy User ID submodule or by the page.
  if (params.trackPageViews === false || alloyWindow()._alloypageviewautotracking === true || trackedUrl === url) {
    return;
  }

  trackedUrl = url;

  queueAlloyCommand((sdk) => {
    sdk.tracking.trackPageViewEvent({
      ...(isNonEmptyString(params.logicalPath) && { logicalPath: params.logicalPath }),
      ...(contentId !== undefined && { contentId })
    });
  });
}

/**
 * Each list is named by the key-value key it stands for, so that a receiver can turn it into
 * `name=id` pairs: `alloy_iab=...`, `alloy_topics=...`, `alloy_ctx_ready=...`, `alloy_audiences=...`.
 */
function segmentData(name: string, segmentIds: unknown) {
  const segment = Array.isArray(segmentIds) ? segmentIds.filter(isNonEmptyString).map((id) => ({ id })) : [];

  return segment.length > 0 ? [{ name, segment }] : [];
}

function buildOrtb2(context: any, audiences: any) {
  // Alloy knows this very page, not just its section
  const contextReady = context?.attribution === 'direct' && context?.canonical_id != null;
  const siteData = [
    ...segmentData('alloy_iab', context?.alloy_iab),
    ...segmentData('alloy_topics', context?.alloy_topics),
    ...segmentData('alloy_ctx_ready', [contextReady ? '1' : '0'])
  ];
  const userData = segmentData('alloy_audiences', audiences?.segment_ids);

  return {
    site: { content: { data: siteData } },
    ...(userData.length > 0 && { user: { data: userData } })
  };
}

const getBidRequestData: AlloySpec['getBidRequestData'] = (request, callback, config, consent) => {
  if (!hasAlloyConsent(consent)) {
    callback();

    return;
  }

  const params: AlloyRtdParams = config?.params ?? {};
  const timeout = positiveNumber(params.timeout, DEFAULT_TIMEOUT);
  const url = window.location.href;
  const contentId = resolveContentId(params);
  const withAudiences = params.audiences !== false;

  loadAlloySdk(params.sdk, MODULE_TYPE_RTD, MODULE_NAME);
  trackPageView(params, url, contentId);

  let pending = withAudiences ? 2 : 1;
  let context: unknown;
  let audiences: unknown;

  const finish = () => {
    if (--pending > 0) {
      return;
    }

    try {
      const ortb2 = buildOrtb2(context, audiences);
      const fragments = request.ortb2Fragments;

      fragments.bidder = fragments.bidder || {};
      resolveBidders(params).forEach((bidder) => {
        fragments.bidder[bidder] = mergeDeep(fragments.bidder[bidder] || {}, deepClone(ortb2));
      });
    } catch (e) {
      logError(LOG_PREFIX + 'failed to add the data to the bid request', e);
    }

    callback();
  };

  callAlloySdk((sdk) => sdk.contextual.getContextData(url, contentId), timeout, (result) => {
    context = result;
    finish();
  });

  if (withAudiences) {
    callAlloySdk((sdk) => sdk.audienceSegment.getAudienceSegmentData(), timeout, (result) => {
      audiences = result;
      finish();
    });
  }
};

export const alloySubmodule: AlloySpec = {
  name: MODULE_NAME,
  gvlid: ALLOY_GVLID,
  // consent is not known yet when the module is configured: nothing is loaded before the first auction
  init: () => true,
  getBidRequestData
};

submodule('realTimeData', alloySubmodule);
