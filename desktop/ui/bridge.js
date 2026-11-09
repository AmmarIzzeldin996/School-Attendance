/* جسر google.script.run إلى خادم سطح المكتب المحلي. */
(function () {
  'use strict';
  if (window.google && window.google.script && window.google.script.run) return;

  function transport(request) {
    return fetch('/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request)
    }).then(function (response) {
      return response.text().then(function (text) {
        if (!response.ok) {
          var message = 'تعذر تنفيذ الطلب (' + response.status + ').';
          try { var parsed = JSON.parse(text); message = parsed.message || parsed.error || message; } catch (ignored) { /* نص عادي */ }
          throw new Error(message);
        }
        if (!text) throw new Error('استجابة فارغة من الخادم.');
        return JSON.parse(text);
      });
    });
  }

  function runner(successHandler, failureHandler) {
    return {
      withSuccessHandler: function (handler) { return runner(handler, failureHandler); },
      withFailureHandler: function (handler) { return runner(successHandler, handler); },
      api: function (request) {
        transport(request).then(function (response) {
          if (successHandler) {
            try { successHandler(response); } catch (error) { if (window.console) window.console.error(error); }
          }
        }).catch(function (error) {
          if (failureHandler) {
            try { failureHandler(error); } catch (ignored) { if (window.console) window.console.error(ignored); }
          }
        });
      }
    };
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = runner(null, null);
  window.google.script.host = window.google.script.host || { close: function () {} };
})();
