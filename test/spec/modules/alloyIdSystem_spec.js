import { expect } from 'chai';
import { alloyIdSubmodule } from 'modules/alloyIdSystem.ts';
import { createEidsArray } from 'modules/userId/eids.js';
import { coreStorage, getConsentHash, HTML5_SUFFIXES, init, setSubmoduleRegistry } from 'modules/userId/index.js';
import { config } from 'src/config.js';
import { hook } from 'src/hook.js';
import { getGlobal } from 'src/prebidGlobal.js';
import { allConsent, gdprDataHandler } from 'src/consentHandler.js';
import { loadExternalScriptStub } from 'test/mocks/adloaderStub.js';

describe('AlloyId module', function () {
  let clock;

  // every global the module or the Alloy SDK may leave on the page
  const ALLOY_GLOBALS = [
    'alloySDK', 'alloyDataLayer', '_alloytenant', '_alloyenv', '_alloyappid', '_alloyconsentcookiename',
    '_alloyautostart', '_alloytracking', '_alloyadtracking', '_alloypageviewautotracking',
    '_datalayerautotracking', '_alloyvisitorreadonly', '_alloyskipeventstracking'
  ];

  function clearAlloyGlobals() {
    ALLOY_GLOBALS.forEach((name) => delete window[name]);
  }

  // consent data as the consent management module provides it
  function tcfConsent({ purpose1 = true, vendor = true } = {}) {
    return {
      gdpr: {
        gdprApplies: true,
        consentString: 'consent-string',
        vendorData: {
          purpose: { consents: { 1: purpose1 } },
          vendor: { consents: { 1436: vendor } }
        }
      }
    };
  }

  // a loaded SDK runs queued commands right away
  function loadedSdk(getVisitorID) {
    return {
      push: (command) => command(),
      identity: { getVisitorID }
    };
  }

  // the storage handle the User ID module passes to getId
  function storageHandle() {
    return { get: sinon.stub(), manage: sinon.spy(), set: sinon.spy(), touch: sinon.spy(), remove: sinon.spy() };
  }

  function getId(config = {}, handle = storageHandle(), consent = tcfConsent()) {
    return alloyIdSubmodule.getId(config, consent, undefined, handle);
  }

  function fetchId(config = {}, handle = storageHandle()) {
    return new Promise((resolve) => getId(config, handle).callback(resolve));
  }

  async function flushPromises() {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(function () {
    clearAlloyGlobals();
  });

  afterEach(function () {
    if (clock) {
      clock.restore();
      clock = undefined;
    }
    clearAlloyGlobals();
  });

  describe('alloyIdSubmodule', function () {
    it('should have the correct name', function () {
      expect(alloyIdSubmodule.name).to.equal('alloyId');
    });

    it('should have the Ringier gvlid', function () {
      expect(alloyIdSubmodule.gvlid).to.equal(1436);
    });

    it('should produce an alloy.ch eid with a numeric atype', function () {
      const eids = createEidsArray({ alloyId: 'abc' }, new Map(Object.entries(alloyIdSubmodule.eids)));

      expect(eids).to.deep.equal([{
        source: 'alloy.ch',
        uids: [{ id: 'abc', atype: 1 }]
      }]);
    });
  });

  describe('decode', function () {
    it('should return the id under the alloyId key', function () {
      expect(alloyIdSubmodule.decode('abc')).to.deep.equal({ alloyId: 'abc' });
    });

    ['', undefined, null, {}, 42].forEach((value) => {
      it(`should return undefined for ${JSON.stringify(value)}`, function () {
        expect(alloyIdSubmodule.decode(value)).to.be.undefined;
      });
    });
  });

  describe('getId', function () {
    it('should return a callback and no synchronous id', function () {
      const result = getId({});

      expect(result.callback).to.be.a('function');
      expect(result.id).to.be.undefined;
    });

    it('should not touch the SDK before the callback runs', function () {
      delete window.alloySDK;

      getId({});

      expect(window.alloySDK).to.be.undefined;
    });

    it('should pass the visitor id of a loaded SDK to the callback', async function () {
      const getVisitorID = sinon.stub().resolves('alloy-123');
      window.alloySDK = loadedSdk(getVisitorID);

      expect(await fetchId()).to.equal('alloy-123');
    });

    it('should call getVisitorID with a timeout of 300 ms by default', async function () {
      const getVisitorID = sinon.stub().resolves('alloy-123');
      window.alloySDK = loadedSdk(getVisitorID);

      await fetchId();

      sinon.assert.calledOnceWithExactly(getVisitorID, { timeout: 300 });
    });

    it('should forward params.timeout to getVisitorID', async function () {
      const getVisitorID = sinon.stub().resolves('alloy-123');
      window.alloySDK = loadedSdk(getVisitorID);

      await fetchId({ params: { timeout: 500 } });

      sinon.assert.calledOnceWithExactly(getVisitorID, { timeout: 500 });
    });

    ['300', -1, 0, NaN, Infinity, null].forEach((timeout) => {
      it(`should fall back to 300 ms for params.timeout = ${String(timeout)}`, async function () {
        const getVisitorID = sinon.stub().resolves('alloy-123');
        window.alloySDK = loadedSdk(getVisitorID);

        await fetchId({ params: { timeout } });

        sinon.assert.calledOnceWithExactly(getVisitorID, { timeout: 300 });
      });
    });

    it('should queue the command and give up after 1000 ms when the SDK is missing', function () {
      clock = sinon.useFakeTimers();
      delete window.alloySDK;
      const callback = sinon.spy();

      getId({}).callback(callback);

      expect(window.alloySDK).to.be.an('array').with.lengthOf(1);

      clock.tick(999);
      sinon.assert.notCalled(callback);

      clock.tick(1);
      sinon.assert.calledOnce(callback);
      expect(callback.firstCall.args[0]).to.be.undefined;
    });

    it('should use an existing command queue instead of replacing it', function () {
      clock = sinon.useFakeTimers();
      const existingCommand = () => {};
      const queue = [existingCommand];
      window.alloySDK = queue;

      getId({}).callback(sinon.spy());

      expect(window.alloySDK).to.equal(queue);
      expect(queue).to.have.lengthOf(2);
      expect(queue[0]).to.equal(existingCommand);
    });

    it('should deliver the id when the SDK loads after the command was queued', async function () {
      delete window.alloySDK;
      const callback = sinon.spy();

      getId({}).callback(callback);

      // the SDK replaces the queue with itself and then runs the queued commands
      const queue = window.alloySDK;
      window.alloySDK = loadedSdk(sinon.stub().resolves('alloy-late'));
      queue.forEach((command) => command());
      await flushPromises();

      sinon.assert.calledOnceWithExactly(callback, 'alloy-late');
    });

    it('should honor params.sdkTimeout', function () {
      clock = sinon.useFakeTimers();
      delete window.alloySDK;
      const callback = sinon.spy();

      getId({ params: { sdkTimeout: 200 } }).callback(callback);

      clock.tick(199);
      sinon.assert.notCalled(callback);

      clock.tick(1);
      sinon.assert.calledOnce(callback);
    });

    ['200', -1, 0, NaN, Infinity, null].forEach((sdkTimeout) => {
      it(`should fall back to 1000 ms for params.sdkTimeout = ${String(sdkTimeout)}`, function () {
        clock = sinon.useFakeTimers();
        delete window.alloySDK;
        const callback = sinon.spy();

        getId({ params: { sdkTimeout } }).callback(callback);

        clock.tick(999);
        sinon.assert.notCalled(callback);

        clock.tick(1);
        sinon.assert.calledOnce(callback);
      });
    });

    it('should return no id when the SDK has no identity API', async function () {
      window.alloySDK = { push: (command) => command() };

      expect(await fetchId()).to.be.undefined;
    });

    it('should return no id when getVisitorID rejects', async function () {
      window.alloySDK = loadedSdk(sinon.stub().rejects(new Error('no consent')));

      expect(await fetchId()).to.be.undefined;
    });

    it('should return no id when getVisitorID throws', async function () {
      window.alloySDK = loadedSdk(sinon.stub().throws(new Error('boom')));

      expect(await fetchId()).to.be.undefined;
    });

    it('should return no id when pushing to the SDK throws', async function () {
      window.alloySDK = {
        push: () => {
          throw new Error('broken sdk');
        }
      };

      expect(await fetchId()).to.be.undefined;
    });

    ['', null, undefined, {}, 42].forEach((value) => {
      it(`should return no id when getVisitorID resolves with ${JSON.stringify(value)}`, async function () {
        window.alloySDK = loadedSdk(sinon.stub().resolves(value));

        expect(await fetchId()).to.be.undefined;
      });
    });

    it('should ignore an id that arrives after the SDK timeout', async function () {
      clock = sinon.useFakeTimers();
      let resolveVisitorId;
      window.alloySDK = loadedSdk(() => new Promise((resolve) => {
        resolveVisitorId = resolve;
      }));
      const callback = sinon.spy();

      getId({}).callback(callback);
      clock.tick(1000);
      resolveVisitorId('alloy-too-late');
      await flushPromises();

      sinon.assert.calledOnce(callback);
      expect(callback.firstCall.args[0]).to.be.undefined;
    });

    describe('loading the SDK', function () {
      const withSdk = { params: { sdk: { appId: 'examplech_de_web', tenant: 'acme' } } };

      it('should configure and load the SDK as soon as getId is called', function () {
        getId(withSdk);

        expect(window._alloyappid).to.equal('examplech_de_web');
        expect(window._alloytenant).to.equal('acme');
        sinon.assert.calledOnce(loadExternalScriptStub);
        const [url, moduleType, moduleName] = loadExternalScriptStub.firstCall.args;
        expect(url).to.match(/^https:\/\/cdn\.alloy\.ch\/client-sdk\/2\.x\.x\/alloy-sdk\.umd\.js\?ts=\d+$/);
        expect(moduleType).to.equal('userId');
        expect(moduleName).to.equal('alloyId');
      });

      it('should deliver the id of the SDK it loaded', async function () {
        const callback = sinon.spy();

        getId(withSdk).callback(callback);

        // the script arrives: the SDK replaces the queue with itself and runs the queued commands
        const queue = window.alloySDK;
        window.alloySDK = loadedSdk(sinon.stub().resolves('alloy-123'));
        queue.forEach((command) => command());
        await flushPromises();

        sinon.assert.calledOnceWithExactly(callback, 'alloy-123');
      });

      it('should not load the SDK again on a refresh', function () {
        getId(withSdk);
        getId(withSdk);

        sinon.assert.calledOnce(loadExternalScriptStub);
      });

      it('should use an SDK that is on the page instead of loading one', async function () {
        window.alloySDK = loadedSdk(sinon.stub().resolves('alloy-123'));

        expect(await fetchId(withSdk)).to.equal('alloy-123');
        sinon.assert.notCalled(loadExternalScriptStub);
        expect(window._alloyappid).to.be.undefined;
      });
    });

    describe('without consent', function () {
      const withSdk = { params: { sdk: { appId: 'examplech_de_web' } } };

      [
        ['consent for purpose 1', tcfConsent({ purpose1: false })],
        ['consent for the Alloy vendor', tcfConsent({ vendor: false })],
        ['TCF consent data', {}],
        ['an answer of the CMP', { gdpr: { gdprApplies: false, vendorData: undefined } }]
      ].forEach(([what, consent]) => {
        it(`should neither load nor ask the SDK without ${what}`, function () {
          const getVisitorID = sinon.stub().resolves('alloy-123');
          const handle = storageHandle();

          const result = getId(withSdk, handle, consent);

          expect(result).to.be.undefined;
          sinon.assert.notCalled(loadExternalScriptStub);
          expect(window._alloyappid).to.be.undefined;
          expect(window.alloySDK).to.be.undefined;

          window.alloySDK = loadedSdk(getVisitorID);
          expect(getId(withSdk, handle, consent)).to.be.undefined;
          sinon.assert.notCalled(getVisitorID);
        });
      });

      it('should still drop an id it provided earlier', function () {
        const handle = storageHandle();

        getId(withSdk, handle, tcfConsent({ vendor: false }));

        sinon.assert.calledOnce(handle.manage);
      });
    });

    it('should take over storage management, so the User ID module stores nothing', function () {
      const handle = storageHandle();

      getId({}, handle);

      sinon.assert.calledOnce(handle.manage);
    });

    it('should never write or delete stored data itself', async function () {
      const handle = storageHandle();

      window.alloySDK = loadedSdk(sinon.stub().resolves('alloy-123'));
      await fetchId({}, handle);
      window.alloySDK = loadedSdk(sinon.stub().resolves(''));
      await fetchId({}, handle);

      sinon.assert.notCalled(handle.set);
      sinon.assert.notCalled(handle.touch);
      sinon.assert.notCalled(handle.remove);
    });

    it('should not ask the SDK for an id when it loads after the SDK timeout', function () {
      clock = sinon.useFakeTimers();
      delete window.alloySDK;
      const getVisitorID = sinon.stub().resolves('alloy-too-late');

      getId({}).callback(sinon.spy());
      clock.tick(1000);

      const queue = window.alloySDK;
      window.alloySDK = loadedSdk(getVisitorID);
      queue.forEach((command) => command());

      sinon.assert.notCalled(getVisitorID);
    });

    it('should not report twice when the timeout fires after the id arrived', async function () {
      clock = sinon.useFakeTimers();
      window.alloySDK = loadedSdk(sinon.stub().resolves('alloy-123'));
      const callback = sinon.spy();

      getId({}).callback(callback);
      await flushPromises();
      clock.tick(5000);

      sinon.assert.calledOnceWithExactly(callback, 'alloy-123');
    });
  });

  describe('with the User ID module', function () {
    function startUserId(userIdConfig = { name: 'alloyId' }) {
      init(config);
      setSubmoduleRegistry([alloyIdSubmodule]);
      config.setConfig({
        userSync: {
          syncDelay: 0,
          auctionDelay: 100,
          userIds: [userIdConfig]
        }
      });
    }

    function alloyEids() {
      return (getGlobal().getUserIdsAsEids() || []).filter((eid) => eid.source === 'alloy.ch');
    }

    const STORAGE_NAME = 'alloyId_spec';
    const withStorage = { name: 'alloyId', storage: { type: 'html5', name: STORAGE_NAME, expires: 30 } };

    function clearStorage() {
      HTML5_SUFFIXES.forEach((suffix) => coreStorage.removeDataFromLocalStorage(STORAGE_NAME + suffix));
    }

    // a stored id the User ID module considers current: not expired, same consent
    function seedStorage(id) {
      coreStorage.setDataInLocalStorage(STORAGE_NAME, id);
      coreStorage.setDataInLocalStorage(`${STORAGE_NAME}_exp`, new Date(Date.now() + 86400000).toUTCString());
      coreStorage.setDataInLocalStorage(`${STORAGE_NAME}_cst`, getConsentHash());
    }

    before(function () {
      hook.ready();
    });

    beforeEach(function () {
      allConsent.reset();
      // as the TCF consent management module does
      gdprDataHandler.enable();
      gdprDataHandler.setConsentData(tcfConsent().gdpr);
      clearStorage();
    });

    afterEach(function () {
      clearStorage();
      config.resetConfig();
      allConsent.reset();
      init(config);
    });

    it('should provide no id when the user has not consented', async function () {
      const getVisitorID = sinon.stub().resolves('alloy-123');
      window.alloySDK = loadedSdk(getVisitorID);
      gdprDataHandler.setConsentData(tcfConsent({ vendor: false }).gdpr);

      startUserId();
      await getGlobal().getUserIdsAsync();

      sinon.assert.notCalled(getVisitorID);
      expect(getGlobal().getUserIds().alloyId).to.be.undefined;
    });

    it('should provide the id and its eid without a storage config', async function () {
      window.alloySDK = loadedSdk(sinon.stub().resolves('alloy-123'));

      startUserId();
      await getGlobal().getUserIdsAsync();

      expect(getGlobal().getUserIds().alloyId).to.equal('alloy-123');
      expect(alloyEids()).to.deep.equal([{
        source: 'alloy.ch',
        uids: [{ id: 'alloy-123', atype: 1 }]
      }]);
    });

    it('should drop the id when a refresh finds none', async function () {
      const getVisitorID = sinon.stub();
      getVisitorID.onFirstCall().resolves('alloy-123');
      getVisitorID.onSecondCall().rejects(new Error('no consent'));
      window.alloySDK = loadedSdk(getVisitorID);

      startUserId();
      await getGlobal().getUserIdsAsync();
      expect(getGlobal().getUserIds().alloyId).to.equal('alloy-123');

      await getGlobal().refreshUserIds();
      await getGlobal().getUserIdsAsync();

      sinon.assert.calledTwice(getVisitorID);
      expect(getGlobal().getUserIds().alloyId).to.be.undefined;
      expect(alloyEids()).to.deep.equal([]);
    });

    it('should not expose the previous id while a refresh waits for the SDK', async function () {
      const getVisitorID = sinon.stub();
      getVisitorID.onFirstCall().resolves('alloy-123');
      getVisitorID.onSecondCall().returns(new Promise(() => {}));
      window.alloySDK = loadedSdk(getVisitorID);

      startUserId();
      await getGlobal().getUserIdsAsync();
      expect(getGlobal().getUserIds().alloyId).to.equal('alloy-123');

      getGlobal().refreshUserIds();
      for (let i = 0; i < 20 && getVisitorID.callCount < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve));
      }

      sinon.assert.calledTwice(getVisitorID);
      expect(getGlobal().getUserIds().alloyId).to.be.undefined;
    });

    it('should not write the id to a configured storage', async function () {
      window.alloySDK = loadedSdk(sinon.stub().resolves('alloy-123'));

      startUserId(withStorage);
      await getGlobal().getUserIdsAsync();

      expect(getGlobal().getUserIds().alloyId).to.equal('alloy-123');
      expect(coreStorage.getDataFromLocalStorage(STORAGE_NAME)).to.not.exist;
    });

    it('should ask the SDK and not use an id found in a configured storage', async function () {
      const getVisitorID = sinon.stub().resolves('');
      window.alloySDK = loadedSdk(getVisitorID);
      seedStorage('stale-alloy-id');

      startUserId(withStorage);
      await getGlobal().getUserIdsAsync();

      sinon.assert.calledOnce(getVisitorID);
      expect(getGlobal().getUserIds().alloyId).to.be.undefined;
      expect(alloyEids()).to.deep.equal([]);
    });

    it('should provide no id and no eid when the SDK has none', async function () {
      window.alloySDK = loadedSdk(sinon.stub().resolves(''));

      startUserId();
      await getGlobal().getUserIdsAsync();

      expect(getGlobal().getUserIds().alloyId).to.be.undefined;
      expect(alloyEids()).to.deep.equal([]);
    });
  });
});
