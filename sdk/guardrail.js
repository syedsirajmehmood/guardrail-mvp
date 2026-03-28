/**
 * Guardrail SDK v2.0.0
 * The AI Escalation Intelligence Layer
 * https://guardrail.dev
 *
 * Usage:
 *   const gr = new Guardrail({ apiKey: 'gr_live_xxxx', context: 'medical' });
 *   const result = await gr.check(aiResponseText, { userId: 'u123' });
 *   // result: { decision: 'deliver'|'flag'|'escalate', confidence: 0-1, reasons: [], id: '...' }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Guardrail = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HOSTED_ENDPOINT = 'https://api.guardrail.dev';

  var _defaults = {
    endpoint: HOSTED_ENDPOINT,
    apiKey: null,
    context: 'general',
    onDeliver: null,
    onFlag: null,
    onEscalate: null,
    onError: null,
    debug: false
  };

  function Guardrail(options) {
    this.config = Object.assign({}, _defaults, options || {});
    if (!this.config.apiKey) {
      throw new Error('Guardrail: apiKey is required. Get yours at https://guardrail.dev');
    }
    this._log('Guardrail v2.0.0 initialized →', this.config.endpoint);
  }

  Guardrail.prototype._log = function () {
    if (this.config.debug) {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[Guardrail]');
      console.log.apply(console, args);
    }
  };

  Guardrail.prototype._headers = function () {
    return {
      'Content-Type': 'application/json',
      'X-Guardrail-Key': this.config.apiKey
    };
  };

  Guardrail.prototype.check = function (text, options) {
    var self = this;
    var opts = Object.assign({ context: self.config.context }, options || {});
    self._log('check()', text.substring(0, 60) + '...');

    return fetch(self.config.endpoint + '/api/check', {
      method: 'POST',
      headers: self._headers(),
      body: JSON.stringify({
        text: text,
        context: opts.context,
        userId: opts.userId || 'anonymous',
        metadata: opts.metadata || {}
      })
    })
      .then(function (res) {
        if (res.status === 401) throw new Error('Guardrail: Invalid or missing API key.');
        if (!res.ok) throw new Error('Guardrail API error: ' + res.status);
        return res.json();
      })
      .then(function (result) {
        self._log('decision:', result.decision, 'confidence:', result.confidence);
        if (result.decision === 'deliver' && typeof self.config.onDeliver === 'function') self.config.onDeliver(result);
        if (result.decision === 'flag' && typeof self.config.onFlag === 'function') self.config.onFlag(result);
        if (result.decision === 'escalate' && typeof self.config.onEscalate === 'function') self.config.onEscalate(result);
        return result;
      })
      .catch(function (err) {
        self._log('Error:', err.message);
        if (typeof self.config.onError === 'function') self.config.onError(err);
        throw err;
      });
  };

  Guardrail.prototype.stream = function (callback) {
    var self = this;
    var es = new EventSource(self.config.endpoint + '/api/events?key=' + self.config.apiKey);
    es.onmessage = function (e) {
      try { callback(JSON.parse(e.data)); } catch (ex) { }
    };
    es.onerror = function () { self._log('SSE connection error'); };
    return { close: function () { es.close(); } };
  };

  Guardrail.prototype.getStats = function () {
    var self = this;
    return fetch(self.config.endpoint + '/api/stats', { headers: self._headers() })
      .then(function (r) { return r.json(); });
  };

  Guardrail.prototype.getLogs = function (limit) {
    var self = this;
    return fetch(self.config.endpoint + '/api/logs?limit=' + (limit || 50), { headers: self._headers() })
      .then(function (r) { return r.json(); });
  };

  return Guardrail;
}));
