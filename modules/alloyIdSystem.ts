/**
 * This module adds the Alloy ID to the User ID module.
 * The {@link module:modules/userId} module is required.
 * @module modules/alloyIdSystem
 * @requires module:modules/userId
 */

import { submodule } from '../src/hook.js';
import { MODULE_TYPE_UID } from '../src/activities/modules.js';
import {
  ALLOY_GVLID,
  ALLOY_SOURCE,
  callAlloySdk,
  hasAlloyConsent,
  loadAlloySdk
} from '../libraries/alloyUtils/sdk.ts';

import type { AlloySdkParams } from '../libraries/alloyUtils/sdk.ts';
import type { IdProviderSpec } from './userId/spec.ts';

const MODULE_NAME = 'alloyId' as const;

// passed to the SDK: how long it may take to resolve the visitor ID
const DEFAULT_TIMEOUT = 300;
// how long this module waits for the SDK to load and answer
const DEFAULT_SDK_TIMEOUT = 1000;

export type AlloyIdParams = {
  /**
   * How to configure and load the Alloy SDK.
   */
  sdk?: AlloySdkParams;
  /**
   * Milliseconds the Alloy SDK may take to resolve the visitor ID. Defaults to 300.
   */
  timeout?: number;
  /**
   * Milliseconds to wait for the Alloy SDK to load and answer. Defaults to 1000.
   */
  sdkTimeout?: number;
};

declare module './userId/spec' {
  interface UserId {
    alloyId: string;
  }
  interface ProvidersToId {
    alloyId: 'alloyId';
  }
  interface ProviderParams {
    alloyId: AlloyIdParams;
  }
}

type AlloyIdSpec = IdProviderSpec<typeof MODULE_NAME>;

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The Alloy SDK is the source of truth for the ID, so every call asks it again.
 */
const getId: AlloyIdSpec['getId'] = (config, consentData, _storedId, handle) => {
  // The User ID module would otherwise store the ID and, on a later call without one (the user withdrew
  // consent, say), keep the one it has. Managed, it stores nothing, drops the current ID right away
  // and takes only what the callback reports.
  handle.manage();

  if (!hasAlloyConsent(consentData)) {
    return undefined;
  }

  const timeout = positiveNumber(config?.params?.timeout, DEFAULT_TIMEOUT);
  const sdkTimeout = positiveNumber(config?.params?.sdkTimeout, DEFAULT_SDK_TIMEOUT);

  // here and not in the callback, which may only run after the first auction
  loadAlloySdk(config?.params?.sdk, MODULE_TYPE_UID, MODULE_NAME);

  return {
    callback(setId) {
      callAlloySdk(
        (sdk) => sdk.identity.getVisitorID({ timeout }),
        sdkTimeout,
        (id) => setId(isValidId(id) ? id : undefined)
      );
    }
  };
};

export const alloyIdSubmodule: AlloyIdSpec = {
  name: MODULE_NAME,
  gvlid: ALLOY_GVLID,
  decode(value) {
    return isValidId(value) ? { [MODULE_NAME]: value } : undefined;
  },
  getId,
  // called instead of getId when a configured storage holds an ID: ask the SDK then, too
  extendId: getId,
  eids: {
    // the function form, to send atype as a number
    [MODULE_NAME]: (ids) => ({
      source: ALLOY_SOURCE,
      uids: ids.map((id) => ({ id, atype: 1 }))
    })
  }
};

submodule('userId', alloyIdSubmodule);
