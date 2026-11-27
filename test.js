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
 'js/ledger.js', 'js/closing.js', 'js/opening.js', 'js/arap.js', 'js/cashier.js', 'js/assets.js', 'js/payroll.js', 'js/tax.js',
 'js/reports.js'].forEach(function (f) {
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
tEq(ot.debit, 2675735050, '期初借方合计 = 26,757,350.50（2675735050 分，含固定资产卡片期初）');
tEq(ot.credit, 2675735050, '期初贷方合计 = 26,757,350.50（2675735050 分）');
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
tEq(bs.opening.debit, 2675735050, '余额表期初借方合计 26,757,350.50（含固定资产）');
tEq(bs.opening.credit, 2675735050, '余额表期初贷方合计 26,757,350.50（含固定资产）');

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

/* 场景 (b)：旧版迁移把缺键写成了空数组/空对象并已存盘，load() 同样要恢复 */
(function () {
  var st = S.get();
  st.bankStatements = [];
  st.customers = [];
  st.suppliers = [];
  S.save();
  var loaded = S.load();
  t(loaded.bankStatements && !Array.isArray(loaded.bankStatements) && loaded.bankStatements['100201'],
    '(b) 空数组 bankStatements 恢复为种子对象');
  tEq(loaded.bankStatements['100201'].length, 12, '(b) 补回种子流水 12 行');
  tEq(JSON.stringify(loaded.bankStatements), seedStmtsJson, '(b) 补回内容与种子完全一致（深拷贝）');
  tEq(loaded.customers.length, seedCustCount, '(b) 补回客户档案（' + seedCustCount + ' 家）');
  tEq(loaded.suppliers.length, seedSupCount, '(b) 补回供应商档案（' + seedSupCount + ' 家）');
  tEq(loaded.vouchers.length, seedVCount, '(b) 凭证一条不少');
  tEq(loaded.entries.length, seedECount, '(b) 分录一行不少');
  t(loaded.vouchers.filter(function (v) { return v.status === '已过账'; }).length === 6,
    '(b) 已过账状态原样保留');
  var recB = FMCashier.reconcile('100201', LP, loaded.bankStatements['100201']);
  tEq(recB.matched.length, 4, '(b) 修复后种子对账勾对 4 笔');
  smoke(function () {
    var el = { innerHTML: '', onclick: null };
    FMCashier.renderCashier(el);
    if (el.innerHTML.indexOf('种子流水 12 行') < 0) throw new Error('(b) 页面未显示“种子流水 12 行”');
  }, '(b) renderCashier 显示种子流水 12 行');
  /* 空数组但不能误伤真正空种子的键：taxRecords 种子默认就是 []，存 [] 后不应被填入奇怪内容 */
  st.taxRecords = [];
  S.save();
  tEq(S.load().taxRecords.length, 0, '种子默认为空的键存 [] 后保持 []（不误判）');
  S.seed(); /* 恢复干净种子 */
})();

/* ---------- 19. chunk 4：固定资产 ---------- */
S.seed();
section('chunk 4 · 固定资产');
var cards = FMAssets.list();
tEq(cards.length, 6, '种子资产卡片 6 张');
t(cards.every(function (c) {
  return c.code && c.name && c.category && c.purchaseDate && typeof c.cost === 'number' &&
    typeof c.months === 'number' && typeof c.residualRate === 'number' && c.method &&
    c.dept && typeof c.accumulated === 'number' && typeof c.monthsElapsed === 'number' && c.status === '在用';
}), '卡片字段齐全且状态在用');
var sumCost = cards.reduce(function (s, c) { return s + c.cost; }, 0);
var sumAcc = cards.reduce(function (s, c) { return s + c.accumulated; }, 0);
tEq(sumCost, 1028000000, '卡片原值合计 10,280,000.00');
tEq(A.balance('1601', LP), sumCost, '卡片原值合计 = 1601 科目余额');
tEq(sumAcc, 275325000, '卡片累计折旧合计 2,753,250.00');
tEq(A.balance('1602', LP), sumAcc, '卡片累计折旧合计 = 1602 科目余额');
(function () {
  var ok = cards.every(function (c) {
    var residual = Math.round(c.cost * c.residualRate);
    var monthly = Math.floor((c.cost - residual) / c.months);
    var me = (Number('2026') - Number(c.purchaseDate.slice(0, 4))) * 12 +
      (Number('10') - Number(c.purchaseDate.slice(5, 7))) + 1; /* 期初 2026-10 前已提月份 */
    me = Math.min(c.months, me);
    return c.monthsElapsed === me && c.accumulated === me * monthly;
  });
  t(ok, '已提月份与购入日期一致且累计折旧 = 月数 × 月折旧（直线法）');
})();
tEq(A.openingTrial().balanced, true, '新期初试算仍平衡');
tEq(A.openingTrial().debit, 2675735050, '新期初借方合计 26,757,350.50');
tEq(FMAssets.netBookValue('ZC001'), 611200000, 'ZC001 净值 = 8,000,000 − 1,888,000 = 6,112,000.00');
tEq(FMAssets.netBookValue('ZC999'), null, '不存在资产净值返回 null');

/* 折旧理论：直线法 */
tEq(FMAssets.depreciation('ZC002', LP), 950000, '直线法月折旧 = (1,200,000 − 60,000) / 120 = 9,500.00');
tEq(FMAssets.depreciation('ZC001', LP), 3200000, 'ZC001 月折旧 32,000.00');
tEq(FMAssets.depreciation('ZC005', '2026-10'), 200000, '历史期间也能算折旧');
tEq(FMAssets.depreciation('ZC001', '2020-01'), 0, '购入前期间应提 0');
tEq(FMAssets.depreciation('ZC999', LP), 0, '不存在资产应提 0');

/* 临时卡片：提满 / 双倍余额递减 / 年数总和（验完移除，不进汇总） */
function ymList(from, n) {
  var out = [], y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  for (var i = 0; i < n; i++) {
    out.push(y + '-' + ('0' + m).slice(-2));
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
(function () {
  var tmp = [
    { code: 'ZCT1', name: '提满测试', category: '电子设备', purchaseDate: '2023-01-01', cost: 3600000, months: 36, residualRate: 0.05, method: '直线法', dept: 'D02', location: '', status: '在用', accumulated: 0, monthsElapsed: 0 },
    { code: 'ZCT2', name: '双倍测试', category: '电子设备', purchaseDate: '2026-01-01', cost: 3600000, months: 48, residualRate: 0.05, method: '双倍余额递减法', dept: 'D02', location: '', status: '在用', accumulated: 0, monthsElapsed: 0 },
    { code: 'ZCT3', name: '年数总和测试', category: '电子设备', purchaseDate: '2026-01-01', cost: 3600000, months: 36, residualRate: 0.05, method: '年数总和法', dept: 'D02', location: '', status: '在用', accumulated: 0, monthsElapsed: 0 }
  ];
  tmp.forEach(function (c) { S.get('assets').push(c); });
  tEq(FMAssets.depreciation('ZCT1', LP), 0, '超过使用年限（第 47 月 > 36 月）应提 0（提满）');
  /* 双倍余额递减（4 年）：首年 = 原值 × 2/4 / 12 = 150,000；第 2 年按年初净值递减；最后 2 年直线 */
  tEq(FMAssets.depreciation('ZCT2', '2026-01'), 150000, '双倍余额递减首月 = 原值×2/年数/12');
  tEq(FMAssets.depreciation('ZCT2', '2026-06'), 150000, '双倍余额递减首年内各月相同');
  tEq(FMAssets.depreciation('ZCT2', '2027-01'), 75000, '双倍余额递减第 2 年按年初净值递减');
  tEq(FMAssets.depreciation('ZCT2', '2029-01'), 30000, '最后 2 年改直线法提完');
  var sum2 = ymList('2026-01', 48).reduce(function (s, p) { return s + FMAssets.depreciation('ZCT2', p); }, 0);
  tEq(sum2, 3420000, '双倍余额递减全程提满 = 原值 − 残值（不留尾差）');
  /* 年数总和：首年 = 基数 × 3/6 / 12 = 142,500，逐年递减 */
  tEq(FMAssets.depreciation('ZCT3', '2026-01'), 142500, '年数总和首年月折旧 = (原值−残值)×3/6/12');
  tEq(FMAssets.depreciation('ZCT3', '2027-01'), 95000, '年数总和第 2 年 = 基数×2/6/12');
  tEq(FMAssets.depreciation('ZCT3', '2028-01'), 47500, '年数总和第 3 年 = 基数×1/6/12');
  t(FMAssets.depreciation('ZCT3', '2026-01') > FMAssets.depreciation('ZCT3', '2027-01') &&
    FMAssets.depreciation('ZCT3', '2027-01') > FMAssets.depreciation('ZCT3', '2028-01'), '年数总和首年最大、逐年递减');
  var sum3 = ymList('2026-01', 36).reduce(function (s, p) { return s + FMAssets.depreciation('ZCT3', p); }, 0);
  tEq(sum3, 3420000, '年数总和全程提满（不留尾差）');
  tmp.forEach(function (c) {
    var i = S.get('assets').indexOf(S.get('assets').filter(function (x) { return x.code === c.code; })[0]);
    S.get('assets').splice(i, 1);
  });
  tEq(FMAssets.list().length, 6, '临时卡片已移除');
})();

/* 当月折旧汇总（种子 6 张） */
var md = FMAssets.monthlyDepreciation(LP);
tEq(md.total, 5650000, '2026-11 应提合计 56,500.00');
(function () {
  function dept(name) { var d = md.byDept.filter(function (x) { return x.dept === name; })[0]; return d ? d.amount : 0; }
  tEq(dept('D06'), 1425000, 'D06（制造）1,425,000（两条生产线）');
  tEq(dept('D08'), 700000, 'D08（销售）700,000（货车）');
  tEq(dept('D01') + dept('D07') + dept('D02'), 3525000, '管理部门合计 3,525,000');
  var e4101 = md.entries.filter(function (e) { return e.accountCode === '4101'; });
  tEq(e4101.length, 2, '制造费用 4101 两行（两条生产线，摘要带资产编码）');
  tEq(e4101.reduce(function (s, e) { return s + e.debit; }, 0), 1425000, '4101 借方合计');
  t(md.entries.some(function (e) { return e.accountCode === '520106'; }), '销售部门折旧进 520106');
  t(md.entries.every(function (e) { return /ZC\d+/.test(e.summary); }), '折旧行摘要注明资产编码');
  tEq(md.entries.reduce(function (s, e) { return s + e.debit; }, 0), md.total, '折旧行借方合计 = 汇总');
})();

/* 新增：校验拒绝路径 */
r = FMAssets.add({ cost: 0, months: 36, category: '电子设备' });
t(!r.ok && /原值/.test(r.reason), '原值 ≤0 拒绝');
r = FMAssets.add({ cost: 100000, months: 601, category: '电子设备' });
t(!r.ok && /1–600/.test(r.reason), '年限 >600 月拒绝');
r = FMAssets.add({ cost: 100000, months: 36, residualRate: 0.51, category: '电子设备' });
t(!r.ok && /0–50%/.test(r.reason), '残值率 >50% 拒绝');
r = FMAssets.add({ cost: 100000, months: 36, category: '无形资产' });
t(!r.ok && /类别/.test(r.reason), '非法类别拒绝');
r = FMAssets.add({ cost: 12000000, months: 24, category: '机器设备', purchaseDate: '2026-11-05' });
t(!r.ok && /最低折旧年限/.test(r.reason) && /10 年/.test(r.reason), '机器 24 月低于最低 10 年拒绝');
r = FMAssets.add({ cost: 100000, months: 36, category: '电子设备', purchaseDate: '2026-12-01' });
t(!r.ok && /晚于当前期间末/.test(r.reason), '购入日期晚于期间末拒绝');
r = FMAssets.add({ cost: 100000, months: 36, category: '电子设备', purchaseDate: '2026-10-20' });
t(!r.ok && /不在当前会计期间/.test(r.reason), '购入日期在期间之前（无法生成凭证）拒绝');
r = FMAssets.add({ cost: 100000, months: 36, category: '电子设备', purchaseDate: '2026-11-05', payMethod: 'credit' });
t(!r.ok && /供应商/.test(r.reason), '赊购未指定供应商拒绝');
r = FMAssets.add({ cost: 100000, months: 36, category: '电子设备', purchaseDate: '2026-11-05', payMethod: 'cash', name: '现金购置' });
tEq(r.ok, true, '现金购置成功（贷 1001）');
(function () {
  var v = S.get('vouchers').filter(function (x) { return x.id === r.voucherId; })[0];
  tEq(v.status, '已过账', '购入凭证已审核并过账');
  var es = V.entriesOf(r.voucherId);
  t(es.some(function (e) { return e.accountCode === '1601' && e.debit === 100000; }), '购入凭证借 1601');
  t(es.some(function (e) { return e.accountCode === '1001' && e.credit === 100000; }), '现金购置贷 1001');
  tEq(v.maker, '系统购置', '购入凭证制单人为系统购置');
})();

/* 银行购置 + 赊购 */
r = FMAssets.add({ name: '测试服务器', category: '电子设备', cost: 1200000, months: 36, residualRate: 0.05,
  purchaseDate: '2026-11-05', dept: 'D02', location: '机房', payMethod: 'bank' });
tEq(r.ok, true, '银行购置 ZC007 成功');
tEq(r.card.code, 'ZC008', '自动编号接续（银行购置为第 2 张新增卡）');
(function () {
  var es = V.entriesOf(r.voucherId);
  t(es.some(function (e) { return e.accountCode === '1601' && e.debit === 1200000; }), '购置凭证借 1601 原值');
  t(es.some(function (e) { return e.accountCode === '100201' && e.credit === 1200000; }), '银行购置贷 100201');
})();
tEq(A.balance('1601', LP), 1028000000 + 1200000 + 100000, '购入后 1601 余额同步增加');
r = FMAssets.add({ name: '测试加工机', category: '机器设备', cost: 2000000, months: 120, residualRate: 0.05,
  purchaseDate: '2026-11-06', dept: 'D06', payMethod: 'credit', supplier: 'S003' });
tEq(r.ok, true, '赊购 ZC008 成功');
(function () {
  var es = V.entriesOf(r.voucherId);
  var row = es.filter(function (e) { return e.accountCode === '2202'; })[0];
  t(!!row && row.credit === 2000000 && row.aux.supplier === 'S003', '赊购贷 2202 且带供应商辅助核算');
})();

/* 计提本月折旧 */
tEq(FMAssets.runDepreciation('2026-12').ok, false, '非当前期间不能计提');
var rd = FMAssets.runDepreciation(LP);
tEq(rd.ok, true, '计提 2026-11 折旧成功');
tEq(rd.total, 5650000 + 2638 + 31666 + 15833, '计提合计 = 种子 56,500.00 + 新增三卡（2,638 + 31,666 + 15,833）= 57,001.37');
(function () {
  var v = S.get('vouchers').filter(function (x) { return x.id === rd.id; })[0];
  tEq(v.status, '已过账', '折旧凭证已过账');
  tEq(v.maker, '系统折旧', '折旧凭证制单人为系统折旧');
  t(v.summary.indexOf('2026-11') >= 0, '折旧凭证摘要注明期间');
  var es = V.entriesOf(rd.id);
  var dt = es.reduce(function (s, e) { return s + e.debit; }, 0);
  var ct = es.reduce(function (s, e) { return s + e.credit; }, 0);
  tEq(dt, ct, '折旧凭证借贷平衡');
  tEq(dt, rd.total, '折旧凭证借方合计 = 计提合计');
  t(es.some(function (e) { return e.accountCode === '1602' && e.credit === rd.total; }), '贷 1602 累计折旧');
  t(es.some(function (e) { return e.accountCode === '4101'; }), '生产部门折旧借 4101 制造费用');
})();
var zc1 = FMAssets.list().filter(function (c) { return c.code === 'ZC001'; })[0];
tEq(zc1.accumulated, 188800000 + 3200000, 'ZC001 累计折旧已更新（1,920,000.00）');
tEq(zc1.monthsElapsed, 60, 'ZC001 已提月份 60');
var zc7 = FMAssets.list().filter(function (c) { return c.code === 'ZC007'; })[0];
tEq(zc7.accumulated, 2638, '现金购置卡首月折旧已入累计（95,000/36 取整 26.38）');
tEq(zc7.monthsElapsed, 1, '新卡已提月份 1');
tEq(FMAssets.list().filter(function (c) { return c.code === 'ZC008'; })[0].accumulated, 31666, 'ZC008 首月折旧 316.66');
tEq(FMAssets.list().filter(function (c) { return c.code === 'ZC009'; })[0].accumulated, 15833, 'ZC009 首月折旧 158.33');
r = FMAssets.runDepreciation(LP);
t(!r.ok && r.reason === '本期折旧已计提', '重复计提返回本期折旧已计提');
(function () {
  var sumA = FMAssets.list().reduce(function (s, c) { return s + c.accumulated; }, 0);
  tEq(sumA, A.balance('1602', LP), '卡片累计折旧合计 = 1602 余额（计提后）');
  var sumC = FMAssets.list().reduce(function (s, c) { return s + c.cost; }, 0);
  tEq(sumC, A.balance('1601', LP), '卡片原值合计 = 1601 余额（计提后）');
})();

/* 已结账期间不能计提 */
(function () {
  var cp = S.get('closedPeriods') || [];
  cp.push(LP);
  S.set('closedPeriods', cp);
  var rr = FMAssets.runDepreciation(LP);
  t(!rr.ok && /已结账/.test(rr.reason), '已结账期间不能计提折旧');
  S.set('closedPeriods', (S.get('closedPeriods') || []).filter(function (p) { return p !== LP; }));
})();

/* 处置：亏损（货车） */
tEq(FMAssets.netBookValue('ZC004'), 35000000 - 23100000, 'ZC004 处置前净值 119,000.00');
r = FMAssets.dispose('ZC999', LP, 1000000);
t(!r.ok && /不存在/.test(r.reason), '处置不存在资产拒绝');
r = FMAssets.dispose('ZC004', LP, -1);
t(!r.ok && /处置价/.test(r.reason), '处置价非法拒绝');
var d1 = FMAssets.dispose('ZC004', LP, 10000000);
tEq(d1.ok, true, '处置 ZC004 成功（处置价 100,000 < 净值 119,000）');
tEq(d1.loss, 1900000, '处置损失 = 净值 − 处置价 = 19,000.00');
tEq(d1.gain, 0, '无处置利得');
(function () {
  var v = S.get('vouchers').filter(function (x) { return x.id === d1.id; })[0];
  tEq(v.status, '已过账', '处置凭证已过账');
  var es = V.entriesOf(d1.id);
  tEq(es.reduce(function (s, e) { return s + e.debit; }, 0), es.reduce(function (s, e) { return s + e.credit; }, 0), '处置凭证借贷平衡');
  t(es.some(function (e) { return e.accountCode === '1602' && e.debit === 23100000; }), '借 1602 转销累计折旧');
  t(es.some(function (e) { return e.accountCode === '100201' && e.debit === 10000000; }), '借 100201 处置收款');
  t(es.some(function (e) { return e.accountCode === '6301' && e.debit === 1900000; }), '借 6301 处置损失');
  t(es.some(function (e) { return e.accountCode === '1601' && e.credit === 35000000; }), '贷 1601 转销原值');
})();
var zc4 = FMAssets.list().filter(function (c) { return c.code === 'ZC004'; })[0];
tEq(zc4.status, '已处置', '处置后卡片状态已处置');
tEq(zc4.disposeDate, '2026-11-30', '处置日期已记录');
tEq(zc4.disposePrice, 10000000, '处置价已记录');
tEq(FMAssets.depreciation('ZC004', '2026-11'), 0, '已处置资产不再折旧');
tEq(A.balance('1601', LP), 1031300000 - 35000000, '处置后 1601 余额减少原值（1,031.3 万 − 35 万）');

/* 处置：盈利（办公电脑） */
tEq(FMAssets.netBookValue('ZC006'), 5000000 - 2375000, 'ZC006 处置前净值 26,250.00');
var d2 = FMAssets.dispose('ZC006', LP, 3000000);
tEq(d2.ok, true, '处置 ZC006 成功（处置价 30,000 > 净值 26,250）');
tEq(d2.gain, 375000, '处置利得 = 处置价 − 净值 = 3,750.00');
(function () {
  var es = V.entriesOf(d2.id);
  t(es.some(function (e) { return e.accountCode === '6301' && e.credit === 375000; }), '贷 6301 处置利得');
  tEq(es.reduce(function (s, e) { return s + e.debit; }, 0), es.reduce(function (s, e) { return s + e.credit; }, 0), '处置凭证借贷平衡');
})();
tEq(FMAssets.list().filter(function (c) { return c.code === 'ZC006'; })[0].status, '已处置', 'ZC006 状态已处置');
tEq(FMAssets.depreciation('ZC006', '2026-12'), 0, '已处置资产后续期间折旧为 0');

/* 处置：未提满当月折旧自动补提（run 之后再新增的卡，本期还没计提过） */
r = FMAssets.add({ name: '补提测试机', category: '电子设备', cost: 500000, months: 36, residualRate: 0.05,
  purchaseDate: '2026-11-08', dept: 'D02', payMethod: 'bank' });
tEq(r.ok && r.card.code, 'ZC010', '计提后新增 ZC010（本期尚未计提）');
var d3 = FMAssets.dispose('ZC010', LP, 400000);
tEq(d3.ok, true, '处置 ZC009 成功');
tEq(d3.catchup && d3.catchup.amount, 13194, '处置前自动补提当月折旧 131.94');
(function () {
  var cu = S.get('vouchers').filter(function (x) { return x.id === d3.catchup.id; })[0];
  tEq(cu.status, '已过账', '补提凭证已过账');
  t(/补提/.test(cu.summary) && cu.summary.indexOf('ZC010') >= 0, '补提凭证摘要注明期间与资产编码');
  var es = V.entriesOf(d3.id);
  tEq(d3.loss, 86806, '补提后净值 4,868.06，处置价 4,000 → 损失 868.06');
  tEq(es.reduce(function (s, e) { return s + e.debit; }, 0), es.reduce(function (s, e) { return s + e.credit; }, 0), '处置凭证借贷平衡');
})();
tEq(A.balance('1602', LP), 281025137 - 23100000 - 2375000,
  '处置转销累计折旧后 1602 余额 = 281,025.13 − 231,000 − 2,375（补提 +13,194 与转销相抵后不变）');

/* 已处置资产不进当月汇总 */
tEq(FMAssets.monthlyDepreciation(LP).total, 5700137 - 700000 - 125000, '已处置资产不进当月折旧汇总');

/* 渲染冒烟 */
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMAssets.renderAssets(el);
  if (el.innerHTML.indexOf('固定资产') < 0 || el.innerHTML.indexOf('折旧明细') < 0) throw new Error('资产页内容缺失');
}, 'renderAssets');
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMAssets.renderAssets(el);
  if (el.innerHTML.indexOf('已处置') < 0) throw new Error('处置状态未显示');
}, 'renderAssets（含已处置卡片）');

/* ---------- 20. chunk 5：薪酬工资 / 个税 ---------- */
S.seed();
section('chunk 5 · 薪酬工资 / 个税');
tEq(S.get('staff').length, 20, '员工档案 20 人');
var withDed = S.get('staff').filter(function (s) {
  var d = s.deductions || {};
  return d.children || d.infant || d.education || d.mortgage || d.rent || d.parents;
});
t(withDed.length >= 5, '带专项附加扣除的员工 ≥ 5 人（实际 ' + withDed.length + '）');
var e1 = S.get('staff').filter(function (s) { return s.id === 'E001'; })[0];
tEq(e1.salary, 3500000, '周建国月薪 35,000.00');
tEq(e1.deductions.children + '/' + e1.deductions.parents, '1/3000', '周建国扣除：子女教育 1 人 + 赡养老人 3000');
tEq(FMPayroll.getStaffPay('E001'), 3500000, 'getStaffPay 档案优先');
tEq(FMPayroll.getStaffPay('E004'), 800000, '王丽月薪 8,000.00');
tEq(FMPayroll.getStaffPay('E002'), 3500000, '吴敏按职务默认（总经理助理 → 总经理档）');
tEq(FMPayroll.getStaffPay('E009'), 600000, '钱芳销售代表默认 6,000.00');
tEq(FMPayroll.getStaffPay('E005'), 800000, '出纳按兜底 8,000.00');

/* 社保：个人 22.5%（8+2+0.5+12），单位 37.8% */
var soc8 = FMPayroll.calcSocial(800000);
tEq(soc8.personalTotal, 180000, '个人五险一金 = 应发×22.5%（8000 → 1,800.00）');
tEq(soc8.personal.pension, 64000, '个人养老 8%');
tEq(soc8.personal.fund, 96000, '个人公积金 12%');
tEq(soc8.companyTotal, 302400, '单位五险一金 = 应发×37.8%（8000 → 3,024.00）');
var soc18 = FMPayroll.calcSocial(1800000);
tEq(soc18.personalTotal, 405000, '18000 应发个人社保公积金 4,050.00');
tEq(soc18.company.pension, 288000, '单位养老 16% = 2,880.00');

/* 个税：8000 无专项附加（陈静 E005）：应纳税所得额 = 8000−5000−1800 = 1200 → 3% → 36.00 */
var t5 = FMPayroll.calcMonthlyTax('E005', LP);
tEq(t5.taxable, 120000, '8000 档应纳税所得额 = 8000−5000−1800 = 1,200.00');
tEq(t5.rate, 0.03, '落在 3% 档');
tEq(t5.taxPayable, 3600, '月税 36.00（按规格自给费率逐笔计算；规格示例“为 0”与其自给费率矛盾，以费率为准）');
/* 18000（郑浩 E010，无专项附加）：18000−5000−1890−2160 = 8950 → 3% → 268.50（与规格手工算一致） */
var t18 = FMPayroll.calcMonthlyTax('E010', LP);
tEq(t18.taxable, 895000, '18000 档应纳税所得额 8,950.00');
tEq(t18.taxPayable, 26850, '税额 8950×3% = 268.50（26850 分）');
/* 专项附加降低税额：李强 E003 租金 1500 */
var t3 = FMPayroll.calcMonthlyTax('E003', LP);
tEq(t3.taxable, 745000, 'E003 应纳税所得额 = 18000−5000−4050−1500 = 7,450.00');
tEq(t3.taxPayable, 22350, '税额 22,350 分（比无附加少 4,500 分）');
/* 应纳税所得额 ≤0 → 0（王丽 E004：8000−5000−1800−3000 <0） */
tEq(FMPayroll.calcMonthlyTax('E004', LP).taxPayable, 0, '应纳税所得额 ≤0 税额为 0，不出负数');
/* 高档：5 万累计 → 10% 档 − 速算 2520 */
var t10 = FMPayroll.calcTax({ cumIncome: 5000000, cumDeduction5000: 0, cumSocialPersonal: 0, cumExtraDeduction: 0, cumTaxPaid: 0 });
tEq(t10.rate + '/' + t10.quickDeduction, '0.1/252000', '落入 10% 档，速算扣除 2,520.00（来自 taxrules）');
tEq(t10.taxPayable, 248000, '50000×10% − 2520 = 2,480.00');
/* 累计已扣大于累计税额 → 不出负 */
tEq(FMPayroll.calcTax({ cumIncome: 100000, cumTaxPaid: 999999 }).taxPayable, 0, '累计已扣超过累计税额时本期为 0');

/* 累计预扣第二个月：税额 = 累计税 − 已扣（临时塞 2026-10 工资单，验完移除） */
(function () {
  var tmp = { id: 'PAY-2026-10-E010', staffId: 'E010', period: '2026-10', gross: 1800000, social: 189000, fund: 216000, extra: 0, taxable: 895000, rate: 0.03, quick: 0, tax: 26850, net: 1388150, status: '已发放', payDate: '' };
  S.get('payrolls').push(tmp);
  var t2 = FMPayroll.calcMonthlyTax('E010', '2026-11');
  tEq(t2.months, 2, '累计月数 2 个月');
  tEq(t2.cumIncome, 3600000, '累计收入 36,000.00');
  tEq(t2.cumDeduction5000, 1000000, '减除费用 5000×2 月');
  tEq(t2.taxPayable, 26850, '第二个月税额 = 累计 53,700 − 已扣 26,850 = 26,850');
  S.get('payrolls').splice(S.get('payrolls').indexOf(tmp), 1);
})();

/* 年终奖单独计税（÷12 找按月换算税率表，来自 taxrules.monthlyBrackets） */
var b1 = FMPayroll.calcBonusTax(3600000, '2026-12-15');
tEq(b1.ok && b1.rate, 0.03, '年终奖 36000 ÷12 = 3000 → 3% 档');
tEq(b1.tax, 108000, '年终奖税 = 36000×3% = 1,080.00（108000 分）');
var b2 = FMPayroll.calcBonusTax(4800000, '2026-12-15');
tEq(b2.rate + '/' + b2.quickDeduction, '0.1/21000', '48000 ÷12 = 4000 → 10% 档、速算 210.00');
tEq(b2.tax, 459000, '年终奖税 = 48000×10% − 210 = 4,590.00');
var b3 = FMPayroll.calcBonusTax(3600000, '2028-01-01');
t(!b3.ok && /2027-12-31/.test(b3.reason), '政策到期（2028 起）拒绝单独计税');
t(!FMPayroll.calcBonusTax(-1, '2026-12-01').ok, '非法年终奖金额拒绝');

/* 计提 2026-11 工资 */
tEq(FMPayroll.accrue('2026-12').ok, false, '非当前期间不能计提');
var ac = FMPayroll.accrue(LP);
tEq(ac.ok, true, '计提 2026-11 工资成功');
tEq(ac.count, 20, '生成 20 条工资单');
tEq(ac.totalGross, 28600000, '应发合计 286,000.00');
tEq(ac.totalSocialPersonal, 3003000, '个人三险合计 30,030.00（10.5%）');
tEq(ac.totalFundPersonal, 3432000, '个人公积金合计 34,320.00（12%）');
tEq(ac.totalTax, 322950, '个税合计 3,229.50');
tEq(ac.totalNet, 21842050, '实发合计 218,420.50');
tEq(ac.totalSocialCompany, 7378800, '单位社保合计 73,788.00（25.8%）');
tEq(ac.totalFundCompany, 3432000, '单位公积金合计 34,320.00（12%）');
(function () {
  var recs = FMPayroll.list(LP);
  tEq(recs.length, 20, 'state.payrolls 本期 20 条');
  t(recs.every(function (r) { return r.status === '已计提'; }), '工资单状态已计提');
  var e4 = recs.filter(function (r) { return r.staffId === 'E004'; })[0];
  tEq(e4.tax, 0, 'E004 本期个税 0');
  tEq(recs.filter(function (r) { return r.staffId === 'E010'; })[0].tax, 26850, 'E010 个税 268.50');
  var v = S.get('vouchers').filter(function (x) { return x.id === ac.id; })[0];
  tEq(v.status, '已过账', '计提凭证已过账');
  tEq(v.maker, '系统薪酬', '制单人系统薪酬');
  var es = V.entriesOf(ac.id);
  tEq(es.reduce(function (s, e) { return s + e.debit; }, 0), es.reduce(function (s, e) { return s + e.credit; }, 0), '计提凭证借贷平衡');
  function creditRow(code) { return es.filter(function (e) { return e.accountCode === code && e.credit > 0; }).reduce(function (s, e) { return s + e.credit; }, 0); }
  tEq(creditRow('221101'), 28600000, '贷 221101 = 应发合计');
  tEq(creditRow('221102'), 7378800, '贷 221102 = 单位社保');
  tEq(creditRow('221103'), 3432000, '贷 221103 = 单位公积金');
  function debitRow(code, summaryPrefix) {
    return es.filter(function (e) { return e.accountCode === code && (!summaryPrefix || e.summary.indexOf(summaryPrefix) === 0); }).reduce(function (s, e) { return s + e.debit; }, 0);
  }
  tEq(debitRow('4101', '计提工资'), 2000000, '生产部门工资进 4101 制造费用（仓储物流 D06）');
  tEq(debitRow('520101', '计提工资'), 7800000, '销售部门工资进 520101 职工薪酬');
  tEq(debitRow('530101', '计提工资'), 18800000, '管理部门工资进 530101 职工薪酬');
  tEq(debitRow('520107'), 2012400, '销售部门单位社保进 520107（新增末级科目）');
  tEq(debitRow('530111'), 2256000, '管理部门单位公积金进 530111（新增末级科目）');
  /* 期初 221101（10 月计提未发）已被种子凭证 0005 发放核销，余额 0 + 本期计提应发 */
  tEq(A.balance('221101', LP), 28600000, '221101 余额 = 本期计提应发（期初已被 0005 发放核销）');
})();
r = FMPayroll.accrue(LP);
t(!r.ok && r.reason === '本期工资已计提，不能重复计提', '重复计提拒绝');
(function () {
  var cp = S.get('closedPeriods') || [];
  cp.push(LP);
  S.set('closedPeriods', cp);
  var rr = FMPayroll.accrue(LP);
  t(!rr.ok && /已结账/.test(rr.reason), '已结账期间不能计提');
  S.set('closedPeriods', (S.get('closedPeriods') || []).filter(function (p) { return p !== LP; }));
})();

/* 发放 2026-11 工资 */
var balBefore = A.balance('221101', LP);
var py = FMPayroll.pay(LP);
tEq(py.ok, true, '发放 2026-11 工资成功');
tEq(py.totalGross, 28600000, '发放应发合计 286,000.00');
tEq(py.totalNet, 21842050, '实发合计 218,420.50');
tEq(py.totalTax, 322950, '代扣个税合计 3,229.50');
(function () {
  var v = S.get('vouchers').filter(function (x) { return x.id === py.id; })[0];
  tEq(v.status, '已过账', '发放凭证已过账');
  var es = V.entriesOf(py.id);
  tEq(es.reduce(function (s, e) { return s + e.debit; }, 0), es.reduce(function (s, e) { return s + e.credit; }, 0), '发放凭证借贷平衡');
  tEq(es.reduce(function (s, e) { return s + e.debit; }, 0), 28600000, '借 221101 = 应发合计');
  function creditRow(code) { return es.filter(function (e) { return e.accountCode === code; }).reduce(function (s, e) { return s + e.credit; }, 0); }
  tEq(creditRow('100201'), 21842050, '贷 100201 = 实发合计');
  tEq(creditRow('222104'), 322950, '贷 222104 = 个税合计');
  tEq(creditRow('221102'), 3003000, '贷 221102 = 个人三险');
  tEq(creditRow('221103'), 3432000, '贷 221103 = 个人公积金');
})();
t(FMPayroll.list(LP).every(function (r2) { return r2.status === '已发放' && r2.payDate === '2026-11-30'; }),
  '工资单状态已发放并记录发放日期');
tEq(A.balance('221101', LP), 0, '发放后 221101 清零（期初已被 0005 核销、本期计提-发放相抵）');
tEq(A.balance('222104', LP), 2180000 + 322950, '222104 余额 = 种子未缴个税 21,800 + 本期代扣 3,229.50');
r = FMPayroll.pay(LP);
t(!r.ok && /已发放/.test(r.reason), '重复发放拒绝');
(function () {
  var saved = S.get('payrolls');
  S.set('payrolls', []);
  var rr = FMPayroll.pay(LP);
  t(!rr.ok && /未计提/.test(rr.reason), '未计提先发拒绝');
  S.set('payrolls', saved);
})();

/* 渲染冒烟 */
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMPayroll.renderPayroll(el);
  if (el.innerHTML.indexOf('薪酬工资') < 0 || el.innerHTML.indexOf('个税明细') < 0 || el.innerHTML.indexOf('五险一金汇总') < 0) throw new Error('工资页内容缺失');
}, 'renderPayroll');
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMPayroll.renderPayroll(el);
  if (el.innerHTML.indexOf('已发放') < 0) throw new Error('发放状态未显示');
}, 'renderPayroll（已发放）');

/* ---------- 21. chunk 5 旧数据迁移：旧 localStorage 补科目/员工字段 ---------- */
section('chunk 5 · 旧数据迁移');
S.seed();
(function () {
  var st = S.get();
  var accCountBefore = st.accounts.length;                       // 122 个（含 520107/520108/530110/530111）
  st.accounts = st.accounts.filter(function (a) { return a.code !== '530110' && a.code !== '530111'; });
  st.staff.forEach(function (s) { s.salary = 0; delete s.deductions; });   // 模拟 chunk 1 时期的旧员工档案
  st.accounts.filter(function (a) { return a.code === '1001'; })[0].name = '库存现金（自定义）'; // 已有科目改名
  st.staff.filter(function (s) { return s.id === 'E005'; })[0].salary = 555555; // 已有非零 salary 不被覆盖
  st.staff.filter(function (s) { return s.id === 'E003'; })[0].deductions = { rent: 999 };      // 已有 deductions 不被覆盖
  S.save();                                                      // Node 桩：写入 memory，模拟浏览器旧 localStorage
  S.load();
  var acc = S.get('accounts');
  tEq(acc.length, accCountBefore, '迁移后科目一条不少（补回 530110/530111）');
  var n110 = acc.filter(function (a) { return a.code === '530110'; })[0];
  var n111 = acc.filter(function (a) { return a.code === '530111'; })[0];
  tEq(n110 && n110.name + '/' + n110.direction + '/' + n110.category, '社会保险费/借/损益', '530110 按种子格式补齐');
  tEq(n111 && n111.parent + '/' + n111.aux.join(','), '5301/部门', '530111 parent/辅助核算与种子一致');
  tEq(acc.filter(function (a) { return a.code === '1001'; })[0].name, '库存现金（自定义）', '已有科目改名不被种子覆盖');
  var e1 = S.get('staff').filter(function (s) { return s.id === 'E001'; })[0];
  var e2 = S.get('staff').filter(function (s) { return s.id === 'E002'; })[0];
  var e5 = S.get('staff').filter(function (s) { return s.id === 'E005'; })[0];
  var e3 = S.get('staff').filter(function (s) { return s.id === 'E003'; })[0];
  tEq(e1.salary + '/' + e1.deductions.children + '/' + e1.deductions.parents, '3500000/1/3000', 'E001 salary/deductions 恢复种子值');
  tEq(e3.salary, 1800000, '旧档案 salary 为 0 的 E003 补种子值 18,000.00');
  tEq(e5.salary, 555555, '已有非零 salary 不被种子覆盖');
  tEq(e3.deductions.rent, 999, '已有 deductions 不被种子覆盖');
  /* 恢复标准旧数据状态后再跑真实流程 */
  e5.salary = 0;                                                 // 555,555 是自定义验证值，还原为 0（按职务默认）
  e3.deductions = { rent: 1500 };                                // 还原种子扣除
  S.save();
  S.load();
  var ac = FMPayroll.accrue(LP);
  tEq(ac.ok && ac.count, 20, '旧数据迁移后计提成功（20 张工资单）');
  tEq(ac.totalGross, 28600000, '迁移后应发合计仍为 286,000.00');
  tEq(ac.totalTax, 322950, '迁移后个税合计 3,229.50');
  tEq(ac.totalNet, 21842050, '迁移后实发合计 218,420.50');
  tEq(acc.filter(function (a) { return a.code === '1001'; })[0].name, '库存现金（自定义）', '迁移不重复覆盖已有数据');
})();

/* ---------- 22. chunk 6：税务管理 ---------- */
section('chunk 6 · 税务管理');
S.seed();
/* 增值税汇总（种子已过账凭证：0001 进项 104,000、0002 销项 156,000；已交税金 0） */
(function () {
  var vs = FMTax.vatSummary(LP);
  tEq(vs.output, 15600000, '销项税额 156,000.00（只有 0002 已过账）');
  tEq(vs.input, 10400000, '进项税额 104,000.00（只有 0001 已过账）');
  tEq(vs.paid, 0, '已交税金 0（0006 缴的是 222102 未交增值税）');
  tEq(vs.payable, 5200000, '应纳增值税 = 销项 − 进项 = 52,000.00');
  tEq(vs.balance, 5200000, '应缴余额 52,000.00');
  var v = FMTax.calcVAT(LP);
  tEq(v.payable + v.carryForward, 5200000, '应纳为正时留抵结转为 0');
})();
/* 进项 > 销项：应纳为负、不生成应交（临时凭证，验完移除） */
(function () {
  var res = V.create({ date: '2026-11-20', summary: '测试进项大于销项留抵', maker: '王丽', attachCount: 0, entries: [
    { accountCode: '22210101', summary: '测试进项冲抵', debit: '200000.00', credit: 0, aux: {} },
    { accountCode: '100201', summary: '测试进项冲抵', debit: 0, credit: '200000.00', aux: {} }] });
  V.audit(res.id, '李强'); V.post(res.id);
  var v = FMTax.calcVAT(LP);
  tEq(v.payable, -14800000, '进项 > 销项时应纳为负（−148,000.00）');
  tEq(v.carryForward, 14800000, '留抵结转下期 148,000.00');
  var f = FMTax.fileVAT(LP);
  tEq(f.ok && f.record.amount, 0, '留抵时不生成应交（申报金额 0）');
  tEq(f.voucherId, null, '留抵时不生成计提凭证');
  t(/留抵/.test(f.record.note), '留抵备注写入申报记录');
  /* 清理：移除临时凭证与申报记录，回到干净种子 */
  var st = S.get();
  st.vouchers = st.vouchers.filter(function (x) { return x.id !== res.id; });
  st.entries = st.entries.filter(function (x) { return x.voucherId !== res.id; });
  S.set('taxRecords', []);
})();
/* 附加税：市区 7%/3%/2%，小微六税两费减半 */
(function () {
  var s = FMTax.calcSurtax(5200000);
  tEq(s.halved, true, '小微条件成立（从业 100 ≤ 300、资产 ≤ 5000 万）');
  tEq(s.urban, 182000, '城建税 = 52,000×7%×50% = 1,820.00');
  tEq(s.edu, 78000, '教育费附加 = 52,000×3%×50% = 780.00');
  tEq(s.local, 52000, '地方教育附加 = 52,000×2%×50% = 520.00');
  tEq(s.total, 312000, '附加税合计 3,120.00');
  var big = FMTax.calcSurtax(5200000, { totalAssetsCents: 6000000000 }); // 资产 6000 万 → 不减半
  tEq(big.halved, false, '资产超 5000 万不减半');
  tEq(big.urban + big.edu + big.local, 624000, '不减半附加合计 6,240.00');
  tEq(big.urban, 364000, '不减半城建税 = 52,000×7% = 3,640.00');
  var z = FMTax.calcSurtax(0);
  tEq(z.total, 0, '应纳增值税 ≤ 0 时附加税为 0');
})();
/* 企业所得税：小微 5%，超 300 万全额 25% 不分段 */
(function () {
  var c = FMTax.calcCIT(LP);
  tEq(c.profit, 120000000, '本期利润总额 1,200,000.00（损益类已过账发生额）');
  tEq(c.isSmall, true, '小微条件成立');
  tEq(c.effectiveRate, 0.05, '实际税率 5%');
  tEq(c.tax, 6000000, '应交所得税 = 120 万 × 5% = 60,000.00');
  tEq(FMTax.calcCIT(LP, { profitCents: 100000000 }).tax, 5000000, '利润 100 万 → 税 5 万（小微 5%）');
  var big = FMTax.calcCIT(LP, { profitCents: 400000000 });
  tEq(big.isSmall, false, '所得额超 300 万不享受小微');
  tEq(big.effectiveRate, 0.25, '全额按 25%');
  tEq(big.tax, 100000000, '利润 400 万 → 税 100 万（不分段）');
  tEq(FMTax.calcCIT(LP, { profitCents: -5000000 }).tax, 0, '利润 ≤ 0 税额为 0');
})();
/* 印花税 */
(function () {
  tEq(FMTax.calcStamp(LP).total, 0, '种子凭证无“合同”摘要 → 印花税 0');
  var r1 = V.create({ date: '2026-11-22', summary: '采购合同 华东电子一批', maker: '王丽', attachCount: 0, entries: [
    { accountCode: '1405', summary: '采购合同入库', debit: '100000.00', credit: 0, aux: {} },
    { accountCode: '100201', summary: '付采购合同款', debit: 0, credit: '100000.00', aux: {} }] });
  V.audit(r1.id, '李强'); V.post(r1.id);
  var r2 = V.create({ date: '2026-11-23', summary: '借款合同 短期流动资金借款', maker: '王丽', attachCount: 0, entries: [
    { accountCode: '100201', summary: '收到借款', debit: '500000.00', credit: 0, aux: {} },
    { accountCode: '2231', summary: '借款本金', debit: 0, credit: '500000.00', aux: {} }] });
  V.audit(r2.id, '李强'); V.post(r2.id);
  var st = FMTax.calcStamp(LP);
  tEq(st.saleBase, 10000000, '买卖合同金额 100,000.00（借贷合计÷2）');
  tEq(st.saleTax, 3000, '买卖合同印花税 = 100,000×0.03% = 30.00');
  tEq(st.loanBase, 50000000, '借款合同金额 500,000.00');
  tEq(st.loanTax, 2500, '借款合同印花税 = 500,000×0.005% = 25.00');
  tEq(st.total, 5500, '本期印花税合计 55.00');
  t(st.fundBookBase > 0 && st.fundBookTax === Math.round(st.fundBookBase * 0.00025),
    '资金账簿税额 = （实收资本+资本公积）×0.025%，仅期初计一次不入本期');
})();
/* 申报增值税及附加 */
(function () {
  t(!FMTax.fileVAT('2026-12').ok, '非当前期间不能申报');
  var cp = S.get('closedPeriods') || [];
  cp.push(LP); S.set('closedPeriods', cp);
  t(!FMTax.fileVAT(LP).ok && /已结账/.test(FMTax.fileVAT(LP).reason), '已结账期间不能申报');
  S.set('closedPeriods', (S.get('closedPeriods') || []).filter(function (p) { return p !== LP; }));
  var f = FMTax.fileVAT(LP);
  tEq(f.ok, true, '申报 2026-11 增值税成功');
  tEq(f.record.id, 'TAX-2026-11-VAT', '申报记录号');
  tEq(f.record.amount, 5200000, '申报税额 = 应纳增值税 52,000.00');
  tEq(f.record.status, '已申报', '状态已申报');
  var v = S.get('vouchers').filter(function (x) { return x.id === f.voucherId; })[0];
  tEq(v.status, '已过账', '申报凭证已过账');
  tEq(v.maker, '系统税务', '制单人系统税务');
  var es = V.entriesOf(f.voucherId);
  tEq(es.reduce(function (s, e) { return s + e.debit; }, 0), es.reduce(function (s, e) { return s + e.credit; }, 0), '申报凭证借贷平衡');
  function dr(c) { return es.filter(function (e) { return e.accountCode === c; }).reduce(function (s, e) { return s + e.debit; }, 0); }
  function cr(c) { return es.filter(function (e) { return e.accountCode === c; }).reduce(function (s, e) { return s + e.credit; }, 0); }
  tEq(dr('22210104'), 5200000, '借 22210104 转出未交增值税 52,000.00');
  tEq(cr('222102'), 5200000, '贷 222102 未交增值税 52,000.00');
  tEq(dr('5101'), 312000, '借 5101 税金及附加 3,120.00（附加）');
  tEq(cr('222105'), 182000, '贷 222105 城建税 1,820.00');
  tEq(cr('222106'), 78000, '贷 222106 教育费附加 780.00');
  tEq(cr('222107'), 52000, '贷 222107 地方教育附加 520.00');
  tEq(A.balance('222102', LP), 5200000, '222102 余额增加至 52,000.00（期初已被 0006 缴清）');
  tEq(A.balance('222105', LP), 182000, '222105 余额 1,820.00');
  tEq(A.balance('5101', LP), 312000, '5101 税金及附加余额 3,120.00');
  t(!FMTax.fileVAT(LP).ok && /已申报/.test(FMTax.fileVAT(LP).reason), '重复申报增值税拒绝');
})();
/* 申报企业所得税（利润已被附加税 3,120 减少） */
(function () {
  var c = FMTax.calcCIT(LP);
  tEq(c.profit, 119688000, '计提附加后利润总额 1,196,880.00');
  tEq(c.tax, 5984400, '应交所得税 = 1,196,880×5% = 59,844.00');
  var f = FMTax.fileCIT(LP);
  tEq(f.ok && f.record.amount, 5984400, '企业所得税申报成功，税额 59,844.00');
  var es = V.entriesOf(f.voucherId);
  tEq(es.reduce(function (s, e) { return s + e.debit; }, 0), es.reduce(function (s, e) { return s + e.credit; }, 0), '企税凭证借贷平衡');
  tEq(es.reduce(function (s, e) { return s + e.debit; }, 0), 5984400, '借 6801 所得税费用 59,844.00');
  tEq(A.balance('222103', LP), 14200000 + 5984400, '222103 余额 = 期初 142,000.00 + 本期计提 59,844.00');
  t(!FMTax.fileCIT(LP).ok && /已申报/.test(FMTax.fileCIT(LP).reason), '重复申报企税拒绝');
})();
/* 缴款 */
(function () {
  var p1 = FMTax.payTax('TAX-2026-11-VAT');
  tEq(p1.ok && p1.total, 5512000, '增值税缴款合计 = 52,000 + 3,120 = 55,120.00');
  var es = V.entriesOf(p1.id);
  tEq(es.reduce(function (s, e) { return s + e.debit; }, 0), es.reduce(function (s, e) { return s + e.credit; }, 0), '缴款凭证借贷平衡');
  function dr(c) { return es.filter(function (e) { return e.accountCode === c; }).reduce(function (s, e) { return s + e.debit; }, 0); }
  tEq(dr('222102'), 5200000, '借 222102 缴纳增值税');
  tEq(dr('222105'), 182000, '借 222105 缴纳城建税');
  tEq(dr('100201'), 0, '贷方无 100201 借方发生');
  tEq(es.reduce(function (s, e) { return s + e.credit; }, 0), 5512000, '贷 100201 55,120.00');
  tEq(A.balance('222105', LP), 0, '缴款后 222105 清零');
  tEq(A.balance('222102', LP), 0, '缴款后 222102 清零');
  var recs = S.get('taxRecords');
  tEq(recs.filter(function (r) { return r.id === 'TAX-2026-11-VAT'; })[0].status, '已缴纳', '记录状态已缴纳');
  t(!FMTax.payTax('TAX-2026-11-VAT').ok && /已缴纳/.test(FMTax.payTax('TAX-2026-11-VAT').reason), '重复缴款拒绝');
  var p2 = FMTax.payTax('TAX-2026-11-CIT');
  tEq(p2.ok && p2.total, 5984400, '企税缴款 59,844.00');
  tEq(A.balance('222103', LP), 14200000, '缴款后 222103 回到期初 142,000.00');
  t(!FMTax.payTax('TAX-9999-99-XXX').ok, '不存在的记录缴款拒绝');
})();
/* 渲染冒烟 */
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMTax.renderTax(el);
  ['增值税', '附加税', '企业所得税', '印花税', '申报记录'].forEach(function (k) { if (el.innerHTML.indexOf(k) < 0) throw new Error('缺 ' + k); });
}, 'renderTax');
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMTax.renderTax(el);
  if (el.innerHTML.indexOf('已缴纳') < 0 || el.innerHTML.indexOf('小微') < 0) throw new Error('申报状态/小微标识未显示');
}, 'renderTax（申报后）');

/* ---------- 23. chunk 6 修正：利润口径含 4101 制造费用（生产部门期间费用） ---------- */
section('chunk 6 · 利润口径（含 4101）');
S.seed();
(function () {
  tEq(FMTax.calcCIT(LP).profit, 120000000, 'fresh seed 利润总额 1,200,000.00 不变（种子不碰 4101）');
  tEq(FMTax.calcCIT(LP).tax, 6000000, 'fresh seed 小微 5% 税 60,000.00 不变');
  var d = FMAssets.runDepreciation(LP); // 4101 14,250 + 520106 7,000 + 530106 35,250
  tEq(d && d.ok, true, '计提折旧成功');
  var ac = FMPayroll.accrue(LP);        // 4101 27,560（工资 20,000 + 单位社保 5,160 + 公积金 2,400）
  tEq(ac.ok, true, '计提工资成功');
  var py = FMPayroll.pay(LP);
  tEq(py.ok, true, '发放工资成功');
  /* 独立轧差：收入 1,200,000 − 折旧 56,500 − 工资及单位社保公积金 394,108 = 749,392 */
  var c = FMTax.calcCIT(LP);
  tEq(c.profit, 74939200, '利润总额 749,392.00（4101 的 41,810 费用进利润，不再虚增）');
  tEq(c.taxable, 74939200, '应纳税所得额 749,392.00');
  tEq(c.isSmall, true, '小微标识');
  tEq(c.tax, 3746960, '小微 5% 税 37,469.60（749,392×5%）');
})();

/* ---------- 24. chunk 7：财务报表 ---------- */
section('chunk 7 · 财务报表');
S.seed();
/* pnlNet 口径（fresh seed）：收入 1,200,000、无费用 → 未结转利润 = 1,200,000.00 */
tEq(FMReports.balanceSheet(LP).pnlNet, 120000000, 'fresh seed pnlNet = 1,200,000.00（未结转利润，含 4101 期间费用口径）');
tEq(FMReports.balanceSheet(LP).balanced, true, 'fresh seed 资产负债表平衡');
/* 演示场景：种子剩余 6 张凭证全部过账 → 折旧 → 工资计提+发放 → 增值税申报+缴款
 * → 企税申报（利润为负时税额 0）→ 结转损益，然后跑三张表。 */
(function () {
  var n = 0;
  S.get('vouchers').forEach(function (v) {
    if (v.period === LP && v.status !== '已过账') { V.audit(v.id, '李强'); if (V.post(v.id).ok) n++; }
  });
  tEq(n, 6, '种子剩余 6 张凭证全部过账（0007–0012）');
})();
tEq(FMAssets.runDepreciation(LP).ok, true, '计提 11 月折旧成功');
tEq(FMPayroll.accrue(LP).ok, true, '计提 11 月工资成功');
tEq(FMPayroll.pay(LP).ok, true, '发放 11 月工资成功');
var fv7 = FMTax.fileVAT(LP);
tEq(fv7.ok && fv7.record.amount > 0, true, '申报增值税（应纳 > 0，' + S.fmt(fv7.ok ? fv7.record.amount : 0) + '）');
var pv7 = FMTax.payTax('TAX-' + LP + '-VAT');
tEq(pv7.ok, true, '缴纳增值税及附加成功');
/* 结转前：pnlNet 与利润表利润总额必须一致（4101 期间费用口径统一） */
(function () {
  var bm = FMReports.balanceSheet(LP), im = FMReports.incomeStatement(LP);
  tEq(bm.pnlNet, im.profitBeforeTax, '结转前 pnlNet === 利润表利润总额（4101 口径统一）');
  tEq(bm.assets.filter(function (l) { return l.label === '在产品及成本类科目'; })[0].amount, 0,
    '在产品及成本类科目行 = 0（4101 不再列资产）');
  tEq(bm.diff, 0, '结转前资产负债表平衡（diff 0）');
})();
tEq(FMTax.fileCIT(LP).ok, true, '申报企业所得税成功（利润为负税额 0）');
tEq(FMClosing.carryForward(LP).ok, true, '结转 11 月损益成功');

/* 独立复算助手：本期已过账（剔除结转损益凭证）借向净额，不依赖 FMReports 内部实现 */
function plNet7(prefix) {
  var d = 0, c = 0, vm = {};
  S.get('vouchers').forEach(function (v) { vm[v.id] = v; });
  S.get('entries').forEach(function (e) {
    var v = vm[e.voucherId];
    if (!v || v.period !== LP || v.status !== '已过账') return;
    if (String(v.summary || '').indexOf('结转本期损益') === 0) return;
    if (String(e.accountCode).indexOf(prefix) !== 0) return;
    d += e.debit || 0; c += e.credit || 0;
  });
  return d - c;
}
function leafSum7(category, period) {
  var sum = 0;
  A.leaves().forEach(function (a) { if (a.category === category) sum += A.balance(a.code, period); });
  return sum;
}

/* —— 资产负债表 —— */
var bs7 = FMReports.balanceSheet(LP);
tEq(bs7.balanced, true, '资产负债表平衡：资产总计 = 负债 + 权益');
t(Math.abs(bs7.diff) <= 1, '资产负债差额 ≤ 1 分（差额 ' + bs7.diff + ' 分）');
tEq(bs7.assets[0].label, '货币资金', '资产第一行是货币资金');
tEq(bs7.assets[0].amount, A.balance('1001', LP) + A.balance('1002', LP), '货币资金 = 1001 + 1002 余额');
(function () {
  var sum = 0;
  A.leaves().forEach(function (a) {
    if (String(a.code).indexOf('1001') === 0 || String(a.code).indexOf('1002') === 0) sum += A.balance(a.code, LP);
  });
  tEq(bs7.assets[0].amount, sum, '货币资金 = 末级子目余额之和（独立复算，父科目不重复算）');
})();
tEq(bs7.assets.filter(function (l) { return l.label === '应收账款'; })[0].amount, A.balance('1122', LP), '应收账款 = 1122');
tEq(bs7.assets.filter(function (l) { return l.label === '固定资产净值'; })[0].amount,
  A.balance('1601', LP) - A.balance('1602', LP), '固定资产净值 = 1601 − 1602');
tEq(bs7.pnlNet, -A.balance('4101', LP),
  '结转后 pnlNet = −4101 余额（损益已清零，制造费用不结转，按期间费用留在权益外）');
tEq(bs7.equity[3].label, '未分配利润', '权益第四行是未分配利润');
tEq(bs7.equity[3].amount, A.balance('3103', LP) + A.balance('310405', LP) - A.balance('4101', LP),
  '未分配利润 = 3103 + 310405 − 制造费用余额（4101 期间费用口径）');
tEq(bs7.totalEquity, leafSum7('所有者权益', LP) + bs7.pnlNet,
  '权益合计 = 权益末级余额之和 + pnlNet（独立复算）');
(function () {
  // 独立复算：借向资产末级余额 + 成本类（4001/4301/4401）末级余额 − 贷向（减值/折旧/坏账）资产末级余额。
  // 4101 制造费用不在资产侧：它是生产部门期间费用（chunk 4/5 口径），进 pnlNet（权益侧）。
  var sum = 0;
  A.leaves().forEach(function (a) {
    if (a.category === '资产') sum += a.direction === '借' ? A.balance(a.code, LP) : -A.balance(a.code, LP);
    else if (a.category === '成本' && a.code !== '4101') sum += A.balance(a.code, LP);
  });
  tEq(bs7.totalAssets, sum, '资产总计 = 借向资产 + 成本类（不含 4101）− 贷向减项（独立复算）');
})();
(function () {
  var sum = 0;
  A.leaves().forEach(function (a) {
    if (a.category !== '负债') return;
    var b = A.balance(a.code, LP);
    sum += a.direction === '贷' ? b : -b; // 借向负债明细（进项税额等）作减项
  });
  tEq(bs7.totalLiabilities, sum, '负债合计 = 负债末级余额按方向净额（独立复算）');
})();
tEq(bs7.totalAssets, bs7.totalLiabilities + bs7.totalEquity, '资产总计 = 负债合计 + 权益合计（总额恒等式）');
t(bs7.assets.every(function (l) { return Number.isInteger(l.amount); }), '报表金额全部为整数分');

/* —— 利润表（全量过账后为净亏损：演示数据成本费用大于收入） —— */
var is7 = FMReports.incomeStatement(LP);
tEq(is7.revenue, 165000000, '营业收入 = 6001 本期贷方发生额 1,650,000（0002 + 0009）');
tEq(is7.revenue, -plNet7('6001'), '营业收入与独立复算一致（6001 贷向净额）');
tEq(is7.cost, 115500000, '营业成本 = 5001 本期借方发生额 1,155,000（结转销售成本已过账）');
tEq(is7.salesExpense, plNet7('5201'), '销售费用 = 5201 本期净发生额（独立复算）');
tEq(is7.adminExpense, plNet7('5301'), '管理费用 = 5301 本期净发生额（独立复算）');
tEq(is7.manufacturingExpense, plNet7('4101'), '制造费用 = 4101 本期净发生额（折旧+生产/仓储工资社保）');
tEq(is7.financeExpense, 725000, '财务费用 = 5401 借款利息 7,250');
tEq(is7.taxes, fv7.surtax.total, '税金及附加 = 5101 附加税计提额');
tEq(is7.operatingProfit, is7.revenue + is7.otherOperatingIncome - is7.cost - is7.manufacturingExpense -
  is7.taxes - is7.salesExpense - is7.adminExpense - is7.financeExpense - is7.otherOperatingExpense,
  '营业利润 = 收入 − 成本 − 制造费用 − 税金及附加 − 三费');
tEq(is7.profitBeforeTax, is7.operatingProfit + is7.nonOperatingNet, '利润总额 = 营业利润 + 营业外收支净额');
tEq(is7.incomeTax, 0, '利润为负时所得税费用为 0');
tEq(is7.netProfit, is7.profitBeforeTax - is7.incomeTax, '净利润 = 利润总额 − 所得税费用');
tEq(is7.netProfit + is7.manufacturingExpense, A.balance('3103', LP) - 68520000,
  '净利润 + 制造费用（4101 不结转）= 3103 期末余额 − 期初 685,200');
t(is7.netProfit < 0, '全量过账+计提后为净亏损（' + S.fmt(is7.netProfit) + '，演示数据如此）');

/* —— 现金流量表 —— */
var cf7 = FMReports.cashFlow(LP);
tEq(cf7.netIncrease, cf7.operating.net + cf7.investing.net + cf7.financing.net, '三项净额之和 = 现金净增加额');
tEq(cf7.closingCash, cf7.openingCash + cf7.netIncrease, '净增加额 + 期初现金 = 期末现金');
tEq(cf7.checkVsBalanceSheet.diff, 0, '期末现金 = 资产负债表货币资金（差 0）');
tEq(cf7.checkVsBalanceSheet.balanced, true, '期末现金与货币资金校验通过');
tEq(cf7.closingCash, bs7.assets[0].amount, '期末现金与资产负债表货币资金直接相等');
(function () {
  var sum = 0;
  ['1001', '100201', '100202'].forEach(function (code) {
    sum += FMLedger.accountBalance(code, LP).opening;
  });
  tEq(cf7.openingCash, sum, '期初现金 = 现金科目期初余额（独立复算）');
})();
(function () {
  var vm = {}, net = 0;
  S.get('vouchers').forEach(function (v) { vm[v.id] = v; });
  S.get('entries').forEach(function (e) {
    var v = vm[e.voucherId];
    if (!v || v.period !== LP || v.status !== '已过账') return;
    var code = String(e.accountCode);
    if (code === '1001' || code === '100201' || code === '100202') net += (e.debit || 0) - (e.credit || 0);
  });
  tEq(cf7.netIncrease, net, '现金净增加额 = 凭证现金分录轧差（独立复算）');
  tEq(cf7.checkVsJournal.match, true, '双源核对：凭证现金发生额 = 出纳日记账发生额');
})();
tEq(cf7.operating.inDetail.sales, 65000000 + 50850000, '销售收现 = 0003 收款 650,000 + 0009 现销 508,500');
tEq(cf7.operating.outDetail.staff, 85240000 + 21842050, '支付职工现金 = 代发工资 852,400 + 实发 218,420.50');
tEq(cf7.operating.outDetail.tax, 23253000 + pv7.total, '支付税费 = 缴 10 月税费 232,530 + 本期增值税及附加缴款');
tEq(cf7.operating.outDetail.purchase, 48000000, '购买商品付现 480,000');
tEq(cf7.operating.outDetail.other, 6540000 + 865040, '其他经营流出 = 租金 65,400 + 差旅 8,650.40（租金进项税不算缴税）');
tEq(cf7.operating.out, cf7.operating.outDetail.purchase + cf7.operating.outDetail.staff +
  cf7.operating.outDetail.tax + cf7.operating.outDetail.other, '经营流出小计 = 各明细之和');
tEq(cf7.investing.net, 0, '投资活动净额 = 0（本期尚无购建/处置）');
tEq(cf7.financing.outDetail.interestDividend, 1450000, '偿付利息付现 14,500（冲 10 月计提 + 本期利息）');
tEq(cf7.financing.net, -1450000, '筹资活动净额 = −14,500');

/* —— 报表只读：计算不改 state —— */
(function () {
  var before = JSON.stringify(S.get());
  FMReports.balanceSheet(LP); FMReports.incomeStatement(LP); FMReports.cashFlow(LP);
  tEq(JSON.stringify(S.get()), before, '三张表计算不修改 state（只读口径）');
})();

/* —— 鲁棒性：新增购建凭证后三表仍自洽 —— */
(function () {
  var r = V.create({ date: '2026-11-26', summary: '测试购入固定资产', maker: '王丽', attachCount: 0, entries: [
    { accountCode: '1601', summary: '购入设备一台', debit: '100000.00', credit: 0, aux: {} },
    { accountCode: '100201', summary: '银行支付设备款', debit: 0, credit: '100000.00', aux: {} }] });
  V.audit(r.id, '李强'); V.post(r.id);
  var b2 = FMReports.balanceSheet(LP);
  tEq(b2.balanced, true, '新增购建凭证后资产负债表仍平衡');
  tEq(b2.assets[0].amount, bs7.assets[0].amount - 10000000, '购建后货币资金减少 100,000');
  var fa = b2.assets.filter(function (l) { return l.label === '固定资产净值'; })[0];
  tEq(fa.amount, A.balance('1601', LP) - A.balance('1602', LP), '固定资产净值仍 = 1601 − 1602（含新购）');
  var c2 = FMReports.cashFlow(LP);
  tEq(c2.investing.out, 10000000, '购建固定资产付现 100,000 进投资活动流出');
  tEq(c2.investing.net, -10000000, '投资活动净额 = −100,000');
  tEq(c2.checkVsBalanceSheet.diff, 0, '期末现金仍与资产负债表货币资金一致');
})();

/* 渲染冒烟 + 导出 CSV（Node 下 exportCSV 返回字符串） */
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMReports.renderReports(el);
  ['资产负债表', '资产总计', '负债和所有者权益总计', '导出 CSV'].forEach(function (k) {
    if (el.innerHTML.indexOf(k) < 0) throw new Error('缺 ' + k);
  });
}, 'renderReports（资产负债表页签）');
smoke(function () {
  var el = { innerHTML: '', onclick: null };
  FMReports.renderReports(el);
  el.onclick({ target: { dataset: { action: 'tab', tab: 'is' } } });
  ['利润表', '营业收入', '净利润', '利润总额'].forEach(function (k) {
    if (el.innerHTML.indexOf(k) < 0) throw new Error('缺 ' + k);
  });
  el.onclick({ target: { dataset: { action: 'tab', tab: 'cf' } } });
  ['现金流量表', '经营活动产生的现金流量净额', '现金及现金等价物净增加额', '期末现金及现金等价物余额'].forEach(function (k) {
    if (el.innerHTML.indexOf(k) < 0) throw new Error('缺 ' + k);
  });
  el.onclick({ target: { dataset: { action: 'tab', tab: 'bs' } } });
}, 'renderReports（利润表/现金流量表页签切换）');
smoke(function () {
  var el = { innerHTML: '', onclick: null }, exported = '';
  FMReports.renderReports(el);
  global.FMToast = function (m) { exported = m; };
  el.onclick({ target: { dataset: { action: 'export' } } });
  if (exported.indexOf('资产负债表') < 0) throw new Error('导出提示缺失');
}, 'renderReports（导出 CSV 触发下载/字符串）');

/* —— pnlNet 与利润表口径一致（4101 期间费用，chunk 6 同环境：fresh seed + 折旧 + 工资 + 增值税申报） —— */
section('chunk 7 修正 · pnlNet 口径（4101 期间费用）');
S.seed();
(function () {
  tEq(FMAssets.runDepreciation(LP).ok, true, '计提折旧成功');
  tEq(FMPayroll.accrue(LP).ok && FMPayroll.pay(LP).ok, true, '工资计提+发放成功');
  tEq(FMTax.fileVAT(LP).ok, true, '增值税申报成功（附加计入 5101）');
  var b = FMReports.balanceSheet(LP), i = FMReports.incomeStatement(LP);
  tEq(b.pnlNet, 74627200, 'pnlNet = 746,272.00（收入 1,200,000 − 折旧 56,500 − 工资社保公积金 394,108 − 附加 3,120）');
  tEq(i.profitBeforeTax, 74627200, '利润表利润总额 = 746,272.00');
  tEq(b.pnlNet, i.profitBeforeTax, 'pnlNet === 利润总额（两边口径一致，不再差 41,810）');
  tEq(b.assets.filter(function (l) { return l.label === '在产品及成本类科目'; })[0].amount, 0,
    '在产品及成本类科目行 = 0（4001/4301/4401 均无余额）');
  tEq(b.diff, 0, '资产负债表仍平衡（diff === 0）');
})();

/* —— 所得税非零情形：fresh seed 直接申报企税 —— */
section('chunk 7 · 利润表（所得税非零情形）');
S.seed();
var fc7 = FMTax.fileCIT(LP);
tEq(fc7.ok && fc7.record.amount, 6000000, '所得税 = 1,200,000 × 5% = 60,000（fresh seed）');
var is7b = FMReports.incomeStatement(LP);
tEq(is7b.incomeTax, 6000000, '利润表所得税费用 = 6801 发生额 60,000');
tEq(is7b.profitBeforeTax, 120000000, '利润总额 1,200,000（fresh seed 已过账口径）');
tEq(is7b.netProfit, 114000000, '净利润 = 1,200,000 − 60,000 = 1,140,000');
tEq(FMClosing.carryForward(LP).ok, true, '结转损益成功');
tEq(FMReports.incomeStatement(LP).netProfit, A.balance('3103', LP) - 68520000,
  '结转后净利润 = 3103 期末余额 − 期初 685,200');
tEq(FMReports.balanceSheet(LP).equity[3].amount, A.balance('3103', LP) + A.balance('310405', LP),
  '未分配利润 = 3103 + 310405 期末余额');
tEq(FMReports.balanceSheet(LP).balanced, true, '资产负债表仍平衡');

/* —— 未过账 / 未审核凭证不进报表 —— */
section('chunk 7 · 未过账凭证不进报表');
S.seed();
(function () {
  var bs0 = FMReports.balanceSheet(LP), is0 = FMReports.incomeStatement(LP), cf0 = FMReports.cashFlow(LP);
  var r = V.create({ date: '2026-11-28', summary: '测试未过账销售', maker: '王丽', attachCount: 0, entries: [
    { accountCode: '1122', summary: '赊销（测试未过账）', debit: '50000.00', credit: 0, aux: { customer: 'C001' } },
    { accountCode: '600101', summary: '赊销（测试未过账）', debit: 0, credit: '50000.00', aux: {} }] });
  V.audit(r.id, '李强'); // 只审核、不过账
  tEq(FMReports.incomeStatement(LP).revenue, is0.revenue, '已审核未过账凭证不进利润表');
  tEq(FMReports.balanceSheet(LP).totalAssets, bs0.totalAssets, '已审核未过账凭证不进资产负债表');
  tEq(FMReports.cashFlow(LP).netIncrease, cf0.netIncrease, '已审核未过账凭证不进现金流量表（净额不变）');
  V.post(r.id);
  tEq(FMReports.incomeStatement(LP).revenue, is0.revenue + 5000000, '过账后进入利润表（+50,000）');
})();

/* ---------- 25. chunk 7 修正：种子版本（SEED_VERSION）与旧数据重建 ---------- */
section('chunk 7 修正 · 种子版本与旧数据重建');
S.seed();
t(typeof FMStore.SEED_VERSION === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(FMStore.SEED_VERSION), 'FMStore.SEED_VERSION 为日期格式字符串常量');
tEq(FMStore.SEED_VERSION, '2026-11-27', 'SEED_VERSION = 2026-11-27');
tEq(S.get().seedVersion, FMStore.SEED_VERSION, 'seed() 把当前种子版本写入 state.seedVersion');
/* 版本相同：load() 不重建，用户改动保留 */
(function () {
  S.get().accounts.filter(function (a) { return a.code === '1001'; })[0].opening = 999; // 模拟用户改动
  S.save();
  S.load();
  tEq(A.get('1001').opening, 999, 'seedVersion 相同时 load() 不重建（改动保留）');
  tEq(S.get().seedVersion, FMStore.SEED_VERSION, '版本号不变');
})();
/* 旧版本：先备份旧库，再整库按当前种子重建 */
(function () {
  var fake = {};
  global.localStorage = { // 临时假 localStorage，验完删除
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(fake, k) ? fake[k] : null; },
    setItem: function (k, v) { fake[k] = String(v); },
    removeItem: function (k) { delete fake[k]; }
  };
  S.seed();
  var st = S.get();
  st.seedVersion = '2026-10-01-old';                                 // 模拟老版本数据
  st.accounts.filter(function (a) { return a.code === '1601'; })[0].opening = 385000000; // 老种子 ¥3,850,000
  S.save();
  S.load();
  tEq(A.get('1601').opening, 1028000000, '旧版本 state 重建后 1601 期初 = ¥10,280,000（1028000000 分）');
  tEq(S.get().seedVersion, FMStore.SEED_VERSION, '重建后 seedVersion 更新为当前值');
  var bk = fake['fm_backup_2026-10-01-old'];
  t(typeof bk === 'string' && bk.indexOf('385000000') >= 0, '旧库已备份到 fm_backup_<旧版本>（含旧期初 385000000）');
  t(bk.indexOf('"seedVersion":"2026-10-01-old"') >= 0, '备份内容是旧版本原文');
  delete global.localStorage;
  S.seed(); // 恢复内存干净种子，供后续断言使用
  tEq(A.get('1601').opening, 1028000000, '恢复后 fresh 种子 1601 期初 = ¥10,280,000');
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
