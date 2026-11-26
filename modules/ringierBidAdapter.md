# Ringier Bidder Adapter

## Overview

```text
Module Name:  Ringier Bidder Adapter
Module Type:  Bidder Adapter
Maintainer:   tech-accounts@ringier.ch
GVL ID:       1436
```

## Description

Connects publishers to the Ringier Advertising Bidlayer, a server-side auction built on Prebid Server.
The adapter sends one OpenRTB 2.6 request per auction with all ad units of the publisher. Bidders, bidder
parameters and rules are configured on the server for each `publisherId` and `placementId`. If ad units on a
page use different `publisherId`s (a misconfiguration), the adapter logs a warning and sends one request per `publisherId`.

All bids are returned under the bidder code `ringier`. The demand source of a bid is only available as an
opaque identifier in `bid.meta.demandSource`. Deal IDs carry the demand source as a prefix
(`<demand source>:<deal ID>`), so line items for deals have to target this value.

Supported media types: **banner**, **video** and **native**. For ad units with several media types the Bidlayer bids
with one of them: banner, then video, then native, as far as the placement allows. For outstream video the publisher
provides the renderer.

## Bid Parameters

| Name          | Scope    | Type   | Description                                     | Example           |
|---------------|----------|--------|-------------------------------------------------|-------------------|
| `publisherId` | required | string | Publisher ID provided by Ringier Advertising.   | `'pub-123'`       |
| `placementId` | required | string | Placement ID provided by Ringier Advertising.   | `'example-top'`   |

Sizes, floors, consent, user IDs and first party data are taken from the ad unit and the Prebid.js configuration.

## Configuration

Optional settings via `pbjs.setConfig({ ringier: { ... } })` (or `setBidderConfig` for `ringier`):

| Name            | Type             | Description                                                                                                    |
|-----------------|------------------|----------------------------------------------------------------------------------------------------------------|
| `clientBidders` | string[]         | Bidders the publisher calls client-side on the page. The Bidlayer does not call them a second time server-side. |
| `configVersion` | string \| number | Version of the publisher setup the page was built with.                                                        |
| `pvId`          | string           | Page view ID of the publisher. Defaults to the page view ID that Prebid.js assigns to this bidder.             |
| `sendEvents`    | boolean          | `true` switches on the event pixels (see Disclosures). Default: `false`.                                       |
| `endpoint`      | string           | Overrides the auction endpoint for testing. Only https URLs on `ringier-advertising.ch` are accepted.           |

```javascript
pbjs.setConfig({
  ringier: {
    clientBidders: ['exampleBidder'],
    configVersion: '2026-11-05.1'
  }
});
```

## User Sync

With iframe syncs allowed, the adapter registers one iframe from the Bidlayer domain (`/static/load-cookie.html`).
It calls the Prebid Server `/cookie_sync` endpoint of the Bidlayer with the `publisherId` as account, and Prebid Server
syncs the bidders configured for this publisher. A `publisherId` made of digits only, or with characters other than
letters, digits, `.`, `_` and `-`, cannot be passed on; the sync then runs without account.
GDPR and GPP consent are passed on. With only image syncs allowed, the adapter registers the image syncs
listed in the auction response. When GDPR applies, no sync takes place without TCF purpose 1 consent; an unknown
GDPR scope counts as GDPR applying.

```javascript
pbjs.setConfig({
  userSync: {
    filterSettings: {
      iframe: { bidders: ['ringier'], filter: 'include' }
    }
  }
});
```

## Disclosures

- This bidder can record win, render, timeout and error events with a pixel call (keepalive request) to the
  Bidlayer domain. The events are off by default; a publisher switches them on with
  `setConfig({ ringier: { sendEvents: true } })`. Auctions work the same without them. The requests carry the
  cookies of the Bidlayer domain.
  - `onBidWon`, `onAdRenderSucceeded`: the event token of the bid (`/event?t=<token>&type=win|render`).
  - `onTimeout`, `onBidderError`: `publisherId`, the `placementId`s of the ad units, `configVersion` if set,
    and the auction timeout or the HTTP status (`/event?type=timeout|error&pub=…&pl=…&cv=…&tmax=…|status=…`).
- Billing URLs (`burl`) of the bids are handed to Prebid.js as impression trackers. Prebid.js fires them once when
  the bid wins, that is when the creative is rendered through Prebid.js (`pbjs.renderAd`) or the bid is marked as
  used (`pbjs.markWinningBidAsUsed`). They do not depend on `sendEvents`.
- For ad units with `deferBilling`, Prebid.js fires the billing URLs only on `pbjs.triggerBilling()`. This adapter
  has no `onBidBillable` handler, so Prebid.js also holds back rendering the creative until then: the publisher has
  to call `pbjs.triggerBilling()` for the ad to show.
- Requests are gzip-compressed (`endpointCompression`, where the browser supports it and outside debug mode) and
  sent with credentials.

## Build

```shell
gulp build --modules=ringierBidAdapter,consentManagementTcf,consentManagementGpp,userId,priceFloors
```

## Test Parameters

These parameters always return a bid with a static test creative from the Bidlayer.

The video ad unit is answered with VAST XML. As for every bidder that returns `vastXml`, Prebid.js accepts an
instream video bid only when a cache is configured, for example `pbjs.setConfig({ cache: { useLocal: true } })`
or a Prebid Cache URL.

```javascript
var adUnits = [
  {
    code: 'test-banner',
    mediaTypes: { banner: { sizes: [[300, 250], [300, 600]] } },
    bids: [{
      bidder: 'ringier',
      params: { publisherId: 'prebid-test', placementId: 'prebid-test-banner' }
    }]
  },
  {
    code: 'test-video',
    mediaTypes: {
      video: { context: 'instream', playerSize: [[640, 480]], mimes: ['video/mp4'], protocols: [2, 3, 5, 6], plcmt: 1, placement: 1 }
    },
    bids: [{
      bidder: 'ringier',
      params: { publisherId: 'prebid-test', placementId: 'prebid-test-video' }
    }]
  },
  {
    code: 'test-native',
    mediaTypes: {
      native: {
        ortb: {
          assets: [
            { id: 1, required: 1, title: { len: 80 } },
            { id: 2, required: 1, img: { type: 3, w: 300, h: 250 } }
          ]
        }
      }
    },
    bids: [{
      bidder: 'ringier',
      params: { publisherId: 'prebid-test', placementId: 'prebid-test-native' }
    }]
  }
];
```
