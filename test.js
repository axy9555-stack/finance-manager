/* 财务管理系统 · 自测脚本
 * 运行：node test.js（无外部依赖）。
 * 用 Node 桩环境（window / document / location 最小实现）按浏览器顺序加载全部 js，
 * 对科目、凭证、余额、试算平衡、税率口径（TAX_RULES_2026.md）做断言，全部通过退出码 0。
 */
'use strict';

/* ---------- 桩环境 ---------- */
global.window = global;
global.document = {
  getElementById: function () { return null; },
  querySelectorAll: function () { return []; }
};
global.location = { hash: '' };
global.FMToast = function () {};

var fs = require('fs');
var path = require('path');
['js/taxrules.js', 'js/store.js', 'js/accounts.js', 'js/voucher.js', 'js/dashboard.js'].forEach(function (f) {
  /* 在全局作用域执行，等价于浏览器的 <script src> */
  var code = fs.readFileSync(path.join(__dirname, f), 'utf8');
  require('vm').runInThisContext(code, { filename: f });
});

/* ---------- 断言工具 ---------- */
var passed = 0, failed = 0, failures = [];
function t(cond, name) {
  if (cond) { passed++; } else { failed++; failures.push(name); }
}
function tEq(actual, expected, name) {
  var okk = actual === expected;
  if (okk) { passed++; } else {
    failed++;
    failures.push(name + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
  }
}
function section(title) { console.log('== ' + title); }

var S = global.FMStore, A = global.FMAccounts, V = global.FMVoucher, T = global.FMTax;

/* ---------- 0. 载入种子数据 ---------- */
S.seed();
var PERIOD = S.get('periods').current;
tEq(PERIOD, '2026-11', '当前会计期间为 2026-11');

/* ---------- 1. 科目表 ---------- */
section('科目表');
t(A.all().length >= 100, '科目数量 ≥ 100（实际 ' + A.all().length + '）');
tEq(A.leaves().length >= 100, true, '末级科目数量 ≥ 100');
(function () {
  var seen = {}, dup = null;
  A.all().forEach(function (a) {
    if (seen[a.code]) dup = a.code;
    seen[a.code] = true;
  });
  t(!dup, '科目编码唯一（重复：' + dup + '）');
  var badFmt = A.all().filter(function (a) { return !/^\d{4}$|^\d{6}$|^\d{8}$/.test(a.code); });
  tEq(badFmt.length, 0, '科目编码均为 4/6/8 位数字（4-2-2）');
  var badCat = A.all().filter(function (a) { return A.CATEGORIES.indexOf(a.category) < 0; });
  tEq(badCat.length, 0, '科目类别均在六大类之内');
  var badDir = A.all().filter(function (a) { return a.direction !== '借' && a.direction !== '贷'; });
  tEq(badDir.length, 0, '科目余额方向只有借/贷');
  var badLevel = A.all().filter(function (a) {
    return a.level !== (a.code.length - 2) / 2 || a.parent !== (a.code.length > 4 ? a.code.slice(0, a.code.length - 2) : null);
  });
  tEq(badLevel.length, 0, '科目 parent / level 与编码一致');
})();
tEq(A.get('1002').name, '银行存款', 'get(1002) 名称正确');
tEq(A.get('9999'), null, 'get 不存在的科目返回 null');
tEq(A.get('100201').opening + A.get('100202').opening, 611230050, '银行存款末级期初合计 6,112,300.50');
t(A.isLeaf('1001'), '1001 是末级科目');
t(!A.isLeaf('1002'), '1002 不是末级科目');
tEq(A.children('1002').length, 2, '1002 有两个下级科目');
tEq(A.fullName('22210101'), '应交税费-应交增值税-进项税额', 'fullName 三级拼接正确');
tEq(A.fullName('100201'), '银行存款-工商银行基本户', 'fullName 二级拼接正确');

/* validate 校验与中文报错 */
var vr = A.validate('1001');
t(vr.ok === true, 'validate 已存在科目返回 ok');
vr = A.validate('');
t(!vr.ok && vr.reason === '科目编码不能为空', 'validate 空编码中文报错');
vr = A.validate('10a1');
t(!vr.ok && /格式不正确/.test(vr.reason), 'validate 非数字编码中文报错');
vr = A.validate('123');
t(!vr.ok && /长度不正确/.test(vr.reason), 'validate 长度错误中文报错');
vr = A.validate('9999');
t(!vr.ok && vr.reason.indexOf('9999') >= 0 && vr.reason.indexOf('不存在') >= 0, 'validate 不存在的科目中文报错');
(function () {
  var reasons = ['', '10a1', '123', '9999'].map(function (c) { return A.validate(c).reason || ''; });
  t(reasons.every(function (r) { return /[\u4e00-\u9fa5]/.test(r); }), 'validate 全部报错信息为中文');
})();

/* ---------- 2. 期初与试算平衡 ---------- */
section('期初 / 试算平衡');
var ot = A.openingTrial();
tEq(ot.balanced, true, '期初试算平衡');
tEq(ot.debit, 2032735050, '期初借方合计 = 20,327,350.50（2032735050 分）');
tEq(ot.credit, 2032735050, '期初贷方合计 = 20,327,350.50（2032735050 分）');
tEq(ot.diff, 0, '期初借贷差额为 0');
var tb0 = V.trialBalance(PERIOD);
tEq(tb0.balanced, true, '当前期间全部凭证试算平衡');
tEq(tb0.diff, 0, '当前期间借贷差额为 0');
tEq(tb0.debit, tb0.credit, '当前期间借方合计 = 贷方合计');
t(tb0.debit > 0, '当前期间有发生额（借方合计 ' + S.fmt(tb0.debit) + ' 元）');
tEq(S.get('vouchers').length, 12, '种子凭证 12 张');
tEq(S.get('entries').length, 46, '种子分录 46 行');
(function () {
  var unbalanced = [];
  S.get('vouchers').forEach(function (v) {
    var dt = 0, ct = 0;
    V.entriesOf(v.id).forEach(function (e) { dt += e.debit; ct += e.credit; });
    if (dt !== ct) unbalanced.push(v.id);
  });
  tEq(unbalanced.length, 0, '每张种子凭证自身借贷相等');
})();

/* ---------- 3. 余额计算一致性 ---------- */
section('余额计算');
(function () {
  /* 用独立实现核对 balance()：期初 + 全部（cumulative）期间内分录，按科目方向折算 */
  ['1002', '1122', '2202', '1405', '222102', '600101'].forEach(function (code) {
    var acc = A.get(code);
    var opening = 0;
    A.all().forEach(function (a) {
      if (a.code.indexOf(code) !== 0) return;
      opening += a.direction === '借' ? (a.opening || 0) : -(a.opening || 0);
    });
    var act = { debit: 0, credit: 0 };
    S.get('entries').forEach(function (e) {
      if (String(e.accountCode).indexOf(code) !== 0) return;
      var v = S.get('vouchers').filter(function (x) { return x.id === e.voucherId; })[0];
      if (!v || v.period > PERIOD) return;
      act.debit += e.debit || 0;
      act.credit += e.credit || 0;
    });
    var net = act.debit - act.credit + opening;
    var expected = acc.direction === '借' ? net : -net;
    tEq(A.balance(code, PERIOD), expected, 'balance(' + code + ') 与独立核算一致');
  });
  tEq(A.balance('1002', PERIOD), 562597050, '银行存款余额 = 5,625,970.50');
  t(A.balance('1122', PERIOD) > 0, '应收账款余额为正');
  t(A.balance('2202', PERIOD) > 0, '应付账款余额为正');
  tEq(A.balance('9999', PERIOD), 0, '不存在科目余额为 0');
  tEq(A.balance('1002', PERIOD, { postedOnly: true }) !== A.balance('1002', PERIOD), true,
    'postedOnly 过滤未过账凭证（有未审核种子凭证）');
})();

/* ---------- 4. 凭证创建校验（全部拒绝路径，中文报错） ---------- */
section('凭证创建校验');
function E(code, a, b, c) {
  /* E(code, 借, 贷) 或 E(code, 行摘要, 借, 贷) */
  return c === undefined
    ? { accountCode: code, summary: '', debit: a, credit: b, aux: {} }
    : { accountCode: code, summary: a, debit: b, credit: c, aux: {} };
}
function res(t_) { return t_ && t_.reason ? t_.reason : JSON.stringify(t_); }
var r;
r = V.create({});
t(!r.ok && /日期不能为空/.test(r.reason), '缺日期拒绝（' + res(r) + '）');
r = V.create({ date: '2026-12-01', summary: 'x', entries: [E('1001', '100', 0), E('100201', 0, '100')] });
t(!r.ok && /不在当前会计期间/.test(r.reason), '跨期间日期拒绝');
r = V.create({ date: '2026-11-01', summary: '  ', entries: [E('1001', '100', 0), E('100201', 0, '100')] });
t(!r.ok && /摘要不能为空/.test(r.reason), '空摘要拒绝');
r = V.create({ date: '2026-11-01', summary: '单行', entries: [E('1001', '100', 0)] });
t(!r.ok && /至少需要两行/.test(r.reason), '单行分录拒绝');
r = V.create({ date: '2026-11-01', summary: '借贷不等', entries: [E('1001', '100', 0), E('100201', 0, '99')] });
t(!r.ok && /不相等/.test(r.reason) && /不平衡/.test(r.reason), '借贷不等拒绝并报差额');
r = V.create({ date: '2026-11-01', summary: '科目不存在', entries: [E('9999', '100', 0), E('100201', 0, '100')] });
t(!r.ok && /9999/.test(r.reason) && /不存在/.test(r.reason), '科目不存在拒绝');
r = V.create({ date: '2026-11-01', summary: '非末级', entries: [E('1002', '100', 0), E('100201', 0, '100')] });
t(!r.ok && /不是末级科目/.test(r.reason), '非末级科目拒绝');
r = V.create({ date: '2026-11-01', summary: '双向', entries: [E('1001', '100', '50'), E('100201', 0, '100')] });
t(!r.ok && /不能同时有金额/.test(r.reason), '借贷同时有金额拒绝');
r = V.create({ date: '2026-11-01', summary: '零金额', entries: [E('1001', 0, 0), E('100201', 0, 0)] });
t(!r.ok && /金额不能为零/.test(r.reason), '全零金额拒绝');
r = V.create({ date: '2026-11-01', summary: '金额格式', entries: [E('1001', '1.234', 0), E('100201', 0, '100')] });
t(!r.ok && /金额格式不正确/.test(r.reason), '超过两位小数拒绝');
(function () {
  var rs = [V.create({}), V.create({ date: '2026-11-01', summary: '', entries: [] })];
  t(rs.every(function (x) { return !x.ok && /[\u4e00-\u9fa5]/.test(x.reason); }), '创建失败报错均为中文');
})();

/* ---------- 5. 凭证创建成功 + 审核 / 过账流程 ---------- */
section('创建 / 审核 / 过账');
var before = S.get('vouchers').length;
r = V.create({
  date: '2026-11-25', summary: '测试现金提现', maker: '王丽', attachCount: 2,
  entries: [E('1001', '提现', '100.00', 0), E('100201', 0, '', '100.00')]
});
tEq(r.ok, true, '平衡凭证创建成功');
tEq(r.id, '记-2026-11-0013', '新凭证编号接续种子流水');
var v13 = S.get('vouchers').filter(function (x) { return x.id === r.id; })[0];
tEq(v13.status, '未审核', '新建凭证状态为未审核');
tEq(v13.maker, '王丽', '制单人记录正确');
tEq(S.get('entries').length, 48, '新分录入 state.entries（46 + 2）');
tEq(V.nextId(PERIOD), '记-2026-11-0014', 'nextId 预测下一编号');
tEq(S.get('vouchers').length, before + 1, '凭证列表 +1');

r = V.audit(r.id, '');
t(!r.ok && /审核人不能为空/.test(r.reason), '空审核人拒绝');
r = V.audit(v13.id, '王丽');
t(!r.ok && /不能审核自己/.test(r.reason) && /王丽/.test(r.reason), '制单人不能审核自己的凭证');
r = V.audit(v13.id, '李强');
tEq(r.ok, true, '他人审核通过');
tEq(v13.status, '已审核', '审核后状态为已审核');
tEq(v13.auditor, '李强', '审核人已记录');
r = V.audit(v13.id, '李强');
t(!r.ok && /只有未审核凭证可以审核/.test(r.reason), '已审核凭证不能重复审核');

r = V.create({ date: '2026-11-26', summary: '测试未审核过账拦截', maker: '王丽',
  entries: [E('5001', '', '10.00', 0), E('1405', 0, '', '10.00')] });
var v14 = r.id;
tEq(V.post(v14).ok, false, '未审核凭证不能过账');
t(/不能过账/.test(V.post(v14).reason), '未过账拦截报错中文');
tEq(V.audit(v14, '李强').ok, true, '凭证 14 审核通过');
r = V.post(v14);
tEq(r.ok, true, '已审核凭证过账成功');
tEq(S.get('vouchers').filter(function (x) { return x.id === v14; })[0].status, '已过账', '过账后状态已过账');
r = V.post(v14);
t(!r.ok && /重复过账|已过账/.test(r.reason), '已过账凭证不能重复过账');
r = V.unpost(v14);
tEq(r.ok, true, '当月凭证反过账成功');
tEq(S.get('vouchers').filter(function (x) { return x.id === v14; })[0].status, '已审核', '反过账后回到已审核');
tEq(V.unpost(v14).ok, false, '未过账凭证不能反过账');

/* ---------- 6. 红字冲销：余额归零 ---------- */
section('红字冲销');
var cashBefore = A.balance('1001', PERIOD);
tEq(V.reverse(v14).ok, false, '未过账凭证不能红字冲销');
tEq(V.post(v14).ok, true, '凭证 14 重新过账');
var cashAfterPost = A.balance('1001', PERIOD);
tEq(cashAfterPost, cashBefore, '过账不影响 1001（该凭证动的是 5001/1405）');
r = V.reverse(v14);
tEq(r.ok, true, '红字冲销生成冲销凭证');
var revId = r.id;
var rev = S.get('vouchers').filter(function (x) { return x.id === revId; })[0];
tEq(rev.status, '未审核', '冲销凭证初始为未审核');
t(/红字冲销/.test(rev.summary), '冲销凭证摘要带“红字冲销”');
(function () {
  var orig = V.entriesOf(v14), rv = V.entriesOf(revId);
  tEq(rv.length, orig.length, '冲销凭证行数与原凭证一致');
  var swapOk = rv.every(function (e, i) {
    return e.accountCode === orig[i].accountCode && e.debit === orig[i].credit && e.credit === orig[i].debit;
  });
  t(swapOk, '冲销凭证借贷互换');
})();
tEq(V.audit(revId, '李强').ok, true, '冲销凭证审核通过');
tEq(V.post(revId).ok, true, '冲销凭证过账');
tEq(A.balance('1001', PERIOD), cashBefore, '红字冲销过账后相关科目余额归零');
(function () {
  var o = V.entriesOf(v14).reduce(function (s, e) { return s + e.debit - e.credit; }, 0);
  var rr = V.entriesOf(revId).reduce(function (s, e) { return s + e.debit - e.credit; }, 0);
  tEq(o + rr, 0, '原凭证与冲销凭证净发生额之和为 0');
})();

/* ---------- 7. 结账期间 / 跨月限制 ---------- */
section('结账与跨月');
var v15 = V.create({ date: '2026-11-27', summary: '测试结账期间拦截', maker: '王丽',
  entries: [E('1001', '', '5.00', 0), E('100201', 0, '', '5.00')] }).id;
var v16 = V.create({ date: '2026-11-28', summary: '测试跨月限制', maker: '王丽',
  entries: [E('1001', '', '6.00', 0), E('100201', 0, '', '6.00')] }).id;
V.audit(v15, '李强');
V.audit(v16, '李强');
tEq(V.post(v16).ok, true, '跨月测试凭证先过账');
(function () {
  var a = S.get('vouchers').filter(function (x) { return x.id === v15; })[0];
  var b = S.get('vouchers').filter(function (x) { return x.id === v16; })[0];
  a.period = '2026-10';
  var p = V.post(v15);
  t(!p.ok && /已结账/.test(p.reason), '已结账期间不能过账');
  b.period = '2026-10';
  var u = V.unpost(v16);
  t(!u.ok && /只能反过账当月/.test(u.reason), '非当月凭证不能反过账');
  var rv2 = V.reverse(v16);
  t(!rv2.ok && /只能红字冲销当月/.test(rv2.reason), '非当月凭证不能红字冲销');
  a.period = PERIOD; /* 还原，保证后续试算仍覆盖该凭证 */
})();
tEq(V.post(v15).ok, true, '还原期间后可正常过账');

/* ---------- 8. 查询 ---------- */
section('凭证查询');
t(V.list({ status: '已过账' }).every(function (v) { return v.status === '已过账'; }), '按状态过滤');
t(V.list({ period: PERIOD }).length > 0, '按期间过滤');
t(V.list({ keyword: '工资' }).some(function (v) { return v.id === '记-2026-11-0005'; }), '关键词命中摘要');
t(V.list({ accountCode: '100201' }).length > 0, '按科目编码前缀过滤');
(function () {
  var e = V.entriesOf('记-2026-11-0001');
  tEq(e[0].line, 1, 'entriesOf 按行号排序');
  tEq(V.entriesOf('记-9999-9999').length, 0, '不存在凭证无分录');
})();

/* ---------- 9. 终态试算平衡 ---------- */
section('终态试算平衡');
var tb1 = V.trialBalance(PERIOD);
tEq(tb1.balanced, true, '全部增删改后当前期间试算仍平衡');
tEq(tb1.debit, tb1.credit, '终态借方合计 = 贷方合计（' + S.fmt(tb1.debit) + ' 元）');
tEq(A.openingTrial().balanced, true, '期初试算不受凭证操作影响');
(function () {
  var log = S.get('auditLog');
  t(log.length >= 5, '审计日志已记录（' + log.length + ' 条）');
  t(log.some(function (l) { return l.action === '红字冲销'; }), '红字冲销已入审计日志');
})();

/* ---------- 10. 金额与转义工具 ---------- */
section('store 工具');
tEq(S.toCents('1,234.56'), 123456, 'toCents 千分位字符串');
tEq(S.toCents('￥-12.3'), -1230, 'toCents 负数一位小数');
tEq(S.toCents('0'), 0, 'toCents 零');
tEq(S.toCents('1.234'), null, 'toCents 三位小数非法');
tEq(S.toCents('abc'), null, 'toCents 非数字非法');
tEq(S.fmt(123456), '1,234.56', 'fmt 千分位');
tEq(S.fmt(-100), '-1.00', 'fmt 负数');
tEq(S.fmt(5), '0.05', 'fmt 分进位显示');
tEq(S.esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;', 'esc HTML 转义');

/* ---------- 11. 税率口径（唯一来源 TAX_RULES_2026.md） ---------- */
section('税率口径 vs TAX_RULES_2026.md');
tEq(T.vat.generalRates.goods, 0.13, '增值税·货物 13%');
tEq(T.vat.generalRates.transport, 0.09, '增值税·交通运输/不动产租赁 9%');
tEq(T.vat.generalRates.service, 0.06, '增值税·服务 6%');
tEq(T.vat.threshold, 5000000, '一般纳税人年销售额标准 500 万');
tEq(T.vat.smallScale.levy, 0.03, '小规模征收率 3%');
tEq(T.vat.smallScale.reduced, 0.01, '小规模减按 1%');
tEq(T.vat.smallScale.reducedFrom, '2026-01-01', '1% 优惠起始 2026-01-01');
tEq(T.vat.smallScale.reducedUntil, '2027-12-31', '1% 优惠截止 2027-12-31');
tEq(T.vat.smallScale.exemptMonthly, 150000, '小规模月销售额免征额 15 万');
tEq(T.vat.smallScale.exemptQuarterly, 450000, '小规模季销售额免征额 45 万');
tEq(T.vatRateFor('general', 'goods'), 0.13, 'vatRateFor 一般纳税人·货物');
tEq(T.vatRateFor('小规模纳税人', 'service', '2026-06-01'), 0.01, 'vatRateFor 小规模优惠期内 1%');
tEq(T.vatRateFor('small', 'goods', '2027-12-31'), 0.01, 'vatRateFor 截止日当天仍 1%');
tEq(T.vatRateFor('small', 'goods', '2028-01-01'), 0.03, 'vatRateFor 优惠期后恢复 3%');
tEq(T.vatRateFor('small', 'realEstate'), 0.05, 'vatRateFor 小规模不动产 5% 不享受 1%');
tEq(T.vatRateFor('general', 'unknown'), null, 'vatRateFor 未知税目返回 null');
tEq(T.cit.rate, 0.25, '企业所得税法定 25%');
tEq(T.cit.highTech, 0.15, '高新技术企业 15%');
tEq(T.cit.smallProfit.incomeLimit, 3000000, '小微应纳税所得额上限 300 万');
tEq(T.cit.smallProfit.staffLimit, 300, '小微从业人数上限 300 人');
tEq(T.cit.smallProfit.assetsLimit, 50000000, '小微资产总额上限 5000 万');
tEq(T.cit.smallProfit.includeRate, 0.25, '小微减按 25% 计入');
tEq(T.cit.smallProfit.rate, 0.20, '小微按 20% 税率');
tEq(T.cit.smallProfit.until, '2027-12-31', '小微优惠执行至 2027-12-31');
tEq(T.smallProfitEffectiveRate(), 0.05, '小微实际税负 5%（25%×20%）');
t(T.isSmallProfit({ taxableIncome: 2999999, staffCount: 300, totalAssets: 49999999 }), 'isSmallProfit 三条件同时满足');
t(T.isSmallProfit({ taxableIncome: 3000000, staffCount: 300, totalAssets: 50000000 }), 'isSmallProfit 边界值（≤）成立');
t(!T.isSmallProfit({ taxableIncome: 3000001, staffCount: 300, totalAssets: 50000000 }), 'isSmallProfit 所得额超 300 万不成立');
t(!T.isSmallProfit({ taxableIncome: 100, staffCount: 301, totalAssets: 100 }), 'isSmallProfit 人数超 300 不成立');
t(!T.isSmallProfit({ taxableIncome: 100, staffCount: 10, totalAssets: 50000001 }), 'isSmallProfit 资产超 5000 万不成立');
t(!T.isSmallProfit({}), 'isSmallProfit 缺参数不成立');
t(!T.isSmallProfit({ taxableIncome: 100, staffCount: 10, totalAssets: 100, restrictedIndustry: true }), 'isSmallProfit 限制行业不成立');
tEq(T.iit.basicDeductionMonthly, 5000, '个税起征点（减除费用）5000 元/月');
tEq(T.iit.brackets.length, 7, '个税预扣率表 7 级');
tEq(T.iit.brackets[0][1] + '/' + T.iit.brackets[0][2], '0.03/0', '第 1 级 3% 速算扣除 0');
tEq(T.iit.brackets[1][1] + '/' + T.iit.brackets[1][2], '0.1/2520', '第 2 级 10% 速算扣除 2520');
tEq(T.iit.brackets[6][1] + '/' + T.iit.brackets[6][2], '0.45/181920', '第 7 级 45% 速算扣除 181920');
tEq(T.iit.brackets[3][2], 31920, '第 4 级速算扣除 31920');
var sd = T.iit.specialDeductions;
tEq(sd.childEdu, 2000, '专项附加·子女教育 2000 元/子女/月');
tEq(sd.infantCare, 2000, '专项附加·婴幼儿照护 2000 元/月');
tEq(sd.degreeEdu, 400, '专项附加·学历继续教育 400 元/月');
tEq(sd.certEdu, 3600, '专项附加·职业资格证书 3600 元');
tEq(sd.housingLoan, 1000, '专项附加·住房贷款利息 1000 元/月');
tEq(sd.rent.tier1 + '/' + sd.rent.tier2 + '/' + sd.rent.tier3, '1500/1100/800', '专项附加·住房租金三档 1500/1100/800');
tEq(sd.elderly.onlyChild, 3000, '专项附加·赡养老人独生子女 3000 元/月');
tEq(sd.elderly.sharedMax, 1500, '专项附加·赡养老人非独生分摊上限 1500 元/月');
tEq(sd.medical.threshold, 15000, '专项附加·大病医疗起付 15000 元');
tEq(sd.medical.cap, 80000, '专项附加·大病医疗限额 80000 元');
tEq(T.surtax.urban, 0.07, '城建税市区 7%');
tEq(T.surtax.county, 0.05, '城建税县城镇 5%');
tEq(T.surtax.other, 0.01, '城建税其他 1%');
tEq(T.surtax.edu, 0.03, '教育费附加 3%');
tEq(T.surtax.localEdu, 0.02, '地方教育附加 2%');
tEq(T.sixTaxTwoFeeHalfUntil, '2027-12-31', '六税两费减半至 2027-12-31');
tEq(T.depreciation.building + '/' + T.depreciation.machinery + '/' + T.depreciation.vehicle + '/' + T.depreciation.electronic,
  '20/10/4/3', '折旧年限 房屋20/设备10/运输4/电子3');
tEq(T.depreciation.residualRate, 0.05, '默认残值率 5%');
tEq(T.stampDuty.saleContract, 0.0003, '印花税买卖合同 0.03%');
tEq(T.iit.settlement.from + '~' + T.iit.settlement.to, '03-01~06-30', '汇算清缴 3 月 1 日至 6 月 30 日');
tEq(T.iit.settlement.exemptIncome, 120000, '免汇算年收入 12 万');
tEq(T.iit.settlement.exemptTax, 400, '免汇算补税额 400 元');
tEq(T.iit.annualBonusSeparateUntil, '2027-12-31', '年终奖单独计税至 2027-12-31');

/* ---------- 12. 渲染冒烟（Node 桩 DOM，不抛错即通过） ---------- */
section('渲染冒烟');
function smoke(fn, name) {
  try { fn(); passed++; }
  catch (e) { failed++; failures.push(name + ' 抛错：' + (e && e.message)); }
}
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  global.FMDashboard.renderDashboard(el);
  if (el.innerHTML.indexOf('看板') < 0 || el.innerHTML.indexOf('试算平衡') < 0) throw new Error('看板内容缺失');
}, 'renderDashboard');
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  V.renderVouchers(el);
  if (el.innerHTML.indexOf('凭证') < 0 || el.innerHTML.indexOf('记-2026-11-0001') < 0) throw new Error('凭证列表内容缺失');
}, 'renderVouchers');
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  A.renderAccounts(el);
  if (el.innerHTML.indexOf('会计科目') < 0 || el.innerHTML.indexOf('平衡') < 0) throw new Error('科目页内容缺失');
}, 'renderAccounts');
smoke(function () {
  var el = { innerHTML: '', onclick: null, onchange: null, oninput: null };
  V.renderVoucherForm(el); /* 新建表单 */
  if (el.innerHTML.indexOf('新建凭证') < 0) throw new Error('新建凭证表单缺失');
}, 'renderVoucherForm（新建）');
smoke(function () {
  var el = { innerHTML: '', onclick: null, onchange: null, oninput: null };
  V.renderVoucherForm(el, '记-2026-11-0001'); /* 查看已有凭证 */
  if (el.innerHTML.indexOf('采购商品一批入库') < 0) throw new Error('凭证详情缺失');
}, 'renderVoucherForm（查看）');

/* ---------- 汇总 ---------- */
console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项（共 ' + (passed + failed) + ' 项断言）');
if (failed) {
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
} else {
  console.log('全部通过 ✓');
}
