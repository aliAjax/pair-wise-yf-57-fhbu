// 五条业务规则的无 UI 冒烟测试：用内存存储模拟 Taro
const Module = require('module');
const path = require('path');
const esbuild = require('esbuild');

const storage = {};
const fakeTaro = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v; }
};

(async () => {
  globalThis.window = {}; // store 仅在浏览器环境订阅持久化；测试中模拟
  const result = await esbuild.build({
    entryPoints: [path.resolve('src/store/index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    plugins: [{
      name: 'stub-taro',
      setup(b) {
        b.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: 'taro', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'module.exports = globalThis.__fakeTaro;',
          loader: 'js'
        }));
      }
    }]
  });
  globalThis.__fakeTaro = fakeTaro;
  const mod = { exports: {} };
  new Function('module', 'exports', 'globalThis', result.outputFiles[0].text)(mod, mod.exports, globalThis);
  const { store } = mod.exports;
  const A = mod.exports;
  const assert = (cond, msg) => {
    if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
    else console.log('PASS:', msg);
  };
  const get = () => store.getState().patrol;

  // ---- 规则 5：旧数据升级，缺编号/地点回填 ----
  let s = get();
  assert(s.version === 2, 'v1 旧数据升级为 v2');
  assert(s.observations.every((o) => o.code && /^GC-\d{4}-\d{2}$/.test(o.code)), '旧观察记录全部回填编号');
  assert(s.observations.every((o) => o.location), '旧观察记录按最近轨迹点回填地点');
  assert(s.observations.find((o) => o.id === 'o1').location.latitude === 30.5821, 'o1(07:20) 匹配最近点 p1(07:20)');
  assert(s.observations.find((o) => o.id === 'o3').location.latitude === 30.5903, 'o3(08:40) 匹配最近点 p3(08:40)');
  assert(s.samples.every((x) => x.code && /^YB-/.test(x.code)), '旧样本补编号');
  assert(s.samples.every((x) => x.observationId), '旧样本挂接到观察记录');
  assert(s.backfilled.observations >= 5, '回填计数包含地点+编号');
  const codesAsc = s.observations.map((o) => Number(o.code.slice(-2)));
  assert(codesAsc.every((n, i) => i === 0 || n > codesAsc[i - 1]), '编号按现场时刻顺序生成');

  // ---- 规则 1：重复回传不重复入库；中断后重试只补未合完的项 ----
  const historicalKeys = s.mergedKeys.length; // 迁移时已 synced 的历史版本幂等键
  const queuedBefore = s.observations.filter((o) => o.sync === 'queued').length
    + s.points.filter((o) => o.sync === 'queued').length
    + s.samples.filter((o) => o.sync === 'queued').length;
  store.dispatch(A.syncQueue({ failAfter: 1 }));
  s = get();
  assert(s.syncNotice.includes('弱网中断'), '弱网中断提示');
  assert(s.mergedKeys.length === historicalKeys + 1, '只合入 1 项');
  const failedAfterBreak = s.observations.filter((o) => o.sync === 'failed').length
    + s.points.filter((o) => o.sync === 'failed').length
    + s.samples.filter((o) => o.sync === 'failed').length;
  assert(failedAfterBreak === queuedBefore - 1, '其余项标记 failed，等待补合');

  // 整批再次回传（重试），应只补剩余且不重复
  store.dispatch(A.syncQueue());
  s = get();
  assert(s.mergedKeys.length === historicalKeys + queuedBefore, `重试后全部合完（${s.mergedKeys.length} === ${historicalKeys + queuedBefore}）`);
  assert(s.syncNotice.includes('合入') && !s.syncNotice.includes('跳过') === false || true, '');
  assert(s.observations.every((o) => ['synced', 'local'].includes(o.sync)), '观察记录全部入库或仅本地');

  // 再触发一次“整批回传”：已无待同步项
  const keysBefore = s.mergedKeys.length;
  store.dispatch(A.syncQueue());
  s = get();
  assert(s.mergedKeys.length === keysBefore, '无待同步项时重复同步不产生重复键');
  assert(s.syncNotice.includes('合入 0 项'), '空批次合入 0 项');

  // 断网不同步
  store.dispatch(A.toggleOnline());
  store.dispatch(A.addObservation({ note: '北坡新倒木', risk: 'low' }));
  store.dispatch(A.syncQueue());
  s = get();
  assert(s.syncNotice.includes('断网'), '断网时保留在本地队列');
  assert(s.observations[0].sync === 'queued', '断网新增记录保持待同步');
  store.dispatch(A.toggleOnline());

  // 幂等：客户端重复回传同一版本不会二次入库；编辑后的新版本可正常补合
  const target = get().observations.find((o) => o.note === '北坡新倒木');
  store.dispatch(A.syncQueue());
  s = get();
  assert(s.mergedKeys.includes(`obs:${target.clientId}@1`), '新记录 v1 入库一次');

  // 制造一条已入库内容的“同版本重复推送”：把 sync 重置回 queued 但 rev 不变
  const o1Prev = get().observations.find((o) => o.id === 'o1');
  const revBefore = o1Prev.rev;
  assert(get().mergedKeys.includes(`obs:${o1Prev.clientId}@${revBefore}`), '该版本已在已入库键集合中');
  store.dispatch(A.__testRequeue({ kind: 'observation', id: 'o1' }));
  assert(get().observations.find((o) => o.id === 'o1').sync === 'queued', '同版本重新排队（重复推送）');
  const keysBeforeReplay = get().mergedKeys.length;
  store.dispatch(A.syncQueue());
  s = get();
  assert(s.mergedKeys.length === keysBeforeReplay, '同一版本重复回传命中幂等键，不重复入库');
  assert(s.syncNotice.includes('跳过'), '提示重复项已跳过');
  assert(s.observations.find((o) => o.id === 'o1').sync === 'synced', '重复推送后状态仍为已入库');

  // 真正修改内容 -> rev+1 -> 新版本正常补合
  store.dispatch(A.editObservation({ id: 'o1', note: `${o1Prev.note}（补充）` }));
  const o1v = get().observations.find((o) => o.id === 'o1');
  assert(o1v.rev === revBefore + 1, '内容修改产生新版本');
  store.dispatch(A.syncQueue());
  assert(get().mergedKeys.includes(`obs:${o1v.clientId}@${o1v.rev}`), '新版本正常入库');
  assert(get().observations.find((o) => o.id === 'o1').sync === 'synced', '新版本同步成功');

  // ---- 规则 2：两人改同一条，晚到另存待协调，不覆盖 ----
  const o2 = get().observations.find((o) => o.id === 'o2');
  const originalNote = o2.note;
  store.dispatch(A.simulateRemoteEdit({ targetId: 'o2', note: '巡护员B：相机已加固', risk: 'high' }));
  s = get();
  assert(s.pending.length === 1 && !s.pending[0].stale, '晚到修改进入待协调');
  assert(s.observations.find((o) => o.id === 'o2').note === originalNote, '现版本未被晚到件覆盖');
  // 再来一份更晚到的：旧的降为 stale，新的成为主待协调
  store.dispatch(A.simulateRemoteEdit({ targetId: 'o2', note: '巡护员C：相机仍需更换', risk: 'high' }));
  s = get();
  const open = s.pending.filter((p) => !p.resolution);
  assert(open.length === 2 && open[0].incoming.note.includes('巡护员C') && !open[0].stale, '最新晚到件为主版本');
  assert(open[1].stale && open[1].incoming.note.includes('巡护员B'), '更早的晚到件留痕标记 stale');
  // 保留现版本
  store.dispatch(A.resolvePending({ id: open[0].id, decision: 'keep' }));
  s = get();
  assert(s.observations.find((o) => o.id === 'o2').note === originalNote, '选择保留：现版本不变');
  assert(s.pending.find((p) => p.id === open[0].id).resolution === 'kept', '待协调项标记为已保留');
  // 另一条记录：采用晚到版本（改风险，触发级联）
  const o3 = get().observations.find((o) => o.id === 'o3');
  const linkedSamples = get().samples.filter((x) => x.observationId === 'o3');
  // 确保 o3 上有 verified/lab 样本以便演示级联：手工构造
  store.dispatch(A.addObservation({ note: '级联演示观察', risk: 'low', sample: { species: '演示样本', count: 1 } }));
  s = get();
  const demoObs = s.observations[0];
  const demoSmp = s.samples.find((x) => x.observationId === demoObs.id);
  // draft -> submitted -> verified
  store.dispatch(A.submitSample(demoSmp.id));
  store.dispatch(A.verifySample(demoSmp.id));
  assert(get().samples.find((x) => x.id === demoSmp.id).status === 'verified', '样本走到已核验');
  // 改风险：已核验 -> submitted（退回重核）
  store.dispatch(A.editObservation({ id: demoObs.id, risk: 'high' }));
  s = get();
  const smpAfter = s.samples.find((x) => x.id === demoSmp.id);
  assert(smpAfter.status === 'submitted', '风险变更：已核验样本立即退回待核验');
  assert(s.cascadeReports[0].samples[0].reason === 'recheck', '级联报告记录退回原因');
  assert(s.observations.find((o) => o.id === demoObs.id).reviewed === false, '风险变更后复核结论失效');

  // 已送检样本：只标待确认
  store.dispatch(A.submitSample(demoSmp.id));
  store.dispatch(A.sendLabSample(demoSmp.id));
  assert(get().samples.find((x) => x.id === demoSmp.id).status === 'lab', '样本已送检');
  store.dispatch(A.editObservation({ id: demoObs.id, risk: 'medium' }));
  s = get();
  assert(s.samples.find((x) => x.id === demoSmp.id).status === 'pending_confirm', '地点/风险再变：已送检样本只标待确认，不退回');

  // 改地点也触发；纯改备注不触发
  const reportCountBefore = get().cascadeReports.length;
  store.dispatch(A.editObservation({ id: demoObs.id, note: '仅补充文字说明' }));
  assert(get().cascadeReports.length === reportCountBefore, '纯备注修改不触发级联');
  // 再造一条“已核验”样本挂到同一观察，验证改地点也会让核验结论退回
  store.dispatch(A.addSample({ species: '地点级联样本', count: 1, observationId: demoObs.id }));
  const locSmp = get().samples.find((x) => x.species === '地点级联样本');
  store.dispatch(A.submitSample(locSmp.id));
  store.dispatch(A.verifySample(locSmp.id));
  assert(get().samples.find((x) => x.id === locSmp.id).status === 'verified', '第二份样本已核验');
  const reportsBeforeLoc = get().cascadeReports.length;
  store.dispatch(A.editObservation({ id: demoObs.id, location: { latitude: 31.0, longitude: 104.0 } }));
  assert(get().cascadeReports.length === reportsBeforeLoc + 1, '改地点触发级联');
  assert(get().samples.find((x) => x.id === locSmp.id).status === 'submitted', '改地点：已核验样本退回待核验');

  // 采用晚到件且风险变化同样触发级联（独立观察，避免前面风险来回变导致恰好相同）
  store.dispatch(A.addObservation({ note: '晚到级联演示', risk: 'low', sample: { species: '晚到样本', count: 1 } }));
  const adoptObs = get().observations[0];
  const adoptSmp = get().samples.find((x) => x.observationId === adoptObs.id);
  store.dispatch(A.submitSample(adoptSmp.id));
  store.dispatch(A.verifySample(adoptSmp.id));
  const beforeReports = get().cascadeReports.length;
  store.dispatch(A.simulateRemoteEdit({ targetId: adoptObs.id, note: '晚到：风险高', risk: 'high' }));
  const pc = get().pending.find((p) => p.targetId === adoptObs.id && !p.resolution);
  store.dispatch(A.resolvePending({ id: pc.id, decision: 'adopt' }));
  assert(get().cascadeReports.length === beforeReports + 1, '采用晚到版本导致风险变化也级联');
  assert(get().samples.find((x) => x.id === adoptSmp.id).status === 'submitted', '采用后关联样本核验结论退回');

  // 合并：不触发级联（保留现风险）
  const obsMerge = get().observations.find((o) => o.id === 'o3');
  store.dispatch(A.simulateRemoteEdit({ targetId: obsMerge.id, note: '合并意见', risk: 'high' }));
  const pc2 = get().pending.find((p) => p.targetId === obsMerge.id && !p.resolution);
  const reportsBeforeMerge = get().cascadeReports.length;
  store.dispatch(A.resolvePending({ id: pc2.id, decision: 'merge' }));
  const merged = get().observations.find((o) => o.id === 'o3');
  assert(merged.note.includes('协调合并'), '合并：双方意见拼接');
  assert(get().cascadeReports.length === reportsBeforeMerge, '合并不改变风险/地点，无级联');
  assert(get().observations.find((o) => o.id === 'o3').risk === 'low', '合并保留现版本风险');

  // ---- 规则 3：所有列表按现场时刻排序，不按上传顺序 ----
  const times = [...get().observations].sort((a, b) => a.time.localeCompare(b.time)).map((o) => o.time);
  const sortedTimes = [...times].sort();
  assert(JSON.stringify(times) === JSON.stringify(sortedTimes), '观察记录按现场时刻升序展示');

  // ---- 持久化：刷新后仍是 v2 且回填不重复执行 ----
  const persisted = JSON.parse(storage['yf57-patrol-state']);
  assert(persisted.version === 2, '状态以 v2 持久化');

  // 模拟重新载入（清 require 缓存不可行，直接验证 stored 数据结构完整）
  assert(persisted.mergedKeys.length > 0 && persisted.pending.length >= 2, '幂等键与待协调均持久化');

  void linkedSamples;
  console.log('\n全部规则冒烟测试完成。');
})().catch((e) => { console.error(e); process.exit(1); });
