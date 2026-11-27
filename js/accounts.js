/* 财务管理系统 · 科目体系
 * window.FMAccounts = {CATEGORIES, AUX_KEYS, defaultChart, all, list, get, validate, isLeaf, children,
 *                      leaves, balance, activity, openingTrial, renderAccounts}
 * 科目 {code, name, category, direction:'借'|'贷', aux:[], parent, level, opening(分), openingAux?}
 * 编码规则 4-2-2：一级 4 位，二级 6 位，三级 8 位。只有末级科目可以录凭证，上级科目余额 = 下级汇总。
 */
(function (root) {
  'use strict';

  var CATEGORIES = ['资产', '负债', '共同', '所有者权益', '成本', '损益'];
  // 辅助核算名称 → 分录 aux 里的键
  var AUX_KEYS = { '部门': 'dept', '职员': 'staff', '客户': 'customer', '供应商': 'supplier', '项目': 'project', '存货': 'item' };

  var D = '借', C = '贷';
  // [编码, 名称, 类别, 余额方向, 辅助核算]
  var CHART = [
    // —— 资产 ——
    ['1001', '库存现金', '资产', D], ['1002', '银行存款', '资产', D],
    ['100201', '工商银行基本户', '资产', D], ['100202', '建设银行一般户', '资产', D],
    ['1012', '其他货币资金', '资产', D], ['1101', '交易性金融资产', '资产', D],
    ['1121', '应收票据', '资产', D, ['客户']], ['1122', '应收账款', '资产', D, ['客户']],
    ['1123', '预付账款', '资产', D, ['供应商']], ['1131', '应收股利', '资产', D], ['1132', '应收利息', '资产', D],
    ['1221', '其他应收款', '资产', D, ['职员']], ['1231', '坏账准备', '资产', C],
    ['1401', '材料采购', '资产', D], ['1402', '在途物资', '资产', D], ['1403', '原材料', '资产', D, ['存货']],
    ['1405', '库存商品', '资产', D, ['存货']], ['1408', '委托加工物资', '资产', D], ['1411', '周转材料', '资产', D],
    ['1461', '融资租赁资产', '资产', D], ['1471', '存货跌价准备', '资产', C],
    ['1501', '持有至到期投资', '资产', D], ['1511', '长期股权投资', '资产', D], ['1521', '投资性房地产', '资产', D],
    ['1601', '固定资产', '资产', D], ['1602', '累计折旧', '资产', C], ['1603', '固定资产减值准备', '资产', C],
    ['1604', '在建工程', '资产', D, ['项目']], ['1605', '工程物资', '资产', D], ['1606', '固定资产清理', '资产', D],
    ['1701', '无形资产', '资产', D], ['1702', '累计摊销', '资产', C], ['1703', '无形资产减值准备', '资产', C],
    ['1711', '商誉', '资产', D], ['1801', '长期待摊费用', '资产', D], ['1811', '递延所得税资产', '资产', D],
    ['1901', '待处理财产损溢', '资产', D],
    // —— 负债 ——
    ['2001', '短期借款', '负债', C], ['2101', '交易性金融负债', '负债', C],
    ['2201', '应付票据', '负债', C, ['供应商']], ['2202', '应付账款', '负债', C, ['供应商']],
    ['2203', '预收账款', '负债', C, ['客户']],
    ['2211', '应付职工薪酬', '负债', C],
    ['221101', '工资、奖金、津贴和补贴', '负债', C], ['221102', '社会保险费', '负债', C], ['221103', '住房公积金', '负债', C],
    ['221104', '职工福利费', '负债', C], ['221105', '工会经费', '负债', C], ['221106', '职工教育经费', '负债', C],
    ['2221', '应交税费', '负债', C],
    ['222101', '应交增值税', '负债', C],
    ['22210101', '进项税额', '负债', D], ['22210102', '销项税额', '负债', C], ['22210103', '已交税金', '负债', D],
    ['22210104', '转出未交增值税', '负债', D], ['22210105', '进项税额转出', '负债', C],
    ['222102', '未交增值税', '负债', C], ['222103', '应交企业所得税', '负债', C], ['222104', '应交个人所得税', '负债', C],
    ['222105', '应交城市维护建设税', '负债', C], ['222106', '应交教育费附加', '负债', C],
    ['222107', '应交地方教育附加', '负债', C], ['222108', '应交印花税', '负债', C],
    ['2231', '应付利息', '负债', C], ['2232', '应付股利', '负债', C], ['2241', '其他应付款', '负债', C],
    ['2401', '递延收益', '负债', C], ['2501', '长期借款', '负债', C], ['2502', '应付债券', '负债', C],
    ['2601', '未确认融资费用', '负债', D], ['2701', '长期应付款', '负债', C], ['2801', '预计负债', '负债', C],
    ['2901', '递延所得税负债', '负债', C],
    // —— 共同 ——
    ['3201', '套期工具', '共同', D], ['3202', '被套期项目', '共同', D],
    // —— 所有者权益 ——
    ['3001', '实收资本', '所有者权益', C], ['3002', '资本公积', '所有者权益', C],
    ['3101', '盈余公积', '所有者权益', C], ['310101', '法定盈余公积', '所有者权益', C], ['310102', '任意盈余公积', '所有者权益', C],
    ['3103', '本年利润', '所有者权益', C],
    ['3104', '利润分配', '所有者权益', C], ['310401', '提取法定盈余公积', '所有者权益', C],
    ['310402', '应付现金股利', '所有者权益', C], ['310405', '未分配利润', '所有者权益', C],
    // —— 成本 ——
    ['4001', '生产成本', '成本', D, ['项目']], ['4101', '制造费用', '成本', D, ['部门']],
    ['4301', '研发支出', '成本', D], ['430101', '费用化支出', '成本', D, ['项目']], ['430102', '资本化支出', '成本', D, ['项目']],
    ['4401', '工程施工', '成本', D, ['项目']],
    // —— 损益 ——
    ['5001', '主营业务成本', '损益', D], ['5002', '其他业务成本', '损益', D], ['5101', '税金及附加', '损益', D],
    ['5201', '销售费用', '损益', D],
    ['520101', '职工薪酬', '损益', D, ['部门']], ['520102', '广告宣传费', '损益', D, ['部门']], ['520103', '差旅费', '损益', D, ['部门']],
    ['520104', '业务招待费', '损益', D, ['部门']], ['520105', '运输费', '损益', D, ['部门']], ['520106', '折旧费', '损益', D, ['部门']],
    ['520199', '其他', '损益', D, ['部门']],
    ['5301', '管理费用', '损益', D],
    ['530101', '职工薪酬', '损益', D, ['部门']], ['530102', '办公费', '损益', D, ['部门']], ['530103', '租赁费', '损益', D, ['部门']],
    ['530104', '差旅费', '损益', D, ['部门']], ['530105', '业务招待费', '损益', D, ['部门']], ['530106', '折旧费', '损益', D, ['部门']],
    ['530107', '无形资产摊销', '损益', D, ['部门']], ['530108', '研发费用', '损益', D, ['部门']],
    ['530109', '中介服务费', '损益', D, ['部门']], ['530199', '其他', '损益', D, ['部门']],
    ['5401', '财务费用', '损益', D],
    ['540101', '利息支出', '损益', D], ['540102', '利息收入', '损益', D], ['540103', '手续费', '损益', D], ['540104', '汇兑损益', '损益', D],
    ['5411', '资产减值损失', '损益', D], ['5421', '营业外支出', '损益', D], ['5801', '所得税费用', '损益', D],
    ['5901', '以前年度损益调整', '损益', D],
    ['6001', '主营业务收入', '损益', C], ['600101', '商品销售收入', '损益', C], ['600102', '服务收入', '损益', C],
    ['6002', '其他业务收入', '损益', C], ['6051', '其他收益', '损益', C], ['6101', '公允价值变动损益', '损益', C],
    ['6111', '投资收益', '损益', C], ['6301', '营业外收入', '损益', C]
  ];

  function defaultChart() {
    return CHART.map(function (r) {
      var code = r[0];
      return {
        code: code, name: r[1], category: r[2], direction: r[3], aux: (r[4] || []).slice(),
        parent: code.length > 4 ? code.slice(0, code.length - 2) : null, level: (code.length - 2) / 2, opening: 0
      };
    });
  }

  var fallback = null;
  function all() {
    var st = root.FMStore && root.FMStore.get('accounts');
    if (st && st.length) return st;
    if (!fallback) fallback = defaultChart();
    return fallback;
  }

  function list(category) {
    var a = all();
    return category ? a.filter(function (x) { return x.category === category; }) : a.slice();
  }

  function get(code) {
    code = String(code === null || code === undefined ? '' : code).trim();
    var a = all();
    for (var i = 0; i < a.length; i++) if (a[i].code === code) return a[i];
    return null;
  }

  function children(code) {
    return all().filter(function (x) { return x.parent === code; });
  }

  function isLeaf(code) { return children(code).length === 0; }

  function leaves() {
    var a = all(), parents = {};
    a.forEach(function (x) { if (x.parent) parents[x.parent] = true; });
    return a.filter(function (x) { return !parents[x.code]; });
  }

  // 完整名称：应交税费-应交增值税-进项税额
  function fullName(code) {
    var parts = [], a = get(code);
    while (a) { parts.unshift(a.name); a = a.parent ? get(a.parent) : null; }
    return parts.join('-');
  }

  // 校验科目编码。存在返回 {ok:true, account}；否则 {ok:false, reason:中文原因}
  function validate(code) {
    if (code === null || code === undefined || String(code).trim() === '') return { ok: false, reason: '科目编码不能为空' };
    var s = String(code).trim();
    if (!/^\d+$/.test(s)) return { ok: false, reason: '科目编码“' + s + '”格式不正确，只能是数字' };
    if (s.length !== 4 && s.length !== 6 && s.length !== 8) return { ok: false, reason: '科目编码“' + s + '”长度不正确，应为 4、6 或 8 位' };
    var a = get(s);
    if (!a) return { ok: false, reason: '科目“' + s + '”不存在，请先在科目表中增加' };
    return { ok: true, account: a };
  }

  function currentPeriod() {
    var p = root.FMStore && root.FMStore.get('periods');
    return (p && p.current) || '';
  }

  function auxMatch(entryAux, want) {
    if (!want) return true;
    for (var k in want) if (want[k] && (!entryAux || entryAux[k] !== want[k])) return false;
    return true;
  }

  // 发生额汇总（含下级科目）。opts: {postedOnly, cumulative, aux:{customer:'C001'}}
  // 默认只算 period 当期；cumulative=true 时算到 period 为止的累计。返回 {debit, credit}（分）
  function activity(code, period, opts) {
    opts = opts || {};
    period = period || currentPeriod();
    code = String(code);
    var vs = (root.FMStore && root.FMStore.get('vouchers')) || [];
    var es = (root.FMStore && root.FMStore.get('entries')) || [];
    var vmap = {};
    vs.forEach(function (v) { vmap[v.id] = v; });
    var debit = 0, credit = 0;
    es.forEach(function (e) {
      if (String(e.accountCode).indexOf(code) !== 0) return;
      var v = vmap[e.voucherId];
      if (!v) return;
      if (opts.cumulative ? v.period > period : v.period !== period) return;
      if (opts.postedOnly && v.status !== '已过账') return;
      if (!auxMatch(e.aux, opts.aux)) return;
      debit += e.debit || 0;
      credit += e.credit || 0;
    });
    return { debit: debit, credit: credit };
  }

  // 期初净额（借 − 贷，含下级）
  function openingNet(code, aux) {
    var net = 0;
    all().forEach(function (a) {
      if (a.code.indexOf(code) !== 0) return;
      var amt = a.opening || 0;
      if (aux) {
        amt = 0;
        (a.openingAux || []).forEach(function (o) { if (auxMatch(o, aux)) amt += o.amount || 0; });
      }
      net += a.direction === '借' ? amt : -amt;
    });
    return net;
  }

  // 科目余额（分），按科目自身方向折算：借方科目 = 借 − 贷，贷方科目 = 贷 − 借。
  // 默认 = 期初 + 截至 period 的全部凭证（含未过账）；period 缺省为当前期间。
  // opts: {postedOnly: 只算已过账, periodOnly: 只算 period 当期发生净额（不含期初）, aux: 按辅助项筛选}
  function balance(code, period, opts) {
    opts = opts || {};
    var a = get(code);
    if (!a) return 0;
    var act = activity(a.code, period, { postedOnly: opts.postedOnly, cumulative: !opts.periodOnly, aux: opts.aux });
    var net = act.debit - act.credit;
    if (!opts.periodOnly) net += openingNet(a.code, opts.aux);
    return a.direction === '借' ? net : -net;
  }

  // 期初试算平衡：末级科目期初余额按方向分列合计
  function openingTrial() {
    var debit = 0, credit = 0;
    leaves().forEach(function (a) {
      if (a.direction === '借') debit += a.opening || 0; else credit += a.opening || 0;
    });
    return { debit: debit, credit: credit, diff: debit - credit, balanced: debit === credit };
  }

  /* ---------- 科目表页面 ---------- */

  var viewCategory = '';

  function renderAccounts(el) {
    var S = root.FMStore, esc = S.esc, fmt = S.fmt;
    var period = currentPeriod();
    var rows = list(viewCategory).slice().sort(function (x, y) { return x.code < y.code ? -1 : 1; });
    var ot = openingTrial();
    var html = '<div class="page-head"><h2>会计科目</h2><div class="page-actions"><span class="muted">共 ' + all().length +
      ' 个科目，其中末级 ' + leaves().length + ' 个 · 编码规则 4-2-2</span></div></div>';
    html += '<div class="tabs">';
    [''].concat(CATEGORIES).forEach(function (c) {
      html += '<button class="tab' + (c === viewCategory ? ' active' : '') + '" data-cat="' + c + '">' + (c || '全部') + '</button>';
    });
    html += '</div>';
    html += '<div class="notice ' + (ot.balanced ? 'ok' : 'bad') + '">期初试算（' + esc((S.get('company') || {}).openingDate || '') +
      '）：借方合计 ' + fmt(ot.debit) + '　贷方合计 ' + fmt(ot.credit) + '　' + (ot.balanced ? '平衡' : '不平衡，差额 ' + fmt(ot.diff)) + '</div>';
    html += '<table class="grid"><thead><tr><th style="width:110px">科目编码</th><th>科目名称</th><th style="width:90px">类别</th>' +
      '<th style="width:60px">方向</th><th style="width:140px">辅助核算</th><th class="num" style="width:150px">期初余额</th>' +
      '<th class="num" style="width:150px">' + esc(period) + ' 期末余额</th></tr></thead><tbody>';
    rows.forEach(function (a) {
      var leaf = isLeaf(a.code);
      var opening = a.direction === '借' ? openingNet(a.code) : -openingNet(a.code);
      var bal = balance(a.code, period);
      html += '<tr class="' + (leaf ? '' : 'parent-row') + '"><td class="mono">' + esc(a.code) + '</td>' +
        '<td style="padding-left:' + (10 + (a.level - 1) * 20) + 'px">' + esc(a.name) + '</td>' +
        '<td>' + esc(a.category) + '</td><td class="center">' + esc(a.direction) + '</td>' +
        '<td>' + esc((a.aux || []).join('、')) + '</td>' +
        '<td class="num">' + (opening ? fmt(opening) : '') + '</td><td class="num">' + (bal ? fmt(bal) : '') + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
    el.onclick = function (ev) {
      var t = ev && ev.target;
      if (t && t.dataset && t.dataset.cat !== undefined) { viewCategory = t.dataset.cat; renderAccounts(el); }
    };
  }

  root.FMAccounts = {
    CATEGORIES: CATEGORIES, AUX_KEYS: AUX_KEYS, defaultChart: defaultChart, all: all, list: list, get: get,
    validate: validate, isLeaf: isLeaf, children: children, leaves: leaves, fullName: fullName,
    balance: balance, activity: activity, openingTrial: openingTrial, renderAccounts: renderAccounts
  };
})(typeof window !== 'undefined' ? window : globalThis);
