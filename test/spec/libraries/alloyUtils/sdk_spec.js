import { expect } from 'chai';
import { ALLOY_GVLID, callAlloySdk, hasAlloyConsent, loadAlloySdk, queueAlloyCommand } from 'libraries/alloyUtils/sdk.ts';
import { loadExternalScriptStub } from 'test/mocks/adloaderStub.js';
import * as utils from 'src/utils.js';

// every global the library or the Alloy SDK may leave on the page
const ALLOY_GLOBALS = [
  'alloySDK', 'alloyDataLayer', 'ringDataLayer', '_alloytenant', '_alloyenv', '_alloyappid',
  '_alloyconsentcookiename', '_alloyautostart', '_alloystarted', '_alloytracking', '_alloyadtracking',
  '_alloypageviewautotracking', '_datalayerautotracking', '_alloyvisitorreadonly', '_alloyskipeventstracking',
  '_hasdlapi', '_setaudiencekv'
];

function clearAlloyGlobals() {
  ALLOY_GLOBALS.forEach((name) => delete window[name]);
}

// consent data as the consent management module provides it
function tcfConsent({ gdprApplies = true, purpose1 = true, vendor = true } = {}) {
  return {
    gdpr: {
      gdprApplies,
      vendorData: {
        purpose: { consents: { 1: purpose1 } },
        vendor: { consents: { [ALLOY_GVLID]: vendor } }
      }
    }
  };
}

describe('alloyUtils sdk', function () {
  const SDK_URL = 'https://cdn.alloy.ch/client-sdk/2.x.x/alloy-sdk.umd.js';
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  let clock;
  let logErrorStub;

  // a loaded SDK runs queued commands right away
  function loadedSdk(api = {}) {
    return { push: (command) => command(), identity: {}, ...api };
  }

  async function flushPromises() {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(function () {
    clearAlloyGlobals();
    logErrorStub = sinon.stub(utils, 'logError');
  });

  afterEach(function () {
    logErrorStub.restore();
    if (clock) {
      clock.restore();
      clock = undefined;
    }
    clearAlloyGlobals();
  });

  describe('hasAlloyConsent', function () {
    it('should allow with purpose 1 and vendor consent', function () {
      expect(hasAlloyConsent(tcfConsent())).to.equal(true);
    });

    it('should allow when the CMP says that GDPR does not apply', function () {
      expect(hasAlloyConsent(tcfConsent({ gdprApplies: false, purpose1: false, vendor: false }))).to.equal(true);
    });

    it('should deny without purpose 1 consent', function () {
      expect(hasAlloyConsent(tcfConsent({ purpose1: false }))).to.equal(false);
    });

    it('should deny without consent for the Alloy vendor', function () {
      expect(hasAlloyConsent(tcfConsent({ vendor: false }))).to.equal(false);
    });

    it('should deny when there is no TCF consent data, as without the TCF consent module', function () {
      expect(hasAlloyConsent(undefined)).to.equal(false);
      expect(hasAlloyConsent(null)).to.equal(false);
      expect(hasAlloyConsent({})).to.equal(false);
      expect(hasAlloyConsent({ gdpr: null })).to.equal(false);
    });

    // what the TCF consent module provides when the CMP timed out: its default scope, no data of the CMP
    [true, false, undefined].forEach((gdprApplies) => {
      it(`should deny when the CMP did not answer (gdprApplies = ${gdprApplies})`, function () {
        expect(hasAlloyConsent({ gdpr: { gdprApplies, vendorData: undefined } })).to.equal(false);
      });
    });
  });

  describe('loadAlloySdk', function () {
    const load = (params) => loadAlloySdk(params, 'userId', 'alloyId');

    it('should configure the SDK with the defaults of the Ringier tag manager', function () {
      load({ appId: 'examplech_de_web' });

      expect(window._alloyappid).to.equal('examplech_de_web');
      expect(window._alloytenant).to.equal('riad');
      expect(window._alloyenv).to.equal('prod');
      expect(window._alloyconsentcookiename).to.equal('eupubconsent-v2');
      expect(window._alloyautostart).to.equal(true);
      expect(window._alloytracking).to.equal(true);
      expect(window._alloyadtracking).to.equal(true);
      expect(window._alloypageviewautotracking).to.equal(false);
      expect(window._datalayerautotracking).to.equal(false);
      expect(window._alloyvisitorreadonly).to.equal(false);
      expect(window._alloyskipeventstracking).to.equal(false);
    });

    it('should pass configured values to the SDK', function () {
      load({
        appId: 'examplech_de_web',
        tenant: 'acme',
        env: 'stg',
        consentCookieName: 'my-consent',
        autoStart: false,
        tracking: false,
        adTracking: false,
        pageViewAutoTracking: true,
        dataLayerAutoTracking: true,
        visitorReadOnly: true,
        skipEventsTracking: true
      });

      expect(window._alloytenant).to.equal('acme');
      expect(window._alloyenv).to.equal('stg');
      expect(window._alloyconsentcookiename).to.equal('my-consent');
      expect(window._alloyautostart).to.equal(false);
      expect(window._alloytracking).to.equal(false);
      expect(window._alloyadtracking).to.equal(false);
      expect(window._alloypageviewautotracking).to.equal(true);
      expect(window._datalayerautotracking).to.equal(true);
      expect(window._alloyvisitorreadonly).to.equal(true);
      expect(window._alloyskipeventstracking).to.equal(true);
    });

    it('should not set the globals the SDK does not read', function () {
      load({ appId: 'examplech_de_web' });

      expect(window).to.not.have.property('_hasdlapi');
      expect(window).to.not.have.property('_setaudiencekv');
    });

    it('should create the command queue', function () {
      load({ appId: 'examplech_de_web' });

      expect(window.alloySDK).to.be.an('array').that.is.empty;
    });

    it('should keep commands that were queued before', function () {
      const command = () => {};
      window.alloySDK = [command];

      load({ appId: 'examplech_de_web' });

      expect(window.alloySDK).to.deep.equal([command]);
    });

    it('should load the SDK as a module script, for the calling module', function () {
      load({ appId: 'examplech_de_web' });

      sinon.assert.calledOnce(loadExternalScriptStub);
      const [url, moduleType, moduleName, callback, doc, attributes] = loadExternalScriptStub.firstCall.args;
      expect(url.split('?')[0]).to.equal(SDK_URL);
      expect(moduleType).to.equal('userId');
      expect(moduleName).to.equal('alloyId');
      expect(callback).to.be.undefined;
      expect(doc).to.equal(document);
      expect(attributes).to.deep.equal({ type: 'module' });
    });

    it('should add a cache buster that changes once a week to a floating version', function () {
      clock = sinon.useFakeTimers(new Date('2026-11-26T12:00:00Z').getTime());

      load({ appId: 'examplech_de_web' });

      const expected = Math.floor(Date.now() / WEEK) * WEEK;
      expect(loadExternalScriptStub.firstCall.args[0]).to.equal(`${SDK_URL}?ts=${expected}`);
    });

    it('should load a pinned version as it is', function () {
      const pinned = 'https://cdn.alloy.ch/client-sdk/2.4.1/alloy-sdk.umd.js';

      load({ appId: 'examplech_de_web', scriptUrl: pinned });

      expect(loadExternalScriptStub.firstCall.args[0]).to.equal(pinned);
    });

    it('should pass the SSO id and the external ids in the Alloy data layer', function () {
      load({ appId: 'examplech_de_web', ssoId: 'sso-1', externalIds: { 'one-id': 'one-1' } });

      expect(window.alloyDataLayer.user).to.deep.equal({
        sso: { id: 'sso-1' },
        externalIds: { 'one-id': 'one-1' }
      });
    });

    it('should fall back to the SSO id of the Ring data layer', function () {
      window.ringDataLayer = { user: { sso: { logged: { id: 'ring-sso' } } } };

      load({ appId: 'examplech_de_web' });

      expect(window.alloyDataLayer.user.sso).to.deep.equal({ id: 'ring-sso' });
    });

    it('should keep what the page already put in the Alloy data layer', function () {
      window.alloyDataLayer = {
        context: { logicalPath: 'example/home', contentId: '42' },
        user: { externalIds: { other: 'x' }, custom: true }
      };

      load({ appId: 'examplech_de_web', externalIds: { 'one-id': 'one-1' } });

      expect(window.alloyDataLayer.context).to.deep.equal({ logicalPath: 'example/home', contentId: '42' });
      expect(window.alloyDataLayer.user.custom).to.equal(true);
      expect(window.alloyDataLayer.user.externalIds).to.deep.equal({ other: 'x', 'one-id': 'one-1' });
    });

    it('should ignore external ids that are not non-empty strings', function () {
      load({ appId: 'examplech_de_web', externalIds: { a: '', b: 5, c: null, d: 'ok' } });

      expect(window.alloyDataLayer.user.externalIds).to.deep.equal({ d: 'ok' });
    });

    it('should not load twice', function () {
      load({ appId: 'examplech_de_web' });
      load({ appId: 'examplech_de_web', tenant: 'other' });

      sinon.assert.calledOnce(loadExternalScriptStub);
      expect(window._alloytenant).to.equal('riad');
    });

    it('should leave an SDK alone that something else has started', function () {
      window._alloyappid = 'tagmanager_web';
      window._alloytenant = 'theirs';

      load({ appId: 'examplech_de_web' });

      sinon.assert.notCalled(loadExternalScriptStub);
      expect(window._alloyappid).to.equal('tagmanager_web');
      expect(window._alloytenant).to.equal('theirs');
      expect(window.alloyDataLayer).to.be.undefined;
    });

    it('should leave an SDK alone that is already loaded', function () {
      const sdk = loadedSdk();
      window.alloySDK = sdk;

      load({ appId: 'examplech_de_web' });

      sinon.assert.notCalled(loadExternalScriptStub);
      expect(window.alloySDK).to.equal(sdk);
      expect(window._alloyappid).to.be.undefined;
    });

    it('should configure nothing when the publisher denies loading external scripts', function () {
      loadExternalScriptStub.returns(undefined);

      load({ appId: 'examplech_de_web' });

      expect(window._alloyappid).to.be.undefined;
      expect(window._alloytenant).to.be.undefined;
      expect(window.alloyDataLayer).to.be.undefined;
    });

    it('should let another module load the SDK after one was denied', function () {
      loadExternalScriptStub.onFirstCall().returns(undefined);

      loadAlloySdk({ appId: 'examplech_de_web' }, 'userId', 'alloyId');
      loadAlloySdk({ appId: 'examplech_de_web' }, 'rtd', 'alloy');

      sinon.assert.calledTwice(loadExternalScriptStub);
      expect(loadExternalScriptStub.secondCall.args[2]).to.equal('alloy');
      expect(window._alloyappid).to.equal('examplech_de_web');
    });

    it('should not load when load is false', function () {
      load({ appId: 'examplech_de_web', load: false });

      sinon.assert.notCalled(loadExternalScriptStub);
      expect(window._alloyappid).to.be.undefined;
    });

    ['', undefined, null, 42].forEach((appId) => {
      it(`should not load and should log an error for appId = ${JSON.stringify(appId)}`, function () {
        load({ appId });

        sinon.assert.notCalled(loadExternalScriptStub);
        sinon.assert.calledOnce(logErrorStub);
        expect(window._alloytenant).to.be.undefined;
      });
    });

    it('should not load and should log an error without params', function () {
      load(undefined);

      sinon.assert.notCalled(loadExternalScriptStub);
      sinon.assert.calledOnce(logErrorStub);
    });

    it('should stay quiet without params when an SDK is already loaded', function () {
      window.alloySDK = loadedSdk();

      load(undefined);

      sinon.assert.notCalled(logErrorStub);
    });
  });

  describe('queueAlloyCommand', function () {
    it('should run the command right away on a loaded SDK', function () {
      const sdk = loadedSdk();
      window.alloySDK = sdk;
      const command = sinon.spy();

      queueAlloyCommand(command);

      sinon.assert.calledOnceWithExactly(command, sdk);
    });

    it('should keep the command for an SDK that loads later, however late', function () {
      clock = sinon.useFakeTimers();
      const command = sinon.spy();

      queueAlloyCommand(command);
      clock.tick(60000);

      const queue = window.alloySDK;
      const sdk = loadedSdk();
      window.alloySDK = sdk;
      queue.forEach((queued) => queued());

      sinon.assert.calledOnceWithExactly(command, sdk);
    });

    it('should not let a failing command break the SDK queue', function () {
      window.alloySDK = loadedSdk();

      expect(() => queueAlloyCommand(() => {
        throw new Error('boom');
      })).to.not.throw();
    });

    it('should not throw when pushing to the SDK throws', function () {
      window.alloySDK = {
        push: () => {
          throw new Error('broken sdk');
        }
      };

      expect(() => queueAlloyCommand(() => {})).to.not.throw();
    });
  });

  describe('callAlloySdk', function () {
    it('should hand the loaded SDK to the command and report its result', function () {
      const sdk = loadedSdk();
      window.alloySDK = sdk;
      const command = sinon.stub().returns('result');
      const done = sinon.spy();

      callAlloySdk(command, 1000, done);

      sinon.assert.calledOnceWithExactly(command, sdk);
      sinon.assert.calledOnceWithExactly(done, 'result');
    });

    it('should wait for a promise the command returns', async function () {
      window.alloySDK = loadedSdk();
      const done = sinon.spy();

      callAlloySdk(() => Promise.resolve('later'), 1000, done);
      sinon.assert.notCalled(done);
      await flushPromises();

      sinon.assert.calledOnceWithExactly(done, 'later');
    });

    it('should queue the command and give up after the timeout when the SDK is missing', function () {
      clock = sinon.useFakeTimers();
      const command = sinon.spy();
      const done = sinon.spy();

      callAlloySdk(command, 1000, done);

      expect(window.alloySDK).to.be.an('array').with.lengthOf(1);
      clock.tick(999);
      sinon.assert.notCalled(done);
      clock.tick(1);
      sinon.assert.calledOnce(done);
      expect(done.firstCall.args[0]).to.be.undefined;
      sinon.assert.notCalled(command);
    });

    it('should use an existing queue instead of replacing it', function () {
      clock = sinon.useFakeTimers();
      const existing = () => {};
      const queue = [existing];
      window.alloySDK = queue;

      callAlloySdk(() => {}, 1000, sinon.spy());

      expect(window.alloySDK).to.equal(queue);
      expect(queue).to.have.lengthOf(2);
      expect(queue[0]).to.equal(existing);
    });

    it('should run the command against the SDK that replaced the queue', async function () {
      const done = sinon.spy();

      callAlloySdk((sdk) => sdk.identity.getVisitorID(), 1000, done);

      // the SDK replaces the queue with itself and then runs the queued commands
      const queue = window.alloySDK;
      window.alloySDK = loadedSdk({ identity: { getVisitorID: () => Promise.resolve('alloy-late') } });
      queue.forEach((command) => command());
      await flushPromises();

      sinon.assert.calledOnceWithExactly(done, 'alloy-late');
    });

    it('should not run the command when the SDK loads after the timeout', function () {
      clock = sinon.useFakeTimers();
      const command = sinon.spy();

      callAlloySdk(command, 1000, sinon.spy());
      clock.tick(1000);

      const queue = window.alloySDK;
      window.alloySDK = loadedSdk();
      queue.forEach((queued) => queued());

      sinon.assert.notCalled(command);
    });

    it('should report nothing when the command throws', function () {
      window.alloySDK = loadedSdk();
      const done = sinon.spy();

      callAlloySdk(() => {
        throw new Error('boom');
      }, 1000, done);

      sinon.assert.calledOnce(done);
      expect(done.firstCall.args[0]).to.be.undefined;
    });

    it('should report nothing when the command rejects', async function () {
      window.alloySDK = loadedSdk();
      const done = sinon.spy();

      callAlloySdk(() => Promise.reject(new Error('no consent')), 1000, done);
      await flushPromises();

      sinon.assert.calledOnce(done);
      expect(done.firstCall.args[0]).to.be.undefined;
    });

    it('should report nothing when pushing to the SDK throws', function () {
      window.alloySDK = {
        push: () => {
          throw new Error('broken sdk');
        }
      };
      const done = sinon.spy();

      callAlloySdk(() => 'never', 1000, done);

      sinon.assert.calledOnce(done);
      expect(done.firstCall.args[0]).to.be.undefined;
    });

    it('should ignore a result that arrives after the timeout', async function () {
      clock = sinon.useFakeTimers();
      window.alloySDK = loadedSdk();
      let resolveCommand;
      const done = sinon.spy();

      callAlloySdk(() => new Promise((resolve) => {
        resolveCommand = resolve;
      }), 1000, done);
      clock.tick(1000);
      resolveCommand('too late');
      await flushPromises();

      sinon.assert.calledOnce(done);
      expect(done.firstCall.args[0]).to.be.undefined;
    });

    it('should not report twice when the timeout fires after the result arrived', function () {
      clock = sinon.useFakeTimers();
      window.alloySDK = loadedSdk();
      const done = sinon.spy();

      callAlloySdk(() => 'result', 1000, done);
      clock.tick(5000);

      sinon.assert.calledOnceWithExactly(done, 'result');
    });
  });
});
