/* 财务管理系统 · 角色权限（chunk 8）
 * window.FMRoles = { ROLES, ACTIONS, can, guard, setRole, current, renderRoleSwitch }
 * - 当前角色存 state.currentRole（种子默认“管理员”）；单机版以“角色切换”近似多操作员分工，
 *   真实的多操作员/权限矩阵需上服务器版（README 已说明）。
 * - 角色：管理员（全部操作）、会计（记账/审核/过账/申报，不能反结账、删凭证、恢复演示数据）、
 *   出纳（只能看现金/银行/收付款，不能记账过账）、审计（只读全部）。
 * - 敏感操作前调 guard(action)：拒绝时写一条“权限拦截”审计日志（用 S().log，不重复记）。
 *   接线点：voucher.post / voucher.deleteVoucher、closing.unclose、tax.fileVAT/fileCIT、
 *   设置页“恢复演示数据”按钮（index.html）。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }

  var ROLES = ['管理员', '会计', '出纳', '审计'];

  // 敏感动作 → 中文名
  var ACTIONS = {
    post: '过账', unclose: '反结账', deleteVoucher: '删除凭证',
    resetDemo: '恢复演示数据', fileTax: '税务申报'
  };

  // 权限矩阵：true = 允许。未列出的动作对未列出角色一律拒绝。
  var MATRIX = {
    '管理员': { post: true, unclose: true, deleteVoucher: true, resetDemo: true, fileTax: true },
    '会计': { post: true, unclose: false, deleteVoucher: false, resetDemo: false, fileTax: true },
    '出纳': { post: false, unclose: false, deleteVoucher: false, resetDemo: false, fileTax: false },
    '审计': { post: false, unclose: false, deleteVoucher: false, resetDemo: false, fileTax: false }
  };

  function current() {
    var r = (S().get('currentRole') || '');
    return MATRIX[r] ? r : '管理员';
  }

  // can(action) → true/false（只判断，不落日志）
  function can(action) {
    var role = current();
    return !!(MATRIX[role] && MATRIX[role][action] === true);
  }

  function denyReason(action) {
    return '当前角色“' + current() + '”无权限执行「' + (ACTIONS[action] || action) + '」';
  }

  // guard(action) → {ok:true} 或 {ok:false, reason}；拒绝时写“权限拦截”审计日志（每次尝试记一条）。
  // 模块内部调用前应先判 root.FMRoles 是否存在（Node 桩 / 未来拆分场景下不强制依赖）。
  function guard(action) {
    if (can(action)) return { ok: true };
    var reason = denyReason(action);
    S().log('权限拦截', action, reason);
    return { ok: false, reason: reason };
  }

  // 切换角色：校验角色名合法，写“切换角色”日志，返回 {ok, role}
  function setRole(role) {
    if (ROLES.indexOf(role) < 0) return { ok: false, reason: '未知角色：' + role + '（可选：' + ROLES.join('、') + '）' };
    var old = current();
    S().set('currentRole', role);
    if (old !== role) S().log('切换角色', role, '从 ' + old + ' 切换到 ' + role);
    return { ok: true, role: role, previous: old };
  }

  /* 顶栏角色切换下拉（index.html 调用一次；onchange 由调用方接 route()） */
  function renderRoleSwitch(sel) {
    if (!sel) return;
    var html = ROLES.map(function (r) {
      return '<option value="' + r + '"' + (current() === r ? ' selected' : '') + '>' + r + '</option>';
    }).join('');
    sel.innerHTML = html;
    sel.value = current();
  }

  root.FMRoles = {
    ROLES: ROLES, ACTIONS: ACTIONS, can: can, guard: guard, setRole: setRole, current: current,
    renderRoleSwitch: renderRoleSwitch
  };
})(typeof window !== 'undefined' ? window : globalThis);
