/* 财务管理系统 · 审计日志（chunk 8）
 * window.FMAudit = { query, actions, renderAudit }
 * - 日志由各模块经 FMStore.log(action, target, detail) 写入 state.auditLog
 *   （{time, user, action, target, detail}，上限 5000 条）。
 * - 关键动作清单（query.actions）：新建/保存凭证、审核、过账、反过账、红字冲销、删除凭证、
 *   结转损益、月结、反结账、税务申报、税款缴款、计提折旧/工资、发放工资、新增/处置资产、
 *   修改期初、开票/收票/发票作废、导入备份、恢复演示数据、切换角色、权限拦截。
 * - renderAudit：按时间倒序 + 按操作人/动作筛选；只读，不写日志（不重复记）。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }

  // 关键动作（按类别给下拉筛选用；与各模块 S().log 的 action 字符串一致）
  var ACTIONS = ['新建凭证', '保存凭证', '审核凭证', '凭证过账', '凭证反过账', '红字冲销', '删除凭证',
    '结转损益', '月结', '反结账', '增值税申报', '企业所得税申报', '税款缴款',
    '计提折旧', '计提工资', '发放工资', '新增固定资产', '资产处置',
    '修改期初', '批量调整期初', '开票', '收票', '发票作废', '发票关联凭证',
    '导入备份', '导出备份', '恢复演示数据', '切换角色', '权限拦截', '设置预算'];

  // 查询：{user, action, keyword}，按 time 倒序（同一毫秒按数组顺序倒序，新的在前）
  function query(filter) {
    filter = filter || {};
    var out = (S().get('auditLog') || []).filter(function (r) {
      if (filter.user && r.user !== filter.user) return false;
      if (filter.action && r.action !== filter.action) return false;
      if (filter.keyword) {
        var kw = String(filter.keyword);
        if (String(r.action).indexOf(kw) < 0 && String(r.target).indexOf(kw) < 0 && String(r.detail).indexOf(kw) < 0) return false;
      }
      return true;
    });
    // 稳定倒序：先按原始下标，再排序
    for (var i = 0; i < out.length; i++) out[i]._idx = i;
    out.sort(function (x, y) {
      if (x.time !== y.time) return x.time < y.time ? 1 : -1;
      return y._idx - x._idx;
    });
    out.forEach(function (r) { delete r._idx; });
    return out;
  }

  /* ---------- 渲染 ---------- */

  var A_ = { user: '', action: '' };

  function renderAudit(el) {
    var esc = S().esc;
    var logs = S().get('auditLog') || [];
    var users = {};
    logs.forEach(function (r) { if (r.user) users[r.user] = true; });
    var rows = query(A_);

    var html = '<div class="page-head"><h2>审计日志</h2><div class="page-actions">' +
      '<span class="muted">共 ' + logs.length + ' 条 · 上限 5000 条 · 只读</span></div></div>';
    html += '<div class="filter-bar">操作人 <select id="fm-aud-user" class="input" style="width:120px"><option value="">全部</option>' +
      Object.keys(users).map(function (u) {
        return '<option value="' + esc(u) + '"' + (A_.user === u ? ' selected' : '') + '>' + esc(u) + '</option>';
      }).join('') + '</select>' +
      '　动作 <select id="fm-aud-action" class="input" style="width:160px"><option value="">全部</option>' +
      ACTIONS.map(function (a) {
        return '<option value="' + a + '"' + (A_.action === a ? ' selected' : '') + '>' + a + '</option>';
      }).join('') + '</select>' +
      '　<button class="btn" data-action="filter">查询</button></div>';

    html += '<table class="grid"><thead><tr><th style="width:180px">时间</th><th style="width:90px">操作人</th>' +
      '<th style="width:130px">动作</th><th style="width:150px">对象</th><th>明细</th></tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="5" class="center muted">没有符合条件的日志</td></tr>';
    rows.forEach(function (r) {
      html += '<tr><td class="mono">' + esc(String(r.time || '').replace('T', ' ').slice(0, 19)) + '</td>' +
        '<td>' + esc(r.user || '—') + '</td><td>' + esc(r.action) + '</td>' +
        '<td class="mono">' + esc(r.target || '—') + '</td><td>' + esc(r.detail || '') + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      if (t.dataset.action === 'filter') {
        var u = document.getElementById('fm-aud-user'), a = document.getElementById('fm-aud-action');
        A_.user = u ? u.value : '';
        A_.action = a ? a.value : '';
        renderAudit(el);
      }
    };
  }

  root.FMAudit = { ACTIONS: ACTIONS, query: query, renderAudit: renderAudit };
})(typeof window !== 'undefined' ? window : globalThis);
