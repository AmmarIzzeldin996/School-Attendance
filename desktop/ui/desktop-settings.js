/* لوحة سطح المكتب: المزامنة، النسخ السحابي، استيراد الطلاب، ومعلومات الجهاز. */
(function () {
  'use strict';
  if (!window.desktopSA || !window.SA || !window.SA.ui) return;

  var ui = window.SA.ui;
  var h = ui.h;
  var state = {
    tab: 'sync',
    status: null,
    timer: null,
    backupTest: null,
    importRows: null,
    importName: ''
  };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else if (key === 'className') node.className = attrs[key];
      else if (key === 'onClick') node.addEventListener('click', attrs[key]);
      else if (key === 'onChange') node.addEventListener('change', attrs[key]);
      else if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function request(path, options) {
    var token = '';
    try { token = sessionStorage.getItem('sa36.session') || ''; } catch (ignored) { token = ''; }
    var init = Object.assign({ headers: { accept: 'application/json' } }, options || {});
    init.headers['x-session-token'] = token;
    if (init.body && typeof init.body !== 'string') {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    return fetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
        if (!response.ok) {
          var message = (data && (data.error || data.message)) || ('تعذر تنفيذ الطلب (' + response.status + ')');
          if (response.status === 401 || response.status === 403) message = 'يلزم تسجيل دخول المشرف لفتح لوحة سطح المكتب.';
          throw new Error(message);
        }
        return data;
      });
    });
  }

  function when(iso) {
    if (!iso) return 'لا يوجد';
    try {
      return new Date(iso).toLocaleString('ar-SA', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (error) { return iso; }
  }

  function alertBox(message, type) {
    if (!message) return null;
    var kind = type || 'warn';
    var node = el('div', { className: 'alert ' + kind }, [el('span', { text: message })]);
    node.appendChild(el('button', {
      type: 'button', className: 'alert-close', 'aria-label': 'إغلاق', text: '×',
      onClick: function () { if (node.parentNode) node.parentNode.removeChild(node); }
    }));
    var timer = setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); },
      kind === 'error' ? 12000 : 8000);
    node.addEventListener('mouseenter', function () { clearTimeout(timer); });
    return node;
  }

  function section(title, subtitle, nodes) {
    return el('section', { className: 'ds-section' }, [
      el('div', { className: 'ds-section-head' }, [
        el('h4', { text: title }),
        subtitle ? el('p', { className: 'hint', text: subtitle }) : null
      ])
    ].concat(nodes.filter(Boolean)));
  }

  function field(labelText, control, hint) {
    return el('label', { className: 'ds-field' }, [
      el('span', { text: labelText }),
      control,
      hint ? el('span', { className: 'hint', text: hint }) : null
    ]);
  }

  function input(value, attrs) {
    return el('input', Object.assign({ type: 'text', dir: 'auto' }, attrs || {}, { value: value == null ? '' : value }));
  }

  function button(label, onClick, kind) {
    var node = el('button', { type: 'button', className: 'btn ' + (kind || ''), text: label });
    node.addEventListener('click', function () { onClick(node); });
    return node;
  }

  function copyText(text, node) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(String(text || '')).then(function () {
      if (!node) return;
      var old = node.textContent;
      node.textContent = 'تم النسخ';
      setTimeout(function () { node.textContent = old; }, 1400);
    });
  }

  // force = true يعيد بناء اللوحة بعد إجراء صريح. الاستقصاء الدوري يحدّث
  // الحالة فقط كي لا يمسح ما يكتبه المستخدم في الحقول.
  function refresh(modal, force) {
    return request('/desktop/status').then(function (status) {
      state.status = status;
      if (force && modal && modal.body && modal.body.isConnected) render(modal);
      return status;
    }).catch(function () { return state.status; });
  }

  /* ---------------- تبويب المزامنة ---------------- */
  function syncTab() {
    var status = state.status || {};
    var sync = status.sync || {};
    var nodes = [];
    var message = el('div', { className: 'ds-alert-slot' });
    nodes.push(el('div', { className: 'ds-summary' }, [
      el('div', {}, [el('b', { text: sync.deviceName || status.deviceName || 'جهاز الحضور' }), el('span', { className: 'hint', text: ' — معرف الجهاز: ' + (sync.deviceId || '') })]),
      el('div', { className: 'hint', text: 'آخر مزامنة: ' + when(sync.lastSyncAt) + ' — عمليات معروفة: ' + (sync.ops || 0) })
    ]));
    if (sync.lastError) nodes.push(alertBox('آخر خطأ في المزامنة: ' + sync.lastError, 'warn'));

    var keyInput = input(sync.key || '', { readOnly: 'readonly', dir: 'ltr', className: 'ds-code' });
    var keyCopy = button('نسخ', function (node) { copyText(sync.key, node); }, 'sm');
    nodes.push(section('مفتاح المزامنة', 'لا يُبثّ عبر الشبكة. انسخه وأدخله يدويًا على الجهاز الآخر من «إضافة جهاز». لا تُرسله خارج شبكة المدرسة.', [
      el('div', { className: 'ds-inline' }, [keyInput, keyCopy])
    ]));

    var auto = el('input', { type: 'checkbox' });
    auto.checked = sync.auto !== false;
    auto.addEventListener('change', function () {
      request('/desktop/sync/auto', { method: 'POST', body: { auto: auto.checked } })
        .then(function () { message.innerHTML = ''; message.appendChild(alertBox('تم تحديث وضع الاكتشاف التلقائي.', 'ok')); })
        .catch(function (error) { message.innerHTML = ''; message.appendChild(alertBox(error.message, 'error')); });
    });
    nodes.push(section('الأجهزة', 'تتم المزامنة مع كل جهاز مُهيأ على نفس الشبكة. الأجهزة المستقلة تُدمج تلقائيًا دون فقدان السجلات.', [
      el('label', { className: 'ds-check' }, [auto, el('span', { text: 'اكتشاف الأجهزة تلقائيًا على الشبكة المحلية' })]),
      peersTable(sync.peers || [], message),
      addPeerForm(message),
      el('div', { className: 'ds-actions' }, [
        button('مزامنة الآن', function (node) {
          node.disabled = true;
          request('/desktop/sync/now', { method: 'POST' }).then(function (data) {
            var result = data.result || {};
            message.innerHTML = '';
            message.appendChild(alertBox('اكتملت المزامنة: ' + (result.applied || 0) + ' تغيير من ' + (result.peers || 0) + ' جهاز.' + (result.errors && result.errors.length ? ' أخطاء: ' + result.errors.join(' | ') : ''), result.errors && result.errors.length ? 'warn' : 'ok'));
            refresh(modalRef, true);
          }).catch(function (error) {
            message.innerHTML = '';
            message.appendChild(alertBox(error.message, 'error'));
          }).finally(function () { node.disabled = false; });
        }, 'primary'),
        button('تحديث الحالة', function (node) { node.disabled = true; refresh(modalRef, true).finally(function () { node.disabled = false; }); })
      ]),
      message
    ]));
    return nodes;
  }

  var modalRef = null;

  function peersTable(peers, message) {
    if (!peers.length) return el('p', { className: 'hint', text: 'لا توجد أجهزة معروفة بعد. افتح النظام على جهاز آخر على نفس الشبكة أو أضف عنوانه يدويًا.' });
    var body = peers.map(function (peer) {
      return el('tr', {}, [
        el('td', {}, [el('strong', { text: peer.name || peer.url }), el('div', { className: 'hint', dir: 'ltr', text: peer.url })]),
        el('td', {}, [el('span', {
          className: 'hint',
          text: peer.needsKey ? 'بانتظار مفتاح المزامنة' : (peer.lastError ? 'خطأ: ' + peer.lastError : 'آخر مزامنة: ' + when(peer.lastAt))
        })]),
        el('td', {}, [button('حذف', function (node) {
          node.disabled = true;
          request('/desktop/sync/peers/' + encodeURIComponent(peer.id), { method: 'DELETE' }).then(function () {
            message.innerHTML = '';
            message.appendChild(alertBox('تم حذف الجهاز من القائمة.', 'ok'));
            refresh(modalRef, true);
          }).catch(function (error) {
            message.innerHTML = '';
            message.appendChild(alertBox(error.message, 'error'));
            node.disabled = false;
          });
        }, 'sm danger')])
      ]);
    });
    return el('table', { className: 'ds-table' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: 'الجهاز' }), el('th', { text: 'الحالة' }), el('th', { text: '' })])]),
      el('tbody', {}, body)
    ]);
  }

  function addPeerForm(message) {
    var url = input('', { placeholder: 'http://192.168.1.10:43118', dir: 'ltr' });
    var key = input('', { placeholder: 'مفتاح المزامنة', dir: 'ltr' });
    var name = input('', { placeholder: 'اسم الجهاز (اختياري)' });
    return el('div', { className: 'ds-add-peer' }, [
      el('div', { className: 'ds-grid-3' }, [field('عنوان الجهاز', url), field('المفتاح', key), field('الاسم', name)]),
      button('إضافة جهاز', function (node) {
        if (!url.value.trim()) {
          message.innerHTML = '';
          message.appendChild(alertBox('أدخل عنوان الجهاز.', 'error'));
          return;
        }
        node.disabled = true;
        request('/desktop/sync/peers', { method: 'POST', body: { url: url.value.trim(), key: key.value.trim(), name: name.value.trim() } })
          .then(function () {
            url.value = ''; key.value = ''; name.value = '';
            message.innerHTML = '';
            message.appendChild(alertBox('أُضيف الجهاز. جرّب «مزامنة الآن».', 'ok'));
            refresh(modalRef, true);
          })
          .catch(function (error) {
            message.innerHTML = '';
            message.appendChild(alertBox(error.message, 'error'));
          })
          .finally(function () { node.disabled = false; });
      })
    ]);
  }

  /* ---------------- تبويب النسخ السحابي ---------------- */
  function backupTab() {
    var status = state.status || {};
    var backup = status.backup || {};
    var config = backup.config || {};
    var creds = backup.credentials || {};
    var stateInfo = backup.state || {};
    var nodes = [];
    var message = el('div', { className: 'ds-alert-slot' });

    nodes.push(el('div', { className: 'ds-summary' }, [
      el('div', {}, [el('b', { text: creds.present ? ('متصل: ' + (creds.clientEmail || '')) : 'Google غير مُهيأ' }),
        el('span', {
          className: 'hint',
          text: creds.present ? ' — ' + (creds.protectedBy || '') + ' — ' + (creds.projectId || '') : ''
        })]),
      el('div', { className: 'hint', text: 'آخر نجاح: ' + when(stateInfo.lastSuccessAt) + ' — آخر تشغيل: ' + when(stateInfo.lastRunAt) })
    ]));
    if (stateInfo.lastError) nodes.push(alertBox('آخر خطأ: ' + stateInfo.lastError, 'warn'));
    if (stateInfo.lastArchiveMode === 'google-sheet' && stateInfo.lastArchiveNote) {
      nodes.push(alertBox('تم النسخ الاحتياطي بنجاح. ' + stateInfo.lastArchiveNote, 'info'));
    } else if (stateInfo.lastArchiveMode === 'drive-files') {
      nodes.push(alertBox('النسخة السحابية الأخيرة رُفعت كملفات JSON وXLSX إلى مجلد Drive، مع تحديث الجدول المقروء.', 'ok'));
    }

    var fileInput = el('input', { type: 'file', accept: '.json,application/json' });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      file.text().then(function (text) {
        return request('/desktop/backup/credentials', { method: 'POST', body: { credentials: JSON.parse(text), test: true } });
      }).then(function (data) {
        message.innerHTML = '';
        var test = data.test || {};
        message.appendChild(alertBox(test.error ? ('حُفظت البيانات لكن فشل الاختبار: ' + test.error) : 'تم حفظ بيانات حساب الخدمة والاتصال بنجاح.', test.error ? 'warn' : 'ok'));
        state.backupTest = test;
        refresh(modalRef, true);
      }).catch(function (error) {
        message.innerHTML = '';
        message.appendChild(alertBox(error.message || 'ملف غير صالح.', 'error'));
      });
    });
    // ربط حساب Google للمشرف: الطريقة الوحيدة لرفع ملفات JSON وXLSX إلى Drive،
    // لأن حساب الخدمة لا يملك مساحة تخزين.
    var userAuth = backup.userAuth || { present: false, linked: false, email: '' };
    var oauthFile = el('input', { type: 'file', accept: '.json,application/json' });
    var oauthNodes = [];
    if (userAuth.linked) {
      oauthNodes.push(el('div', { className: 'hint', text: 'مرتبط بحساب: ' + (userAuth.email || 'حساب Google') }));
      oauthNodes.push(button('إلغاء الربط', function (node) {
        node.disabled = true;
        request('/desktop/backup/oauth/remove', { method: 'POST' }).then(function () {
          message.innerHTML = '';
          message.appendChild(alertBox('أُلغي ربط حساب Google؛ يعود النسخ إلى أرشيف جدول Google.', 'ok'));
          refresh(modalRef, true);
        }).catch(function (error) {
          message.innerHTML = '';
          message.appendChild(alertBox(error.message, 'error'));
          node.disabled = false;
        });
      }, 'sm danger'));
    } else {
      oauthNodes.push(el('div', { className: 'ds-inline' }, [oauthFile, button('ربط حساب Google', function (node) {
        var file = oauthFile.files && oauthFile.files[0];
        if (!file) {
          message.innerHTML = '';
          message.appendChild(alertBox('اختر ملف عميل OAuth (client_secret_*.json) أولًا.', 'warn'));
          return;
        }
        node.disabled = true;
        file.text().then(function (text) {
          return request('/desktop/backup/oauth/start', { method: 'POST', body: { client: JSON.parse(text) } });
        }).then(function (data) {
          if (window.desktopSA && window.desktopSA.openExternal) window.desktopSA.openExternal(data.url);
          else window.open(data.url, '_blank', 'noopener');
          message.innerHTML = '';
          message.appendChild(alertBox('أكمل الموافقة في المتصفح، ثم اضغط «تحقق من الربط».', 'info'));
        }).catch(function (error) {
          message.innerHTML = '';
          message.appendChild(alertBox(error.message || 'ملف عميل OAuth غير صالح.', 'error'));
        }).finally(function () { node.disabled = false; });
      }), button('تحقق من الربط', function (node) {
        node.disabled = true;
        request('/desktop/backup/status').then(function (status) {
          var linked = status && status.userAuth && status.userAuth.linked;
          message.innerHTML = '';
          message.appendChild(alertBox(linked
            ? 'تم ربط حساب Google بنجاح: ' + (status.userAuth.email || 'حساب Google') + '.'
            : 'لم يكتمل الربط بعد. أكمل الموافقة في المتصفح ثم أعد المحاولة.', linked ? 'ok' : 'warn'));
          if (linked) refresh(modalRef, true);
        }).catch(function (error) {
          message.innerHTML = '';
          message.appendChild(alertBox(error.message, 'error'));
        }).finally(function () { node.disabled = false; });
      }, 'sm')]));
    }
    nodes.push(section('حساب Google لرفع الملفات',
      'أنشئ عميل OAuth (نوع Desktop app) في نفس مشروع Google Cloud، فعّل Drive API، ثم ارفع ملف client_secret_*.json واربط الحساب. الصلاحية المطلوبة drive.file فقط (الملفات التي ينشئها النظام).',
      [el('div', { className: 'ds-actions' }, oauthNodes)]));

    nodes.push(section('حساب خدمة Google', 'ارفع ملف مفتاح حساب الخدمة (JSON). يُخزَّن مشفرًا على هذا الجهاز ولا يُرسل لأي طرف آخر.', [
      el('div', { className: 'ds-inline' }, [fileInput, button('اختبار الاتصال', function (node) {
        node.disabled = true;
        request('/desktop/backup/test', { method: 'POST' }).then(function (data) {
          state.backupTest = data.test || {};
          message.innerHTML = '';
          message.appendChild(alertBox('الاتصال ناجح. المجلد: ' + (data.test.folderName || '') + ' — الجدول: ' + (data.test.spreadsheetName || ''), 'ok'));
          refresh(modalRef, true);
        }).catch(function (error) {
          message.innerHTML = '';
          message.appendChild(alertBox(error.message, 'error'));
        }).finally(function () { node.disabled = false; });
      }), button('إزالة البيانات', function (node) {
        node.disabled = true;
        request('/desktop/backup/remove-credentials', { method: 'POST' }).then(function () {
          message.innerHTML = '';
          message.appendChild(alertBox('أُزيلت بيانات الاعتماد من هذا الجهاز.', 'ok'));
          refresh(modalRef, true);
        }).catch(function (error) {
          message.innerHTML = '';
          message.appendChild(alertBox(error.message, 'error'));
          node.disabled = false;
        });
      }, 'sm danger')])
    ]));

    var folder = input(config.folderName || 'School Attendance Backups');
    var sheetName = input(config.spreadsheetName || 'School Attendance Backup');
    var sheetId = input(config.spreadsheetId || '', { dir: 'ltr', placeholder: 'اتركه فارغًا للإنشاء التلقائي' });
    var auto = el('input', { type: 'checkbox' });
    auto.checked = config.auto !== false;
    nodes.push(section('إعدادات النسخ', 'نسخة JSON كاملة وملف Excel محليًا، وجدول Google مقروء. تُرفع ملفات JSON وXLSX إلى Drive عند توفر مساحة؛ وإلا يُحفظ أرشيف JSON داخل تبويب «JSON» في جدول Google.', [
      el('div', { className: 'ds-grid-3' }, [field('مجلد Drive', folder), field('اسم جدول Google', sheetName), field('معرف الجدول (اختياري)', sheetId)]),
      el('label', { className: 'ds-check' }, [auto, el('span', { text: 'نسخ تلقائي يومي في وقت النسخ الاحتياطي من الإعدادات العامة' })]),
      el('div', { className: 'ds-actions' }, [
        button('حفظ الإعدادات', function (node) {
          node.disabled = true;
          request('/desktop/backup/config', { method: 'POST', body: {
            folderName: folder.value.trim(), spreadsheetName: sheetName.value.trim(),
            spreadsheetId: sheetId.value.trim(), auto: auto.checked
          } }).then(function () {
            message.innerHTML = '';
            message.appendChild(alertBox('حُفظت إعدادات النسخ.', 'ok'));
            refresh(modalRef, true);
          }).catch(function (error) {
            message.innerHTML = '';
            message.appendChild(alertBox(error.message, 'error'));
          }).finally(function () { node.disabled = false; });
        }),
        button('نسخ الآن', function (node) {
          node.disabled = true;
          message.innerHTML = '';
          message.appendChild(alertBox('جارٍ إنشاء النسخة المحلية ورفعها إلى Google…', 'warn'));
          request('/desktop/backup/run', { method: 'POST' }).then(function (data) {
            var result = data.result || {};
            var cloud = result.cloud || null;
            var summary = 'اكتمل النسخ الاحتياطي.';
            var kind = 'ok';
            if (!cloud) {
              summary += ' (سحابي غير مُهيأ)';
            } else if (cloud.archiveMode === 'google-sheet') {
              summary = 'اكتمل النسخ الاحتياطي بنجاح: حُدّث جدول Google المقروء، وحُفظ أرشيف JSON كامل داخل تبويب «JSON»، والنسختان JSON وXLSX محفوظتان على هذا الجهاز.';
              kind = 'ok';
            } else {
              summary += ' رُفعت ملفات JSON وXLSX إلى مجلد Drive: ' + ((cloud.json && cloud.json.name) || '') + '.';
            }
            message.innerHTML = '';
            message.appendChild(alertBox(summary, kind));
            if (cloud && cloud.folderUrl) {
              message.appendChild(el('div', { className: 'ds-links' }, [
                el('a', { href: cloud.folderUrl, target: '_blank', rel: 'noreferrer', text: 'فتح مجلد Drive' }),
                el('a', { href: cloud.spreadsheetUrl, target: '_blank', rel: 'noreferrer', text: 'فتح جدول Google' })
              ]));
            }
            refresh(modalRef, true);
          }).catch(function (error) {
            message.innerHTML = '';
            message.appendChild(alertBox(error.message, 'error'));
          }).finally(function () { node.disabled = false; });
        }, 'primary'),
        button('استيراد أحدث نسخة سحابية', function (node) {
          node.disabled = true;
          request('/desktop/backup/import-latest', { method: 'POST' }).then(function (data) {
            var imported = data.result || {};
            message.innerHTML = '';
            message.appendChild(alertBox('نُزّلت النسخة «' + (imported.name || '') + '» إلى النسخ المحلية' +
              (imported.archiveMode === 'google-sheet' ? ' (من تبويب JSON في جدول Google)' : ' (من ملفات Drive)') +
              '. استعدها من تبويب النسخ الاحتياطي في الإعدادات.', 'ok'));
          }).catch(function (error) {
            message.innerHTML = '';
            message.appendChild(alertBox(error.message, 'error'));
          }).finally(function () { node.disabled = false; });
        }),
        button('فتح مجلد النسخ المحلية', function () {
          if (window.desktopSA.openBackups) window.desktopSA.openBackups();
          else window.desktopSA.openDataFolder();
        })
      ]),
      message,
      el('p', {
        className: 'hint',
        dir: 'ltr',
        text: (status.dataDir || '') + '\\backups\\exports'
      })
    ]));

    if (state.backupTest && !state.backupTest.error) {
      nodes.push(section('روابط سحابية', '', [
        el('div', { className: 'ds-links' }, [
          el('a', { href: state.backupTest.folderUrl, target: '_blank', rel: 'noreferrer', text: 'مجلد النسخ في Drive' }),
          el('a', { href: state.backupTest.spreadsheetUrl, target: '_blank', rel: 'noreferrer', text: 'جدول Google المقروء' })
        ])
      ]));
    }
    return nodes;
  }

  /* ---------------- تبويب استيراد الطلاب ---------------- */
  function importTab() {
    var nodes = [];
    var message = el('div', { className: 'ds-alert-slot' });
    var preview = el('div', { className: 'ds-preview' });
    var fileInput = el('input', { type: 'file', accept: '.xlsx,.xls,.csv' });
    var runButton = button('استيراد الطلاب', function (node) { runImport(node, message, preview); }, 'primary');
    runButton.disabled = true;

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      state.importRows = null;
      state.importName = file.name;
      preview.innerHTML = '';
      preview.appendChild(el('p', { className: 'hint', text: 'جارٍ تحليل الملف…' }));
      file.arrayBuffer().then(function (buffer) {
        return fetch('/desktop/parse-students', { method: 'POST', body: buffer, headers: { 'content-type': 'application/octet-stream' } });
      }).then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) throw new Error((data && data.error) || 'تعذر تحليل الملف.');
          return data;
        });
      }).then(function (data) {
        state.importRows = data.students || [];
        renderPreview(preview, data, runButton, message);
      }).catch(function (error) {
        preview.innerHTML = '';
        preview.appendChild(alertBox(error.message, 'error'));
      });
    });

    nodes.push(section('استيراد الطلاب من ملف', 'يُستورد الطلاب فقط، دون أي سجل حضور تاريخي. لن يتكرر طالب موجود بنفس الرقم أو الاسم.', [
      field('ملف Excel أو CSV', fileInput, 'الأعمدة: رقم الطالب، اسم الطالب، الصف والفصل، هاتف ولي الأمر (اختياري).'),
      preview,
      el('div', { className: 'ds-actions' }, [runButton]),
      message
    ]));
    return nodes;
  }

  function renderPreview(container, data, runButton, message) {
    container.innerHTML = '';
    var lines = [
      el('p', {}, [el('b', { text: 'الورقة: ' + data.sheetName }), el('span', { className: 'hint', text: ' — صالح: ' + data.count + ' من ' + data.total })]),
      alertBox('سيُضاف ' + data.count + ' طالبًا إلى قاعدة البيانات.' + (data.duplicates && data.duplicates.length ? ' تكرارات داخل الملف مُهملة: ' + data.duplicates.length : ''), 'ok')
    ];
    if (data.errors && data.errors.length) {
      lines.push(alertBox('أسطر مرفوضة (' + data.errors.length + '): ' + data.errors.slice(0, 5).map(function (item) { return 'سطر ' + item.line + ': ' + item.message; }).join(' | '), 'warn'));
    }
    var rows = (data.sample || []).map(function (student) {
      return el('tr', {}, [el('td', { text: student.id }), el('td', { text: student.name }), el('td', { text: student.classroom }), el('td', { text: student.phone || '' })]);
    });
    if (rows.length) {
      lines.push(el('table', { className: 'ds-table' }, [
        el('thead', {}, [el('tr', {}, [el('th', { text: 'الرقم' }), el('th', { text: 'الاسم' }), el('th', { text: 'الصف' }), el('th', { text: 'الهاتف' })])]),
        el('tbody', {}, rows)
      ]));
    }
    lines.forEach(function (node) { container.appendChild(node); });
    runButton.disabled = !(data.students && data.students.length);
    runButton.dataset.count = String(data.count || 0);
  }

  function runImport(node, message, preview) {
    if (!state.importRows || !state.importRows.length) return;
    var rows = state.importRows;
    node.disabled = true;
    message.innerHTML = '';
    ui.api('getStudents', {}).then(function (existing) {
      var ids = {};
      var names = {};
      (existing || []).forEach(function (student) {
        ids[String(student.id || '').toUpperCase()] = true;
        names[String(student.name || '').replace(/\s+/g, ' ').toLowerCase()] = true;
      });
      var unique = [];
      var skipped = 0;
      rows.forEach(function (student) {
        var id = String(student.id || '').toUpperCase();
        var name = String(student.name || '').replace(/\s+/g, ' ').toLowerCase();
        if (ids[id] || names[name]) { skipped += 1; return; }
        ids[id] = true; names[name] = true;
        unique.push(student);
      });
      if (!unique.length) throw new Error('كل الطلاب في الملف موجودون مسبقًا. لم تتم إضافة أي طالب.');
      message.appendChild(alertBox('جارٍ استيراد ' + unique.length + ' طالبًا' + (skipped ? ' (تخطي ' + skipped + ' موجود مسبقًا)' : '') + '…', 'warn'));
      return ui.api('importStudents', { rows: unique }).then(function (result) {
        message.innerHTML = '';
        message.appendChild(alertBox('تم استيراد ' + result.count + ' طالبًا بنجاح.' + (skipped ? ' تخطي ' + skipped + ' موجود مسبقًا.' : ''), 'ok'));
        ui.toast('تم استيراد ' + result.count + ' طالبًا.', 'success');
        state.importRows = null;
        preview.innerHTML = '';
        if (ui.refreshBootstrap) ui.refreshBootstrap();
      });
    }).catch(function (error) {
      message.innerHTML = '';
      message.appendChild(alertBox(error.message || 'تعذر استيراد الطلاب.', 'error'));
    }).finally(function () { node.disabled = false; });
  }

  /* ---------------- معلومات الجهاز ---------------- */
  function infoTab() {
    var status = state.status || {};
    var sync = status.sync || {};
    var versions = window.desktopSA.versions || {};
    return [
      section('معلومات الجهاز', '', [
        el('dl', { className: 'ds-info' }, [
          el('dt', { text: 'إصدار التطبيق' }), el('dd', { text: status.version || '' }),
          el('dt', { text: 'معرف الجهاز' }), el('dd', { dir: 'ltr', text: sync.deviceId || '' }),
          el('dt', { text: 'الدور' }), el('dd', { text: status.role === 'primary' ? 'جهاز أساسي' : 'جهاز منضم' }),
          el('dt', { text: 'منفذ الخادم المحلي' }), el('dd', { dir: 'ltr', text: String(status.port || '') }),
          el('dt', { text: 'مجلد البيانات' }), el('dd', { dir: 'ltr', className: 'ds-path', text: status.dataDir || '' }),
          el('dt', { text: 'Electron / Chrome' }), el('dd', { dir: 'ltr', text: (versions.electron || '') + ' / ' + (versions.chrome || '') })
        ]),
        el('div', { className: 'ds-actions' }, [
          button('فتح مجلد البيانات', function () { window.desktopSA.openDataFolder(); }),
          button('تنزيل قاعدة البيانات JSON', function () { window.open('/desktop/database', '_blank'); })
        ]),
        alertBox('النسخ الاحتياطي المحلي يعمل تلقائيًا وفق إعدادات النظام. النسخ السحابي يحتاج حساب خدمة Google من تبويب «النسخ السحابي».', 'warn')
      ])
    ];
  }

  /* ---------------- بناء اللوحة ---------------- */
  function render(modal) {
    var tabs = [
      { id: 'sync', label: 'المزامنة', build: syncTab },
      { id: 'backup', label: 'النسخ السحابي', build: backupTab },
      { id: 'import', label: 'استيراد الطلاب', build: importTab },
      { id: 'info', label: 'معلومات الجهاز', build: infoTab }
    ];
    var body = modal.body;
    body.innerHTML = '';
    body.appendChild(el('div', { className: 'ds-tabs' }, tabs.map(function (tab) {
      var node = el('button', { type: 'button', className: 'ds-tab' + (state.tab === tab.id ? ' active' : ''), text: tab.label });
      node.addEventListener('click', function () {
        state.tab = tab.id;
        render(modal);
      });
      return node;
    })));
    var content = el('div', { className: 'ds-tab-body' });
    tabs.filter(function (tab) { return tab.id === state.tab; })[0].build().forEach(function (node) {
      if (node) content.appendChild(node);
    });
    body.appendChild(content);
  }

  function openPanel() {
    state.tab = 'sync';
    state.backupTest = null;
    var modal = ui.openModal('سطح المكتب — المزامنة والنسخ الاحتياطي', [], [], { wide: true });
    modalRef = modal;
    modal.body.classList.add('ds-body');
    modal.card.classList.add('ds-card');
    render(modal);
    refresh(modal, true);
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (!modal.body || !modal.body.isConnected) { clearInterval(state.timer); state.timer = null; return; }
      refresh(modal);
    }, 5000);
    modal.card.addEventListener('click', function (event) {
      var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!link) return;
      if (/^https?:\/\//i.test(link.getAttribute('href') || '')) {
        event.preventDefault();
        window.desktopSA.openExternal(link.getAttribute('href'));
      }
    });
  }

  function injectEntry() {
    var actions = document.querySelector('.topbar-actions');
    var existing = document.getElementById('desktopPanelBtn');
    var user = ui.state && ui.state.user;
    // لوحة سطح المكتب (المزامنة/النسخ/الاستيراد) للمشرف فقط.
    if (!user || user.role !== 'admin') {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (!actions || existing) return;
    var btn = el('button', { type: 'button', id: 'desktopPanelBtn', className: 'btn ghost sm desktop-entry', text: 'سطح المكتب', title: 'المزامنة والنسخ الاحتياطي' });
    btn.addEventListener('click', openPanel);
    actions.insertBefore(btn, actions.firstChild);
  }

  function setLoginMessage(message, type) {
    var box = document.getElementById('loginAlert');
    if (!box) return;
    box.className = message ? ('alert ' + (type || 'warn')) : 'alert hidden';
    box.textContent = message || '';
    if (message && type === 'error') {
      var token = (box.dataset.dsToken || 0) + 1;
      box.dataset.dsToken = String(token);
      setTimeout(function () {
        if (box.dataset.dsToken === String(token) && box.textContent === message) {
          box.className = 'alert hidden';
          box.textContent = '';
        }
      }, 12000);
    }
  }

  // يظهر في تطبيق سطح المكتب فقط: استعادة كلمة مرور المشرف دون الحاجة إلى
  // الوصول إلى الملفات أو المحرر. التأكيد يتم في نافذة Electron أصلية.
  function injectRecovery() {
    var form = document.getElementById('loginPasswordForm');
    if (!form || document.getElementById('desktopRecoverBtn') || !window.desktopSA.recoverAdmin) return;
    var btn = el('button', {
      type: 'button',
      id: 'desktopRecoverBtn',
      className: 'btn ghost block',
      title: 'يتطلب موافقة مسؤول Windows على هذا الجهاز',
      text: 'نسيت كلمة مرور المشرف؟'
    });
    btn.addEventListener('click', function () {
      btn.disabled = true;
      window.desktopSA.recoverAdmin().then(function (result) {
        if (!result || result.cancelled) return;
        if (result.error) {
          setLoginMessage(result.error, 'error');
          return;
        }
        setLoginMessage('اسم المستخدم: ' + result.username +
          ' — كلمة المرور المؤقتة: ' + result.temporaryPassword +
          '. سجّل الدخول بها الآن وغيّرها فورًا.', 'warn');
        var user = document.getElementById('loginUsername');
        var pass = document.getElementById('loginPassword');
        if (user) user.value = result.username || '';
        if (pass) { pass.value = result.temporaryPassword || ''; pass.focus(); }
      }).catch(function (error) {
        setLoginMessage('تعذر إعادة تعيين كلمة المرور: ' + (error && error.message ? error.message : 'خطأ غير معروف'), 'error');
      }).then(function () {
        btn.disabled = false;
      });
    });
    form.insertAdjacentElement('afterend', btn);
  }

  function boot() {
    injectEntry();
    injectRecovery();
    var observer = new MutationObserver(function () { injectEntry(); injectRecovery(); });
    observer.observe(document.body, { childList: true, subtree: true });
    if (window.desktopSA.onSyncApplied) {
      window.desktopSA.onSyncApplied(function (payload) {
        var stats = (payload && payload.stats) || {};
        if (stats.applied) ui.toast('تمت مزامنة ' + stats.applied + ' تغيير من جهاز آخر.', 'success');
        if (modalRef && modalRef.body && modalRef.body.isConnected) refresh(modalRef);
      });
    }
    if (window.desktopSA.onBackupFinished) {
      window.desktopSA.onBackupFinished(function (payload) {
        if (payload && payload.ok) ui.toast('اكتمل النسخ الاحتياطي التلقائي.', 'success');
        else if (payload && payload.message) ui.toast('تعذر النسخ الاحتياطي: ' + payload.message, 'error');
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
