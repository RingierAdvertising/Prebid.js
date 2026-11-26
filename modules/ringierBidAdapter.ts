import { config } from '../src/config.js';
import { BANNER, NATIVE, VIDEO, type MediaType } from '../src/mediaTypes.js';
import { isNumber, logWarn, politeTriggerPixel } from '../src/utils.js';
import { registerBidder, type AdapterRequest, type BidderSpec, type ExtendedResponse } from '../src/adapters/bidderFactory.js';
import { ortbConverter } from '../libraries/ortbConverter/converter.js';
import { EVENT_TYPE_IMPRESSION, TRACKER_METHOD_IMG } from '../src/eventTrackers.js';
import type { BidderRequest, BidRequest } from '../src/adapterManager.js';
import type { Bid } from '../src/bidfactory.js';
import type { ORTBRequest } from '../src/types/ortb/request.d.ts';

const BIDDER_CODE = 'ringier' as const;
const GVLID = 1436;
const BIDLAYER_DOMAIN = 'ringier-advertising.ch';
export const ENDPOINT = `https://bid.at.${BIDLAYER_DOMAIN}/openrtb2/auction`;
const EVENT_PATH = '/event';
const SYNC_IFRAME_PATH = '/static/load-cookie.html';
const COOKIE_SYNC_PATH = '/cookie_sync';
const MAX_SYNC_COUNT = 10;
// load-cookie.html splits `args` at `,` and `:` and turns digit-only values into numbers, which Prebid Server rejects as account
const SYNC_ACCOUNT_PATTERN = /^(?!\d+$)[\w.-]+$/;
const DEFAULT_TTL = 300;
// OpenRTB default for a response without `cur`
const DEFAULT_CURRENCY = 'USD';

export type RingierBidParams = {
  /** Publisher ID assigned by Ringier Advertising. */
  publisherId: string;
  /** Placement ID assigned by Ringier Advertising. */
  placementId: string;
};

export type RingierConfig = {
  /**
   * Overrides the auction endpoint, e.g. for a staging environment.
   * Must be an https URL on the Ringier Bidlayer domain; anything else is ignored.
   */
  endpoint?: string;
  /** Version of the publisher config the page was set up with. */
  configVersion?: string | number;
  /** Bidders the publisher requests client-side on this page; the Bidlayer does not call them again. */
  clientBidders?: string[];
  /** Page view ID used by the publisher; defaults to the page view ID Prebid.js assigns to this bidder. */
  pvId?: string;
  /** Set to true to send the event pixels (win, render, timeout, error). Off by default. */
  sendEvents?: boolean;
};

declare module '../src/adUnits' {
  interface BidderParams {
    [BIDDER_CODE]: RingierBidParams;
  }
}

declare module '../src/config' {
  interface Config {
    [BIDDER_CODE]?: RingierConfig;
  }
}

type RingierBidRequest = BidRequest<typeof BIDDER_CODE>;

type RingierEventInfo = {
  token: string;
  eventBase: string;
};

type RingierBid = Bid & {
  ext?: { [BIDDER_CODE]?: RingierEventInfo };
};

/** `seatbid[].bid[].ext.ringier` in a Bidlayer response */
type RingierResponseExt = {
  /** opaque origin of the bid */
  o?: unknown;
  /** event token */
  t?: unknown;
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function getRingierConfig(): RingierConfig {
  return config.getConfig(BIDDER_CODE) || {};
}

/**
 * User syncs need TCF purpose 1 consent. Unlike `hasPurpose1Consent`, an unknown GDPR scope counts as GDPR applying.
 * Without any GDPR data (no TCF module on the page) Prebid Server decides on /cookie_sync with its default scope.
 */
function canSync(gdprConsent): boolean {
  if (gdprConsent == null || gdprConsent.gdprApplies === false) return true;
  return gdprConsent.vendorData?.purpose?.consents?.[1] === true;
}

function isBidlayerHost(hostname: string): boolean {
  return hostname === BIDLAYER_DOMAIN || hostname.endsWith(`.${BIDLAYER_DOMAIN}`);
}

/**
 * Returns the auction endpoint. An override from `setConfig({ringier: {endpoint}})` is only accepted
 * when it points to the Bidlayer domain over https.
 */
export function getEndpoint(): string {
  const override = getRingierConfig().endpoint;
  if (override == null) return ENDPOINT;
  try {
    const url = new URL(override);
    if (url.protocol === 'https:' && isBidlayerHost(url.hostname)) return url.href;
  } catch (e) {
  }
  logWarn(`${BIDDER_CODE}: ignoring endpoint override '${override}', it must be an https URL on ${BIDLAYER_DOMAIN}`);
  return ENDPOINT;
}

function getRequestExt(publisherId: string, bidderRequest: BidderRequest<typeof BIDDER_CODE>) {
  const { configVersion, clientBidders, pvId } = getRingierConfig();
  const ext: Record<string, unknown> = { publisherId };
  if (isNonEmptyString(configVersion) || isNumber(configVersion)) {
    // the Bidlayer reads configVersion as a string only
    ext.configVersion = String(configVersion);
  }
  if (Array.isArray(clientBidders)) {
    ext.clientBidders = clientBidders.filter(isNonEmptyString);
  }
  const pageViewId = isNonEmptyString(pvId) ? pvId : bidderRequest.pageViewId;
  if (isNonEmptyString(pageViewId)) {
    ext.pvId = pageViewId;
  }
  return ext;
}

function getResponseMediaType(bid, bidRequest: RingierBidRequest): MediaType | undefined {
  // ORTB 2.6 `mtype` is handled by the converter; Prebid Server also reports the type in `ext.prebid.type`.
  if (bid.mtype != null) return undefined;
  const pbsType = bid.ext?.prebid?.type;
  if ([BANNER, VIDEO, NATIVE].includes(pbsType)) return pbsType;
  const requestedTypes = Object.keys(bidRequest?.mediaTypes || {});
  return requestedTypes.length === 1 ? requestedTypes[0] as MediaType : undefined;
}

const converter = ortbConverter<typeof BIDDER_CODE>({
  context: { netRevenue: true, ttl: DEFAULT_TTL },
  imp(buildImp, bidRequest, context) {
    const imp = buildImp(bidRequest, context);
    imp.ext = imp.ext || {};
    imp.ext[BIDDER_CODE] = { placementId: bidRequest.params.placementId };
    return imp;
  },
  request(buildRequest, imps, bidderRequest, context) {
    const request = buildRequest(imps, bidderRequest, context);
    request.ext = request.ext || {};
    request.ext[BIDDER_CODE] = getRequestExt(context.bidRequests[0].params.publisherId, bidderRequest);
    return request;
  },
  bidResponse(buildBidResponse, bid, context) {
    const mediaType = getResponseMediaType(bid, context.bidRequest);
    const bidResponse = buildBidResponse(bid, mediaType ? { ...context, mediaType } : context);
    bidResponse.currency = bidResponse.currency || DEFAULT_CURRENCY;

    const ringierExt: RingierResponseExt | undefined = bid.ext?.[BIDDER_CODE];
    if (isNonEmptyString(ringierExt?.o)) {
      bidResponse.meta.demandSource = ringierExt.o;
    }
    if (isNonEmptyString(ringierExt?.t) && context.eventBase) {
      (bidResponse as RingierBid).ext = {
        [BIDDER_CODE]: { token: ringierExt.t, eventBase: context.eventBase as string }
      };
    }
    // Prebid.js core fires `burl` only for Prebid Server bids; client adapters hand it over as a billing tracker.
    // Like for Prebid Server bids, the URL is used as is: the Bidlayer resolves its macros with the original price.
    const burl = bid.burl;
    if (isNonEmptyString(burl)) {
      const trackers = bidResponse.eventtrackers || [];
      const known = trackers.some(({ event, method, url }) => event === EVENT_TYPE_IMPRESSION && method === TRACKER_METHOD_IMG && url === burl);
      if (!known) {
        bidResponse.eventtrackers = trackers.concat({ event: EVENT_TYPE_IMPRESSION, method: TRACKER_METHOD_IMG, url: burl });
      }
    }
    return bidResponse;
  },
});

function sendEvent(eventBase: string, params: Record<string, string | number | undefined>) {
  if (getRingierConfig().sendEvents !== true) return;
  const query = Object.entries(params)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  politeTriggerPixel(`${eventBase}${EVENT_PATH}?${query}`);
}

/** Win and render events of a bid, identified by the event token the Bidlayer issued for it. */
function fireBidEvent(bid: RingierBid, type: 'win' | 'render') {
  const info = bid?.ext?.[BIDDER_CODE];
  if (!info?.token || !info?.eventBase) return;
  sendEvent(info.eventBase, { t: info.token, type });
}

/**
 * Timeout and error events of a request, which have no event token: one event per publisher,
 * with the placements of its ad units.
 */
function fireRequestEvent(params: Partial<RingierBidParams>[], type: 'timeout' | 'error', details: Record<string, number | undefined>) {
  const placementsByPublisher = new Map<string, Set<string>>();
  params
    .filter(param => isNonEmptyString(param?.publisherId) && isNonEmptyString(param?.placementId))
    .forEach(({ publisherId, placementId }) => {
      placementsByPublisher.set(publisherId, (placementsByPublisher.get(publisherId) || new Set()).add(placementId));
    });
  const eventBase = new URL(getEndpoint()).origin;
  const { configVersion } = getRingierConfig();
  placementsByPublisher.forEach((placementIds, publisherId) => {
    sendEvent(eventBase, {
      type,
      pub: publisherId,
      pl: [...placementIds].join(','),
      cv: isNonEmptyString(configVersion) || isNumber(configVersion) ? configVersion : undefined,
      ...details,
    });
  });
}

// Prebid Server syncs the bidders configured for this account
let syncAccount: string | undefined;

function getImageSyncs(serverResponses): string[] {
  const urls: string[] = (serverResponses || []).flatMap(response => {
    const syncs = response?.body?.ext?.[BIDDER_CODE]?.syncs;
    return Array.isArray(syncs) ? syncs : [];
  })
    .filter(sync => sync?.type === 'image' && isNonEmptyString(sync.url) && sync.url.startsWith('https://'))
    .map(sync => sync.url);
  return [...new Set(urls)].slice(0, MAX_SYNC_COUNT);
}

export const spec: BidderSpec<typeof BIDDER_CODE> = {
  code: BIDDER_CODE,
  gvlid: GVLID,
  supportedMediaTypes: [BANNER, VIDEO, NATIVE],

  isBidRequestValid(bid) {
    const { publisherId, placementId } = bid?.params || ({} as RingierBidParams);
    if (isNonEmptyString(publisherId) && isNonEmptyString(placementId)) return true;
    logWarn(`${BIDDER_CODE}: publisherId and placementId must be non-empty strings`, bid?.params);
    return false;
  },

  buildRequests(validBidRequests, bidderRequest) {
    const url = getEndpoint();
    const eventBase = getRingierConfig().sendEvents === true ? new URL(url).origin : undefined;
    // One request per auction; ad units of a different publisher (a misconfiguration) get their own request.
    const byPublisher = new Map<string, RingierBidRequest[]>();
    validBidRequests.forEach(bidRequest => {
      const publisherId = bidRequest.params.publisherId;
      byPublisher.set(publisherId, (byPublisher.get(publisherId) || []).concat(bidRequest));
    });
    if (byPublisher.size > 1) {
      logWarn(`${BIDDER_CODE}: ad units use different publisherIds (${[...byPublisher.keys()].join(', ')}), sending one request per publisherId`);
    }
    syncAccount = [...byPublisher.keys()][0];
    return [...byPublisher.values()].map(bidRequests => ({
      method: 'POST' as const,
      url,
      data: converter.toORTB({ bidRequests, bidderRequest, context: { eventBase } }),
      options: {
        withCredentials: true,
        endpointCompression: true,
      },
    }));
  },

  interpretResponse(serverResponse, request: AdapterRequest) {
    if (!serverResponse?.body) return [];
    const response = converter.fromORTB({
      request: request.data as ORTBRequest,
      response: serverResponse.body,
    }) as ExtendedResponse;
    return response.bids || [];
  },

  getUserSyncs(syncOptions, serverResponses, gdprConsent, uspConsent, gppConsent) {
    if (!canSync(gdprConsent)) return [];
    const origin = new URL(getEndpoint()).origin;

    if (syncOptions.iframeEnabled) {
      const params: Record<string, string> = {
        endpoint: `${origin}${COOKIE_SYNC_PATH}`,
        max_sync_count: String(MAX_SYNC_COUNT),
      };
      if (isNonEmptyString(syncAccount)) {
        if (SYNC_ACCOUNT_PATTERN.test(syncAccount)) {
          params.args = `account:${syncAccount}`;
        } else {
          logWarn(`${BIDDER_CODE}: publisherId ${syncAccount} cannot be passed to the user sync, syncing without account`);
        }
      }
      if (typeof gdprConsent?.gdprApplies === 'boolean') {
        params.gdpr = gdprConsent.gdprApplies ? '1' : '0';
      }
      if (isNonEmptyString(gdprConsent?.consentString)) {
        params.gdpr_consent = gdprConsent.consentString;
      }
      if (isNonEmptyString(gppConsent?.gppString)) {
        params.gpp = gppConsent.gppString;
        if (gppConsent.applicableSections?.length) {
          params.gpp_sid = gppConsent.applicableSections.join(',');
        }
      }
      const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
      return [{ type: 'iframe', url: `${origin}${SYNC_IFRAME_PATH}?${query}` }];
    }

    if (syncOptions.pixelEnabled) {
      return getImageSyncs(serverResponses).map(url => ({ type: 'image' as const, url }));
    }
    return [];
  },

  onBidWon(bid) {
    fireBidEvent(bid, 'win');
  },

  onAdRenderSucceeded(bid) {
    fireBidEvent(bid, 'render');
  },

  onTimeout(timedOutBidRequests) {
    // Prebid.js hands over the ad unit's configured params of this bidder as a list here.
    const params = (timedOutBidRequests || []).flatMap(bidRequest => [].concat(bidRequest?.params || []));
    fireRequestEvent(params, 'timeout', { tmax: timedOutBidRequests?.[0]?.timeout });
  },

  onBidderError({ error, bidderRequest }) {
    const params = (bidderRequest?.bids || []).map(bidRequest => bidRequest?.params);
    fireRequestEvent(params, 'error', { status: error?.status ?? 0 });
  },
};

registerBidder(spec);
