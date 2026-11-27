/* 临时验证脚本：跑 chunk 7 演示场景并打印三张表实测数（验完删除） */
'use strict';
global.window = global;
global.document = { getElementById: function () { return null; }, querySelectorAll: function () { return []; } };
global.location = { hash: '' };
global.FMToast = function () {};
var fs = require('fs'), path = require('path'), vm = require('vm');
['js/taxrules.js', 'js/store.js', 'js/accounts.js', 'js/voucher.js', 'js/dashboard.js',
 'js/ledger.js', 'js/closing.js', 'js/opening.js', 'js/arap.js', 'js/cashier.js', 'js/assets.js', 'js/payroll.js', 'js/tax.js', 'js/reports.js'].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), { filename: f });
});
var S = global.FMStore, A = global.FMAccounts, V = global.FMVoucher, R = global.FMReports;
S.seed();
var LP = S.get('periods').current;

// 1. 过账种子剩余凭证 0007–0012
S.get('vouchers').forEach(function (v) {
  if (v.period === LP && v.status !== '已过账') { V.audit(v.id, '李强'); var p = V.post(v.id); if (!p.ok) console.log('post fail', v.id, p.reason); }
});
// 2. 折旧、工资计提+发放
var d = global.FMAssets.runDepreciation(LP); console.log('dep', d && d.ok);
var ac = global.FMPayroll.accrue(LP); console.log('accrue', ac && ac.ok, ac && ac.totalGross);
var py = global.FMPayroll.pay(LP); console.log('pay', py && py.ok);
// 3. 税：申报 + 缴款
var f1 = global.FMTax.fileVAT(LP); console.log('fileVAT', f1.ok, f1.ok ? f1.record.amount : f1.reason, 'surtax', f1.ok ? f1.surtax.total : '');
var p1 = f1.ok ? global.FMTax.payTax('TAX-' + LP + '-VAT') : null; console.log('payVAT', p1 && p1.ok, p1 && p1.total);
var f2 = global.FMTax.fileCIT(LP); console.log('fileCIT', f2.ok, f2.ok ? f2.record.amount : f2.reason, 'profit', f2.ok ? f2.cit.profit : '');
var p2 = f2.ok && f2.record.amount > 0 ? global.FMTax.payTax('TAX-' + LP + '-CIT') : null; console.log('payCIT', p2 && p2.ok, p2 && p2.total);
// 4. 结转损益
var cf = global.FMClosing.carryForward(LP); console.log('carry', cf.ok, cf.ok ? cf.amount : cf.reason);

var bs = R.balanceSheet(LP), inc = R.incomeStatement(LP), cfr = R.cashFlow(LP);
console.log('\n--- 资产负债表 ---');
bs.assets.forEach(function (l) { console.log(' ', l.label, S.fmt(l.amount)); });
console.log('资产总计', S.fmt(bs.totalAssets));
bs.liabilities.forEach(function (l) { console.log(' ', l.label, S.fmt(l.amount)); });
console.log('负债合计', S.fmt(bs.totalLiabilities));
bs.equity.forEach(function (l) { console.log(' ', l.label, S.fmt(l.amount), l.note || ''); });
console.log('权益合计', S.fmt(bs.totalEquity), '负债+权益', S.fmt(bs.totalLiabEquity), 'diff', bs.diff, 'balanced', bs.balanced);

console.log('\n--- 利润表 ---');
['revenue','otherOperatingIncome','cost','manufacturingExpense','taxes','salesExpense','adminExpense','financeExpense','otherOperatingExpense','operatingProfit','nonOperatingNet','profitBeforeTax','incomeTax','netProfit'].forEach(function (k) { console.log(' ', k, S.fmt(inc[k])); });
console.log('3103 closing', S.fmt(A.balance('3103', LP)), 'opening', S.fmt(A.balance('3103', LP) - inc.netProfit));

console.log('\n--- 现金流量表 ---');
console.log('op in', S.fmt(cfr.operating.in), JSON.stringify(cfr.operating.inDetail));
console.log('op out', S.fmt(cfr.operating.out), JSON.stringify(cfr.operating.outDetail));
console.log('op net', S.fmt(cfr.operating.net));
console.log('inv', S.fmt(cfr.investing.in), S.fmt(cfr.investing.out), S.fmt(cfr.investing.net));
console.log('fin', S.fmt(cfr.financing.in), S.fmt(cfr.financing.out), JSON.stringify(cfr.financing.outDetail), S.fmt(cfr.financing.net));
console.log('netIncrease', S.fmt(cfr.netIncrease), 'opening', S.fmt(cfr.openingCash), 'closing', S.fmt(cfr.closingCash));
console.log('checkBS', JSON.stringify(cfr.checkVsBalanceSheet), 'checkJournal', JSON.stringify(cfr.checkVsJournal));
console.log('TB', JSON.stringify(V.trialBalance(LP)));
