/* 财务管理系统 · 看板
 * window.FMDashboard.renderDashboard(el)
 * 指标：本期凭证数、本期借贷合计与试算平衡状态、银行存款 / 应收 / 应付余额、本月收入 / 成本 / 费用、最近凭证。
 * 所有余额来自 FMAccounts.balance（期初 + 全部凭证，整数分）。
 */
(function (root) {
  'use strict';

  function renderDashboard(el) {
    var S = root.FMStore, A = root.FMAccounts, V = root.FMVoucher;
    var esc = S.esc, fmt = S.fmt;
    var period = (S.get('periods') || {}).current || '';
    var vs = V.list({ period: period });
    var tb = V.trialBalance(period);

    function netOf(codes, creditSide) {
      var net = 0;
      codes.forEach(function (code) {
        var act = A.activity(code, period, { periodOnly: true });
        net += creditSide ? (act.credit - act.debit) : (act.debit - act.credit);
      });
      return net;
    }
    var income = netOf(['6001', '6002', '6051'], true);
    var cost = netOf(['5001', '5002', '5101'], false);
    var expense = netOf(['5201', '5301', '5401', '5411', '5421'], false);

    var html = '<div class="page-head"><h2>看板</h2><div class="page-actions"><span class="muted">会计期间 ' + esc(period) +
      (periodClosed() ? '（已结账）' : '（未结账）') + '</span></div></div>';

    html += '<div class="cards">';
    function card(label, value, extra, cls) {
      return '<div class="card"><div class="card-label">' + label + '</div><div class="card-num ' + (cls || '') + '">' + value + '</div>' +
        (extra ? '<div class="card-extra">' + extra + '</div>' : '') + '</div>';
    }
    html += card('本期凭证数', vs.length + ' 张');
    html += card('本期借方合计', '<span class="num">' + fmt(tb.debit) + '</span>');
    html += card('本期贷方合计', '<span class="num">' + fmt(tb.credit) + '</span>');
    html += card('试算平衡', tb.balanced ? '平' : '不平', tb.balanced ? '借贷差额 0.00' : '差额 ' + fmt(tb.diff), tb.balanced ? 'good' : 'bad');
    html += card('银行存款余额', '<span class="num">' + fmt(A.balance('1002', period)) + '</span>');
    html += card('应收账款余额', '<span class="num">' + fmt(A.balance('1122', period)) + '</span>');
    html += card('应付账款余额', '<span class="num">' + fmt(A.balance('2202', period)) + '</span>');
    html += '</div>';

    html += '<div class="cards" style="margin-top:12px">';
    html += card('本月收入', '<span class="num">' + fmt(income) + '</span>', '主营业务 + 其他业务 + 其他收益');
    html += card('本月成本', '<span class="num">' + fmt(cost) + '</span>', '主营业务成本 + 其他业务成本 + 税金及附加');
    html += card('本月费用', '<span class="num">' + fmt(expense) + '</span>', '销售 + 管理 + 财务费用等');
    html += card('本月毛估利润', '<span class="num ' + (income - cost - expense >= 0 ? 'good' : 'bad') + '">' + fmt(income - cost - expense) + '</span>', '收入 − 成本 − 费用（未含所得税）');
    html += '</div>';

    // 损益类一级科目发生额
    html += '<h3 class="sec-title">本月损益类发生额</h3><table class="grid"><thead><tr><th style="width:110px">科目</th><th>名称</th>' +
      '<th class="num" style="width:150px">借方发生</th><th class="num" style="width:150px">贷方发生</th></tr></thead><tbody>';
    var pl = ['6001', '6002', '6051', '5001', '5002', '5101', '5201', '5301', '5401', '5411', '5421', '6301', '6111', '6101'];
    pl.forEach(function (code) {
      var act = A.activity(code, period, { periodOnly: true });
      if (!act.debit && !act.credit) return;
      html += '<tr><td class="mono">' + code + '</td><td>' + esc(A.fullName(code)) + '</td>' +
        '<td class="num">' + (act.debit ? fmt(act.debit) : '') + '</td><td class="num">' + (act.credit ? fmt(act.credit) : '') + '</td></tr>';
    });
    html += '</tbody></table>';

    // 最近凭证
    html += '<h3 class="sec-title">最近凭证</h3><table class="grid"><thead><tr><th style="width:130px">编号</th><th style="width:100px">日期</th>' +
      '<th>摘要</th><th class="num" style="width:130px">借方合计</th><th class="center" style="width:90px">状态</th></tr></thead><tbody>';
    var latest = vs.slice(-5).reverse();
    if (!latest.length) html += '<tr><td colspan="5" class="center muted">本期暂无凭证</td></tr>';
    latest.forEach(function (v) {
      var es = V.entriesOf(v.id), dt = 0;
      es.forEach(function (e) { dt += e.debit || 0; });
      html += '<tr><td class="mono">' + esc(v.id) + '</td><td>' + esc(v.date) + '</td><td>' + esc(v.summary) + '</td>' +
        '<td class="num">' + fmt(dt) + '</td><td class="center"><span class="badge" data-status="' + v.status + '">' + v.status + '</span></td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  function periodClosed() {
    var p = root.FMStore.get('periods') || { list: [] };
    var cur = p.current, hit = null;
    p.list.forEach(function (x) { if (x.period === cur) hit = x; });
    return !!(hit && hit.closed);
  }

  root.FMDashboard = { renderDashboard: renderDashboard };
})(typeof window !== 'undefined' ? window : globalThis);
