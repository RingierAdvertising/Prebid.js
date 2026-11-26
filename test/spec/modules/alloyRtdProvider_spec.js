import { expect } from 'chai';
import { alloySubmodule } from 'modules/alloyRtdProvider.ts';
import { loadExternalScriptStub } from 'test/mocks/adloaderStub.js';

describe('Alloy RTD provider', function () {
  let clock;
  let originalUrl;
  let pageCounter = 0;

  // every global the module or the Alloy SDK may leave on the page
  const ALLOY_GLOBALS = [
    'alloySDK', 'alloyDataLayer', '_alloytenant', '_alloyenv', '_alloyappid', '_alloyconsentcookiename',
    '_alloyautostart', '_alloytracking', '_alloyadtracking', '_alloypageviewautotracking',
    '_datalayerautotracking', '_alloyvisitorreadonly', '_alloyskipeventstracking'
  ];

  const CONTEXT = {
    alloy_iab: ['iab-1', 'iab-2'],
    alloy_topics: ['topic-1'],
    canonical_id: 'c-1',
    attribution: 'direct',
    is_brandsafe: null
  };
  const AUDIENCES = { segment_ids: ['aud-1', 'aud-2'] };

  function clearAlloyGlobals() {
    ALLOY_GLOBALS.forEach((name) => delete window[name]);
  }

  // consent data as the consent management module provides it
  function tcfConsent({ purpose1 = true, vendor = true } = {}) {
    return {
      gdpr: {
        gdprApplies: true,
        vendorData: {
          purpose: { consents: { 1: purpose1 } },
          vendor: { consents: { 1436: vendor } }
        }
      }
    };
  }

  // a loaded SDK runs queued commands right away
  function loadedSdk({ context = CONTEXT, audiences = AUDIENCES } = {}) {
    return {
      push: (command) => command(),
      identity: {},
      contextual: { getContextData: sinon.stub().resolves(context) },
      audienceSegment: { getAudienceSegmentData: sinon.stub().resolves(audiences) },
      tracking: { trackPageViewEvent: sinon.spy() }
    };
  }

  function makeConfig(params = {}) {
    return { name: 'alloy', waitForIt: true, params };
  }

  function makeRequest(bidder = {}) {
    return { ortb2Fragments: { global: {}, bidder } };
  }

  // resolves with the request once the module calls back
  function run(config = makeConfig(), consent = tcfConsent(), request = makeRequest()) {
    return new Promise((resolve) => {
      alloySubmodule.getBidRequestData(request, () => resolve(request), config, consent, 300);
    });
  }

  // a new URL, without leaving the test page: page views are tracked once per URL
  function navigate() {
    window.history.replaceState(null, '', `?alloyRtdPage=${++pageCounter}`);
  }

  beforeEach(function () {
    originalUrl = window.location.href;
    clearAlloyGlobals();
    navigate();
  });

  afterEach(function () {
    if (clock) {
      clock.restore();
      clock = undefined;
    }
    clearAlloyGlobals();
    window.history.replaceState(null, '', originalUrl);
  });

  describe('alloySubmodule', function () {
    it('should have the correct name', function () {
      expect(alloySubmodule.name).to.equal('alloy');
    });

    it('should have the Ringier gvlid', function () {
      expect(alloySubmodule.gvlid).to.equal(1436);
    });

    it('should not set ad server targeting', function () {
      expect(alloySubmodule.getTargetingData).to.be.undefined;
    });

    it('should initialize without loading the SDK, as consent is not known yet', function () {
      expect(alloySubmodule.init(makeConfig({ sdk: { appId: 'examplech_de_web' } }), {})).to.equal(true);

      sinon.assert.notCalled(loadExternalScriptStub);
      expect(window._alloyappid).to.be.undefined;
    });
  });

  describe('getBidRequestData', function () {
    describe('loading the SDK', function () {
      it('should configure and load the SDK before the auction', function () {
        alloySubmodule.getBidRequestData(
          makeRequest(), () => {}, makeConfig({ sdk: { appId: 'examplech_de_web', tenant: 'acme' } }), tcfConsent(), 300
        );

        expect(window._alloyappid).to.equal('examplech_de_web');
        expect(window._alloytenant).to.equal('acme');
        sinon.assert.calledOnce(loadExternalScriptStub);
        const [url, moduleType, moduleName] = loadExternalScriptStub.firstCall.args;
        expect(url).to.match(/^https:\/\/cdn\.alloy\.ch\/client-sdk\/2\.x\.x\/alloy-sdk\.umd\.js\?ts=\d+$/);
        expect(moduleType).to.equal('rtd');
        expect(moduleName).to.equal('alloy');
      });

      it('should use an SDK that is on the page instead of loading one', async function () {
        window.alloySDK = loadedSdk();

        await run(makeConfig({ sdk: { appId: 'examplech_de_web' } }));

        sinon.assert.notCalled(loadExternalScriptStub);
      });
    });

    describe('data in the bid request', function () {
      it('should pass contextual and audience segments to the ringier bidder', async function () {
        window.alloySDK = loadedSdk();

        const request = await run();

        expect(request.ortb2Fragments.bidder).to.deep.equal({
          ringier: {
            site: {
              content: {
                data: [
                  { name: 'alloy_iab', segment: [{ id: 'iab-1' }, { id: 'iab-2' }] },
                  { name: 'alloy_topics', segment: [{ id: 'topic-1' }] },
                  { name: 'alloy_ctx_ready', segment: [{ id: '1' }] }
                ]
              }
            },
            user: {
              data: [
                { name: 'alloy_audiences', segment: [{ id: 'aud-1' }, { id: 'aud-2' }] }
              ]
            }
          }
        });
      });

      it('should never write to the data all bidders get', async function () {
        window.alloySDK = loadedSdk();

        const request = await run();

        expect(request.ortb2Fragments.global).to.deep.equal({});
      });

      it('should pass the data to the configured bidders, each with its own copy', async function () {
        window.alloySDK = loadedSdk();

        const request = await run(makeConfig({ bidders: ['ringier', 'other'] }));

        expect(Object.keys(request.ortb2Fragments.bidder)).to.have.members(['ringier', 'other']);
        expect(request.ortb2Fragments.bidder.other).to.deep.equal(request.ortb2Fragments.bidder.ringier);
        expect(request.ortb2Fragments.bidder.other.site).to.not.equal(request.ortb2Fragments.bidder.ringier.site);
      });

      it('should pass the data to no bidder when the list is empty', async function () {
        window.alloySDK = loadedSdk();

        const request = await run(makeConfig({ bidders: [] }));

        expect(request.ortb2Fragments.bidder).to.deep.equal({});
      });

      ['ringier', 42, null, {}].forEach((bidders) => {
        it(`should fall back to the ringier bidder for bidders = ${JSON.stringify(bidders)}`, async function () {
          window.alloySDK = loadedSdk();

          const request = await run(makeConfig({ bidders }));

          expect(Object.keys(request.ortb2Fragments.bidder)).to.deep.equal(['ringier']);
        });
      });

      it('should keep what the bidder already has', async function () {
        window.alloySDK = loadedSdk();
        const request = makeRequest({
          ringier: {
            site: {
              content: { data: [{ name: 'other.com', segment: [{ id: 'x' }] }] },
              ext: { data: { pagetype: 'article' } }
            },
            user: { data: [{ name: 'other.com', segment: [{ id: 'y' }] }] }
          }
        });

        await run(makeConfig(), tcfConsent(), request);

        const { site, user } = request.ortb2Fragments.bidder.ringier;
        expect(site.content.data.map((data) => data.name)).to.deep.equal(
          ['other.com', 'alloy_iab', 'alloy_topics', 'alloy_ctx_ready']
        );
        expect(site.ext.data).to.deep.equal({ pagetype: 'article' });
        expect(user.data.map((data) => data.name)).to.deep.equal(['other.com', 'alloy_audiences']);
      });

      it('should work without bidder fragments on the request', async function () {
        window.alloySDK = loadedSdk();

        const request = await run(makeConfig(), tcfConsent(), { ortb2Fragments: { global: {} } });

        expect(request.ortb2Fragments.bidder.ringier.user.data).to.have.lengthOf(1);
      });

      it('should leave out empty segment lists', async function () {
        window.alloySDK = loadedSdk({
          context: { ...CONTEXT, alloy_iab: [], alloy_topics: [] },
          audiences: { segment_ids: [] }
        });

        const request = await run();

        expect(request.ortb2Fragments.bidder.ringier).to.deep.equal({
          site: { content: { data: [{ name: 'alloy_ctx_ready', segment: [{ id: '1' }] }] } }
        });
      });

      it('should only pass segment ids that are non-empty strings', async function () {
        window.alloySDK = loadedSdk({
          context: { ...CONTEXT, alloy_iab: ['iab-1', '', 7, null, { id: 'x' }], alloy_topics: 'topic-1' },
          audiences: { segment_ids: [undefined, 'aud-1'] }
        });

        const { site, user } = (await run()).ortb2Fragments.bidder.ringier;

        expect(site.content.data).to.deep.equal([
          { name: 'alloy_iab', segment: [{ id: 'iab-1' }] },
          { name: 'alloy_ctx_ready', segment: [{ id: '1' }] }
        ]);
        expect(user.data).to.deep.equal([
          { name: 'alloy_audiences', segment: [{ id: 'aud-1' }] }
        ]);
      });

      [
        ['the attribution is indirect', { ...CONTEXT, attribution: 'indirect' }],
        ['there is no canonical id', { ...CONTEXT, canonical_id: null }],
        ['the SDK has no context', {}],
        ['the SDK answers with nothing', null]
      ].forEach(([when, context]) => {
        it(`should mark the context as not ready when ${when}`, async function () {
          window.alloySDK = loadedSdk({ context });

          const request = await run();

          expect(request.ortb2Fragments.bidder.ringier.site.content.data).to.deep.include(
            { name: 'alloy_ctx_ready', segment: [{ id: '0' }] }
          );
        });
      });

      it('should not ask for audience segments when audiences is false', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;

        const request = await run(makeConfig({ audiences: false }));

        sinon.assert.notCalled(sdk.audienceSegment.getAudienceSegmentData);
        expect(request.ortb2Fragments.bidder.ringier.user).to.be.undefined;
        expect(request.ortb2Fragments.bidder.ringier.site.content.data).to.have.lengthOf(3);
      });

      it('should name each entry by the key-value key it stands for', async function () {
        window.alloySDK = loadedSdk();

        const { site, user } = (await run()).ortb2Fragments.bidder.ringier;
        const keyValues = [...site.content.data, ...user.data]
          .flatMap(({ name, segment }) => segment.map(({ id }) => `${name}=${id}`));

        expect(keyValues).to.deep.equal([
          'alloy_iab=iab-1', 'alloy_iab=iab-2', 'alloy_topics=topic-1', 'alloy_ctx_ready=1',
          'alloy_audiences=aud-1', 'alloy_audiences=aud-2'
        ]);
      });
    });

    describe('content id', function () {
      it('should ask for the context of the current page', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;

        await run();

        sinon.assert.calledOnceWithExactly(sdk.contextual.getContextData, window.location.href, undefined);
      });

      it('should pass params.contentId', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;

        await run(makeConfig({ contentId: 'article-1' }));

        sinon.assert.calledOnceWithExactly(sdk.contextual.getContextData, window.location.href, 'article-1');
      });

      it('should fall back to the content id of the Alloy data layer', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;
        window.alloyDataLayer = { context: { contentId: 4711 } };

        await run();

        sinon.assert.calledOnceWithExactly(sdk.contextual.getContextData, window.location.href, 4711);
      });

      ['', '  ', NaN, Infinity, null, {}, true].forEach((contentId) => {
        it(`should pass no content id for ${String(contentId)}`, async function () {
          const sdk = loadedSdk();
          window.alloySDK = sdk;

          await run(makeConfig({ contentId }));

          sinon.assert.calledOnceWithExactly(sdk.contextual.getContextData, window.location.href, undefined);
        });
      });
    });

    describe('page views', function () {
      it('should track a page view with the logical path and the content id', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;

        await run(makeConfig({ logicalPath: 'examplech_de_web/desktop/sport', contentId: 'article-1' }));

        sinon.assert.calledOnceWithExactly(sdk.tracking.trackPageViewEvent, {
          logicalPath: 'examplech_de_web/desktop/sport',
          contentId: 'article-1'
        });
      });

      it('should leave logical path and content id to the SDK when none is configured', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;

        await run();

        sinon.assert.calledOnceWithExactly(sdk.tracking.trackPageViewEvent, {});
      });

      it('should track a page only once, however many auctions run on it', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;

        await run();
        await run();

        sinon.assert.calledOnce(sdk.tracking.trackPageViewEvent);
      });

      it('should track again when the URL changes, as in a single-page app', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;

        await run();
        navigate();
        await run();

        sinon.assert.calledTwice(sdk.tracking.trackPageViewEvent);
      });

      it('should track the page view even when the SDK loads after the timeout', function () {
        clock = sinon.useFakeTimers();
        const callback = sinon.spy();

        alloySubmodule.getBidRequestData(makeRequest(), callback, makeConfig({ sdk: { load: false } }), tcfConsent(), 300);
        clock.tick(5000);
        sinon.assert.calledOnce(callback);

        const queue = window.alloySDK;
        const sdk = loadedSdk();
        window.alloySDK = sdk;
        queue.forEach((command) => command());

        sinon.assert.calledOnce(sdk.tracking.trackPageViewEvent);
        sinon.assert.notCalled(sdk.contextual.getContextData);
      });

      it('should not track when trackPageViews is false', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;

        await run(makeConfig({ trackPageViews: false }));

        sinon.assert.notCalled(sdk.tracking.trackPageViewEvent);
      });

      it('should not track when it starts the SDK with page view auto tracking', function () {
        alloySubmodule.getBidRequestData(
          makeRequest(),
          () => {},
          makeConfig({ sdk: { appId: 'examplech_de_web', pageViewAutoTracking: true } }),
          tcfConsent(),
          300
        );

        const queue = window.alloySDK;
        const sdk = loadedSdk();
        window.alloySDK = sdk;
        queue.forEach((command) => command());

        sinon.assert.notCalled(sdk.tracking.trackPageViewEvent);
        sinon.assert.calledOnce(sdk.contextual.getContextData);
      });

      it('should not track when an SDK that tracks page views on its own is already running', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;
        // set by whatever started the SDK: the Alloy User ID submodule, the tag manager, the page
        window._alloypageviewautotracking = true;

        await run();

        sinon.assert.notCalled(sdk.tracking.trackPageViewEvent);
      });

      it('should track when the SDK it could not configure does not track page views on its own', async function () {
        const sdk = loadedSdk();
        window.alloySDK = sdk;
        window._alloypageviewautotracking = false;

        await run(makeConfig({ sdk: { pageViewAutoTracking: true } }));

        sinon.assert.calledOnce(sdk.tracking.trackPageViewEvent);
      });

      it('should survive an SDK without the tracking API', async function () {
        const sdk = loadedSdk();
        delete sdk.tracking;
        window.alloySDK = sdk;

        const request = await run();

        expect(request.ortb2Fragments.bidder.ringier.user.data).to.have.lengthOf(1);
      });
    });

    describe('without consent', function () {
      [
        ['consent for purpose 1', tcfConsent({ purpose1: false })],
        ['consent for the Alloy vendor', tcfConsent({ vendor: false })],
        ['TCF consent data', {}],
        ['an answer of the CMP', { gdpr: { gdprApplies: false, vendorData: undefined } }]
      ].forEach(([what, consent]) => {
        it(`should do nothing without ${what}`, function () {
          const sdk = loadedSdk();
          const request = makeRequest();
          const callback = sinon.spy();

          alloySubmodule.getBidRequestData(
            request, callback, makeConfig({ sdk: { appId: 'examplech_de_web' } }), consent, 300
          );

          sinon.assert.calledOnce(callback);
          sinon.assert.notCalled(loadExternalScriptStub);
          expect(window._alloyappid).to.be.undefined;
          expect(window.alloySDK).to.be.undefined;
          expect(request).to.deep.equal(makeRequest());

          window.alloySDK = sdk;
          alloySubmodule.getBidRequestData(request, callback, makeConfig(), consent, 300);
          sinon.assert.notCalled(sdk.contextual.getContextData);
          sinon.assert.notCalled(sdk.audienceSegment.getAudienceSegmentData);
          sinon.assert.notCalled(sdk.tracking.trackPageViewEvent);
        });
      });
    });

    describe('when Alloy does not answer', function () {
      it('should continue after 1000 ms by default, with the context marked as not ready', function () {
        clock = sinon.useFakeTimers();
        const request = makeRequest();
        const callback = sinon.spy();

        alloySubmodule.getBidRequestData(request, callback, makeConfig({ sdk: { load: false } }), tcfConsent(), 300);

        clock.tick(999);
        sinon.assert.notCalled(callback);
        clock.tick(1);
        sinon.assert.calledOnce(callback);
        expect(request.ortb2Fragments.bidder).to.deep.equal({
          ringier: { site: { content: { data: [{ name: 'alloy_ctx_ready', segment: [{ id: '0' }] }] } } }
        });
      });

      it('should honor params.timeout', function () {
        clock = sinon.useFakeTimers();
        const callback = sinon.spy();

        alloySubmodule.getBidRequestData(
          makeRequest(), callback, makeConfig({ timeout: 200, sdk: { load: false } }), tcfConsent(), 300
        );

        clock.tick(199);
        sinon.assert.notCalled(callback);
        clock.tick(1);
        sinon.assert.calledOnce(callback);
      });

      ['200', -1, 0, NaN, null].forEach((timeout) => {
        it(`should fall back to 1000 ms for params.timeout = ${String(timeout)}`, function () {
          clock = sinon.useFakeTimers();
          const callback = sinon.spy();

          alloySubmodule.getBidRequestData(
            makeRequest(), callback, makeConfig({ timeout, sdk: { load: false } }), tcfConsent(), 300
          );

          clock.tick(999);
          sinon.assert.notCalled(callback);
          clock.tick(1);
          sinon.assert.calledOnce(callback);
        });
      });

      it('should pass what it has when only one of the two SDK calls fails', async function () {
        const sdk = loadedSdk();
        sdk.contextual.getContextData = sinon.stub().rejects(new Error('down'));
        window.alloySDK = sdk;

        const request = await run();

        expect(request.ortb2Fragments.bidder.ringier).to.deep.equal({
          site: { content: { data: [{ name: 'alloy_ctx_ready', segment: [{ id: '0' }] }] } },
          user: { data: [{ name: 'alloy_audiences', segment: [{ id: 'aud-1' }, { id: 'aud-2' }] }] }
        });
      });

      it('should call back exactly once', async function () {
        clock = sinon.useFakeTimers();
        window.alloySDK = loadedSdk();
        const callback = sinon.spy();

        alloySubmodule.getBidRequestData(makeRequest(), callback, makeConfig(), tcfConsent(), 300);
        for (let i = 0; i < 5; i++) {
          await Promise.resolve();
        }
        clock.tick(5000);

        sinon.assert.calledOnce(callback);
      });

      it('should call back even when the request cannot be written to', async function () {
        window.alloySDK = loadedSdk();
        const callback = sinon.spy();

        alloySubmodule.getBidRequestData(Object.freeze({}), callback, makeConfig(), tcfConsent(), 300);
        for (let i = 0; i < 5; i++) {
          await Promise.resolve();
        }

        sinon.assert.calledOnce(callback);
      });

      it('should work without params', async function () {
        window.alloySDK = loadedSdk();

        const request = await run({ name: 'alloy' });

        expect(request.ortb2Fragments.bidder.ringier.user.data).to.have.lengthOf(1);
      });
    });
  });
});
