import assert from 'node:assert';
import {
  buildBatch,
  dropPointFor,
  invalidateForObservation,
  mergeBatch,
  migrateObservations,
  nearestPoint,
  timeMs,
  type Observation,
  type PatrolState,
  type Sample,
  type TrackPoint,
} from './engine';

function makeState(): PatrolState {
  const points: TrackPoint[] = [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '2026-09-29 07:20', source: 'gps', origin: 'seed', synced: true },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '2026-09-29 08:05', source: 'gps', origin: 'seed', synced: true },
  ];
  const observations: Observation[] = [
    { id: 'o1', code: '', time: '2026-09-29 07:20', note: '足迹', risk: 'medium', sync: 'synced', reviewed: false, version: timeMs('2026-09-29 07:20'), origin: 'seed', pendingCoordination: false },
    { id: 'o2', code: '', time: '2026-09-29 08:05', note: '相机松动', risk: 'high', sync: 'synced', reviewed: false, version: timeMs('2026-09-29 08:05'), origin: 'seed', pendingCoordination: false },
    { id: 'o3', code: '', time: '2026-09-29 08:40', note: '样线正常', risk: 'low', sync: 'synced', reviewed: true, version: timeMs('2026-09-29 08:40'), origin: 'seed', pendingCoordination: false },
  ];
  const samples: Sample[] = [
    { id: 's1', code: 'WD-01', species: '毛发', count: 1, status: 'submitted', origin: 'seed', synced: true, observationId: 'o2' },
    { id: 's2', code: 'WD-02', species: '粪便', count: 2, status: 'verified', origin: 'seed', synced: true, observationId: 'o1' },
  ];
  return {
    deviceId: 'dev-local',
    observations,
    points,
    samples,
    remoteInbox: [],
    batches: [],
    activeBatchId: null,
    notice: null,
    conflict: null,
    coordination: [],
    lastSyncAt: null,
    migrated: false,
  };
}

// 1. 最近轨迹点回填
{
  const s = makeState();
  const np = nearestPoint(s.points, '2026-09-29 08:40');
  assert.equal(np?.id, 'p2', '08:40 应回填最近轨迹点 p2');
  const m = migrateObservations(s.observations, s.points);
  assert.equal(m.migratedCount, 3, '3 条旧记录应升级');
  assert.equal(m.filledCodes, 3, '3 条应补编号');
  assert.equal(m.observations[0].locationId, 'p1', 'o1 回填 p1');
  assert.equal(m.observations[1].locationId, 'p2', 'o2 回填 p2');
  assert.equal(m.observations[2].locationId, 'p2', 'o3 回填 p2（最近）');
  assert.ok(m.observations[0].code.startsWith('WD-0929-'), '编号已生成');
  console.log('✓ 最近轨迹点回填');
}

// 2. 并发修改：晚到另存待协调，不覆盖原记录
{
  const s = makeState();
  s.remoteInbox = [
    { id: 'o2', code: '', time: '2026-09-29 09:10', note: '队友加固', risk: 'low', sync: 'queued', reviewed: false, version: timeMs('2026-09-29 09:10'), origin: 'teammate', pendingCoordination: false },
  ];
  const batch = buildBatch(s);
  assert.equal(batch.items.length, 1, '批次含 1 项队友修改');
  const outcome = mergeBatch(s, batch, dropPointFor(batch.items.length, 2));
  assert.equal(outcome.dropped, false, '第2次尝试应全部合入');
  const saved = outcome.observations.find((o) => o.id === 'o2#teammate');
  assert.ok(saved, '晚到版本应另存为 o2#teammate');
  assert.equal(saved?.pendingCoordination, true, '标记待协调');
  assert.equal(saved?.conflictOf, 'o2', '指向原记录');
  assert.equal(outcome.observations.find((o) => o.id === 'o2')?.risk, 'high', '原记录不被覆盖');
  assert.equal(outcome.coordination.length, 1, '待协调列表 1 条');
  console.log('✓ 并发修改另存待协调');
}

// 3. 失效退回：风险变更 → 样本核验失效；已送检只标待确认
{
  const s = makeState();
  const inv = invalidateForObservation(s.observations, s.samples, 'o2');
  const s1 = inv.samples.find((x) => x.id === 's1');
  assert.equal(s1?.status, 'pending_confirmation', '已送检样本只标待确认');
  const o2 = inv.observations.find((o) => o.id === 'o2');
  assert.equal(o2?.reviewed, false, '复核结论失效退回');
  const inv2 = invalidateForObservation(s.observations, s.samples, 'o1');
  const s2 = inv2.samples.find((x) => x.id === 's2');
  assert.equal(s2?.status, 'draft', '已核验样本退回草稿');
  console.log('✓ 失效退回（已送检→待确认，已核验→草稿）');
}

// 4. 幂等重试：首次弱网只合一部分，重试只补没合完的
{
  const s = makeState();
  s.remoteInbox = [
    { id: 'o2', code: '', time: '2026-09-29 09:10', note: '队友1', risk: 'low', sync: 'queued', reviewed: false, version: timeMs('2026-09-29 09:10'), origin: 'teammate', pendingCoordination: false },
    { id: 'o3', code: '', time: '2026-09-29 09:20', note: '队友2', risk: 'medium', sync: 'queued', reviewed: false, version: timeMs('2026-09-29 09:20'), origin: 'teammate', pendingCoordination: false },
  ];
  const batch = buildBatch(s);
  assert.equal(batch.items.length, 2);
  const first = mergeBatch(s, batch, dropPointFor(batch.items.length, 1));
  assert.equal(first.dropped, true, '首次弱网应中断');
  assert.equal(first.processedCount, 1, '首次只合 1 项');
  assert.equal(first.mergedClientIds.length, 1, '只记录 1 项已合入');
  // 重试：只补没合完的
  const second = mergeBatch({ ...s, observations: first.observations, remoteInbox: first.remoteInbox, coordination: first.coordination }, batch, dropPointFor(batch.items.length, 2));
  assert.equal(second.dropped, false, '重试应完成');
  assert.equal(second.mergedClientIds.length, 2, '2 项都已合入');
  assert.equal(second.results.filter((r) => r.status === 'conflict').length, 1, '重试只处理剩余 1 项并触发冲突');
  console.log('✓ 幂等重试（只补没合完的项）');
}

// 5. 重复回传不重复入库
{
  const s = makeState();
  s.remoteInbox = [
    { id: 'o2', code: '', time: '2026-09-29 09:10', note: '队友', risk: 'low', sync: 'queued', reviewed: false, version: timeMs('2026-09-29 09:10'), origin: 'teammate', pendingCoordination: false },
  ];
  const batch = buildBatch(s);
  const first = mergeBatch(s, batch, dropPointFor(batch.items.length, 2));
  const countAfterFirst = first.observations.length;
  // 重复回传同一批：mergedClientIds 中的项全部跳过
  const replay = mergeBatch({ ...s, observations: first.observations, remoteInbox: first.remoteInbox, coordination: first.coordination }, batch, 0);
  assert.equal(replay.observations.length, countAfterFirst, '重复回传不新增记录');
  assert.equal(replay.results.length, 0, 'dropPoint=0 不处理新项');
  console.log('✓ 重复回传不重复入库');
}

// 6. 现场时刻排序
{
  const s = makeState();
  const sorted = [...s.observations].sort((a, b) => timeMs(b.time) - timeMs(a.time));
  assert.equal(sorted[0].id, 'o3', '最新时刻排最前');
  assert.equal(sorted[2].id, 'o1', '最旧时刻排最后');
  console.log('✓ 按现场时刻排序');
}

console.log('\n全部逻辑测试通过');
