import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';
import {
  buildBatch,
  dropPointFor,
  formatFieldTime,
  invalidateForObservation,
  mergeBatch,
  migrateObservations,
  nearestPoint,
  timeMs,
  type Observation,
  type PatrolState,
  type Risk,
  type Sample,
  type SyncBatch,
  type TrackPoint,
} from './engine';

export type { PatrolState, Observation, TrackPoint, Sample, Risk, SampleStatus, SyncState, SyncBatch, ItemResult } from './engine';
export { sortByFieldTime } from './engine';

const STORAGE_KEY = 'yf57-patrol-state';
const DEVICE_KEY = 'yf57-device-id';

function makeDeviceId(): string {
  let id = '';
  try {
    id = Taro.getStorageSync(DEVICE_KEY) || '';
  } catch {
    /* ignore */
  }
  if (!id) {
    id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      Taro.setStorageSync(DEVICE_KEY, id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

function seedState(deviceId: string): PatrolState {
  const observations: Observation[] = [
    { id: 'o1', code: '', time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: false, version: timeMs('2026-09-29 07:20'), origin: 'seed', pendingCoordination: false },
    { id: 'o2', code: '', time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'synced', reviewed: false, version: timeMs('2026-09-29 08:05'), origin: 'seed', pendingCoordination: false },
    { id: 'o3', code: '', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', sync: 'synced', reviewed: true, version: timeMs('2026-09-29 08:40'), origin: 'seed', pendingCoordination: false },
  ];
  const points: TrackPoint[] = [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '2026-09-29 07:20', source: 'gps', origin: 'seed', synced: true },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '2026-09-29 08:05', source: 'gps', origin: 'seed', synced: true },
  ];
  const samples: Sample[] = [
    { id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted', origin: 'seed', synced: true, observationId: 'o2' },
  ];
  // 队友并发修改：晚到的另存待协调
  const remoteInbox: Observation[] = [
    { id: 'o2', code: '', time: '2026-09-29 09:10', note: '红外相机已自行加固，风险下调', risk: 'low', sync: 'queued', reviewed: false, version: timeMs('2026-09-29 09:10'), origin: 'teammate', pendingCoordination: false },
    { id: 'o3', code: '', time: '2026-09-29 09:20', note: '样线南段发现零星兽径，风险上调', risk: 'medium', sync: 'queued', reviewed: false, version: timeMs('2026-09-29 09:20'), origin: 'teammate', pendingCoordination: false },
  ];
  return {
    deviceId,
    observations,
    points,
    samples,
    remoteInbox,
    batches: [],
    activeBatchId: null,
    notice: null,
    conflict: null,
    coordination: [],
    lastSyncAt: null,
    migrated: false,
  };
}

function applyMigration(state: PatrolState): PatrolState {
  if (state.migrated) return state;
  const m = migrateObservations(state.observations, state.points);
  const next: PatrolState = { ...state, observations: m.observations, migrated: true };
  if (m.migratedCount > 0) {
    next.notice = `已升级旧数据：按最近轨迹点回填 ${m.migratedCount} 条记录的编号与位置。`;
  }
  return next;
}

function loadState(): PatrolState {
  const deviceId = makeDeviceId();
  const seed = seedState(deviceId);
  try {
    const saved = Taro.getStorageSync(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<PatrolState>;
      const merged: PatrolState = { ...seed, ...parsed, deviceId };
      return applyMigration(merged);
    }
  } catch {
    /* ignore */
  }
  return applyMigration(seed);
}

function applyOutcome(state: PatrolState, batch: SyncBatch, outcome: ReturnType<typeof mergeBatch>) {
  state.observations = outcome.observations;
  state.points = outcome.points;
  state.samples = outcome.samples;
  state.remoteInbox = outcome.remoteInbox;
  state.coordination = outcome.coordination;
  batch.mergedClientIds = outcome.mergedClientIds;
  batch.results = outcome.results;
  batch.attempt += 1;
  const exists = state.batches.some((b) => b.batchId === batch.batchId);
  if (!exists) state.batches = [batch, ...state.batches];
  state.activeBatchId = batch.batchId;
  if (outcome.dropped) {
    batch.status = 'partial';
    state.conflict = `同步中断（模拟弱网）：已合并 ${outcome.processedCount}/${outcome.pendingCount} 项，可重试未完成项。`;
  } else {
    batch.status = 'done';
    const newConflicts = outcome.results.filter((r) => r.status === 'conflict').length;
    state.conflict = newConflicts > 0 ? `同步完成：${newConflicts} 条记录因两人修改同一条已另存待协调，不按上传顺序覆盖。` : null;
  }
  state.lastSyncAt = new Date().toISOString();
}

const slice = createSlice({
  name: 'patrol',
  initialState: loadState(),
  reducers: {
    addObservation: (state, action: PayloadAction<{ note: string; risk: Risk }>) => {
      const now = new Date();
      const time = formatFieldTime(now);
      state.observations.unshift({
        id: `o-${now.getTime()}`,
        code: '',
        time,
        note: action.payload.note,
        risk: action.payload.risk,
        sync: 'queued',
        reviewed: false,
        version: timeMs(time),
        origin: state.deviceId,
        pendingCoordination: false,
      });
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      state.points.push({
        id: `p-${Date.now()}`,
        latitude: action.payload.latitude,
        longitude: action.payload.longitude,
        at: formatFieldTime(new Date()),
        source: 'gps',
        origin: state.deviceId,
        synced: false,
      });
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number; observationId?: string }>) => {
      state.samples.unshift({
        id: `s-${Date.now()}`,
        code: action.payload.code,
        species: action.payload.species,
        count: action.payload.count,
        status: 'draft',
        observationId: action.payload.observationId,
        origin: state.deviceId,
        synced: false,
      });
    },
    editObservationRisk: (state, action: PayloadAction<{ id: string; risk: Risk }>) => {
      const obs = state.observations.find((o) => o.id === action.payload.id);
      if (!obs || obs.risk === action.payload.risk) return;
      obs.risk = action.payload.risk;
      const inv = invalidateForObservation(state.observations, state.samples, obs.id);
      state.observations = inv.observations;
      state.samples = inv.samples;
      state.notice = '风险等级已变更：样本核验与复核结论立即失效退回；已送检样本只标待确认。';
    },
    relinkObservationLocation: (state, action: PayloadAction<string>) => {
      const obs = state.observations.find((o) => o.id === action.payload);
      if (!obs) return;
      const np = nearestPoint(state.points, obs.time);
      if (!np) return;
      const changed = obs.locationId !== np.id;
      obs.locationId = np.id;
      obs.location = { latitude: np.latitude, longitude: np.longitude };
      if (changed) {
        const inv = invalidateForObservation(state.observations, state.samples, obs.id);
        state.observations = inv.observations;
        state.samples = inv.samples;
        state.notice = '地点已按最近轨迹点重新回填：样本核验与复核结论立即失效退回。';
      }
    },
    submitSample: (state, action: PayloadAction<string>) => {
      const s = state.samples.find((x) => x.id === action.payload);
      if (s && s.status === 'draft') s.status = 'submitted';
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const s = state.samples.find((x) => x.id === action.payload);
      if (s && s.status === 'draft') s.status = 'verified';
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const obs = state.observations.find((o) => o.id === action.payload);
      if (obs) obs.reviewed = true;
    },
    syncQueue: (state) => {
      const active = state.batches.find((b) => b.batchId === state.activeBatchId);
      if (active && active.status === 'partial') {
        // 有未完成批次，先补没合完的项
        active.attempt += 1;
        const outcome = mergeBatch(state, active, dropPointFor(active.items.length, active.attempt));
        applyOutcome(state, active, outcome);
        return;
      }
      const batch = buildBatch(state);
      if (batch.items.length === 0) {
        state.notice = '没有待同步项。';
        return;
      }
      batch.attempt = 1;
      const outcome = mergeBatch(state, batch, dropPointFor(batch.items.length, 1));
      applyOutcome(state, batch, outcome);
    },
    retryBatch: (state) => {
      const batch = state.batches.find((b) => b.batchId === state.activeBatchId);
      if (!batch || batch.status !== 'partial') return;
      batch.attempt += 1;
      const outcome = mergeBatch(state, batch, dropPointFor(batch.items.length, batch.attempt));
      applyOutcome(state, batch, outcome);
    },
    reuploadBatch: (state) => {
      const batch = state.batches.find((b) => b.batchId === state.activeBatchId);
      if (!batch) return;
      const already = batch.items.filter((it) => batch.mergedClientIds.includes(it.clientId));
      state.notice = `重复回传本批：${already.length} 项均已合入，无新增入库。`;
    },
    resolveCoordination: (state, action: PayloadAction<string>) => {
      const id = action.payload;
      state.coordination = state.coordination.filter((c) => c !== id);
      const obs = state.observations.find((o) => o.id === id);
      if (obs) {
        obs.pendingCoordination = false;
        obs.sync = 'synced';
      }
      if (state.coordination.length === 0) state.conflict = null;
    },
    simulateRemoteEdit: (state) => {
      const target = state.observations.find(
        (o) => o.origin === 'seed' && !state.remoteInbox.some((r) => r.id === o.id)
      );
      if (!target) {
        state.notice = '没有可模拟的记录。';
        return;
      }
      const risks: Risk[] = ['low', 'medium', 'high'];
      const nextRisk = risks[(risks.indexOf(target.risk) + 1) % risks.length];
      const time = formatFieldTime(new Date(timeMs(target.time) + 3600000));
      const edit: Observation = {
        ...target,
        id: target.id,
        code: '',
        time,
        risk: nextRisk,
        note: `队友并发修改：${target.note}`,
        version: timeMs(time),
        origin: 'teammate',
        sync: 'queued',
        pendingCoordination: false,
      };
      state.remoteInbox.push(edit);
      state.notice = `已模拟队友对 ${target.id} 的并发修改，下次同步将触发另存待协调。`;
    },
    dismissNotice: (state) => {
      state.notice = null;
    },
    dismissConflict: (state) => {
      state.conflict = null;
    },
  },
});

export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }),
  }),
});
export const { useConnectionQuery } = patrolApi;
export const {
  addObservation,
  addPoint,
  addSample,
  editObservationRisk,
  relinkObservationLocation,
  submitSample,
  verifySample,
  reviewObservation,
  syncQueue,
  retryBatch,
  reuploadBatch,
  resolveCoordination,
  simulateRemoteEdit,
  dismissNotice,
  dismissConflict,
} = slice.actions;

export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware),
});
store.subscribe(() => {
  try {
    Taro.setStorageSync(STORAGE_KEY, JSON.stringify(store.getState().patrol));
  } catch {
    /* ignore */
  }
});

export type RootState = ReturnType<typeof store.getState>;
