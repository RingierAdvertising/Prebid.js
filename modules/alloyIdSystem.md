## Alloy User ID Submodule

This module passes the visitor ID of [Alloy](https://www.ringier-advertising.ch/de/hauseigene-datenloesung-alloy/), the first-party data platform of Ringier Advertising, to bidders.

The module loads the Alloy SDK and asks it for the ID. If the SDK is on the page already, it uses that one and loads nothing. Combine it with the [Alloy RTD provider](alloyRtdProvider.md) to also pass Alloy's contextual and audience segments.

Maintainer: tech-accounts@ringier.ch

## Building Prebid.js with Alloy User ID Submodule

To build Prebid.js with the `alloyIdSystem` module included:

```
gulp build --modules=userId,alloyIdSystem
```

### Prebid Configuration

You can configure this submodule in your `userSync.userIds[]` configuration:

```javascript
pbjs.setConfig({
    userSync: {
        auctionDelay: 300,
        userIds: [{
            name: 'alloyId',
            params: {
                sdk: {
                    appId: 'examplech_de_web' // provided by Ringier Advertising
                }
            },
            bidders: ['ringier']
        }]
    }
});
```

`auctionDelay` gives the Alloy SDK time to load and answer before the first auction starts. Without it, or when the SDK needs longer, the first auction starts without the ID.

`bidders` limits the ID to the bidders you name. Without it, every bidder gets it.

Do not configure `storage`: the Alloy SDK keeps the ID itself. The module asks the SDK on every page view and on every `refreshUserIds()`, and Prebid.js stores nothing for it, even if `storage` is set.

The Alloy SDK is the source of truth. While the module waits for it, and when it provides no ID (no consent, an error, or no answer within `params.sdkTimeout`), an ID from an earlier request is no longer passed to bidders.

The module does not set a publisher provided ID (PPID) for your ad server.

### Parameters

| Param under userSync.userIds[] | Scope | Type | Description | Example |
| --- | --- | --- | --- | --- |
| name | Required | String | ID of the module - `"alloyId"` | `"alloyId"` |
| params | Required | Object | Container of all module params. | |
| params.sdk | Required | Object | How to configure and load the Alloy SDK, see below. | |
| params.timeout | Optional | Number | Milliseconds the Alloy SDK may take to resolve the visitor ID. Defaults to `300`. | `500` |
| params.sdkTimeout | Optional | Number | Milliseconds to wait for the Alloy SDK to load and answer. After that the module provides no ID for this request; a later `refreshUserIds()` asks again. Defaults to `1000`. | `1500` |

### Alloy SDK parameters

`params.sdk` is the same for this module and the Alloy RTD provider. If you use both, give both the same object. The SDK is configured and loaded once, by whichever module runs first.

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

### External script

**This module loads external JavaScript: the Alloy SDK, about 137 KB (33 KB compressed), from `cdn.alloy.ch`.** By default it loads the current 2.x release; set `params.sdk.scriptUrl` to pin a version or to load it from elsewhere.

You can deny the script with the `loadExternalScript` [activity control](https://docs.prebid.org/dev-docs/activity-controls.html); the module then provides no ID unless the SDK is on the page. If the script fails to load, the module does not try again on that page view.

### Consent

The module needs the [TCF consent management module](https://docs.prebid.org/dev-docs/modules/consentManagementTcf.html). It only loads and asks the Alloy SDK when the CMP has answered and, if GDPR applies, the user has given consent for purpose 1 and for Ringier AG (GVL ID 1436). Without TCF consent data, for example when the CMP timed out, it does nothing.

It checks this itself, so it holds in builds without the `tcfControl` module as well. The Alloy SDK checks consent on its own, too.

### Example of the provided eid

```javascript
{
    source: 'alloy.ch',
    uids: [{
        id: 'some-random-id-value',
        atype: 1
    }]
}
```
