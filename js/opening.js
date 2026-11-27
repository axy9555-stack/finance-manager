/* 财务管理系统 · 期初余额（chunk 2）
 * window.FMOpening = { get, set, validate, adjust, renderOpening }
 * - 期初余额记在末级科目上（分，整数，≥0），方向与科目余额方向一致。
 * - 只允许在尚无已结账期间时修改期初（state.closedPeriods 非空即锁定，返回中文原因）。
 * - adjust(list)：批量调整，事务性——任一行校验失败或保存后期初试算不平衡，全部回滚。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }
  function A() { return root.FMAccounts; }
  function fail(reason) { return { ok: false, reason: reason }; }

  function lockedPeriod() {
    var cp = (S().get('closedPeriods') || []).slice().sort();
    return cp.length ? cp[cp.length - 1] : null;
  }

  function checkRow(row) {
    var a = A().get(row.code);
    if (!a) return '科目“' + row.code + '”不存在，请先在科目表中增加';
    if (!A().isLeaf(row.code)) return '科目“' + row.code + '”不是末级科目，期初余额应记在末级科目';
    if (typeof row.amount !== 'number' || !isFinite(row.amount)) return '科目“' + row.code + '”的期初余额不是有效数字';
    if (row.amount < 0) return '科目“' + row.code + '”的期初余额不能为负数';
    if (Math.round(row.amount) !== row.amount) return '科目“' + row.code + '”的期初余额必须为整数分（无小数）';
    if (row.direction !== a.direction) return '科目“' + row.code + '”的余额方向与科目方向（' + a.direction + '）不一致';
    return null;
  }

  // 某科目期初余额（分）；科目不存在返回 null
  function get(code) {
    var a = A().get(code);
    return a ? (a.opening || 0) : null;
  }

  // 单笔修改。只校验行级条件（期间锁 / 金额 / 方向）；试算平衡由 validate() / adjust() 把关。
  function set(code, amount, direction) {
    var lock = lockedPeriod();
    if (lock) return fail('已有已结账期间（' + lock + '），不能修改期初余额，请先反结账');
    var err = checkRow({ code: code, amount: amount, direction: direction });
    if (err) return fail(err);
    var a = A().get(code);
    var old = a.opening || 0;
    a.opening = amount;
    S().save();
    S().log('修改期初', code, S().fmt(old) + ' → ' + S().fmt(amount));
    return { ok: true, code: code, opening: amount, previous: old };
  }

  // 期初试算平衡：借方合计 = 贷方合计
  function validate() {
    var ot = A().openingTrial();
    if (ot.balanced) return { ok: true, debit: ot.debit, credit: ot.credit, diff: 0 };
    return {
      ok: false, debit: ot.debit, credit: ot.credit, diff: ot.diff,
      reason: '期初试算不平衡：借方合计 ' + S().fmt(ot.debit) + '，贷方合计 ' + S().fmt(ot.credit) +
        '，差额 ' + S().fmt(Math.abs(ot.diff)) + '（借 − 贷），请调整期初余额后再保存'
    };
  }

  // 批量调整：list = [{code, amount(分), direction}]。全部校验通过才写入；
  // 任一行失败 → 全部回滚并返回第一个失败原因；写入后试算不平衡 → 全部回滚。
  function adjust(list) {
    var lock = lockedPeriod();
    if (lock) return fail('已有已结账期间（' + lock + '），不能调整期初余额，请先反结账');
    if (!Array.isArray(list) || !list.length) return fail('没有要调整的期初数据');
    for (var i = 0; i < list.length; i++) {
      var err = checkRow(list[i] || {});
      if (err) return fail(err);
    }
    var originals = {};
    list.forEach(function (r) {
      var a = A().get(r.code);
      originals[r.code] = a.opening || 0;
      a.opening = r.amount;
    });
    var v = validate();
    if (!v.ok) {
      for (var code in originals) A().get(code).opening = originals[code];
      return { ok: false, reason: v.reason, debit: v.debit, credit: v.credit, diff: v.diff };
    }
    S().save();
    S().log('批量调整期初', '', list.length + ' 行，借方合计 ' + S().fmt(v.debit) + '，贷方合计 ' + S().fmt(v.credit));
    return { ok: true, updated: list.length, debit: v.debit, credit: v.credit, diff: 0 };
  }

  /* ---------- 渲染：期初页 ---------- */

  function renderOpening(el) {
    var esc = S().esc, fmt = S().fmt;
    var leaves = A().leaves().slice().sort(function (x, y) { return x.code < y.code ? -1 : 1; });
    var v = validate();
    var lock = lockedPeriod();

    var html = '<div class="page-head"><h2>期初余额</h2><div class="page-actions">' +
      '<button class="btn btn-primary" data-action="save-opening"' + (lock ? ' disabled' : '') + '>保存全部</button></div></div>';
    html += '<div class="notice ' + (v.ok ? 'ok' : 'bad') + '">' +
      (v.ok ? '期初试算平衡：借方合计 ' + fmt(v.debit) + ' = 贷方合计 ' + fmt(v.credit)
        : esc(v.reason)) +
      (lock ? '　<span class="bad-text">期间 ' + esc(lock) + ' 已结账，期初已锁定，请先反结账。</span>' : '') + '</div>';
    html += '<table class="grid"><thead><tr><th style="width:100px">科目编码</th><th>科目名称</th>' +
      '<th class="center" style="width:50px">方向</th><th style="width:170px">期初余额（元）</th></tr></thead><tbody>';
    leaves.forEach(function (a) {
      var yuan = a.opening ? ((a.opening) / 100).toFixed(2) : '0.00';
      html += '<tr><td class="mono">' + esc(a.code) + '</td><td>' + esc(a.name) + '</td>' +
        '<td class="center">' + a.direction + '</td>' +
        '<td><input class="input num fm-open" data-code="' + esc(a.code) + '" data-dir="' + a.direction + '"' +
        (lock ? ' disabled' : '') + ' inputmode="decimal" style="width:150px" value="' + yuan + '"></td></tr>';
    });
    html += '</tbody></table>';
    html += '<div style="margin-top:10px" class="tot">借方合计 <b id="fm-open-d" class="num">' + fmt(v.debit) + '</b>　' +
      '贷方合计 <b id="fm-open-c" class="num">' + fmt(v.credit) + '</b>　' +
      '差额 <b id="fm-open-diff" class="num">' + fmt(Math.abs(v.diff)) + '</b></div>';
    el.innerHTML = html;

    function readSums() {
      var inputs = el.querySelectorAll('input.fm-open');
      var d = 0, c = 0;
      for (var i = 0; i < inputs.length; i++) {
        var cents = S().toCents(inputs[i].value);
        if (cents === null || cents < 0) continue;
        if (inputs[i].dataset.dir === '借') d += cents; else c += cents;
      }
      return { debit: d, credit: c };
    }
    function refreshSums() {
      var s = readSums();
      var td = document.getElementById('fm-open-d'), tc = document.getElementById('fm-open-c'), tf = document.getElementById('fm-open-diff');
      if (td) td.textContent = fmt(s.debit);
      if (tc) tc.textContent = fmt(s.credit);
      if (tf) {
        tf.textContent = fmt(Math.abs(s.debit - s.credit));
        tf.className = 'num ' + (s.debit === s.credit ? 'ok-text' : 'bad-text');
      }
    }

    el.oninput = refreshSums;
    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      if (t.dataset.action !== 'save-opening') return;
      var list = [];
      var inputs = el.querySelectorAll('input.fm-open');
      for (var i = 0; i < inputs.length; i++) {
        var cents = S().toCents(inputs[i].value);
        if (cents === null) {
          root.FMToast('第 ' + (i + 1) + ' 行（' + inputs[i].dataset.code + '）金额格式不正确，最多两位小数', 'bad');
          return;
        }
        list.push({ code: inputs[i].dataset.code, amount: Math.max(cents, 0), direction: inputs[i].dataset.dir });
      }
      var res = adjust(list);
      root.FMToast(res.ok ? '期初已保存：借方合计 ' + fmt(res.debit) + '，贷方合计 ' + fmt(res.credit) : res.reason,
        res.ok ? 'ok' : 'bad');
      if (res.ok) renderOpening(el);
    };
  }

  root.FMOpening = { get: get, set: set, validate: validate, adjust: adjust, renderOpening: renderOpening };
})(typeof window !== 'undefined' ? window : globalThis);
