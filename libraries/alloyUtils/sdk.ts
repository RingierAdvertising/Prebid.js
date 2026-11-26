/**
 * Shared by the Alloy User ID and RTD submodules: starts the Alloy SDK the way the Ringier Advertising
 * tag manager does, and runs commands against it.
 */

import { loadExternalScript } from '../../src/adloader.js';
import { logError, logInfo } from '../../src/utils.js';
import type { ModuleType } from '../../src/activities/modules.ts';
import type { AllConsentData } from '../../src/consentHandler.ts';

/** Ringier AG in the IAB Global Vendor List */
export const ALLOY_GVLID = 1436;
/** `source` of the Alloy eid and `name` of the Alloy segment data */
export const ALLOY_SOURCE = 'alloy.ch';

const LOG_PREFIX = 'Alloy: ';
const DEFAULT_SCRIPT_URL = 'https://cdn.alloy.ch/client-sdk/2.x.x/alloy-sdk.umd.js';
const DEFAULT_TENANT = 'riad';
const DEFAULT_ENV = 'prod';
const DEFAULT_CONSENT_COOKIE_NAME = 'eupubconsent-v2';
const WEEK = 7 * 24 * 60 * 60 * 1000;

export type AlloySdkParams = {
  /**
   * ID of the site in Alloy, for example `examplech_de_web`. Required to load the SDK.
   */
  appId?: string;
  /**
   * Alloy tenant. Defaults to `riad`.
   */
  tenant?: string;
  /**
   * Alloy environment: `prod`, `stg` or `dev`. Defaults to `prod`.
   */
  env?: string;
  /**
   * URL of the SDK. Defaults to the current 2.x release on the Alloy CDN.
   */
  scriptUrl?: string;
  /**
   * Name of the cookie holding the TCF consent string. Defaults to `eupubconsent-v2`.
   */
  consentCookieName?: string;
  /**
   * Start the SDK as soon as it has loaded. Defaults to true; if false, the page calls `alloySDK.start()`.
   */
  autoStart?: boolean;
  /**
   * Track events. Defaults to true.
   */
  tracking?: boolean;
  /**
   * Track ad events. Defaults to true.
   */
  adTracking?: boolean;
  /**
   * Let the SDK track page views on its own. Defaults to false.
   */
  pageViewAutoTracking?: boolean;
  /**
   * Let the SDK track `window.dataLayer` events. Defaults to false.
   */
  dataLayerAutoTracking?: boolean;
  /**
   * Only read the visitor ID, never create one. Defaults to false.
   */
  visitorReadOnly?: boolean;
  /**
   * Skip event tracking. Defaults to false.
   */
  skipEventsTracking?: boolean;
  /**
   * ID of the logged-in user.
   */
  ssoId?: string;
  /**
   * Other IDs of the user, by name, for Alloy to match on.
   */
  externalIds?: Record<string, string>;
  /**
   * Set to false if the page loads the Alloy SDK itself. Defaults to true.
   */
  load?: boolean;
};

/**
 * `window.alloySDK` is a command queue: a plain array until the Alloy SDK has loaded, then the SDK
 * itself, which runs the commands queued so far and every later one right away.
 */
export type AlloySdk = {
  push: (command: () => void) => unknown;
  identity?: {
    getVisitorID: (options?: { timeout?: number }) => Promise<unknown>;
  };
  contextual?: {
    getContextData: (url: string, contentId?: string | number) => Promise<unknown>;
  };
  audienceSegment?: {
    getAudienceSegmentData: () => Promise<unknown>;
  };
  tracking?: {
    trackPageViewEvent: (pageView: { logicalPath?: string; contentId?: string | number }) => void;
  };
};

export type AlloyWindow = Window & {
  alloySDK?: AlloySdk;
  alloyDataLayer?: {
    context?: { logicalPath?: string; contentId?: unknown };
    user?: { sso?: { id?: string }; externalIds?: Record<string, string> } & Record<string, unknown>;
  } & Record<string, unknown>;
  ringDataLayer?: { user?: { sso?: { logged?: { id?: string } } } };
  _alloytenant?: string;
  _alloyenv?: string;
  _alloyappid?: string;
  _alloyconsentcookiename?: string;
  _alloyautostart?: boolean;
  _alloytracking?: boolean;
  _alloyadtracking?: boolean;
  _alloypageviewautotracking?: boolean;
  _datalayerautotracking?: boolean;
  _alloyvisitorreadonly?: boolean;
  _alloyskipeventstracking?: boolean;
};

export function alloyWindow(): AlloyWindow {
  return window as AlloyWindow;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isLoaded(sdk: unknown): boolean {
  return sdk != null && !Array.isArray(sdk);
}

function stringOr(value: unknown, fallback: string): string {
  return isNonEmptyString(value) ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * No request may go to Alloy without consent, so this takes TCF consent data: without the TCF consent
 * management module, or when the CMP did not answer, nothing is known and nothing is allowed. When
 * GDPR applies, the user must have consented to purpose 1 and to the vendor. Prebid's TCF control
 * enforces the same, but only in builds that include it.
 */
export function hasAlloyConsent(consent?: Partial<AllConsentData> | null): boolean {
  const gdpr = consent?.gdpr;
  const vendorData = gdpr?.vendorData as any;

  // not there when the CMP timed out: gdprApplies is then just the configured default
  if (vendorData == null) {
    return false;
  }

  if (gdpr.gdprApplies === false) {
    return true;
  }

  return vendorData.purpose?.consents?.[1] === true && vendorData.vendor?.consents?.[ALLOY_GVLID] === true;
}

/**
 * Configures and loads the Alloy SDK, unless it is on the page already or something else (the Ringier
 * Advertising tag manager, the page, an earlier call) has started it.
 */
export function loadAlloySdk(params: AlloySdkParams | undefined, moduleType: ModuleType, moduleName: string): void {
  const win = alloyWindow();

  if (isLoaded(win.alloySDK) || win._alloyappid !== undefined || params?.load === false) {
    return;
  }

  if (!isNonEmptyString(params?.appId)) {
    logError(LOG_PREFIX + 'params.sdk.appId is required to load the Alloy SDK');

    return;
  }

  const scriptUrl = stringOr(params.scriptUrl, DEFAULT_SCRIPT_URL);
  // a floating version is cached for at most a week
  const cacheBuster = scriptUrl.includes('.x.x') ? `?ts=${Math.floor(Date.now() / WEEK) * WEEK}` : '';

  // The script runs later, so the SDK finds what is set below. Requested first, as the publisher may
  // deny this module external scripts: nothing is configured then, and another module may still load it.
  if (!loadExternalScript(scriptUrl + cacheBuster, moduleType, moduleName, undefined, document, { type: 'module' })) {
    return;
  }

  const externalIds = Object.fromEntries(
    Object.entries({ ...win.alloyDataLayer?.user?.externalIds, ...params.externalIds })
      .filter(([, id]) => isNonEmptyString(id))
  );

  win.alloyDataLayer = {
    ...win.alloyDataLayer,
    user: {
      ...win.alloyDataLayer?.user,
      sso: { id: isNonEmptyString(params.ssoId) ? params.ssoId : win.ringDataLayer?.user?.sso?.logged?.id },
      ...(Object.keys(externalIds).length > 0 && { externalIds })
    }
  };

  win.alloySDK = win.alloySDK || ([] as unknown as AlloySdk);
  win._alloyappid = params.appId;
  win._alloytenant = stringOr(params.tenant, DEFAULT_TENANT);
  win._alloyenv = stringOr(params.env, DEFAULT_ENV);
  win._alloyconsentcookiename = stringOr(params.consentCookieName, DEFAULT_CONSENT_COOKIE_NAME);
  win._alloyautostart = booleanOr(params.autoStart, true);
  win._alloytracking = booleanOr(params.tracking, true);
  win._alloyadtracking = booleanOr(params.adTracking, true);
  win._alloypageviewautotracking = booleanOr(params.pageViewAutoTracking, false);
  win._datalayerautotracking = booleanOr(params.dataLayerAutoTracking, false);
  win._alloyvisitorreadonly = booleanOr(params.visitorReadOnly, false);
  win._alloyskipeventstracking = booleanOr(params.skipEventsTracking, false);
}

/**
 * Runs `command` against the Alloy SDK once it has loaded, however long that takes. For calls nothing
 * waits for, such as tracking.
 */
export function queueAlloyCommand(command: (sdk: AlloySdk) => void): void {
  const win = alloyWindow();

  try {
    win.alloySDK = win.alloySDK || ([] as unknown as AlloySdk);
    win.alloySDK.push(() => {
      try {
        // read the SDK here: once loaded, it replaces the queue this command was pushed to
        command(win.alloySDK);
      } catch (e) {
        logInfo(LOG_PREFIX + 'the SDK call failed', e);
      }
    });
  } catch (e) {
    logInfo(LOG_PREFIX + 'the SDK call failed', e);
  }
}

/**
 * Runs `command` against the Alloy SDK once it has loaded, and reports its result exactly once:
 * `undefined` if the command fails or the SDK does not answer within `timeout` milliseconds.
 */
export function callAlloySdk<T>(
  command: (sdk: AlloySdk) => T | Promise<T>,
  timeout: number,
  done: (result?: T) => void
): void {
  const win = alloyWindow();
  let settled = false;

  // only the first outcome counts: the result, a failure or the timeout
  const finish = (result?: T) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);
    done(result);
  };

  const fail = (e: unknown) => {
    logInfo(LOG_PREFIX + 'the SDK call failed', e);
    finish();
  };

  const timer = setTimeout(() => {
    logInfo(LOG_PREFIX + 'no answer from the SDK, timeout');
    finish();
  }, timeout);

  try {
    win.alloySDK = win.alloySDK || ([] as unknown as AlloySdk);
    win.alloySDK.push(() => {
      if (settled) {
        return;
      }

      try {
        // read the SDK here: once loaded, it replaces the queue this command was pushed to
        const result = command(win.alloySDK);

        if (typeof (result as Promise<T>)?.then === 'function') {
          (result as Promise<T>).then(finish, fail);
        } else {
          finish(result as T);
        }
      } catch (e) {
        fail(e);
      }
    });
  } catch (e) {
    fail(e);
  }
}
