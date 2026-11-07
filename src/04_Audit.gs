// 04_Audit.gs — سجل تدقيق إلحاقي داخل نفس القفل. لا يُستخدم بديلًا عن السجل التقني.
function audit_(ctx, action, options) {
  options = options || {};
  var account = ctx && ctx.account ? ctx.account : null;
  var operator = options.operator || (account ? account.username : 'النظام');
  var requestId = options.requestId || (ctx && ctx.requestId) || '';
  var details = cleanText_(options.details || '', 400);
  var entry = {
    at: stamp_(),
    operator: operator,
    action: cleanText_(action, 80),
    details: details,
    event_id: uuid_(),
    request_id: requestId,
    target_type: cleanText_(options.targetType || '', 40),
    target_id: cleanText_(options.targetId || '', 80),
    result: options.result || 'SUCCESS',
    reason: cleanText_(options.reason || '', 300),
    before_json: options.before === undefined ? '' : jsonSafe_(options.before, 900),
    after_json: options.after === undefined ? '' : jsonSafe_(options.after, 900)
  };
  appendRows_('Audit', [entry]);
  return entry;
}

// لا يُخفي خطأ العملية الأصلي إذا فشل التدقيق نفسه.
function auditSafe_(ctx, action, options) {
  try { return audit_(ctx, action, options); }
  catch (error) {
    log_('ERROR', 'audit_write_failed', {
      action: ctx && ctx.action,
      request_id: ctx && ctx.requestId,
      code: error && error.code ? error.code : 'INTERNAL'
    });
    return null;
  }
}

function getAudit_(ctx, payload) {
  var limit = Math.min(500, Math.max(1, Number(payload && payload.limit) || 100));
  var rows = readTable_('Audit');
  return rows.slice(-limit).reverse().map(function (row) {
    return {
      at: row.at,
      operator: row.operator,
      action: row.action,
      details: row.details,
      eventId: row.event_id,
      requestId: row.request_id,
      targetType: row.target_type,
      targetId: row.target_id,
      result: row.result,
      reason: row.reason,
      before: row.before_json,
      after: row.after_json
    };
  });
}
