# Overview

```
Module Name: Alloy RTD Provider
Module Type: RTD Provider
Maintainer: tech-accounts@ringier.ch
```

# Description

This module passes data of [Alloy](https://www.ringier-advertising.ch/de/hauseigene-datenloesung-alloy/), the first-party data platform of Ringier Advertising, to the bidders you name:

- the contextual segments of the current page,
- the audience segments of the user.

It also tracks a page view in Alloy, once per URL.

The module loads the Alloy SDK. If the SDK is on the page already, it uses that one and loads nothing. Combine it with the [Alloy User ID submodule](alloyIdSystem.md) to also pass the Alloy ID.

The module does not set ad server targeting.

# Building Prebid.js with the Alloy RTD provider

```
gulp build --modules=rtdModule,alloyRtdProvider
```

# Configuration

```javascript
pbjs.setConfig({
    realTimeData: {
        auctionDelay: 300,
        dataProviders: [{
            name: 'alloy',
            waitForIt: true,
            params: {
                sdk: {
                    appId: 'examplech_de_web' // provided by Ringier Advertising
                }
            }
        }]
    }
});
```

`auctionDelay` and `waitForIt` give the Alloy SDK time to load and answer before the auction starts. When it needs longer, the auction starts without the Alloy data.

## Parameters

| Name | Scope | Type | Description | Default |
| --- | --- | --- | --- | --- |
| name | Required | String | Name of the module - `"alloy"` | |
| waitForIt | Optional | Boolean | Delay the auction for this module, up to `auctionDelay`. Recommended. | `false` |
| params | Required | Object | Container of all module params. | |
| params.sdk | Required | Object | How to configure and load the Alloy SDK, see below. | |
| params.bidders | Optional | Array of strings | Bidders that get the Alloy data. No other bidder gets it. | `['ringier']` |
| params.timeout | Optional | Number | Milliseconds to wait for the Alloy SDK to load and answer. | `1000` |
| params.audiences | Optional | Boolean | Fetch the audience segments of the user. | `true` |
| params.trackPageViews | Optional | Boolean | Track a page view once per URL. Ignored if the SDK tracks page views itself (`pageViewAutoTracking`). Set it to `false` if something else on the page tracks Alloy page views. | `true` |
| params.logicalPath | Optional | String | Logical path of the page for the page view, for example `examplech_de_web/desktop/sport`. Without it the SDK uses `window.alloyDataLayer.context.logicalPath`, then the app ID. | |
| params.contentId | Optional | String or number | ID of the article in the CMS. | `window.alloyDataLayer.context.contentId` |

On a single-page app, update `params.logicalPath` and `params.contentId` (or `window.alloyDataLayer.context`) before the first auction of each page. The module tracks a new page view when the URL has changed.

## Alloy SDK parameters

`params.sdk` is the same for this module and the Alloy User ID submodule. If you use both, give both the same object. The SDK is configured and loaded once, by whichever module runs first.

| Param under params.sdk | Scope | Type | Description | Default |
| --- | --- | --- | --- | --- |
| appId | Required | String | ID of the site in Alloy, provided by Ringier Advertising. | |
| tenant | Optional | String | Alloy tenant. | `"riad"` |
| env | Optional | String | Alloy environment: `"prod"`, `"stg"` or `"dev"`. | `"prod"` |
| scriptUrl | Optional | String | URL of the Alloy SDK. | `"https://cdn.alloy.ch/client-sdk/2.x.x/alloy-sdk.umd.js"` |
| consentCookieName | Optional | String | Name of the cookie holding the TCF consent string. | `"eupubconsent-v2"` |
| autoStart | Optional | Boolean | Start the SDK as soon as it has loaded. If `false`, the page calls `alloySDK.start()`. | `true` |
| tracking | Optional | Boolean | Track events. | `true` |
| adTracking | Optional | Boolean | Track ad events. | `true` |
| pageViewAutoTracking | Optional | Boolean | Let the SDK track page views on its own. | `false` |
| dataLayerAutoTracking | Optional | Boolean | Let the SDK track `window.dataLayer` events. | `false` |
| visitorReadOnly | Optional | Boolean | Only read the visitor ID, never create one. | `false` |
| skipEventsTracking | Optional | Boolean | Skip event tracking. | `false` |
| ssoId | Optional | String | ID of the logged-in user. | |
| externalIds | Optional | Object | Other IDs of the user, by name, for Alloy to match on. | |
| load | Optional | Boolean | Set to `false` if the page loads the Alloy SDK itself. The module then only uses that SDK. | `true` |

The module leaves an Alloy SDK alone that is on the page already or that something else has started: it does not configure or load it a second time.

# Output

The module adds the data to the first-party data of each bidder in `params.bidders`, and of no other bidder:

```javascript
{
    site: {
        content: {
            data: [
                { name: 'alloy_iab', segment: [{ id: '0oujx' }] },
                { name: 'alloy_topics', segment: [{ id: '3kd9a' }] },
                { name: 'alloy_ctx_ready', segment: [{ id: '1' }] }
            ]
        }
    },
    user: {
        data: [
            { name: 'alloy_audiences', segment: [{ id: '8fj2k' }] }
        ]
    }
}
```

Each entry is named by the key-value key it stands for: the `ringier` bidder turns the entries into the key-values `alloy_iab`, `alloy_topics`, `alloy_ctx_ready` and `alloy_audiences` on its side. The segment IDs are Alloy's own. A list without segments is left out. `alloy_ctx_ready` is `1` when Alloy knows the page itself, and `0` when it only knows its section or did not answer.

# External script

**This module loads external JavaScript: the Alloy SDK, about 137 KB (33 KB compressed), from `cdn.alloy.ch`.** By default it loads the current 2.x release; set `params.sdk.scriptUrl` to pin a version or to load it from elsewhere.

You can deny the script with the `loadExternalScript` [activity control](https://docs.prebid.org/dev-docs/activity-controls.html); the module then provides no data unless the SDK is on the page. If the script fails to load, the module does not try again on that page view.

# Consent

The module needs the [TCF consent management module](https://docs.prebid.org/dev-docs/modules/consentManagementTcf.html). It only loads and asks the Alloy SDK when the CMP has answered and, if GDPR applies, the user has given consent for purpose 1 and for Ringier AG (GVL ID 1436). Without TCF consent data, for example when the CMP timed out, it does nothing.

It checks this itself, so it holds in builds without the `tcfControl` module as well. The Alloy SDK checks consent on its own, too.
