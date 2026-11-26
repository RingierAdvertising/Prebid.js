import { expect } from 'chai';
import sinon from 'sinon';
import { spec, ENDPOINT, getEndpoint } from 'modules/ringierBidAdapter.js';
import { newBidder } from 'src/adapters/bidderFactory.js';
import { config } from 'src/config.js';
import * as utils from 'src/utils.js';
import { BANNER, NATIVE, VIDEO } from 'src/mediaTypes.js';
import { EVENT_TYPE_IMPRESSION, TRACKER_METHOD_IMG } from 'src/eventTrackers.js';
import 'modules/priceFloors.js';

const BIDDER_CODE = 'ringier';
const OVERRIDE_ENDPOINT = 'https://other.ringier-advertising.ch/openrtb2/auction';

function makeBidRequest(overrides = {}) {
  return {
    bidder: BIDDER_CODE,
    params: { publisherId: 'pub-1', placementId: 'example-top' },
    adUnitCode: 'div-top',
    bidId: 'bid-1',
    bidderRequestId: 'bidder-request-1',
    auctionId: 'auction-1',
    mediaTypes: { banner: { sizes: [[300, 250], [300, 600]], pos: 1 } },
    ortb2Imp: { ext: { gpid: '/123/example/top', tid: 'tid-1' } },
    ...overrides,
  };
}

function makeBidderRequest(bids, overrides = {}) {
  return {
    bidderCode: BIDDER_CODE,
    bidderRequestId: 'bidder-request-1',
    auctionId: 'auction-1',
    pageViewId: 'prebid-pv-1',
    timeout: 1000,
    bids,
    refererInfo: { page: 'https://www.example.com/news', domain: 'www.example.com' },
    ortb2: {
      site: { page: 'https://www.example.com/news', domain: 'www.example.com' },
      device: { sua: { source: 2, platform: { brand: 'macOS' } } },
      regs: { ext: { gdpr: 1, dsa: { dsarequired: 1 } }, gpp: 'DBABMA~gpp', gpp_sid: [2] },
      user: {
        ext: {
          consent: 'CONSENT_STRING',
          eids: [{ source: 'id5-sync.com', uids: [{ id: 'id5-id', atype: 1 }] }],
        },
      },
      source: { ext: { schain: { ver: '1.0', complete: 1, nodes: [{ asi: 'ringier.ch', sid: '1', hp: 1 }] } } },
    },
    ...overrides,
  };
}

function buildSingleRequest(bids = [makeBidRequest()], bidderRequestOverrides = {}) {
  const requests = spec.buildRequests(bids, makeBidderRequest(bids, bidderRequestOverrides));
  expect(requests).to.have.lengthOf(1);
  return requests[0];
}

function makeOrtbBid(overrides = {}) {
  return {
    id: 'seat-bid-1',
    impid: 'bid-1',
    price: 2.5,
    adm: '<div>ad</div>',
    w: 300,
    h: 250,
    crid: 'creative-1',
    adomain: ['advertiser.example'],
    mtype: 1,
    ext: { ringier: { o: 'opaque-origin-1', t: 'event-token-1' } },
    ...overrides,
  };
}

function makeServerResponse(request, bids = [makeOrtbBid()], overrides = {}) {
  return {
    body: {
      id: request.data.id,
      cur: 'CHF',
      seatbid: [{ seat: BIDDER_CODE, bid: bids }],
      ...overrides,
    },
  };
}

describe('ringierBidAdapter', function () {
  let sandbox;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
  });

  afterEach(function () {
    sandbox.restore();
    config.resetConfig();
  });

  describe('spec', function () {
    it('registers the ringier bidder with its GVL ID and media types', function () {
      expect(spec.code).to.equal(BIDDER_CODE);
      expect(spec.gvlid).to.equal(1436);
      expect(spec.supportedMediaTypes).to.deep.equal([BANNER, VIDEO, NATIVE]);
      expect(newBidder(spec).callBids).to.be.a('function');
    });
  });

  describe('isBidRequestValid', function () {
    it('accepts a bid with publisherId and placementId', function () {
      expect(spec.isBidRequestValid(makeBidRequest())).to.equal(true);
    });

    [
      ['publisherId is missing', { placementId: 'p' }],
      ['placementId is missing', { publisherId: 'pub' }],
      ['publisherId is empty', { publisherId: '', placementId: 'p' }],
      ['placementId is empty', { publisherId: 'pub', placementId: '' }],
      ['publisherId is a number', { publisherId: 1, placementId: 'p' }],
      ['placementId is a number', { publisherId: 'pub', placementId: 2 }],
    ].forEach(([description, params]) => {
      it(`rejects a bid when ${description}`, function () {
        expect(spec.isBidRequestValid(makeBidRequest({ params }))).to.equal(false);
      });
    });

    it('rejects a bid without params', function () {
      expect(spec.isBidRequestValid(makeBidRequest({ params: undefined }))).to.equal(false);
    });
  });

  describe('buildRequests', function () {
    it('sends all ad units of the auction in one compressed POST', function () {
      const bids = [
        makeBidRequest(),
        makeBidRequest({ bidId: 'bid-2', adUnitCode: 'div-rect', params: { publisherId: 'pub-1', placementId: 'example-rect' } }),
      ];
      const request = buildSingleRequest(bids);

      expect(request.method).to.equal('POST');
      expect(request.url).to.equal(ENDPOINT);
      expect(request.options).to.deep.equal({ withCredentials: true, endpointCompression: true });
      expect(request.data.imp.map(imp => imp.id)).to.deep.equal(['bid-1', 'bid-2']);
      expect(request.data.imp.map(imp => imp.ext.ringier.placementId)).to.deep.equal(['example-top', 'example-rect']);
    });

    it('sends the publisherId and the page view ID in ext.ringier', function () {
      const request = buildSingleRequest();
      expect(request.data.ext.ringier).to.deep.equal({ publisherId: 'pub-1', pvId: 'prebid-pv-1' });
    });

    it('adds configVersion, clientBidders and pvId from setConfig', function () {
      config.setConfig({
        ringier: { configVersion: 'v42', clientBidders: ['bidderA', 'bidderB', 7, ''], pvId: 'pv-1' },
      });
      const request = buildSingleRequest();
      expect(request.data.ext.ringier).to.deep.equal({
        publisherId: 'pub-1',
        configVersion: 'v42',
        clientBidders: ['bidderA', 'bidderB'],
        pvId: 'pv-1',
      });
    });

    it('sends an empty clientBidders list, which tells the Bidlayer that no bidder runs client-side', function () {
      config.setConfig({ ringier: { clientBidders: [] } });
      const request = buildSingleRequest();
      expect(request.data.ext.ringier.clientBidders).to.deep.equal([]);
    });

    it('sends a numeric configVersion as a string, the only form the Bidlayer reads', function () {
      config.setConfig({ ringier: { configVersion: 17 } });
      const request = buildSingleRequest();
      expect(request.data.ext.ringier.configVersion).to.equal('17');
    });

    it('ignores invalid config values', function () {
      config.setConfig({ ringier: { configVersion: { v: 1 }, clientBidders: 'bidderA', pvId: 5 } });
      const request = buildSingleRequest([makeBidRequest()], { pageViewId: undefined });
      expect(request.data.ext.ringier).to.deep.equal({ publisherId: 'pub-1' });
    });

    it('reads bidder-specific config', function () {
      config.setBidderConfig({ bidders: [BIDDER_CODE], config: { ringier: { configVersion: 'bidder-v1' } } });
      const request = config.runWithBidder(BIDDER_CODE, () => buildSingleRequest());
      expect(request.data.ext.ringier.configVersion).to.equal('bidder-v1');
    });

    it('splits ad units of different publishers into separate requests', function () {
      const logWarn = sandbox.stub(utils, 'logWarn');
      const bids = [
        makeBidRequest(),
        makeBidRequest({ bidId: 'bid-2', params: { publisherId: 'pub-2', placementId: 'other' } }),
      ];
      const requests = spec.buildRequests(bids, makeBidderRequest(bids));
      expect(requests).to.have.lengthOf(2);
      expect(requests.map(r => r.data.ext.ringier.publisherId)).to.deep.equal(['pub-1', 'pub-2']);
      expect(requests.map(r => r.data.imp.map(imp => imp.id))).to.deep.equal([['bid-1'], ['bid-2']]);
      expect(logWarn.calledOnce).to.equal(true);
    });

    it('passes consent, eids, schain, DSA and first party data through', function () {
      const { data } = buildSingleRequest();
      expect(data.regs.ext.gdpr).to.equal(1);
      expect(data.regs.ext.dsa).to.deep.equal({ dsarequired: 1 });
      expect(data.regs.gpp).to.equal('DBABMA~gpp');
      expect(data.regs.gpp_sid).to.deep.equal([2]);
      expect(data.user.ext.consent).to.equal('CONSENT_STRING');
      expect(data.user.ext.eids).to.deep.equal([{ source: 'id5-sync.com', uids: [{ id: 'id5-id', atype: 1 }] }]);
      expect(data.source.ext.schain.nodes[0].asi).to.equal('ringier.ch');
      expect(data.site.page).to.equal('https://www.example.com/news');
      expect(data.device.sua.platform.brand).to.equal('macOS');
      expect(data.tmax).to.equal(1000);
    });

    it('passes the blocking fields of the request and the imp through', function () {
      const bid = makeBidRequest({ ortb2Imp: { banner: { battr: [1, 3] } } });
      const bidderRequest = makeBidderRequest([bid]);
      Object.assign(bidderRequest.ortb2, { bcat: ['IAB25'], badv: ['blocked.example'], bapp: ['com.blocked.app'] });
      const [{ data }] = spec.buildRequests([bid], bidderRequest);
      expect(data.bcat).to.deep.equal(['IAB25']);
      expect(data.badv).to.deep.equal(['blocked.example']);
      expect(data.bapp).to.deep.equal(['com.blocked.app']);
      expect(data.imp[0].banner.battr).to.deep.equal([1, 3]);
    });

    it('sends slot sizes, position and gpid', function () {
      const imp = buildSingleRequest().data.imp[0];
      expect(imp.banner.format).to.deep.equal([{ w: 300, h: 250 }, { w: 300, h: 600 }]);
      expect(imp.banner.pos).to.equal(1);
      expect(imp.ext.gpid).to.equal('/123/example/top');
    });

    it('sends floors from the price floors module', function () {
      const bid = makeBidRequest({ getFloor: () => ({ currency: 'CHF', floor: 1.5 }) });
      const imp = buildSingleRequest([bid]).data.imp[0];
      expect(imp.bidfloor).to.equal(1.5);
      expect(imp.bidfloorcur).to.equal('CHF');
    });

    if (FEATURES.VIDEO) {
      it('builds a video imp', function () {
        const bid = makeBidRequest({
          mediaTypes: { video: { context: 'instream', playerSize: [[640, 480]], mimes: ['video/mp4'], protocols: [2, 3], plcmt: 1, placement: 1 } },
        });
        const imp = buildSingleRequest([bid]).data.imp[0];
        expect(imp.video).to.include({ w: 640, h: 480, plcmt: 1, placement: 1 });
        expect(imp.video.mimes).to.deep.equal(['video/mp4']);
        expect(imp.banner).to.equal(undefined);
      });
    }

    if (FEATURES.VIDEO && FEATURES.NATIVE) {
      it('sends every media type of a multiformat ad unit in one imp', function () {
        const bid = makeBidRequest({
          mediaTypes: {
            banner: { sizes: [[300, 250]] },
            video: { context: 'outstream', playerSize: [[640, 480]], mimes: ['video/mp4'] },
            native: { ortb: { ver: '1.2', assets: [{ id: 1, required: 1, title: { len: 80 } }] } },
          },
          nativeOrtbRequest: { ver: '1.2', assets: [{ id: 1, required: 1, title: { len: 80 } }] },
        });
        const requests = spec.buildRequests([bid], makeBidderRequest([bid]));
        expect(requests).to.have.lengthOf(1);
        const imp = requests[0].data.imp[0];
        expect(imp.banner.format).to.deep.equal([{ w: 300, h: 250 }]);
        expect(imp.video.mimes).to.deep.equal(['video/mp4']);
        expect(JSON.parse(imp.native.request).assets).to.have.lengthOf(1);
      });
    }

    if (FEATURES.NATIVE) {
      it('builds a native imp', function () {
        const bid = makeBidRequest({
          mediaTypes: { native: { ortb: { ver: '1.2', assets: [{ id: 1, required: 1, title: { len: 80 } }] } } },
          nativeOrtbRequest: { ver: '1.2', assets: [{ id: 1, required: 1, title: { len: 80 } }] },
        });
        const imp = buildSingleRequest([bid]).data.imp[0];
        expect(JSON.parse(imp.native.request).assets).to.deep.equal([{ id: 1, required: 1, title: { len: 80 } }]);
      });
    }

    describe('endpoint override', function () {
      it('uses an https endpoint on the Bidlayer domain', function () {
        config.setConfig({ ringier: { endpoint: OVERRIDE_ENDPOINT, sendEvents: true } });
        expect(buildSingleRequest().url).to.equal(OVERRIDE_ENDPOINT);
      });

      [
        ['another domain', 'https://evil.example/openrtb2/auction'],
        ['a look-alike domain', 'https://bid.notringier-advertising.ch/openrtb2/auction'],
        ['plain http', 'http://bid.at.ringier-advertising.ch/openrtb2/auction'],
        ['an invalid URL', 'not a url'],
      ].forEach(([description, endpoint]) => {
        it(`ignores ${description}`, function () {
          const logWarn = sandbox.stub(utils, 'logWarn');
          config.setConfig({ ringier: { endpoint } });
          expect(getEndpoint()).to.equal(ENDPOINT);
          expect(logWarn.calledOnce).to.equal(true);
        });
      });
    });
  });

  describe('interpretResponse', function () {
    it('returns all bids under the ringier bidder code with the OpenRTB fields', function () {
      config.setConfig({ ringier: { sendEvents: true } });
      const request = buildSingleRequest();
      const bids = spec.interpretResponse(makeServerResponse(request, [
        makeOrtbBid({ dealid: 'a1b2c3d4:deal-123', exp: 120 }),
      ]), request);

      expect(bids).to.have.lengthOf(1);
      const bid = bids[0];
      expect(bid.bidderCode).to.equal(undefined);
      expect(bid).to.include({
        requestId: 'bid-1',
        cpm: 2.5,
        currency: 'CHF',
        width: 300,
        height: 250,
        ad: '<div>ad</div>',
        creativeId: 'creative-1',
        dealId: 'a1b2c3d4:deal-123',
        netRevenue: true,
        ttl: 120,
        mediaType: BANNER,
      });
      expect(bid.meta.advertiserDomains).to.deep.equal(['advertiser.example']);
      expect(bid.meta.demandSource).to.equal('opaque-origin-1');
      expect(bid.ext.ringier).to.deep.equal({ token: 'event-token-1', eventBase: 'https://bid.at.ringier-advertising.ch' });
    });

    it('hands the DSA transparency data of a bid to Prebid.js', function () {
      const request = buildSingleRequest();
      const dsa = { behalf: 'Advertiser', paid: 'Payer', transparency: [{ domain: 'platform.example', dsaparams: [1] }], adrender: 1 };
      const [bid] = spec.interpretResponse(makeServerResponse(request, [
        makeOrtbBid({ ext: { ringier: { o: 'opaque-origin-1', t: 'event-token-1' }, dsa } }),
      ]), request);
      expect(bid.meta.dsa).to.deep.equal(dsa);
    });

    it('keeps several bids for the same imp', function () {
      const request = buildSingleRequest();
      const bids = spec.interpretResponse(makeServerResponse(request, [
        makeOrtbBid(),
        makeOrtbBid({ id: 'seat-bid-2', price: 1.2, dealid: 'e5f6a7b8:d-1' }),
      ]), request);
      expect(bids.map(b => [b.cpm, b.dealId])).to.deep.equal([[2.5, undefined], [1.2, 'e5f6a7b8:d-1']]);
    });

    it('defaults ttl to 300 seconds and currency to USD', function () {
      const request = buildSingleRequest();
      const [bid] = spec.interpretResponse(makeServerResponse(request, [makeOrtbBid()], { cur: undefined }), request);
      expect(bid.ttl).to.equal(300);
      expect(bid.currency).to.equal('USD');
    });

    it('takes the media type from ext.prebid.type when mtype is missing', function () {
      const bids = [makeBidRequest({ mediaTypes: { banner: { sizes: [[300, 250]] }, video: { context: 'outstream', playerSize: [640, 480] } } })];
      const request = buildSingleRequest(bids);
      const [bid] = spec.interpretResponse(makeServerResponse(request, [
        makeOrtbBid({ mtype: undefined, ext: { prebid: { type: 'banner' } } }),
      ]), request);
      expect(bid.mediaType).to.equal(BANNER);
    });

    it('takes the only requested media type when the response does not name one', function () {
      const request = buildSingleRequest();
      const [bid] = spec.interpretResponse(makeServerResponse(request, [makeOrtbBid({ mtype: undefined })]), request);
      expect(bid.mediaType).to.equal(BANNER);
    });

    it('drops a bid whose media type cannot be determined', function () {
      sandbox.stub(utils, 'logError');
      const bids = [makeBidRequest({ mediaTypes: { banner: { sizes: [[300, 250]] }, video: { context: 'outstream', playerSize: [640, 480] } } })];
      const request = buildSingleRequest(bids);
      expect(spec.interpretResponse(makeServerResponse(request, [makeOrtbBid({ mtype: undefined })]), request)).to.deep.equal([]);
    });

    if (FEATURES.VIDEO) {
      it('returns video bids with the VAST markup', function () {
        const bids = [makeBidRequest({ mediaTypes: { video: { context: 'instream', playerSize: [[640, 480]], mimes: ['video/mp4'] } } })];
        const request = buildSingleRequest(bids);
        const [bid] = spec.interpretResponse(makeServerResponse(request, [
          makeOrtbBid({ mtype: 2, adm: '<VAST version="4.0"></VAST>', w: 640, h: 480 }),
        ]), request);
        expect(bid.mediaType).to.equal(VIDEO);
        expect(bid.vastXml).to.equal('<VAST version="4.0"></VAST>');
      });
    }

    if (FEATURES.NATIVE) {
      it('returns native bids', function () {
        const nativeOrtbRequest = { ver: '1.2', assets: [{ id: 1, required: 1, title: { len: 80 } }] };
        const bids = [makeBidRequest({ mediaTypes: { native: { ortb: nativeOrtbRequest } }, nativeOrtbRequest })];
        const request = buildSingleRequest(bids);
        const adm = { ver: '1.2', assets: [{ id: 1, title: { text: 'Hello' } }], link: { url: 'https://advertiser.example' } };
        const [bid] = spec.interpretResponse(makeServerResponse(request, [
          makeOrtbBid({ mtype: 4, adm: JSON.stringify(adm), w: undefined, h: undefined }),
        ]), request);
        expect(bid.mediaType).to.equal(NATIVE);
        expect(bid.native.ortb).to.deep.equal(adm);
      });
    }

    it('turns burl into a billing tracker and leaves its macros to the Bidlayer', function () {
      const request = buildSingleRequest();
      const [bid] = spec.interpretResponse(makeServerResponse(request, [
        makeOrtbBid({ burl: 'https://ssp.example/bill?p=${AUCTION_PRICE}' }),
      ]), request);
      expect(bid.eventtrackers).to.deep.equal([{
        event: EVENT_TYPE_IMPRESSION,
        method: TRACKER_METHOD_IMG,
        url: 'https://ssp.example/bill?p=${AUCTION_PRICE}',
      }]);
    });

    it('does not add burl twice when the bid also lists it as event tracker', function () {
      const request = buildSingleRequest();
      const tracker = { event: EVENT_TYPE_IMPRESSION, method: TRACKER_METHOD_IMG, url: 'https://ssp.example/bill?p=1' };
      const [bid] = spec.interpretResponse(makeServerResponse(request, [
        makeOrtbBid({ burl: 'https://ssp.example/bill?p=1', ext: { eventtrackers: [tracker], ringier: { o: 'x', t: 'y' } } }),
      ]), request);
      expect(bid.eventtrackers).to.deep.equal([tracker]);
    });

    it('does not keep event data unless the publisher switched events on', function () {
      const request = buildSingleRequest();
      const [bid] = spec.interpretResponse(makeServerResponse(request), request);
      expect(bid.ext).to.equal(undefined);
      expect(bid.meta.demandSource).to.equal('opaque-origin-1');
    });

    it('does not keep event data for a bid without a token', function () {
      config.setConfig({ ringier: { sendEvents: true } });
      const request = buildSingleRequest();
      const bids = spec.interpretResponse(makeServerResponse(request, [
        makeOrtbBid({ ext: {} }),
        makeOrtbBid({ id: 'seat-bid-2', ext: undefined }),
      ]), request);
      expect(bids).to.have.lengthOf(2);
      bids.forEach(bid => {
        expect(bid.ext).to.equal(undefined);
        expect(bid.meta.demandSource).to.equal(undefined);
      });
    });

    it('ignores bids for unknown imps', function () {
      sandbox.stub(utils, 'logError');
      const request = buildSingleRequest();
      expect(spec.interpretResponse(makeServerResponse(request, [makeOrtbBid({ impid: 'unknown' })]), request)).to.deep.equal([]);
    });

    it('returns no bids for an empty response', function () {
      const request = buildSingleRequest();
      expect(spec.interpretResponse({ body: undefined }, request)).to.deep.equal([]);
      expect(spec.interpretResponse({ body: { id: request.data.id, nbr: 2 } }, request)).to.deep.equal([]);
    });
  });

  describe('events', function () {
    let pixel;

    beforeEach(function () {
      pixel = sandbox.stub(utils, 'politeTriggerPixel');
      config.setConfig({ ringier: { sendEvents: true } });
    });

    function wonBid() {
      const request = buildSingleRequest();
      return spec.interpretResponse(makeServerResponse(request, [
        makeOrtbBid({ ext: { ringier: { o: 'x', t: 'tok/en+1=' } } }),
      ]), request)[0];
    }

    it('sends a win event with the event token', function () {
      spec.onBidWon(wonBid());
      expect(pixel.calledOnceWith('https://bid.at.ringier-advertising.ch/event?t=tok%2Fen%2B1%3D&type=win')).to.equal(true);
    });

    it('sends a render event with the event token', function () {
      spec.onAdRenderSucceeded(wonBid());
      expect(pixel.calledOnceWith('https://bid.at.ringier-advertising.ch/event?t=tok%2Fen%2B1%3D&type=render')).to.equal(true);
    });

    it('sends events to the origin of an overridden endpoint', function () {
      config.setConfig({ ringier: { endpoint: OVERRIDE_ENDPOINT, sendEvents: true } });
      spec.onBidWon(wonBid());
      expect(pixel.calledOnceWith('https://other.ringier-advertising.ch/event?t=tok%2Fen%2B1%3D&type=win')).to.equal(true);
    });

    it('sends nothing for a bid without event data', function () {
      spec.onBidWon({ bidder: BIDDER_CODE, cpm: 1 });
      spec.onAdRenderSucceeded({ bidder: BIDDER_CODE, cpm: 1, ext: { ringier: { eventBase: 'https://bid.at.ringier-advertising.ch' } } });
      expect(pixel.called).to.equal(false);
    });

    it('sends nothing unless the publisher switched events on', function () {
      config.setConfig({ ringier: {} });
      spec.onBidWon(wonBid());
      expect(pixel.called).to.equal(false);
    });

    it('sends nothing for an earlier bid once the publisher switched events off', function () {
      const bid = wonBid();
      config.setConfig({ ringier: { sendEvents: false } });
      spec.onBidWon(bid);
      spec.onAdRenderSucceeded(bid);
      expect(pixel.called).to.equal(false);
    });
  });

  describe('timeout and error events', function () {
    let pixel;

    beforeEach(function () {
      pixel = sandbox.stub(utils, 'politeTriggerPixel');
      config.setConfig({ ringier: { sendEvents: true } });
    });

    function sentParams() {
      return pixel.getCalls().map(call => {
        const url = new URL(call.args[0]);
        return { origin: url.origin, path: url.pathname, params: Object.fromEntries(url.searchParams) };
      });
    }

    // the shape Prebid.js passes to onTimeout: the configured params of the ad unit as a list
    function timedOut(adUnitCode, params, timeout = 1000) {
      return { bidder: BIDDER_CODE, adUnitCode, bidId: `bid-${adUnitCode}`, params, timeout };
    }

    it('sends a timeout event per publisher with its placements', function () {
      config.setConfig({ ringier: { configVersion: 'v42', sendEvents: true } });
      spec.onTimeout([
        timedOut('div-top', [{ publisherId: 'pub-1', placementId: 'example-top' }]),
        timedOut('div-rect', [{ publisherId: 'pub-1', placementId: 'example-rect' }]),
        timedOut('div-dup', [{ publisherId: 'pub-1', placementId: 'example-top' }]),
      ]);
      expect(sentParams()).to.deep.equal([{
        origin: 'https://bid.at.ringier-advertising.ch',
        path: '/event',
        params: { type: 'timeout', pub: 'pub-1', pl: 'example-top,example-rect', cv: 'v42', tmax: '1000' },
      }]);
    });

    it('sends one timeout event for each publisher and skips incomplete params', function () {
      spec.onTimeout([
        timedOut('div-top', [{ publisherId: 'pub-1', placementId: 'top' }]),
        timedOut('div-other', [{ publisherId: 'pub-2', placementId: 'other' }, null, { publisherId: 'pub-3' }]),
        timedOut('div-none', undefined),
      ]);
      expect(sentParams().map(({ params }) => [params.pub, params.pl])).to.deep.equal([['pub-1', 'top'], ['pub-2', 'other']]);
    });

    it('sends an error event with the HTTP status', function () {
      const bids = [makeBidRequest(), makeBidRequest({ bidId: 'bid-2', params: { publisherId: 'pub-1', placementId: 'example-rect' } })];
      spec.onBidderError({ error: { status: 503 }, bidderRequest: makeBidderRequest(bids) });
      expect(sentParams()).to.deep.equal([{
        origin: 'https://bid.at.ringier-advertising.ch',
        path: '/event',
        params: { type: 'error', pub: 'pub-1', pl: 'example-top,example-rect', status: '503' },
      }]);
    });

    it('reports status 0 for a network error and ignores invalid bids', function () {
      const bids = [makeBidRequest(), makeBidRequest({ bidId: 'bid-2', params: { publisherId: '' } })];
      spec.onBidderError({ error: {}, bidderRequest: makeBidderRequest(bids) });
      expect(sentParams().map(({ params }) => params)).to.deep.equal([{ type: 'error', pub: 'pub-1', pl: 'example-top', status: '0' }]);
    });

    it('encodes placement IDs', function () {
      spec.onTimeout([timedOut('div', [{ publisherId: 'pub&1', placementId: 'a b/c' }])]);
      expect(pixel.firstCall.args[0]).to.contain('pub=pub%261&pl=a%20b%2Fc');
    });

    it('sends to the origin of an overridden endpoint', function () {
      config.setConfig({ ringier: { endpoint: OVERRIDE_ENDPOINT, sendEvents: true } });
      spec.onBidderError({ error: { status: 500 }, bidderRequest: makeBidderRequest([makeBidRequest()]) });
      expect(sentParams()[0].origin).to.equal('https://other.ringier-advertising.ch');
    });

    it('sends nothing unless the publisher switched events on', function () {
      config.setConfig({ ringier: {} });
      spec.onTimeout([timedOut('div-top', [{ publisherId: 'pub-1', placementId: 'top' }])]);
      spec.onBidderError({ error: { status: 500 }, bidderRequest: makeBidderRequest([makeBidRequest()]) });
      expect(pixel.called).to.equal(false);
    });

    it('sends nothing without ad units', function () {
      spec.onTimeout([]);
      spec.onBidderError({ error: { status: 500 }, bidderRequest: undefined });
      expect(pixel.called).to.equal(false);
    });
  });

  describe('getUserSyncs', function () {
    const consentWithPurpose1 = {
      gdprApplies: true,
      consentString: 'CONSENT STRING',
      vendorData: { purpose: { consents: { 1: true } } },
    };
    const gppConsent = { gppString: 'DBABMA~gpp', applicableSections: [2, 6] };

    function parseSync(sync) {
      const url = new URL(sync.url);
      return { origin: url.origin, path: url.pathname, params: Object.fromEntries(url.searchParams) };
    }

    function syncFor(publisherIds) {
      const bids = publisherIds.map((publisherId, i) => makeBidRequest({ bidId: `bid-${i}`, params: { publisherId, placementId: 'p' } }));
      spec.buildRequests(bids, makeBidderRequest(bids));
      const [sync] = spec.getUserSyncs({ iframeEnabled: true }, [], null, null, null);
      return parseSync(sync).params;
    }

    beforeEach(function () {
      // the sync account is the publisherId of the latest request
      buildSingleRequest();
    });

    it('loads the sync iframe that calls the Bidlayer cookie_sync', function () {
      const syncs = spec.getUserSyncs({ iframeEnabled: true, pixelEnabled: true }, [], consentWithPurpose1, undefined, gppConsent);
      expect(syncs).to.have.lengthOf(1);
      expect(syncs[0].type).to.equal('iframe');
      expect(parseSync(syncs[0])).to.deep.equal({
        origin: 'https://bid.at.ringier-advertising.ch',
        path: '/static/load-cookie.html',
        params: {
          endpoint: 'https://bid.at.ringier-advertising.ch/cookie_sync',
          max_sync_count: '10',
          args: 'account:pub-1',
          gdpr: '1',
          gdpr_consent: 'CONSENT STRING',
          gpp: 'DBABMA~gpp',
          gpp_sid: '2,6',
        },
      });
    });

    it('syncs without consent parameters when GDPR does not apply', function () {
      const syncs = spec.getUserSyncs({ iframeEnabled: true }, [], { gdprApplies: false }, undefined, undefined);
      expect(parseSync(syncs[0]).params).to.deep.equal({
        endpoint: 'https://bid.at.ringier-advertising.ch/cookie_sync',
        max_sync_count: '10',
        args: 'account:pub-1',
        gdpr: '0',
      });
    });

    it('passes the publisherId of the latest request as Prebid Server account', function () {
      sandbox.stub(utils, 'logWarn');
      expect(syncFor(['pub_b.2026-v1']).args).to.equal('account:pub_b.2026-v1');
      expect(syncFor(['pub-a', 'pub-b', 'pub-a']).args).to.equal('account:pub-a');
    });

    it('syncs without account when load-cookie.html cannot pass the publisherId on', function () {
      const logWarn = sandbox.stub(utils, 'logWarn');
      ['12345', 'pub:1', 'pub,1', 'pub 1', 'pub&1'].forEach(publisherId => {
        expect(syncFor([publisherId]), publisherId).to.not.have.property('args');
      });
      expect(logWarn.callCount).to.equal(5);
      expect(logWarn.firstCall.args[0]).to.contain('12345');
    });

    it('syncs on the origin of an overridden endpoint', function () {
      config.setConfig({ ringier: { endpoint: OVERRIDE_ENDPOINT, sendEvents: true } });
      const [sync] = spec.getUserSyncs({ iframeEnabled: true }, [], null, null, null);
      expect(parseSync(sync).origin).to.equal('https://other.ringier-advertising.ch');
      expect(parseSync(sync).params.endpoint).to.equal('https://other.ringier-advertising.ch/cookie_sync');
    });

    it('does not sync without purpose 1 consent', function () {
      const noPurpose1 = { gdprApplies: true, consentString: 'X', vendorData: { purpose: { consents: { 1: false } } } };
      expect(spec.getUserSyncs({ iframeEnabled: true, pixelEnabled: true }, [], noPurpose1)).to.deep.equal([]);
      expect(spec.getUserSyncs({ iframeEnabled: true, pixelEnabled: true }, [], { gdprApplies: true })).to.deep.equal([]);
    });

    it('treats an unknown GDPR scope as GDPR applying', function () {
      const unknownScope = { consentString: 'X' };
      expect(spec.getUserSyncs({ iframeEnabled: true, pixelEnabled: true }, [], unknownScope)).to.deep.equal([]);
      const unknownScopeWithConsent = { consentString: 'X', vendorData: { purpose: { consents: { 1: true } } } };
      expect(spec.getUserSyncs({ iframeEnabled: true }, [], unknownScopeWithConsent)).to.have.lengthOf(1);
    });

    it('leaves the decision to Prebid Server when the page has no GDPR data', function () {
      const [sync] = spec.getUserSyncs({ iframeEnabled: true }, [], null, null, null);
      expect(parseSync(sync).params).to.deep.equal({
        endpoint: 'https://bid.at.ringier-advertising.ch/cookie_sync',
        max_sync_count: '10',
        args: 'account:pub-1',
      });
    });

    it('sends the GPP string without sections when none apply', function () {
      const [sync] = spec.getUserSyncs({ iframeEnabled: true }, [], null, null, { gppString: 'DBABMA~gpp', applicableSections: [] });
      expect(parseSync(sync).params.gpp).to.equal('DBABMA~gpp');
      expect(parseSync(sync).params).to.not.have.property('gpp_sid');
    });

    it('registers at most ten image syncs and ignores malformed sync lists', function () {
      const syncs = Array.from({ length: 12 }, (_, i) => ({ type: 'image', url: `https://ssp-${i}.example/sync` }));
      const responses = [
        { body: { ext: { ringier: { syncs: 'https://not-a-list.example' } } } },
        { body: { ext: { ringier: { syncs: [null, 42, ...syncs] } } } },
        null,
      ];
      const result = spec.getUserSyncs({ pixelEnabled: true }, responses, null);
      expect(result).to.have.lengthOf(10);
      expect(result[0]).to.deep.equal({ type: 'image', url: 'https://ssp-0.example/sync' });
    });

    it('falls back to image syncs from the response when iframes are not allowed', function () {
      const responses = [
        {
          body: {
            ext: {
              ringier: {
                syncs: [
                  { type: 'image', url: 'https://ssp-a.example/sync?gdpr=1' },
                  { type: 'image', url: 'https://ssp-a.example/sync?gdpr=1' },
                  { type: 'iframe', url: 'https://ssp-b.example/sync' },
                  { type: 'image', url: 'http://insecure.example/sync' },
                  { type: 'image' },
                ]
              }
            }
          }
        },
        { body: { ext: { ringier: { syncs: [{ type: 'image', url: 'https://ssp-c.example/sync' }] } } } },
        { body: {} },
      ];
      expect(spec.getUserSyncs({ iframeEnabled: false, pixelEnabled: true }, responses, consentWithPurpose1)).to.deep.equal([
        { type: 'image', url: 'https://ssp-a.example/sync?gdpr=1' },
        { type: 'image', url: 'https://ssp-c.example/sync' },
      ]);
    });

    it('returns nothing when no sync type is allowed', function () {
      expect(spec.getUserSyncs({ iframeEnabled: false, pixelEnabled: false }, [], consentWithPurpose1)).to.deep.equal([]);
    });
  });
});
