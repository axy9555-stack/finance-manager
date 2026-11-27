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
['js/taxrules.js', 'js/store.js', 'js/accounts.js', 'js/voucher.js', 'js/dashboard.js',
 'js/ledger.js', 'js/closing.js', 'js/opening.js', 'js/arap.js', 'js/cashier.js'].forEach(function (f) {
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
tEq(tb0.balanced, true, '当前期间已过账凭证试算平衡');
tEq(tb0.diff, 0, '当前期间借贷差额为 0');
tEq(tb0.debit, tb0.credit, '当前期间借方合计 = 贷方合计');
tEq(tb0.debit, 460853000, '新鲜种子已过账借方合计 4,608,530.00（只计 0001–0006）');
tEq(tb0.postedCount, 6, '已过账凭证 6 张');
tEq(tb0.voucherCount, 12, '本期凭证总数仍为 12 张');
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
  /* 用独立实现核对 balance()：期初 + 已过账凭证（账簿口径，未过账不算余额） */
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
      if (!v || v.period > PERIOD || v.status !== '已过账') return;
      act.debit += e.debit || 0;
      act.credit += e.credit || 0;
    });
    var net = act.debit - act.credit + opening;
    var expected = acc.direction === '借' ? net : -net;
    tEq(A.balance(code, PERIOD), expected, 'balance(' + code + ') 与独立核算一致');
  });
  tEq(A.balance('1002', PERIOD), 519737050, '银行存款余额（已过账口径）= 5,197,370.50');
  t(A.balance('1122', PERIOD) > 0, '应收账款余额为正');
  t(A.balance('2202', PERIOD) > 0, '应付账款余额为正');
  tEq(A.balance('9999', PERIOD), 0, '不存在科目余额为 0');
  tEq(A.balance('1002', PERIOD, { postedOnly: false }) !== A.balance('1002', PERIOD), true,
    'postedOnly:false 计入未过账凭证（与默认已过账口径不等，差 0007–0012 的发生额）');
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

/* ---------- 13. chunk 2：总账 / 余额表 / 明细账 ---------- */
S.seed();
var LP = S.get('periods').current;
section('chunk 2 · 总账 / 余额表 / 明细账');
(function () {
  /* 独立复算核对 accountBalance */
  ['1002', '1122', '2202', '600101', '1405', '3103'].forEach(function (code) {
    var acc = A.get(code);
    var sign = acc.direction === '借' ? 1 : -1;
    var open = 0;
    A.all().forEach(function (a) {
      if (String(a.code).indexOf(code) !== 0) return;
      open += a.direction === '借' ? (a.opening || 0) : -(a.opening || 0);
    });
    var d = 0, c = 0;
    S.get('entries').forEach(function (e) {
      if (String(e.accountCode).indexOf(code) !== 0) return;
      var v = S.get('vouchers').filter(function (x) { return x.id === e.voucherId; })[0];
      if (!v || v.period !== LP || v.status !== '已过账') return;
      d += e.debit || 0;
      c += e.credit || 0;
    });
    var got = FMLedger.accountBalance(code, LP);
    tEq(got.opening, open * sign, 'accountBalance(' + code + ').opening 独立复算一致');
    tEq(got.debit, d, 'accountBalance(' + code + ').debit 只含已过账');
    tEq(got.credit, c, 'accountBalance(' + code + ').credit 只含已过账');
    tEq(got.closing, (open + d - c) * sign, 'accountBalance(' + code + ').closing 独立复算一致');
  });
})();
tEq(FMLedger.accountBalance('9999', LP), null, 'accountBalance 不存在科目返回 null');
tEq(FMLedger.accountBalance('100201', LP).opening, 486230050, '工行基本户期初 4,862,300.50');
t(FMLedger.accountBalance('2202', LP).opening > 0, '贷方向科目期初按贷正折算');
t(FMLedger.accountBalance('1002', LP).debit > 0 || FMLedger.accountBalance('1002', LP).credit > 0, '银行存款有已过账发生额');

var gl = FMLedger.generalLedger(LP);
tEq(gl.rows.length, A.leaves().length, '总账行数 = 末级科目数（' + A.leaves().length + '）');
t(gl.rows.every(function (r) {
  return r.direction === '借' ? r.closing === r.opening + r.debit - r.credit
    : r.closing === r.opening - r.debit + r.credit;
}), '总账每行 期末 = 期初 ± 本期借贷发生（按方向折算）');
var glA = FMLedger.generalLedger(LP, '资产');
t(glA.rows.length > 0 && glA.rows.every(function (r) { return r.category === '资产'; }), '总账按大类筛选（资产）');

var bs = FMLedger.balanceSheet(LP);
tEq(bs.balanced, true, '科目余额表平衡');
tEq(bs.closing.debit, bs.closing.credit, '余额表借方合计 = 贷方合计（' + S.fmt(bs.closing.debit) + ' 元）');
tEq(bs.diff, 0, '余额表差额为 0');
tEq(bs.reason, '', '平衡时无报错原因');
tEq(bs.opening.debit, 2032735050, '余额表期初借方合计 20,327,350.50');
tEq(bs.opening.credit, 2032735050, '余额表期初贷方合计 20,327,350.50');

var dl = FMLedger.detailLedger('100201', LP);
t(dl.rows.length > 0, '明细账有已过账分录行（' + dl.rows.length + ' 行）');
(function () {
  /* 独立复算滚动余额 */
  var manual = [];
  S.get('entries').forEach(function (e) {
    if (String(e.accountCode).indexOf('100201') !== 0) return;
    var v = S.get('vouchers').filter(function (x) { return x.id === e.voucherId; })[0];
    if (!v || v.period !== LP || v.status !== '已过账') return;
    manual.push({ date: v.date, vid: v.id, line: e.line || 0, d: e.debit || 0, c: e.credit || 0 });
  });
  manual.sort(function (x, y) {
    if (x.date !== y.date) return x.date < y.date ? -1 : 1;
    if (x.vid !== y.vid) return x.vid < y.vid ? -1 : 1;
    return x.line - y.line;
  });
  var raw = 486230050, expected = [];
  manual.forEach(function (m) { raw += m.d - m.c; expected.push(raw); });
  tEq(dl.rows.map(function (r) { return r.balance; }).join(','), expected.join(','), '明细账余额逐行滚动与独立复算一致');
  tEq(dl.rows[0].balance, 486230050 + manual[0].d - manual[0].c, '明细账首行余额 = 期初 + 首行净额');
  tEq(dl.closing, FMLedger.accountBalance('100201', LP).closing, '明细账期末 = 余额表期末');
  var dates = dl.rows.map(function (r) { return r.date; });
  t(dates.every(function (d, i) { return i === 0 || dates[i - 1] <= d; }), '明细账按日期升序');
})();
tEq(dl.rows.every(function (r) { return !!r.voucherId; }), true, '明细账行都带凭证号');
tEq(FMLedger.detailLedger('9999', LP), null, '明细账不存在科目返回 null');

var tb2 = FMLedger.trialBalance(LP), base = V.trialBalance(LP);
tEq(tb2.balanced, true, 'chunk 2 试算平衡表平衡');
tEq(tb2.debit, base.debit, '试算平衡复用 voucher.js 借方合计');
tEq(tb2.credit, base.credit, '试算平衡复用 voucher.js 贷方合计');
tEq(tb2.byCategory.reduce(function (s, c) { return s + c.debit; }, 0), tb2.debit, '大类借方合计之和 = 总借方');
tEq(tb2.byCategory.reduce(function (s, c) { return s + c.credit; }, 0), tb2.credit, '大类贷方合计之和 = 总贷方');
tEq(tb2.byCategory.length, A.CATEGORIES.length, '按 6 大类分组');

var csv = FMLedger.exportCSV([['科目编码', '名称', '方向', '期初余额'], ['1001', '库存现金', '借', '38,650.00'], ['a"b', 'x,y']]);
tEq(csv.charCodeAt(0), 0xFEFF, 'CSV 带 UTF-8 BOM');
t(csv.slice(1).indexOf('科目编码,名称,方向,期初余额\r\n') === 0, 'CSV 表头与 CRLF');
t(csv.indexOf('1001,库存现金,借,"38,650.00"') > 0, 'CSV 含逗号字段自动加引号');
t(csv.indexOf('"a""b","x,y"') > 0, 'CSV 引号与逗号转义');
tEq(csv.slice(-2), '\r\n', 'CSV 以换行结束');
t(typeof FMLedger.exportCSV([]) === 'string', 'Node 环境导出返回字符串');

/* ---------- 14. chunk 2：期初余额 ---------- */
section('chunk 2 · 期初余额');
tEq(FMOpening.get('1001'), 3865000, 'get 期初余额（38,650.00 元）');
tEq(FMOpening.get('9999'), null, 'get 不存在科目返回 null');
tEq(FMOpening.validate().ok, true, '种子期初试算平衡通过');
r = FMOpening.set('9999', 100, '借');
t(!r.ok && /不存在/.test(r.reason), 'set 科目不存在拒绝');
r = FMOpening.set('1002', 100, '借');
t(!r.ok && /不是末级/.test(r.reason), 'set 非末级科目拒绝');
r = FMOpening.set('1001', -1, '借');
t(!r.ok && /不能为负/.test(r.reason), 'set 负数金额拒绝');
r = FMOpening.set('1001', 100.5, '借');
t(!r.ok && /整数分/.test(r.reason), 'set 非整数分拒绝');
r = FMOpening.set('1001', 100, '贷');
t(!r.ok && /方向/.test(r.reason), 'set 方向与科目方向不一致拒绝');
tEq(FMOpening.set('1001', 3865000, '借').ok, true, 'set 同值写入成功');
tEq(FMOpening.set('1001', 3875000, '借').ok, true, 'set 修改借方期初（+100 元）');
tEq(FMOpening.set('2202', 284570000, '贷').ok, true, 'set 修改贷方期初（+100 元）');
tEq(FMOpening.validate().ok, true, '成对修改后期初仍平衡');
var adj = FMOpening.adjust([
  { code: '1001', amount: 3895000, direction: '借' },
  { code: '2202', amount: 284590000, direction: '贷' }
]);
tEq(adj.ok, true, 'adjust 平衡批量调整成功');
tEq(FMOpening.get('1001'), 3895000, 'adjust 写入借方期初');
tEq(FMOpening.get('2202'), 284590000, 'adjust 写入贷方期初');
tEq(FMOpening.validate().ok, true, 'adjust 后期初仍平衡');
var adj2 = FMOpening.adjust([
  { code: '1001', amount: 3905000, direction: '借' },
  { code: '1001', amount: -5, direction: '借' }
]);
t(!adj2.ok && /不能为负/.test(adj2.reason), 'adjust 任一行失败返回第一个失败原因');
tEq(FMOpening.get('1001'), 3895000, 'adjust 行级失败全部回滚（借方未变）');
var adj3 = FMOpening.adjust([
  { code: '1001', amount: 3915000, direction: '借' },
  { code: '2202', amount: 284600000, direction: '贷' }
]);
t(!adj3.ok && /不平衡/.test(adj3.reason) && /差额/.test(adj3.reason), '期初不平拒绝保存并报差额');
tEq(FMOpening.get('1001'), 3895000, '不平批量回滚（借方未变）');
tEq(FMOpening.get('2202'), 284590000, '不平批量回滚（贷方未变）');
tEq(FMOpening.validate().ok, true, '回滚后期初仍平衡');
r = FMOpening.adjust([{ code: '1001', amount: 1 }]);
t(!r.ok && /方向/.test(r.reason), 'adjust 缺方向拒绝');

/* ---------- 15. chunk 2：结账流程（结转损益 → 月结 → 反结账） ---------- */
section('chunk 2 · 结账 / 结转损益 / 反结账');
var cl = FMClosing.closeChecklist(LP);
tEq(cl.length, 4, '检查清单 4 项');
tEq(cl[0].ok, true, '① 本期试算平衡通过');
tEq(cl[1].ok, false, '② 存在未过账凭证被拦');
tEq(cl[3].ok, false, '④ 损益未结转被标记');
r = FMClosing.close(LP);
t(!r.ok && /检查未通过/.test(r.reason) && /已过账/.test(r.reason), '结账被检查清单拦截（未过账凭证）');
tEq(FMClosing.isClosed(LP), false, '拦截后期间未结账');

S.get('vouchers').forEach(function (v) { if (v.status === '未审核') V.audit(v.id, '李强'); });
t(S.get('vouchers').every(function (v) { return v.status !== '未审核'; }), '未审核凭证已全部审核');
var postFails = [];
S.get('vouchers').forEach(function (v) {
  if (v.status !== '已过账') { var p = V.post(v.id); if (!p.ok) postFails.push(p.reason); }
});
tEq(postFails.length, 0, '全部凭证过账成功');
tEq(S.get('vouchers').filter(function (v) { return v.status === '已过账'; }).length, 12, '12 张凭证全部已过账');

tEq(FMClosing.carryForward('2026-12').ok, false, '非当前期间不能结转损益');
var cf = FMClosing.carryForward(LP);
tEq(cf.ok, true, '结转损益成功');
tEq(cf.income, 165000000, '结转收入 1,650,000.00');
tEq(cf.expense, 222290040, '结转成本费用 2,222,900.40');
tEq(cf.amount, -57290040, '净亏损 −572,900.40 结转本年利润');
var carryV = S.get('vouchers').filter(function (v) { return v.id === cf.id; })[0];
tEq(carryV.status, '已过账', '结转凭证已审核并过账');
tEq(carryV.maker, '系统结转', '结转凭证制单人为系统结转');
t(/结转本期损益（2026-11）/.test(carryV.summary), '结转凭证摘要注明期间');
tEq(V.entriesOf(cf.id).reduce(function (s, e) { return s + e.debit; }, 0), 222290040, '结转凭证借方合计 = 成本费用合计（借贷平衡）');
var plZero = A.leaves().filter(function (a) { return a.category === '损益'; })
  .every(function (a) { return FMLedger.accountBalance(a.code, LP).closing === 0; });
tEq(plZero, true, '结转后损益类末级科目余额全部归零');
(function () {
  var b3103 = FMLedger.accountBalance('3103', LP);
  tEq(b3103.closing - b3103.opening, -57290040, '本年利润承接结转净额 −572,900.40（原期初贷余额 685,200 承接后变借余额）');
  tEq(b3103.closing, 11229960, '本年利润期末贷向折算余额 112,299.60（期初 685,200 − 亏损 572,900.40）');
})();
var cf2 = FMClosing.carryForward(LP);
t(!cf2.ok && cf2.reason === '本期损益已结转', '重复结转返回“本期损益已结转”');

tEq(FMClosing.closeChecklist(LP).every(function (i) { return i.ok; }), true, '全部过账并结转后检查清单全通过');
tEq(FMClosing.canClose(LP).ok, true, 'canClose 允许结账');
t(!FMClosing.canClose('2026-13').ok, 'canClose 非法期间拒绝');
var rclose = FMClosing.close(LP);
tEq(rclose.ok, true, '月结成功');
tEq(FMClosing.isClosed(LP), true, '期间已结账锁定');
t((S.get('closedPeriods') || []).indexOf(LP) >= 0, 'closedPeriods 已记录该期间');
r = FMClosing.close(LP);
t(!r.ok && /重复结账/.test(r.reason), '重复结账被拒绝');

/* 锁定后的凭证与期初操作 */
r = V.create({ date: '2026-11-28', summary: '结账后新增', maker: '王丽',
  entries: [E('1001', '', '1.00', 0), E('100201', 0, '', '1.00')] });
t(!r.ok && /已结账，不能新增凭证/.test(r.reason), '已结账期间不能新增凭证');
var somePosted = S.get('vouchers').filter(function (v) { return v.status === '已过账' && v.period === LP; })[0];
r = V.unpost(somePosted.id);
t(!r.ok && /已结账，不能反过账/.test(r.reason), '已结账期间不能反过账');
r = V.reverse(somePosted.id);
t(!r.ok && /已结账，不能红字冲销/.test(r.reason), '已结账期间不能红字冲销');
r = FMOpening.set('1001', 100, '借');
t(!r.ok && /结账/.test(r.reason), '已结账后期初 set 被拒绝');
r = FMOpening.adjust([{ code: '1001', amount: 1, direction: '借' }]);
t(!r.ok && /结账/.test(r.reason), '已结账后期初 adjust 被拒绝');

/* 反结账 */
var cpSim = (S.get('closedPeriods') || []).slice();
cpSim.push('2026-10');
S.set('closedPeriods', cpSim);
r = FMClosing.unclose('2026-10', '测试');
t(!r.ok && /只能反结最近/.test(r.reason), '只能反结最近一个已结账期间');
S.set('closedPeriods', (S.get('closedPeriods') || []).filter(function (p) { return p !== '2026-10'; }));
r = FMClosing.unclose('2026-99', '测试');
t(!r.ok && /未结账/.test(r.reason), '未结账期间不能反结');
tEq(FMClosing.unclose(LP, '').ok, false, '反结账原因必填');
tEq(FMClosing.unclose(LP, '   ').ok, false, '空白原因无效');
var ru = FMClosing.unclose(LP, '测试：发现漏记凭证需要补充');
tEq(ru.ok, true, '反结最近一个已结账期间成功');
tEq(FMClosing.isClosed(LP), false, '反结账后期间解锁');
t((S.get('auditLog') || []).some(function (l) {
  return l.action === '反结账' && l.target === LP && /原因：/.test(l.detail);
}), '反结账写入审计日志（操作人/时间/原因）');
r = V.create({ date: '2026-11-28', summary: '反结账后新增', maker: '王丽',
  entries: [E('1001', '', '2.00', 0), E('100201', 0, '', '2.00')] });
tEq(r.ok, true, '反结账后可再新增凭证');
tEq(FMOpening.set('1001', 3895000, '借').ok, true, '反结账后期初解锁可修改');

/* chunk 2 渲染冒烟 */
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMLedger.renderLedger(el);
  if (el.innerHTML.indexOf('总账 / 余额表') < 0 || el.innerHTML.indexOf('期末借方') < 0) throw new Error('总账页内容缺失');
}, 'renderLedger');
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMLedger.renderTrialBalance(el);
  if (el.innerHTML.indexOf('试算平衡表') < 0) throw new Error('试算平衡表内容缺失');
}, 'renderTrialBalance');
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMClosing.renderClosing(el);
  if (el.innerHTML.indexOf('结账前检查清单') < 0) throw new Error('结账页内容缺失');
}, 'renderClosing');
smoke(function () {
  var el = { innerHTML: '', onclick: null, oninput: null };
  FMOpening.renderOpening(el);
  if (el.innerHTML.indexOf('期初余额') < 0 || el.innerHTML.indexOf('借方合计') < 0) throw new Error('期初页内容缺失');
}, 'renderOpening');

/* ---------- 16. chunk 3：应收应付 ---------- */
S.seed();
var LP = S.get('periods').current;
section('chunk 3 · 应收应付 / 往来账');
(function () {
  var cust = FMARAP.customers(), sup = FMARAP.suppliers();
  t(cust.length >= 5, '客户档案 ≥ 5 个（实际 ' + cust.length + '）');
  t(sup.length >= 5, '供应商档案 ≥ 5 个（实际 ' + sup.length + '）');
  var c1 = cust.filter(function (p) { return p.id === 'C001'; })[0];
  tEq(c1 && c1.name, '南京瑞丰科技有限公司', 'C001 = 南京瑞丰科技');
  var s1 = sup.filter(function (p) { return p.id === 'S001'; })[0];
  tEq(s1 && s1.name, '华东电子有限公司', 'S001 = 华东电子');
  var c3 = cust.filter(function (p) { return p.id === 'C003'; })[0];
  tEq(c3 && c3.name, '苏州明达贸易有限公司', 'C003 = 苏州明达贸易');
  t(cust.every(function (p) { return p.creditLimit > 0 && p.creditDays > 0 && typeof p.contact === 'string' && typeof p.phone === 'string'; }),
    '客户档案字段齐全（信用额度/账期/联系人/电话）');
  t(sup.every(function (p) { return p.creditLimit > 0 && p.creditDays > 0; }), '供应商档案字段齐全');

  /* 档案外编码自动补 */
  var tmpE = { id: '__tmp__-1', voucherId: '__tmp__', line: 1, accountCode: '1122', summary: '临时', debit: 1, credit: 0, aux: { customer: 'C999' } };
  S.get('entries').push(tmpE);
  var auto = FMARAP.customers().filter(function (p) { return p.id === 'C999'; })[0];
  t(!!auto && auto.auto === true && auto.name === 'C999', '档案外的 aux 编码自动补档案（名称取编码）');
  tEq(FMARAP.customerBalance('C999', LP).closing, 0, '无已过账凭证的往来单位余额为 0');
  S.get('entries').splice(S.get('entries').indexOf(tmpE), 1);
  t(!FMARAP.customers().some(function (p) { return p.id === 'C999'; }), '临时分录移除后自动档案消失');
})();

var cb1 = FMARAP.customerBalance('C001', LP);
tEq(cb1.opening, 82000000, 'C001 期初应收 820,000.00');
tEq(cb1.debit, 135600000, 'C001 本期已过账应收发生 1,356,000.00');
tEq(cb1.credit, 0, 'C001 本期无收款');
tEq(cb1.closing, 217600000, 'C001 应收余额 2,176,000.00');
tEq(FMARAP.customerBalance('C002', LP).closing, 50000000, 'C002 应收余额 500,000.00（期初 1,150,000 − 收款 650,000）');
tEq(FMARAP.customerBalance('C003', LP).closing, 36840000, 'C003 应收余额 368,400.00');

var sb1 = FMARAP.supplierBalance('S001', LP);
tEq(sb1.opening, 96000000, 'S001 期初应付 960,000.00');
tEq(sb1.credit, 90400000, 'S001 本期已过账采购发生 904,000.00');
tEq(sb1.closing, 186400000, 'S001 应付余额 1,864,000.00');
tEq(FMARAP.supplierBalance('S002', LP).closing, 60560000, 'S002 应付余额 605,600.00（1,085,600 − 付款 480,000）');

(function () {
  var sumC = FMARAP.customers().reduce(function (s, p) { return s + FMARAP.customerBalance(p.id, LP).closing; }, 0);
  tEq(sumC, A.balance('1122', LP), '客户应收余额合计 = 1122 科目余额（' + S.fmt(A.balance('1122', LP)) + '）');
  var sumS = FMARAP.suppliers().reduce(function (s, p) { return s + FMARAP.supplierBalance(p.id, LP).closing; }, 0);
  tEq(sumS, A.balance('2202', LP), '供应商应付余额合计 = 2202 科目余额（' + S.fmt(A.balance('2202', LP)) + '）');
})();

/* 账龄（新鲜种子：全部挂账都从期初建账日算，均为 0–30 天） */
var ag = FMARAP.aging('receivable', LP);
tEq(ag.buckets.length, 4, '账龄分四档');
tEq(ag.total, A.balance('1122', LP), '账龄挂账总额 = 应收科目余额');
tEq(ag.buckets[0].amount, ag.total, '新鲜种子全部挂账在 0–30 天档');
tEq(ag.buckets[1].amount + ag.buckets[2].amount + ag.buckets[3].amount, 0, '其余三档为 0');
tEq(Math.round(ag.buckets.reduce(function (s, b) { return s + b.pct; }, 0)), 100, '账龄占比合计 100%');

/* 临时塞一笔 2026-06 的已过账老应收（2026-11 不受影响，仅验账龄分档），验完移除 */
(function () {
  var tv = { id: '记-2026-06-9901', date: '2026-06-15', period: '2026-06', summary: '临时老应收（测试）', status: '已过账', maker: '', auditor: '', attachCount: 0 };
  var te = { id: tv.id + '-1', voucherId: tv.id, line: 1, accountCode: '1122', summary: '老应收', debit: 50000000, credit: 0, aux: { customer: 'C003' } };
  S.get('vouchers').push(tv);
  S.get('entries').push(te);
  var ag2 = FMARAP.aging('receivable', LP);
  tEq(ag2.total, 447440000, '老应收后挂账总额 4,474,400.00');
  tEq(ag2.buckets[0].amount, 397440000, '0–30 天档 3,974,400.00');
  tEq(ag2.buckets[3].amount, 50000000, '90 天以上档 500,000.00（2026-06-15 起 168 天）');
  tEq(FMARAP.customerBalance('C003', LP).closing, 86840000, 'C003 含老应收余额 868,400.00');
  S.get('vouchers').splice(S.get('vouchers').indexOf(tv), 1);
  S.get('entries').splice(S.get('entries').indexOf(te), 1);
  tEq(FMARAP.customerBalance('C003', LP).closing, 36840000, '临时凭证移除后 C003 余额复原');
  tEq(FMARAP.aging('receivable', LP).total, 397440000, '账龄总额复原');
})();

var lp = FMARAP.listPayables(LP);
tEq(lp.rows.length, 6, '应付明细 6 行（4 期初 + 2 发生）');
tEq(lp.rows.every(function (r) { return typeof r.ageDays === 'number' && r.ageDays >= 0; }), true, '应付明细每行带账龄天数');
tEq(lp.rows.filter(function (r) { return r.code === 'S001'; }).map(function (r) { return r.balance; }).join(','), '96000000,186400000', 'S001 余额逐行滚动');
tEq(lp.rows.filter(function (r) { return r.code === 'S002'; }).map(function (r) { return r.balance; }).join(','), '108560000,60560000', 'S002 余额逐行滚动');
tEq(lp.rows.every(function (r) { return !r.voucherId || (S.get('vouchers').filter(function (v) { return v.id === r.voucherId; })[0] || { status: '' }).status === '已过账'; }), true, '应付明细只含已过账凭证');

var lr = FMARAP.listReceivables(LP);
tEq(lr.rows.length, 7, '应收明细 7 行（5 期初 + 2 发生）');
tEq(lr.rows[0].summary, '期初余额', '明细首行为期初余额行');
tEq(lr.rows.filter(function (r) { return r.code === 'C001'; }).map(function (r) { return r.balance; }).join(','), '82000000,217600000', 'C001 余额逐行滚动');
tEq(lr.rows.filter(function (r) { return r.code === 'C002'; }).map(function (r) { return r.balance; }).join(','), '115000000,50000000', 'C002 余额逐行滚动');
tEq(lr.rows[lr.rows.length - 1].ageDays, 25, '最后一行（11-05 收款）账龄 25 天');
(function () {
  var dates = lr.rows.map(function (r) { return r.date; });
  t(dates.every(function (d, i) { return i === 0 || dates[i - 1] <= d; }), '应收明细按日期排序');
})();
tEq(FMARAP.partyLedger('customer', 'C002', LP).closing, 50000000, 'partyLedger 期末与 customerBalance 一致');

/* ---------- 17. chunk 3：出纳 / 银行 ---------- */
section('chunk 3 · 出纳 / 银行');
var accs = FMCashier.accounts();
tEq(accs.length, 3, '账户档案 3 个（现金 + 两个银行户）');
tEq(accs.map(function (a) { return a.code; }).join(','), '1001,100201,100202', '账户编码正确');
var acc201 = accs.filter(function (a) { return a.code === '100201'; })[0];
tEq(acc201.bank, '工商银行', '账户银行字段');
tEq(acc201.masked, '**** **** 6781', '账号脱敏只显后 4 位');

tEq(FMCashier.balance('100201', LP), 394737050, '工行户余额 3,947,370.50（期初 4,862,300.50 − 净付 914,930.00）');
tEq(FMCashier.balance('100202', LP), 125000000, '建行户余额 1,250,000.00');
tEq(FMCashier.balance('1001', LP), 3865000, '库存现金余额 38,650.00');
tEq(FMCashier.balance('100201', LP), FMLedger.accountBalance('100201', LP).closing, '出纳余额与总账 accountBalance 一致');

var j201 = FMCashier.journal('100201', LP);
tEq(j201.rows.length, 4, '工行日记账 4 行（只含已过账）');
tEq(j201.opening, 486230050, '日记账期初 4,862,300.50');
tEq(j201.rows[j201.rows.length - 1].balance, FMCashier.balance('100201', LP), '日记账期末 = 账户余额');
(function () {
  var manual = [];
  S.get('entries').forEach(function (e) {
    if (String(e.accountCode).indexOf('100201') !== 0) return;
    var v = S.get('vouchers').filter(function (x) { return x.id === e.voucherId; })[0];
    if (!v || v.period !== LP || v.status !== '已过账') return;
    manual.push({ date: v.date, line: e.line || 0, d: e.debit || 0, c: e.credit || 0 });
  });
  manual.sort(function (x, y) { if (x.date !== y.date) return x.date < y.date ? -1 : 1; return x.line - y.line; });
  var raw = 486230050, expected = [];
  manual.forEach(function (m) { raw += m.d - m.c; expected.push(raw); });
  tEq(j201.rows.map(function (r) { return r.balance; }).join(','), expected.join(','), '日记账余额逐行滚动与独立复算一致');
})();
t(j201.rows.every(function (r) { return r.counter && r.counter.length > 0; }), '日记账每行带对方科目');
t(j201.rows[0].counter.indexOf('1122') >= 0, '收款行对方科目含 1122');
var j202 = FMCashier.journal('100202', LP);
tEq(j202.rows.length, 0, '建行户本期无已过账发生');
tEq(j202.opening, 125000000, '建行户期初');

/* 银行对账：种子流水 */
var stmt = (S.get('bankStatements') || {})['100201'] || [];
t(stmt.length >= 8, '种子银行流水 ≥ 8 行（实际 ' + stmt.length + '）');
var rec = FMCashier.reconcile('100201', LP, stmt);
tEq(rec.matched.length, 4, '种子流水勾对 4 笔（11 月已过账日记账全部勾上）');
tEq(rec.unmatchedJournal.length, 0, '企业已记银行未记 0 笔');
tEq(rec.unmatchedStatement.length, 8, '未达账项 8 笔（含未过账凭证对应的流水）');
tEq(rec.balance, FMCashier.balance('100201', LP), '对账结果带账面余额');
t(rec.unmatchedStatement.some(function (s) { return s.summary === '银行手续费'; }), '未达账项单独列出（银行手续费）');
t(rec.matched.every(function (m) { return m.journal.amount === m.statement.amount; }), '勾对双方金额相等');
t(rec.matched.every(function (m) { return Math.abs(m.statement.amount) > 0; }), '勾对不含零金额行');

/* 勾对边界（日记账收款行日期 11-05，金额 650,000）：金额差 1 分不勾、日期差 4 天不勾、±3 天内勾 */
tEq(FMCashier.reconcile('100201', LP, [{ date: '2026-11-05', amount: 65000000, summary: 'a' }]).matched.length, 1, '同日同额勾对');
tEq(FMCashier.reconcile('100201', LP, [{ date: '2026-11-07', amount: 65000000, summary: 'a' }]).matched.length, 1, '日期差 2 天勾对');
tEq(FMCashier.reconcile('100201', LP, [{ date: '2026-11-08', amount: 65000000, summary: 'a' }]).matched.length, 1, '日期差 3 天（边界）勾对');
tEq(FMCashier.reconcile('100201', LP, [{ date: '2026-11-09', amount: 65000000, summary: 'a' }]).matched.length, 0, '日期差 4 天不勾对');
tEq(FMCashier.reconcile('100201', LP, [{ date: '2026-11-05', amount: 64999999, summary: 'a' }]).matched.length, 0, '金额差 1 分不勾对');
tEq(FMCashier.reconcile('100201', LP, [{ date: '2026-11-09', amount: 64999999, summary: 'a' }]).unmatchedStatement.length, 1, '不勾对的流水进未达账项');

/* CSV 导入 */
var imp = FMCashier.importBank('日期,摘要,金额\n2026-11-03,收到货款,"1,234.56"\n2026-11-04,支付货款,-500.50\n2026-11-05,存现,+2000.00\n坏行\n2026-13-01,坏日期,100.00\n2026-11-05,坏金额,abc\n');
tEq(imp.rows.length, 3, 'CSV 有效行 3 行');
tEq(imp.rows[0].amount, 123456, 'CSV 千分位金额解析');
tEq(imp.rows[1].amount, -50050, 'CSV 负金额解析');
tEq(imp.rows[2].amount, 200000, 'CSV 正号金额解析');
tEq(imp.rows[0].date, '2026-11-03', 'CSV 日期列');
tEq(imp.skipped, 3, 'CSV 坏行跳过 3 行');
tEq(imp.skipReasons.length, 3, '每个坏行有原因');
t(imp.skipReasons.every(function (r) { return /[\u4e00-\u9fa5]/.test(r); }), '坏行原因为中文');
tEq(imp.skipReasons[0].indexOf('列数不足') >= 0, true, '列数不足原因');
tEq(imp.skipReasons[1].indexOf('日期') >= 0, true, '坏日期原因');
tEq(imp.skipReasons[2].indexOf('金额') >= 0, true, '坏金额原因');
var imp2 = FMCashier.importBank('');
tEq(imp2.rows.length + imp2.skipped, 0, '空 CSV 无行');

/* 导入流水 → 勾对（导入金额与日记账均不相等，全部进未达账项） */
var recImp = FMCashier.reconcile('100201', LP, imp.rows);
tEq(recImp.matched.length, 0, '导入流水与日记账金额均不等，勾对 0 笔');
tEq(recImp.unmatchedStatement.length, 3, '导入流水 3 行全部进未达账项');

/* chunk 3 渲染冒烟 */
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMARAP.renderARAP(el);
  if (el.innerHTML.indexOf('应收应付') < 0 || el.innerHTML.indexOf('账龄分析') < 0) throw new Error('往来页内容缺失');
  /* 切到供应商视图再渲染一次 */
  var el2 = { innerHTML: '', onclick: null };
  FMARAP.supplierBalance('S001', LP);
  FMARAP.renderARAP(el2);
  if (el2.innerHTML.indexOf('华东电子') < 0) throw new Error('供应商视图缺失');
}, 'renderARAP');
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMCashier.renderCashier(el);
  if (el.innerHTML.indexOf('出纳 / 银行') < 0 || el.innerHTML.indexOf('银行对账') < 0 || el.innerHTML.indexOf('未达账项') < 0) throw new Error('出纳页内容缺失');
  /* 切到建行户视角再渲染 */
  var el2 = { innerHTML: '', onclick: null };
  FMCashier.balance('100202', LP);
  FMCashier.renderCashier(el2);
  if (el2.innerHTML.indexOf('建设银行') < 0) throw new Error('建行户视图缺失');
}, 'renderCashier');

/* ---------- 18. chunk 3 修复：旧 state 迁移（缺键补种子默认值） ---------- */
section('chunk 3 修复 · 旧 state 迁移');
S.seed();
var seedStmtsJson = JSON.stringify(S.get('bankStatements'));
var seedCustCount = S.get('customers').length, seedSupCount = S.get('suppliers').length;
var seedVCount = S.get('vouchers').length, seedECount = S.get('entries').length;

/* 模拟 chunk 2 时期旧数据：删掉 bankStatements 后 load() 应补回种子流水 */
(function () {
  var st = S.get();
  delete st.bankStatements;
  S.save();
  var loaded = S.load();
  var bs = loaded.bankStatements;
  t(bs && !Array.isArray(bs) && bs['100201'], 'load() 后 bankStatements 是对象且含 100201（不再被误填空数组）');
  tEq(bs['100201'].length, 12, '补回种子流水 12 行');
  tEq(JSON.stringify(bs), seedStmtsJson, '补回内容与种子完全一致（深拷贝，非引用）');
  var rec = FMCashier.reconcile('100201', LP, bs['100201']);
  tEq(rec.matched.length, 4, '旧数据修复后种子对账勾对 4 笔');
  smoke(function () {
    var el = { innerHTML: '', onclick: null };
    FMCashier.renderCashier(el);
    if (el.innerHTML.indexOf('种子流水 12 行') < 0) throw new Error('页面未显示“种子流水 12 行”');
  }, '旧数据修复后 renderCashier 显示种子流水 12 行');
})();

/* 再模拟更旧的数据：customers / suppliers 也缺失，凭证分录一条不少 */
(function () {
  var st = S.get();
  delete st.customers;
  delete st.suppliers;
  S.save();
  var loaded = S.load();
  tEq(loaded.customers.length, seedCustCount, 'load() 补回客户档案（' + seedCustCount + ' 家）');
  tEq(loaded.suppliers.length, seedSupCount, 'load() 补回供应商档案（' + seedSupCount + ' 家）');
  tEq(loaded.vouchers.length, seedVCount, '已有凭证一条不少');
  tEq(loaded.entries.length, seedECount, '已有分录一行不少');
})();

/* 已有键一字不动：改过凭证状态与流水摘要后 load() 不重置用户数据 */
(function () {
  var st = S.get();
  st.vouchers[0].status = '已过账'; /* 保持，验证不改写 */
  st.vouchers.push({ id: '记-2026-11-9901', date: '2026-11-20', period: '2026-11', summary: '用户凭证', status: '已过账', maker: '王丽', auditor: '李强', attachCount: 1 });
  st.bankStatements['100201'][0].summary = '用户改过的摘要';
  S.save();
  var loaded = S.load();
  t(loaded.vouchers.some(function (v) { return v.id === '记-2026-11-9901' && v.status === '已过账'; }),
    'load() 不动已有数据：用户已过账凭证原样保留');
  tEq(loaded.bankStatements['100201'][0].summary, '用户改过的摘要', 'load() 不重置已存在的 bankStatements（用户改不被覆盖）');
  S.seed(); /* 恢复干净种子，供后续/终态使用 */
})();

/* ---------- 汇总 ---------- */
console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项（共 ' + (passed + failed) + ' 项断言）');
if (failed) {
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
} else {
  console.log('全部通过 ✓');
}
