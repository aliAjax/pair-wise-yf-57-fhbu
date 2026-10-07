// 离线巡护数据的纯逻辑引擎：现场时刻排序、并发修改另存待协调、失效退回、幂等重试、按最近轨迹点回填。

export type Risk = 'low' | 'medium' | 'high';
export type SyncState = 'local' | 'queued' | 'synced' | 'conflict';
export type SampleStatus = 'draft' | 'submitted' | 'verified' | 'pending_confirmation';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface Observation {
  id: string;
  code: string; // 编号
  time: string; // 现场时刻
  note: string;
  risk: Risk;
  location?: GeoPoint;
  locationId?: string; // 关联的最近轨迹点
  sync: SyncState;
  reviewed: boolean; // 复核结论
  reviewNote?: string;
  version: number; // 由现场时刻决定，用于排序与并发判定
  origin: string; // 来源设备/队友
  pendingCoordination: boolean; // 晚到版本另存待协调
  conflictOf?: string; // 另存时指向的原记录
  migrated?: boolean;
}

export interface TrackPoint {
  id: string;
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
  origin: string;
  synced: boolean;
}

export interface Sample {
  id: string;
  code: string;
  species: string;
  count: number;
  status: SampleStatus;
  observationId?: string;
  origin: string;
  synced: boolean;
}

export type ItemType = 'observation' | 'point' | 'sample';

export interface SyncItem {
  clientId: string; // 幂等键：同一条记录的同一版本重复回传时相同
  type: ItemType;
  payload: Observation | TrackPoint | Sample;
}

export interface ItemResult {
  clientId: string;
  type: ItemType;
  status: 'merged' | 'skipped' | 'conflict';
  message: string;
}

export interface SyncBatch {
  batchId: string;
  createdAt: string;
  items: SyncItem[];
  mergedClientIds: string[]; // 已合入的项，重试只补没合完的
  results: ItemResult[];
  status: 'partial' | 'done';
  attempt: number;
}

export interface PatrolState {
  deviceId: string;
  observations: Observation[];
  points: TrackPoint[];
  samples: Sample[];
  remoteInbox: Observation[]; // 队友并发修改，待同步合并
  batches: SyncBatch[];
  activeBatchId: string | null;
  notice: string | null; // 提示横幅（升级、重复回传等）
  conflict: string | null; // 冲突/中断横幅
  coordination: string[]; // 待协调记录 id
  lastSyncAt: string | null;
  migrated: boolean;
}

export function timeMs(t: string): number {
  if (!t) return 0;
  const n = Date.parse(t.replace(' ', 'T'));
  return Number.isFinite(n) ? n : 0;
}

export function formatFieldTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function observationKey(id: string, version: number): string {
  return `observation:${id}:${version}`;
}
export function pointKey(id: string): string {
  return `point:${id}`;
}
export function sampleKey(id: string): string {
  return `sample:${id}`;
}

export function sortByFieldTime<T extends { time: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => timeMs(b.time) - timeMs(a.time));
}

// 按最近轨迹点回填：取现场时刻最接近的轨迹点
export function nearestPoint(points: TrackPoint[], at: string): TrackPoint | null {
  if (!points.length) return null;
  const target = timeMs(at);
  let best: TrackPoint | null = null;
  let bestDiff = Infinity;
  for (const p of points) {
    const diff = Math.abs(timeMs(p.at) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return best;
}

// 旧数据升级：缺编号或缺少位置关联的记录，按最近轨迹点回填编号与位置
export function migrateObservations(
  observations: Observation[],
  points: TrackPoint[]
): { observations: Observation[]; migratedCount: number; filledCodes: number } {
  let migratedCount = 0;
  let filledCodes = 0;
  const next = observations.map((o, idx) => {
    const copy = { ...o };
    let changed = false;
    const legacy = !copy.code || !copy.locationId;
    if (legacy) {
      const np = nearestPoint(points, copy.time);
      if (np) {
        if (!copy.locationId) {
          copy.locationId = np.id;
          changed = true;
        }
        if (!copy.location) {
          copy.location = { latitude: np.latitude, longitude: np.longitude };
          changed = true;
        }
      }
      if (!copy.code) {
        copy.code = `WD-0929-${String(idx + 1).padStart(2, '0')}`;
        filledCodes++;
        changed = true;
      }
      if (changed) {
        copy.migrated = true;
        migratedCount++;
      }
    }
    return copy;
  });
  return { observations: next, migratedCount, filledCodes };
}

// 失效退回：观察记录地点或风险一变，样本核验与复核结论立即失效；已送检样本只标待确认
export function invalidateForObservation(
  observations: Observation[],
  samples: Sample[],
  obsId: string
): { observations: Observation[]; samples: Sample[] } {
  const nextObs = observations.map((o) =>
    o.id === obsId ? { ...o, reviewed: false, reviewNote: undefined } : o
  );
  const nextSamples = samples.map((s) => {
    if (s.observationId !== obsId) return s;
    if (s.status === 'submitted' || s.status === 'pending_confirmation') {
      return { ...s, status: 'pending_confirmation' as SampleStatus };
    }
    return { ...s, status: 'draft' as SampleStatus };
  });
  return { observations: nextObs, samples: nextSamples };
}

function mergeObservation(
  observations: Observation[],
  points: TrackPoint[],
  samples: Sample[],
  incoming: Observation
): { observations: Observation[]; samples: Sample[]; addedCoordination: string[]; result: ItemResult } {
  const clientId = observationKey(incoming.id, incoming.version);
  const idx = observations.findIndex((o) => o.id === incoming.id);
  if (idx === -1) {
    const copy: Observation = { ...incoming, sync: 'synced', version: incoming.version || timeMs(incoming.time) };
    if (!copy.locationId) {
      const np = nearestPoint(points, copy.time);
      if (np) {
        copy.locationId = np.id;
        copy.location = { latitude: np.latitude, longitude: np.longitude };
      }
    }
    return {
      observations: [...observations, copy],
      samples,
      addedCoordination: [],
      result: { clientId, type: 'observation', status: 'merged', message: '观察记录已合并' },
    };
  }
  const existing = observations[idx];
  const incomingVer = incoming.version || timeMs(incoming.time);
  const existingVer = existing.version || timeMs(existing.time);

  if (existing.origin === incoming.origin) {
    if (incomingVer > existingVer) {
      const updated: Observation = { ...existing, ...incoming, sync: existing.sync, version: incomingVer };
      let nextObs = observations.slice();
      nextObs[idx] = updated;
      let nextSamples = samples;
      const changed = existing.risk !== updated.risk || existing.locationId !== updated.locationId;
      if (changed) {
        const inv = invalidateForObservation(nextObs, nextSamples, existing.id);
        nextObs = inv.observations;
        nextSamples = inv.samples;
      }
      return {
        observations: nextObs,
        samples: nextSamples,
        addedCoordination: [],
        result: { clientId, type: 'observation', status: 'merged', message: '已按现场时刻更新为最新版本' },
      };
    }
    return {
      observations,
      samples,
      addedCoordination: [],
      result: { clientId, type: 'observation', status: 'skipped', message: '同一记录重复回传，未重复入库' },
    };
  }

  // 不同来源（队友）并发修改：晚到的另存待协调，不按上传顺序覆盖
  if (incomingVer > existingVer) {
    const savedId = `${incoming.id}#${incoming.origin}`;
    if (observations.some((o) => o.id === savedId)) {
      return {
        observations,
        samples,
        addedCoordination: [],
        result: { clientId, type: 'observation', status: 'skipped', message: '该协调版本已存在，跳过' },
      };
    }
    const saved: Observation = {
      ...incoming,
      id: savedId,
      code: incoming.code || existing.code,
      sync: 'conflict',
      pendingCoordination: true,
      conflictOf: existing.id,
      version: incomingVer,
    };
    return {
      observations: [...observations, saved],
      samples,
      addedCoordination: [savedId],
      result: { clientId, type: 'observation', status: 'conflict', message: '两人修改同一条，晚到版本已另存待协调' },
    };
  }
  return {
    observations,
    samples,
    addedCoordination: [],
    result: { clientId, type: 'observation', status: 'skipped', message: '旧于现场最新版本，未覆盖' },
  };
}

export interface MergeOutcome {
  observations: Observation[];
  points: TrackPoint[];
  samples: Sample[];
  remoteInbox: Observation[];
  mergedClientIds: string[];
  results: ItemResult[];
  coordination: string[];
  processedCount: number;
  pendingCount: number;
  dropped: boolean;
}

export function mergeBatch(state: PatrolState, batch: SyncBatch, dropPoint: number): MergeOutcome {
  let observations = [...state.observations];
  let points = [...state.points];
  let samples = [...state.samples];
  let remoteInbox = [...state.remoteInbox];
  let coordination = [...state.coordination];
  const mergedClientIds = [...batch.mergedClientIds];
  const results: ItemResult[] = [...batch.results];

  const pending = batch.items.filter((it) => !mergedClientIds.includes(it.clientId));
  const toProcess = pending.slice(0, dropPoint);

  for (const item of toProcess) {
    const payload = item.payload;
    if (item.type === 'observation') {
      if (payload.origin === state.deviceId) {
        // 本机记录：上传后标记已同步，不重复插入
        observations = observations.map((o) => (o.id === payload.id ? { ...o, sync: 'synced' as SyncState } : o));
        results.push({ clientId: item.clientId, type: 'observation', status: 'merged', message: '本机记录已上传' });
      } else {
        const res = mergeObservation(observations, points, samples, payload as Observation);
        observations = res.observations;
        samples = res.samples;
        coordination = coordination.concat(res.addedCoordination);
        results.push(res.result);
        remoteInbox = remoteInbox.filter(
          (o) => !(o.id === payload.id && o.origin === payload.origin && o.version === (payload as Observation).version)
        );
      }
      mergedClientIds.push(item.clientId);
    } else if (item.type === 'point') {
      const p = payload as TrackPoint;
      if (p.origin === state.deviceId) {
        points = points.map((x) => (x.id === p.id ? { ...x, synced: true } : x));
        results.push({ clientId: item.clientId, type: 'point', status: 'merged', message: '轨迹点已上传' });
      } else if (points.some((x) => x.id === p.id)) {
        results.push({ clientId: item.clientId, type: 'point', status: 'skipped', message: '轨迹点已存在，跳过重复回传' });
      } else {
        points.push({ ...p, synced: true });
        results.push({ clientId: item.clientId, type: 'point', status: 'merged', message: '轨迹点已合并' });
      }
      mergedClientIds.push(item.clientId);
    } else if (item.type === 'sample') {
      const s = payload as Sample;
      if (s.origin === state.deviceId) {
        samples = samples.map((x) => (x.id === s.id ? { ...x, synced: true } : x));
        results.push({ clientId: item.clientId, type: 'sample', status: 'merged', message: '样本已上传' });
      } else if (samples.some((x) => x.id === s.id)) {
        results.push({ clientId: item.clientId, type: 'sample', status: 'skipped', message: '样本已存在，跳过重复回传' });
      } else {
        samples.push({ ...s, synced: true });
        results.push({ clientId: item.clientId, type: 'sample', status: 'merged', message: '样本已合并' });
      }
      mergedClientIds.push(item.clientId);
    }
  }

  const dropped = toProcess.length < pending.length;
  return {
    observations,
    points,
    samples,
    remoteInbox,
    mergedClientIds,
    results,
    coordination,
    processedCount: toProcess.length,
    pendingCount: pending.length,
    dropped,
  };
}

export function buildBatch(state: PatrolState): SyncBatch {
  const items: SyncItem[] = [];
  for (const o of state.observations) {
    if (o.sync === 'queued' || o.sync === 'local') {
      items.push({ clientId: observationKey(o.id, o.version), type: 'observation', payload: o });
    }
  }
  for (const p of state.points) {
    if (!p.synced) items.push({ clientId: pointKey(p.id), type: 'point', payload: p });
  }
  for (const s of state.samples) {
    if (!s.synced) items.push({ clientId: sampleKey(s.id), type: 'sample', payload: s });
  }
  for (const o of state.remoteInbox) {
    items.push({ clientId: observationKey(o.id, o.version), type: 'observation', payload: o });
  }
  return {
    batchId: `batch-${Date.now()}`,
    createdAt: new Date().toISOString(),
    items,
    mergedClientIds: [],
    results: [],
    status: 'partial',
    attempt: 0,
  };
}

// 首次弱网：至少留 1 项未合；重试时全部合入
export function dropPointFor(pendingCount: number, attempt: number): number {
  if (pendingCount === 0) return 0;
  if (attempt <= 1) return Math.max(1, pendingCount - 1);
  return pendingCount;
}
