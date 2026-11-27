/* 财务管理系统 · 凭证核心
 * window.FMVoucher = {STATUS, create, audit, post, unpost, reverse, list, trialBalance, entriesOf,
 *                     renderVouchers, renderVoucherForm}
 * 凭证 {id:'记-2026-11-0001', date, period, summary, status:'未审核'|'已审核'|'已过账',
 *       maker, auditor, attachCount, entries:[...]}
 * 分录同时挂凭证 entries 和 state.entries（行 id = 凭证id-行号），逻辑统一走 state.entries。
 * 金额一律整数分；显示用 FMStore.fmt() 转元。
 */
(function (root) {
  'use strict';

  var S = function () { return root.FMStore; };
  var A = function () { return root.FMAccounts; };
  var STATUS = ['未审核', '已审核', '已过账'];

  function currentPeriod() {
    var p = S().get('periods');
    return (p && p.current) || '';
  }

  function periodClosed(period) {
    var p = S().get('periods') || { list: [] };
    var hit = null;
    p.list.forEach(function (x) { if (x.period === period) hit = x; });
    return !!(hit && hit.closed);
  }

  // chunk 2：经 FMClosing 结账的期间（state.closedPeriods）凭证全部锁定
  function closedLock(period) {
    return ((S().get('closedPeriods') || []).indexOf(period) >= 0);
  }

  function vouchers() { return S().get('vouchers') || []; }
  function entries() { return S().get('entries') || []; }

  // 凭证的分录行（来自 state.entries，按行号排序）
  function entriesOf(id) {
    var rows = [];
    entries().forEach(function (e) { if (e.voucherId === id) rows.push(e); });
    rows.sort(function (x, y) { return (x.line || 0) - (y.line || 0); });
    return rows;
  }

  function getV(id) {
    var hit = null;
    vouchers().forEach(function (v) { if (v.id === id) hit = v; });
    return hit;
  }

  // 期间内下一个凭证编号：记-2026-11-0013
  function nextId(period) {
    var prefix = '记-' + period + '-', max = 0;
    vouchers().forEach(function (v) {
      if (v.id && v.id.indexOf(prefix) === 0) {
        var n = parseInt(v.id.slice(prefix.length), 10);
        if (n > max) max = n;
      }
    });
    return prefix + ('0000' + (max + 1)).slice(-4);
  }

  function fail(reason) { return { ok: false, reason: reason }; }

  function cleanCents(v) {
    if (v === '' || v === null || v === undefined) return 0;
    var c = S().toCents(v);
    return c === null ? NaN : c;
  }

  /* ---------- 创建 ---------- */
  // data: {date, summary, maker, attachCount, entries:[{accountCode, summary, debit, credit, aux}]}
  function create(data) {
    data = data || {};
    var period = currentPeriod();
    if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date)))
      return fail('凭证日期不能为空，格式应为 2026-11-01');
    if (String(data.date).slice(0, 7) !== period)
      return fail('凭证日期 ' + data.date + ' 不在当前会计期间（' + period + '）内');
    if (closedLock(period)) return fail('会计期间 ' + period + ' 已结账，不能新增凭证');
    if (!data.summary || !String(data.summary).trim()) return fail('凭证摘要不能为空');

    var rows = [];
    var src = Array.isArray(data.entries) ? data.entries : [];
    var lineNo = 0;
    for (var i = 0; i < src.length; i++) {
      var r = src[i] || {};
      var code = r.accountCode === undefined || r.accountCode === null ? '' : String(r.accountCode).trim();
      var d = cleanCents(r.debit), c = cleanCents(r.credit);
      if (isNaN(d) || isNaN(c)) return fail('第 ' + (i + 1) + ' 行金额格式不正确（最多两位小数）');
      if (!code && !d && !c) continue; // 空行跳过
      var chk = A().validate(code);
      if (!chk.ok) return fail('第 ' + (i + 1) + ' 行：' + chk.reason);
      if (!A().isLeaf(code)) return fail('第 ' + (i + 1) + ' 行：科目“' + code + '”不是末级科目，不能记账');
      if (d > 0 && c > 0) return fail('第 ' + (i + 1) + ' 行借方和贷方不能同时有金额');
      if (d === 0 && c === 0) return fail('第 ' + (i + 1) + ' 行金额不能为零');
      lineNo++;
      rows.push({
        id: '', voucherId: '', line: lineNo, accountCode: code,
        summary: (r.summary === undefined || r.summary === null || String(r.summary).trim() === '') ? String(data.summary).trim() : String(r.summary).trim(),
        debit: d, credit: c, aux: r.aux && typeof r.aux === 'object' ? r.aux : {}
      });
    }
    if (rows.length < 2) return fail('凭证分录至少需要两行');
    var dt = 0, ct = 0;
    rows.forEach(function (r) { dt += r.debit; ct += r.credit; });
    if (dt !== ct) return fail('借方合计 ' + S().fmt(dt) + ' 与贷方合计 ' + S().fmt(ct) + ' 不相等，凭证不平衡');
    if (dt <= 0) return fail('凭证金额不能为零');

    var id = nextId(period);
    var voucher = {
      id: id, date: data.date, period: period, summary: String(data.summary).trim(),
      status: '未审核', maker: data.maker || (S().get('company') || {}).operator || '',
      auditor: '', attachCount: parseInt(data.attachCount, 10) || 0, entries: rows, createdAt: new Date().toISOString()
    };
    var flat = entries();
    rows.forEach(function (r) {
      var row = {};
      for (var k in r) row[k] = r[k];
      row.id = id + '-' + r.line;
      row.voucherId = id;
      flat.push(row);
    });
    var vs = vouchers();
    vs.push(voucher);
    S().set('vouchers', vs);
    S().set('entries', flat);
    S().log('新建凭证', id, voucher.summary);
    return { ok: true, id: id, voucher: voucher };
  }

  /* ---------- 审核 / 过账 / 反过账 / 红字冲销 ---------- */

  function audit(id, auditor) {
    var v = getV(id);
    if (!v) return fail('凭证“' + id + '”不存在');
    if (v.status !== '未审核') return fail('只有未审核凭证可以审核（当前状态：' + v.status + '）');
    auditor = (auditor || '').trim();
    if (!auditor) return fail('审核人不能为空');
    if (auditor === v.maker) return fail('制单人不能审核自己编制的凭证（制单人：' + v.maker + '）');
    v.status = '已审核';
    v.auditor = auditor;
    S().save();
    S().log('审核凭证', id, '审核人：' + auditor);
    return { ok: true, voucher: v };
  }

  function post(id) {
    /* chunk 8：角色权限拦截（出纳/审计不能过账） */
    var rg = root.FMRoles ? root.FMRoles.guard('post') : { ok: true };
    if (!rg.ok) return fail(rg.reason);
    var v = getV(id);
    if (!v) return fail('凭证“' + id + '”不存在');
    if (v.status === '未审核') return fail('未审核凭证不能过账，请先审核');
    if (v.status === '已过账') return fail('凭证已过账，不能重复过账');
    if (periodClosed(v.period)) return fail('会计期间 ' + v.period + ' 已结账，不能过账');
    if (closedLock(v.period)) return fail('会计期间 ' + v.period + ' 已结账，不能过账');
    v.status = '已过账';
    S().save();
    S().log('凭证过账', id, '');
    return { ok: true, voucher: v };
  }

  function unpost(id) {
    var v = getV(id);
    if (!v) return fail('凭证“' + id + '”不存在');
    if (v.status !== '已过账') return fail('只有已过账凭证可以反过账（当前状态：' + v.status + '）');
    if (v.period !== currentPeriod()) return fail('只能反过账当月（' + currentPeriod() + '）凭证');
    if (periodClosed(v.period)) return fail('会计期间已结账，不能反过账');
    if (closedLock(v.period)) return fail('会计期间 ' + v.period + ' 已结账，不能反过账');
    v.status = '已审核';
    S().save();
    S().log('凭证反过账', id, '');
    return { ok: true, voucher: v };
  }

  // 红字冲销：生成一张金额相反的新凭证（借贷互换），新凭证为未审核状态
  function reverse(id) {
    var v = getV(id);
    if (!v) return fail('凭证“' + id + '”不存在');
    if (v.status !== '已过账') return fail('只有已过账凭证可以红字冲销（当前状态：' + v.status + '）');
    if (v.period !== currentPeriod()) return fail('只能红字冲销当月（' + currentPeriod() + '）凭证');
    if (periodClosed(v.period)) return fail('会计期间已结账，不能红字冲销');
    if (closedLock(v.period)) return fail('会计期间 ' + v.period + ' 已结账，不能红字冲销');
    var rows = entriesOf(id).map(function (e) {
      /* 金额转为元字符串，避免 create 里 cleanCents 把分再当成元乘 100 */
      return {
        accountCode: e.accountCode, summary: '冲销：' + (e.summary || v.summary),
        debit: e.credit ? (e.credit / 100).toFixed(2) : 0,
        credit: e.debit ? (e.debit / 100).toFixed(2) : 0, aux: e.aux || {}
      };
    });
    var maker = (S().get('company') || {}).operator || v.maker;
    var res = create({
      date: v.date, summary: '红字冲销：' + v.summary, maker: maker,
      attachCount: v.attachCount, entries: rows
    });
    if (res.ok) S().log('红字冲销', id, '生成冲销凭证 ' + res.id);
    return res;
  }

  /* 删除凭证（chunk 8）：仅限未审核凭证；已审核/已过账不可删（应走红字冲销）。
   * 管理员专属（会计/出纳/审计被 guard 拦截）；凭证与分录一并移除，写审计日志。 */
  function deleteVoucher(id) {
    var rg = root.FMRoles ? root.FMRoles.guard('deleteVoucher') : { ok: true };
    if (!rg.ok) return fail(rg.reason);
    var v = getV(id);
    if (!v) return fail('凭证“' + id + '”不存在');
    if (v.status !== '未审核') return fail('只有未审核凭证可以删除（当前状态：' + v.status + '），已审核/已过账请走红字冲销');
    var vs = vouchers().filter(function (x) { return x.id !== id; });
    var es = entries().filter(function (e) { return e.voucherId !== id; });
    S().set('vouchers', vs);
    S().set('entries', es);
    S().log('删除凭证', id, v.summary + '（' + v.maker + ' 制单）');
    return { ok: true, id: id };
  }

  /* ---------- 查询 ---------- */
  // filter: {period, status, accountCode, keyword}
  function list(filter) {
    filter = filter || {};
    var es = entries(), out = [];
    vouchers().forEach(function (v) {
      if (filter.period && v.period !== filter.period) return;
      if (filter.status && v.status !== filter.status) return;
      if (filter.accountCode) {
        var hit = false, pref = String(filter.accountCode);
        es.forEach(function (e) { if (e.voucherId === v.id && String(e.accountCode).indexOf(pref) === 0) hit = true; });
        if (!hit) return;
      }
      if (filter.keyword) {
        var kw = String(filter.keyword).trim();
        if (kw) {
          var inEntry = false;
          es.forEach(function (e) { if (e.voucherId === v.id && String(e.summary).indexOf(kw) >= 0) inEntry = true; });
          if (String(v.summary).indexOf(kw) < 0 && String(v.id).indexOf(kw) < 0 && !inEntry) return;
        }
      }
      out.push(v);
    });
    out.sort(function (x, y) { return x.id < y.id ? -1 : 1; });
    return out;
  }

  // 试算平衡：某期间已过账（已记账）凭证分录的借方合计 / 贷方合计 / 差额。
  // 口径：只有已过账凭证进账簿与试算；voucherCount 是本期凭证总数，postedCount 是已过账张数。
  function trialBalance(period) {
    period = period || currentPeriod();
    var debit = 0, credit = 0, count = 0, postedCount = 0;
    vouchers().forEach(function (v) {
      if (v.period === period) { count++; if (v.status === '已过账') postedCount++; }
    });
    entries().forEach(function (e) {
      var v = getV(e.voucherId);
      if (!v || v.period !== period || v.status !== '已过账') return;
      debit += e.debit || 0;
      credit += e.credit || 0;
    });
    return {
      period: period, voucherCount: count, postedCount: postedCount,
      debit: debit, credit: credit, diff: debit - credit, balanced: debit === credit
    };
  }

  /* ---------- 渲染：凭证列表 ---------- */

  var F = { period: '', status: '', keyword: '' };

  function badge(status) {
    return '<span class="badge" data-status="' + status + '">' + status + '</span>';
  }

  function auxText(aux) {
    if (!aux) return '';
    var names = [], deptMap = {}, staffMap = {}, custMap = {}, supMap = {};
    (S().get('departments') || []).forEach(function (x) { deptMap[x.id] = x.name; });
    (S().get('staff') || []).forEach(function (x) { staffMap[x.id] = x.name; });
    (S().get('customers') || []).forEach(function (x) { custMap[x.id] = x.name; });
    (S().get('suppliers') || []).forEach(function (x) { supMap[x.id] = x.name; });
    if (aux.dept) names.push('部门:' + (deptMap[aux.dept] || aux.dept));
    if (aux.staff) names.push('职员:' + (staffMap[aux.staff] || aux.staff));
    if (aux.customer) names.push('客户:' + (custMap[aux.customer] || aux.customer));
    if (aux.supplier) names.push('供应商:' + (supMap[aux.supplier] || aux.supplier));
    if (aux.project) names.push('项目:' + aux.project);
    if (aux.item) names.push('存货:' + aux.item);
    return names.join(' / ');
  }

  function renderVouchers(el) {
    var esc = S().esc, fmt = S().fmt;
    if (!F.period) F.period = currentPeriod();
    var rows = list(F);
    var html = '<div class="page-head"><h2>凭证</h2><div class="page-actions">' +
      '<button class="btn btn-primary" data-action="new">＋ 新建凭证</button></div></div>';
    html += '<div class="filter-bar">' +
      '期间 <input id="fm-f-period" class="input" style="width:100px" value="' + esc(F.period) + '">' +
      '　状态 <select id="fm-f-status" class="input" style="width:100px">' +
      '<option value="">全部</option>' + STATUS.map(function (s) {
        return '<option value="' + s + '"' + (F.status === s ? ' selected' : '') + '>' + s + '</option>';
      }).join('') + '</select>' +
      '　关键词 <input id="fm-f-keyword" class="input" style="width:160px" placeholder="摘要 / 编号" value="' + esc(F.keyword) + '">' +
      '　<button class="btn" data-action="filter">查询</button></div>';
    html += '<div class="muted" style="margin:8px 0">共 ' + rows.length + ' 张凭证</div>';
    html += '<table class="grid"><thead><tr><th style="width:130px">凭证编号</th><th style="width:100px">日期</th>' +
      '<th>摘要</th><th class="num" style="width:110px">借方合计</th><th class="center" style="width:80px">状态</th>' +
      '<th style="width:70px">制单</th><th style="width:70px">审核</th><th style="width:230px">操作</th></tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="8" class="center muted">没有符合条件的凭证</td></tr>';
    rows.forEach(function (v) {
      var es = entriesOf(v.id), dt = 0;
      es.forEach(function (e) { dt += e.debit || 0; });
      var ops = '<button class="btn btn-sm" data-act="view" data-id="' + esc(v.id) + '">查看</button>';
      if (v.status === '未审核') ops += ' <button class="btn btn-sm" data-act="audit" data-id="' + esc(v.id) + '">审核</button>' +
        ' <button class="btn btn-sm btn-danger" data-act="del" data-id="' + esc(v.id) + '" title="删除未审核凭证">删</button>';
      if (v.status === '已审核') ops += ' <button class="btn btn-sm" data-act="post" data-id="' + esc(v.id) + '">过账</button>';
      if (v.status === '已过账') ops += ' <button class="btn btn-sm" data-act="unpost" data-id="' + esc(v.id) + '">反过账</button>' +
        ' <button class="btn btn-sm btn-danger" data-act="reverse" data-id="' + esc(v.id) + '">红字冲销</button>';
      html += '<tr><td class="mono">' + esc(v.id) + '</td><td>' + esc(v.date) + '</td>' +
        '<td>' + esc(v.summary) + '</td><td class="num">' + fmt(dt) + '</td>' +
        '<td class="center">' + badge(v.status) + '</td><td>' + esc(v.maker) + '</td><td>' + esc(v.auditor || '—') + '</td>' +
        '<td>' + ops + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && (t.dataset.action || t.dataset.act))) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      var act = t.dataset.action || t.dataset.act;
      if (act === 'new') { location.hash = '#/voucher/new'; return; }
      if (act === 'filter') {
        var p = document.getElementById('fm-f-period'), st = document.getElementById('fm-f-status'), kw = document.getElementById('fm-f-keyword');
        F.period = p ? p.value.trim() : '';
        F.status = st ? st.value : '';
        F.keyword = kw ? kw.value.trim() : '';
        renderVouchers(el);
        return;
      }
      var id = t.dataset.id, res = null;
      if (act === 'view') { location.hash = '#/voucher/' + encodeURIComponent(id); return; }
      if (act === 'audit') {
        var auditor = (S().get('company') || {}).operator || '';
        // 简易口径：以系统操作员审核；若与制单人相同则提示需由他人审核
        res = S().get && auditWithOperator(id, auditor);
      } else if (act === 'post') res = post(id);
      else if (act === 'unpost') res = unpost(id);
      else if (act === 'reverse') res = reverse(id);
      else if (act === 'del') res = deleteVoucher(id);
      if (res && !res.ok) root.FMToast(res.reason, 'bad');
      else if (res && res.ok) root.FMToast('操作成功' + (res.id ? '：' + res.id : ''), 'ok');
      if (res && res.ok && act === 'reverse') location.hash = '#/vouchers';
      else if (res && res.ok) renderVouchers(el);
    };
  }

  function auditWithOperator(id, operator) {
    var v = getV(id);
    if (v && operator && operator === v.maker) {
      return fail('制单人“' + v.maker + '”不能审核自己的凭证，请先用其他操作员登录审核');
    }
    return audit(id, operator);
  }

  /* ---------- 渲染：凭证录入 / 查看 ---------- */

  var draft = null; // 新建时的草稿 {date, summary, attachCount, rows:[{accountCode, summary, debit, credit, aux}]}

  function nameMap(kind) {
    var m = {};
    (S().get(kind) || []).forEach(function (x) { m[x.id] = x.name; });
    return m;
  }

  function optionList(map, selected) {
    var out = '<option value="">（无）</option>';
    for (var k in map) out += '<option value="' + k + '"' + (selected === k ? ' selected' : '') + '>' + S().esc(map[k]) + '</option>';
    return out;
  }

  function accountOptions(selected) {
    var groups = {}, order = [];
    A().leaves().forEach(function (a) {
      if (!groups[a.category]) { groups[a.category] = []; order.push(a.category); }
      groups[a.category].push(a);
    });
    var html = '<option value="">— 选择科目 —</option>';
    order.forEach(function (c) {
      html += '<optgroup label="' + c + '">';
      groups[c].forEach(function (a) {
        html += '<option value="' + a.code + '"' + (selected === a.code ? ' selected' : '') + '>' + a.code + ' ' + S().esc(a.name) + '</option>';
      });
      html += '</optgroup>';
    });
    return html;
  }

  function emptyRow() { return { accountCode: '', summary: '', debit: '', credit: '', aux: {} }; }

  function auxInputs(a, row) {
    var acc = A().get(a) || { aux: [] };
    var html = '';
    acc.aux.forEach(function (name) {
      var key = A().AUX_KEYS[name];
      var val = (row.aux && row.aux[key]) || '';
      if (key === 'dept') html += '<select class="input fm-aux" data-aux="dept"><option value="">部门（无）</option>' + optionList(nameMap('departments'), val) + '</select> ';
      else if (key === 'staff') html += '<select class="input fm-aux" data-aux="staff"><option value="">职员（无）</option>' + optionList(nameMap('staff'), val) + '</select> ';
      else if (key === 'customer') html += '<select class="input fm-aux" data-aux="customer"><option value="">客户（无）</option>' + optionList(nameMap('customers'), val) + '</select> ';
      else if (key === 'supplier') html += '<select class="input fm-aux" data-aux="supplier"><option value="">供应商（无）</option>' + optionList(nameMap('suppliers'), val) + '</select> ';
      else html += '<input class="input fm-aux" data-aux="' + key + '" style="width:90px" placeholder="' + name + '" value="' + S().esc(val) + '">';
    });
    return html || '<span class="muted">—</span>';
  }

  function rowHtml(row, idx, readonly) {
    var esc = S().esc, fmt = S().fmt;
    var d = row.debit === '' ? '' : (typeof row.debit === 'number' ? fmt(row.debit) : row.debit);
    var c = row.credit === '' ? '' : (typeof row.credit === 'number' ? fmt(row.credit) : row.credit);
    return '<tr class="fm-entry' + (readonly ? ' readonly' : '') + '">' +
      '<td class="mono center">' + (idx + 1) + '</td>' +
      '<td>' + (readonly
        ? '<span class="mono">' + esc(row.accountCode) + '</span> ' + esc(A().fullName(row.accountCode))
        : '<select class="input fm-acc" style="width:100%">' + accountOptions(row.accountCode) + '</select>') + '</td>' +
      '<td>' + (readonly ? esc(row.summary) : '<input class="input fm-sum" style="width:100%" value="' + esc(row.summary) + '">') + '</td>' +
      '<td>' + (readonly ? '<span class="num">' + (row.debit ? fmt(row.debit) : '') + '</span>'
        : '<input class="input fm-debit num" style="width:110px" inputmode="decimal" value="' + esc(d) + '">') + '</td>' +
      '<td>' + (readonly ? '<span class="num">' + (row.credit ? fmt(row.credit) : '') + '</span>'
        : '<input class="input fm-credit num" style="width:110px" inputmode="decimal" value="' + esc(c) + '">') + '</td>' +
      '<td class="aux-cell">' + (readonly ? esc(auxText(row.aux)) : auxInputs(row.accountCode, row)) + '</td>' +
      (readonly ? '' : '<td class="center"><button class="btn btn-sm" data-action="del-row" data-idx="' + idx + '">删</button></td>') +
      '</tr>';
  }

  function readForm() {
    var d = draft;
    var el1 = document.getElementById('fm-v-date'), el2 = document.getElementById('fm-v-summary'), el3 = document.getElementById('fm-v-attach');
    if (el1) d.date = el1.value.trim();
    if (el2) d.summary = el2.value.trim();
    if (el3) d.attachCount = parseInt(el3.value, 10) || 0;
    var rows = [];
    var trs = document.querySelectorAll('tr.fm-entry');
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      var acc = tr.querySelector('select.fm-acc');
      var aux = {};
      var auxEls = tr.querySelectorAll('.fm-aux');
      for (var j = 0; j < auxEls.length; j++) if (auxEls[j].value) aux[auxEls[j].dataset.aux] = auxEls[j].value;
      rows.push({
        accountCode: acc ? acc.value : (tr.dataset ? tr.dataset.code : ''),
        summary: (tr.querySelector('input.fm-sum') || { value: tr.dataset ? tr.dataset.sum : '' }).value,
        debit: (tr.querySelector('input.fm-debit') || { value: tr.dataset ? tr.dataset.debit : '' }).value,
        credit: (tr.querySelector('input.fm-credit') || { value: tr.dataset ? tr.dataset.credit : '' }).value,
        aux: aux
      });
    }
    d.rows = rows;
    return d;
  }

  function renderVoucherForm(el, id) {
    var esc = S().esc, fmt = S().fmt;
    var readonly = false, v = null;

    if (id) {
      v = getV(decodeURIComponent(id));
      if (!v) { el.innerHTML = '<div class="notice bad">凭证“' + esc(id) + '”不存在</div>'; return; }
      readonly = true; // 已保存的凭证不可改，只能走审核 / 过账 / 冲销流程
      var es = entriesOf(v.id);
      var dt = 0, ct = 0;
      es.forEach(function (e) { dt += e.debit || 0; ct += e.credit || 0; });
      var ops = '<button class="btn" data-action="back">← 返回列表</button> ';
      if (v.status === '未审核') ops += '<button class="btn btn-primary" data-action="do-audit" data-id="' + esc(v.id) + '">审核</button>';
      if (v.status === '已审核') ops += '<button class="btn btn-primary" data-action="do-post" data-id="' + esc(v.id) + '">过账</button>';
      if (v.status === '已过账') ops += '<button class="btn" data-action="do-unpost" data-id="' + esc(v.id) + '">反过账</button> ' +
        '<button class="btn btn-danger" data-action="do-reverse" data-id="' + esc(v.id) + '">红字冲销</button>';
      var html = '<div class="page-head"><h2>凭证 ' + esc(v.id) + '</h2><div class="page-actions">' + ops + '</div></div>';
      html += '<table class="form-table"><tr><th>日期</th><td>' + esc(v.date) + '</td><th>状态</th><td>' + badge(v.status) + '</td></tr>' +
        '<tr><th>摘要</th><td colspan="3">' + esc(v.summary) + '</td></tr>' +
        '<tr><th>制单人</th><td>' + esc(v.maker) + '</td><th>审核人</th><td>' + esc(v.auditor || '—') + '</td></tr>' +
        '<tr><th>附单据</th><td>' + (v.attachCount || 0) + ' 张</td><th>借贷合计</th><td class="num">' + fmt(dt) + ' / ' + fmt(ct) + '</td></tr></table>';
      html += '<table class="grid" style="margin-top:12px"><thead><tr><th style="width:40px">行</th><th style="width:220px">科目</th><th>摘要</th>' +
        '<th class="num" style="width:120px">借方</th><th class="num" style="width:120px">贷方</th><th style="width:220px">辅助核算</th></tr></thead><tbody>';
      es.forEach(function (e, i) {
        html += '<tr class="fm-entry readonly" data-code="' + esc(e.accountCode) + '" data-sum="' + esc(e.summary) + '" data-debit="' + e.debit + '" data-credit="' + e.credit + '">' +
          '<td class="mono center">' + (i + 1) + '</td>' +
          '<td><span class="mono">' + esc(e.accountCode) + '</span> ' + esc(A().fullName(e.accountCode)) + '</td>' +
          '<td>' + esc(e.summary) + '</td><td class="num">' + (e.debit ? fmt(e.debit) : '') + '</td>' +
          '<td class="num">' + (e.credit ? fmt(e.credit) : '') + '</td><td>' + esc(auxText(e.aux)) + '</td></tr>';
      });
      html += '</tbody></table>';
      el.innerHTML = html;
      el.onclick = function (ev) {
        var t = ev && ev.target;
        while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
        if (!t || t === el || !t.dataset) return;
        var act = t.dataset.action, vid = t.dataset.id;
        if (act === 'back') { location.hash = '#/vouchers'; return; }
        var res = null;
        if (act === 'do-audit') res = auditWithOperator(vid, (S().get('company') || {}).operator || '');
        else if (act === 'do-post') res = post(vid);
        else if (act === 'do-unpost') res = unpost(vid);
        else if (act === 'do-reverse') res = reverse(vid);
        if (res && !res.ok) root.FMToast(res.reason, 'bad');
        else if (res && res.ok) {
          root.FMToast('操作成功' + (res.id ? '：' + res.id : ''), 'ok');
          if (act === 'do-reverse') { location.hash = '#/vouchers'; return; }
        }
        renderVoucherForm(el, vid);
      };
      return;
    }

    // —— 新建凭证 ——
    if (!draft) {
      var today = new Date().toISOString().slice(0, 10);
      var period = currentPeriod();
      if (today.slice(0, 7) !== period) today = period + '-01';
      draft = { date: today, summary: '', attachCount: 1, rows: [emptyRow(), emptyRow(), emptyRow(), emptyRow()] };
    }

    function draw() {
      var dt = 0, ct = 0;
      draft.rows.forEach(function (r) {
        var d = cleanCents(r.debit), c = cleanCents(r.credit);
        dt += isFinite(d) ? d : 0;
        ct += isFinite(c) ? c : 0;
      });
      var html = '<div class="page-head"><h2>新建凭证</h2><div class="page-actions">' +
        '<button class="btn" data-action="cancel">放弃</button>' +
        '<button class="btn btn-primary" data-action="save">保存凭证</button></div></div>';
      html += '<table class="form-table"><tr><th>凭证日期</th><td><input id="fm-v-date" class="input" style="width:130px" value="' + esc(draft.date) + '" placeholder="' + esc(currentPeriod()) + '-01"></td>' +
        '<th>附单据</th><td><input id="fm-v-attach" class="input" style="width:60px" value="' + (draft.attachCount || 0) + '"> 张</td>' +
        '<th>制单人</th><td>' + esc((S().get('company') || {}).operator || '') + '</td></tr>' +
        '<tr><th>摘要</th><td colspan="5"><input id="fm-v-summary" class="input" style="width:420px" value="' + esc(draft.summary) + '" placeholder="凭证摘要"></td></tr></table>';
      html += '<table class="grid" style="margin-top:12px"><thead><tr><th style="width:40px">行</th><th style="width:260px">科目（末级）</th><th>摘要</th>' +
        '<th style="width:120px">借方（元）</th><th style="width:120px">贷方（元）</th><th style="width:240px">辅助核算</th><th style="width:50px"></th></tr></thead><tbody>';
      draft.rows.forEach(function (r, i) { html += rowHtml(r, i, false); });
      html += '</tbody></table>';
      html += '<div style="margin-top:10px"><button class="btn" data-action="add-row">＋ 增加分录行</button>' +
        '　<span class="tot">借方合计 <b id="fm-tot-d" class="num">' + fmt(dt) + '</b>　贷方合计 <b id="fm-tot-c" class="num">' + fmt(ct) + '</b>　' +
        '<span id="fm-tot-tip" class="' + (dt === ct && dt > 0 ? 'ok-text' : 'bad-text') + '">' +
        (dt === ct && dt > 0 ? '借贷平衡' : (dt === 0 && ct === 0 ? '尚未录入金额' : '借贷不平衡，差额 ' + fmt(Math.abs(dt - ct)))) + '</span></span></div>';
      el.innerHTML = html;
    }

    draw();

    el.onchange = function (ev) {
      var t = ev && ev.target;
      if (t && t.classList && t.classList.contains('fm-acc')) {
        readForm();
        // 换科目后重绘以刷新辅助核算输入
        renderVoucherForm(el, null);
      }
    };
    el.oninput = function () {
      readForm();
      var dt = 0, ct = 0;
      draft.rows.forEach(function (r) {
        var d = cleanCents(r.debit), c = cleanCents(r.credit);
        dt += isFinite(d) ? d : 0;
        ct += isFinite(c) ? c : 0;
      });
      var td = document.getElementById('fm-tot-d'), tc = document.getElementById('fm-tot-c'), tip = document.getElementById('fm-tot-tip');
      if (td) td.textContent = fmt(dt);
      if (tc) tc.textContent = fmt(ct);
      if (tip) {
        if (dt === ct && dt > 0) { tip.textContent = '借贷平衡'; tip.className = 'ok-text'; }
        else if (dt === 0 && ct === 0) { tip.textContent = '尚未录入金额'; tip.className = 'muted'; }
        else { tip.textContent = '借贷不平衡，差额 ' + fmt(Math.abs(dt - ct)); tip.className = 'bad-text'; }
      }
    };
    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      var act = t.dataset.action;
      if (act === 'add-row') { readForm(); draft.rows.push(emptyRow()); renderVoucherForm(el, null); return; }
      if (act === 'del-row') {
        readForm();
        var idx = parseInt(t.dataset.idx, 10);
        if (draft.rows.length > 2) draft.rows.splice(idx, 1);
        else root.FMToast('至少保留两行分录', 'bad');
        renderVoucherForm(el, null);
        return;
      }
      if (act === 'cancel') { draft = null; location.hash = '#/vouchers'; return; }
      if (act === 'save') {
        readForm();
        var res = create({
          date: draft.date, summary: draft.summary, attachCount: draft.attachCount, entries: draft.rows
        });
        if (!res.ok) { root.FMToast(res.reason, 'bad'); return; }
        S().log('保存凭证', res.id, draft.summary);
        draft = null;
        root.FMToast('凭证已保存：' + res.id, 'ok');
        location.hash = '#/vouchers';
      }
    };
  }

  root.FMVoucher = {
    STATUS: STATUS, create: create, audit: audit, post: post, unpost: unpost, reverse: reverse, deleteVoucher: deleteVoucher,
    list: list, trialBalance: trialBalance, entriesOf: entriesOf, nextId: nextId,
    renderVouchers: renderVouchers, renderVoucherForm: renderVoucherForm
  };
})(typeof window !== 'undefined' ? window : globalThis);
