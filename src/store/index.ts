import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';

/* 业务对象 */
export type Risk = 'low' | 'medium' | 'high';
export type SyncState = 'local' | 'queued' | 'synced' | 'failed';
/** 样本：draft 草稿 / submitted 已提交待核验 / lab 已送检 / verified 已核验 / pending_confirm 待确认 / returned 退回重做 */
export type SampleStatus = 'draft' | 'submitted' | 'lab' | 'verified' | 'pending_confirm' | 'returned';

export interface GeoPoint { latitude: number; longitude: number; }

export interface PatrolObservation {
  id: string;
  clientId: string;
  rev: number;                    // 内容版本：每次现场修改 +1，幂等键按 clientId+rev
  code?: string;                 // 记录编号，旧数据升级时回填
  time: string;                  // 现场时刻（排序与归并的唯一依据）
  updatedAt: string;
  note: string;
  risk: Risk;
  location?: GeoPoint;           // 记录地点，旧数据按最近轨迹点回填
  sync: SyncState;
  reviewed: boolean;
  reviewInvalid?: boolean;       // 地点/风险变更导致复核结论失效
}

export interface TrackPoint {
  id: string;
  clientId: string;
  rev: number;
  time: string;                  // 现场时刻，与观察记录同口径
  latitude: number;
  longitude: number;
  source: 'gps' | 'manual';
  sync: SyncState;
}

export interface Sample {
  id: string;
  clientId: string;
  rev: number;
  code?: string;
  species: string;
  count: number;
  status: SampleStatus;
  observationId?: string;
  sync: SyncState;
}

/** 晚到的另一条修改：不覆盖已入库版本，统一进待协调 */
export interface PendingCoordination {
  id: string;
  targetType: 'observation';
  targetId: string;
  targetCode?: string;
  incoming: { note: string; risk: Risk; location?: GeoPoint };
  fieldTime: string;             // 现场时刻（原记录的）
  arrivedAt: string;             // 到达站点的时刻
  stale: boolean;                // 已有更新的待协调版本，本条为更旧的迟到版本
  resolution?: 'kept' | 'adopted' | 'merged';
}

export interface CascadeReport {
  observationCode: string;
  reviewCleared: boolean;
  samples: { code?: string; species: string; from: SampleStatus; to: SampleStatus; reason: 'lab_pending' | 'recheck' }[];
  at: string;
}

interface State {
  version: number;
  online: boolean;
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  pending: PendingCoordination[];
  mergedKeys: string[];          // 已入库（已合并）项的幂等键，重复回传直接跳过
  cascadeReports: CascadeReport[];
  backfilled: { observations: number; points: number; samples: number };
  lastSync: string | null;
  syncNotice: string | null;
}

/** 升级前的旧格式：记录无编号、无地点，轨迹点无 time/sync，样本无 code/sync */
interface LegacyV1 {
  observations: { id: string; time: string; note: string; risk: Risk; sync?: string; reviewed?: boolean }[];
  points: { id: string; latitude: number; longitude: number; at?: string; source?: 'gps' | 'manual' }[];
  samples: { id: string; code?: string; species: string; count: number; status?: SampleStatus }[];
  conflict?: string | null;
}

/* ---------- 工具 ---------- */
const pad = (n: number) => String(n).padStart(2, '0');

const now = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const dayKeyOf = () => now().slice(0, 10);
const codeDay = (dayKey: string) => dayKey.slice(5).replace('-', ''); // MMDD

/** 取现场时刻中的“当日分钟数”，跨格式（YYYY-MM-DD HH:mm / HH:mm）可比 */
function minutesOfDay(raw: string): number {
  const m = /(\d{1,2}):(\d{2})/.exec(raw);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** 现场时刻排序：升序，解析失败的排最后，绝不按上传顺序 */
export function fieldTimeCmp(a: { time: string }, b: { time: string }) {
  const ta = Date.parse(a.time.replace(/-/g, '/'));
  const tb = Date.parse(b.time.replace(/-/g, '/'));
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return ta - tb;
}

function nearestPoint(obsTime: string, points: TrackPoint[]): GeoPoint | undefined {
  const target = minutesOfDay(obsTime);
  let best: TrackPoint | undefined;
  let bestGap = Infinity;
  for (const p of points) {
    const gap = Math.abs(minutesOfDay(p.time) - target);
    if (Number.isNaN(gap)) continue;
    if (gap < bestGap) { bestGap = gap; best = p; }
  }
  return best ? { latitude: best.latitude, longitude: best.longitude } : undefined;
}

const emptyBackfill = { observations: 0, points: 0, samples: 0 };

/* ---------- 旧数据升级（v1 -> v2）：缺编号、缺地点按最近轨迹点回填 ---------- */
function migrate(raw: unknown): State {
  const legacy = raw as Partial<LegacyV1 & State>;

  const observations: PatrolObservation[] = (legacy.observations ?? []).map((o) => ({
    id: o.id,
    clientId: (o as PatrolObservation).clientId ?? o.id,
    rev: (o as PatrolObservation).rev ?? 1,
    code: (o as PatrolObservation).code,
    time: o.time,
    updatedAt: (o as PatrolObservation).updatedAt ?? o.time,
    note: o.note,
    risk: o.risk,
    location: (o as PatrolObservation).location,
    // 旧版的“冲突中”状态升级后重新进队列协调，不自动选边
    sync: ((o as { sync?: string }).sync === 'conflict' ? 'queued' : ((o as PatrolObservation).sync ?? 'local')) as SyncState,
    reviewed: o.reviewed ?? false,
    reviewInvalid: false
  }));

  const points: TrackPoint[] = (legacy.points ?? []).map((p) => ({
    id: p.id,
    clientId: (p as TrackPoint).clientId ?? p.id,
    rev: (p as TrackPoint).rev ?? 1,
    time: (p as TrackPoint).time ?? `${dayKeyOf()} ${p.at ?? '00:00'}`,
    latitude: p.latitude,
    longitude: p.longitude,
    source: p.source ?? 'gps',
    sync: (p as TrackPoint).sync ?? 'local'
  }));

  const samples: Sample[] = (legacy.samples ?? []).map((s) => ({
    id: s.id,
    clientId: (s as Sample).clientId ?? s.id,
    rev: (s as Sample).rev ?? 1,
    code: s.code,
    species: s.species,
    count: s.count,
    status: s.status ?? 'draft',
    observationId: (s as Sample).observationId,
    sync: (s as Sample).sync ?? 'local'
  }));

  const backfilled = { ...emptyBackfill };
  points.sort(fieldTimeCmp);

  // 旧观察记录：缺地点，按现场时刻最近的轨迹点回填
  for (const o of observations) {
    if (!o.location) {
      const loc = nearestPoint(o.time, points);
      if (loc) { o.location = loc; backfilled.observations += 1; }
    }
  }
  // 旧观察记录：缺编号，按现场时刻顺序统一编号
  observations.sort(fieldTimeCmp);
  let seq = 1;
  for (const o of observations) {
    if (!o.code) {
      o.code = `GC-${codeDay(o.time.slice(0, 10))}-${pad(seq++)}`;
      backfilled.observations += 1;
    }
  }
  // 旧样本：缺编号
  let sseq = 1;
  for (const s of samples) {
    if (!s.code) {
      s.code = `YB-${codeDay(dayKeyOf())}-${pad(sseq++)}`;
      backfilled.samples += 1;
    }
  }
  // 旧样本未挂观察记录的，按顺序挂到已有观察（旧数据无样本时刻，保证级联规则可生效）
  {
    const usedCount = new Map<string, number>();
    for (const x of samples) if (x.observationId) usedCount.set(x.observationId, (usedCount.get(x.observationId) ?? 0) + 1);
    for (const s of samples) {
      if (s.observationId) continue;
      const candidate = observations.find((o) => (usedCount.get(o.id) ?? 0) === 0) ?? observations[observations.length - 1];
      if (candidate) {
        s.observationId = candidate.id;
        usedCount.set(candidate.id, (usedCount.get(candidate.id) ?? 0) + 1);
      }
    }
  }

  return {
    version: 2,
    online: (raw as State).online ?? true,
    observations,
    points,
    samples,
    pending: (raw as State).pending ?? [],
    // 升级前已 synced 的历史数据，视同已入库版本登记幂等键，防止重复回传
    mergedKeys: (raw as State).mergedKeys ?? [
      ...observations.filter((o) => o.sync === 'synced').map((o) => `obs:${o.clientId}@${o.rev}`),
      ...points.filter((p) => p.sync === 'synced').map((p) => `pt:${p.clientId}@${p.rev}`),
      ...samples.filter((x) => x.sync === 'synced').map((x) => `smp:${x.clientId}@${x.rev}`)
    ],
    cascadeReports: (raw as State).cascadeReports ?? [],
    backfilled: (raw as State).backfilled ?? backfilled,
    lastSync: (raw as State).lastSync ?? null,
    syncNotice: null
  };
}

/* 升级演示种子：模拟现场旧版数据——记录无编号无地点、轨迹点只有 HH:MM、样本无编号 */
const seedV1: LegacyV1 = {
  observations: [
    { id: 'o1', time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: true },
    { id: 'o2', time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'queued' },
    { id: 'o3', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', sync: 'queued' }
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' },
    { id: 'p3', latitude: 30.5903, longitude: 103.2258, at: '08:40', source: 'manual' }
  ],
  samples: [
    { id: 's1', species: '疑似豹猫毛发', count: 1, status: 'submitted' },
    { id: 's2', species: '足迹拓印', count: 2, status: 'lab' }
  ],
  conflict: null
};

function readState(): State {
  try {
    const saved = Taro.getStorageSync('yf57-patrol-state');
    if (saved) {
      const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
      if ((parsed as State).version === 2) return { ...(parsed as State), syncNotice: null };
      return migrate(parsed); // 旧版本数据：升级并回填
    }
  } catch { /* 存储不可用时使用种子 */ }
  return migrate(seedV1);
}

/* ---------- 级联：地点或风险等级变更时，样本核验/复核结论立即失效 ---------- */
function cascadeInvalidate(state: State, obs: PatrolObservation) {
  const report: CascadeReport = { observationCode: obs.code ?? obs.id, reviewCleared: false, samples: [], at: now() };
  if (obs.reviewed) { obs.reviewed = false; obs.reviewInvalid = true; report.reviewCleared = true; }
  for (const s of state.samples) {
    if (s.observationId !== obs.id) continue;
    const from = s.status;
    if (s.status === 'lab') {
      s.status = 'pending_confirm'; // 已送检：只标待确认，不退回重做
      s.rev += 1;
      s.sync = 'queued';
      report.samples.push({ code: s.code, species: s.species, from, to: s.status, reason: 'lab_pending' });
    } else if (s.status === 'verified') {
      s.status = 'submitted';      // 已核验结论失效，退回重新核验
      s.rev += 1;
      s.sync = 'queued';
      report.samples.push({ code: s.code, species: s.species, from, to: s.status, reason: 'recheck' });
    }
  }
  if (report.reviewCleared || report.samples.length) state.cascadeReports.unshift(report);
}

/* ---------- 晚到修改归并：另存待协调，绝不按上传顺序覆盖 ---------- */
function parkIncomingObservation(state: State, targetId: string, incoming: PendingCoordination['incoming']) {
  const target = state.observations.find((o) => o.id === targetId || o.clientId === targetId);
  if (!target) return;
  // 同一记录已有未协调版本：更新的来件作为待协调主版本，更早的来件降级为历史（stale），仍保留可查
  for (const p of state.pending) {
    if (p.targetId === target.id && !p.resolution && !p.stale) p.stale = true;
  }
  state.pending.unshift({
    id: uid('pc'), targetType: 'observation', targetId: target.id, targetCode: target.code,
    incoming, fieldTime: target.time, arrivedAt: now(), stale: false
  });
}

const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    toggleOnline: (state) => { state.online = !state.online; state.syncNotice = null; },

    addObservation: (state, action: PayloadAction<{ note: string; risk: Risk; location?: GeoPoint; sample?: { species: string; count: number } }>) => {
      const id = uid('o');
      const time = now();
      const dayKey = dayKeyOf();
      const sameDayCount = state.observations.filter((o) => o.time.startsWith(dayKey)).length;
      const code = `GC-${codeDay(dayKey)}-${pad(sameDayCount + 1)}`;
      const location = action.payload.location ?? nearestPoint(time, state.points);
      state.observations.unshift({
        id, clientId: id, rev: 1, code, time, updatedAt: time, note: action.payload.note,
        risk: action.payload.risk, location, sync: 'queued', reviewed: false
      });
      // 同批登记的样本直接关联本观察：地点/风险变更时即可级联退回
      if (action.payload.sample) {
        const sid = uid('s');
        const n = state.samples.filter((s) => s.code?.startsWith(`YB-${codeDay(dayKey)}`)).length + 1;
        state.samples.unshift({
          id: sid, clientId: sid, rev: 1, code: `YB-${codeDay(dayKey)}-${pad(n)}`,
          species: action.payload.sample.species, count: action.payload.sample.count,
          status: 'draft', observationId: id, sync: 'queued'
        });
      }
    },

    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number; source?: 'gps' | 'manual' }>) => {
      const id = uid('p');
      state.points.push({
        id, clientId: id, rev: 1, time: now(), latitude: action.payload.latitude,
        longitude: action.payload.longitude, source: action.payload.source ?? 'gps', sync: 'queued'
      });
    },

    addSample: (state, action: PayloadAction<{ species: string; count: number; observationId?: string }>) => {
      const id = uid('s');
      const n = state.samples.length + 1;
      state.samples.unshift({
        id, clientId: id, rev: 1, code: `YB-${codeDay(dayKeyOf())}-${pad(n)}`,
        species: action.payload.species, count: action.payload.count,
        status: 'draft', observationId: action.payload.observationId, sync: 'queued'
      });
    },

    /** 编辑观察记录：地点或风险一变即触发级联退回；纯备注变化不会作废核验结论 */
    editObservation: (state, action: PayloadAction<{ id: string; note?: string; risk?: Risk; location?: GeoPoint }>) => {
      const obs = state.observations.find((o) => o.id === action.payload.id);
      if (!obs) return;
      const keyChanged =
        (action.payload.risk !== undefined && action.payload.risk !== obs.risk) ||
        (action.payload.location !== undefined &&
          (!obs.location || obs.location.latitude !== action.payload.location.latitude || obs.location.longitude !== action.payload.location.longitude));
      if (action.payload.note !== undefined) obs.note = action.payload.note;
      if (action.payload.risk !== undefined) obs.risk = action.payload.risk;
      if (action.payload.location !== undefined) obs.location = action.payload.location;
      obs.rev += 1; // 新内容版本：同步幂等键随之变化，可正常补合；旧版本重传仍去重
      obs.updatedAt = now();
      obs.sync = 'queued';
      if (keyChanged) cascadeInvalidate(state, obs);
    },

    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((o) => o.id === action.payload);
      if (item && !item.reviewed) { item.reviewed = true; item.reviewInvalid = false; item.rev += 1; item.sync = 'queued'; }
    },

    submitSample: (state, action: PayloadAction<string>) => {
      const s = state.samples.find((x) => x.id === action.payload);
      if (s && (s.status === 'draft' || s.status === 'returned')) { s.status = 'submitted'; s.rev += 1; s.sync = 'queued'; }
    },
    sendLabSample: (state, action: PayloadAction<string>) => {
      const s = state.samples.find((x) => x.id === action.payload);
      if (s && s.status === 'submitted') { s.status = 'lab'; s.rev += 1; s.sync = 'queued'; }
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const s = state.samples.find((x) => x.id === action.payload);
      if (s && s.status === 'submitted') { s.status = 'verified'; s.rev += 1; s.sync = 'queued'; }
    },

    /**
     * 同步：按现场时刻排队；逐项用 clientId 幂等去重——已合完的跳过，
     * 失败中断后重试只补未合完的项，重复回传不会重复入库。
     * failAfter > 0 时合并若干项后模拟弱网中断。
     */
    syncQueue: (state, action: PayloadAction<{ failAfter?: number } | undefined>) => {
      if (!state.online) {
        state.syncNotice = '当前处于断网状态，已保留在本地队列，恢复联网后重试即可。';
        return;
      }
      const queue: { key: string; time: string; mark: () => void }[] = [];
      for (const o of state.observations) {
        if (o.sync === 'queued' || o.sync === 'failed') {
          queue.push({ key: `obs:${o.clientId}@${o.rev}`, time: o.time, mark: () => { o.sync = 'synced'; } });
        }
      }
      for (const p of state.points) {
        if (p.sync === 'queued' || p.sync === 'failed') {
          queue.push({ key: `pt:${p.clientId}@${p.rev}`, time: p.time, mark: () => { p.sync = 'synced'; } });
        }
      }
      for (const s of state.samples) {
        if (s.sync === 'queued' || s.sync === 'failed') {
          const linkedTime = s.observationId ? (state.observations.find((o) => o.id === s.observationId)?.time ?? '') : '';
          queue.push({ key: `smp:${s.clientId}@${s.rev}`, time: linkedTime, mark: () => { s.sync = 'synced'; } });
        }
      }
      queue.sort(fieldTimeCmp); // 按现场时刻，不按上传顺序

      let merged = 0;
      let skipped = 0;
      let interrupted = false;
      const failAfter = action.payload?.failAfter ?? Infinity;
      for (const item of queue) {
        if (state.mergedKeys.includes(item.key)) {
          // 同一版本重复回传：不重复入库，但该项本就已在库，状态归位为已入库
          item.mark();
          skipped += 1;
          continue;
        }
        if (merged >= failAfter) { interrupted = true; break; }
        item.mark();
        state.mergedKeys.push(item.key);
        merged += 1;
      }
      // 未合完的项置 failed，下次重试只补它们（已 synced 的不动）
      for (const o of state.observations) {
        if ((o.sync === 'queued' || o.sync === 'failed') && !state.mergedKeys.includes(`obs:${o.clientId}@${o.rev}`)) o.sync = 'failed';
      }
      for (const p of state.points) {
        if ((p.sync === 'queued' || p.sync === 'failed') && !state.mergedKeys.includes(`pt:${p.clientId}@${p.rev}`)) p.sync = 'failed';
      }
      for (const s of state.samples) {
        if ((s.sync === 'queued' || s.sync === 'failed') && !state.mergedKeys.includes(`smp:${s.clientId}@${s.rev}`)) s.sync = 'failed';
      }
      const remain = queue.filter((item) => !state.mergedKeys.includes(item.key)).length;

      state.lastSync = now();
      const parts = [interrupted
        ? `弱网中断：按现场时刻合入 ${merged} 项，剩余 ${remain} 项未合完，重试只补这些。`
        : `同步完成：按现场时刻顺序合入 ${merged} 项。`];
      if (skipped) parts.push(`重复回传 ${skipped} 项已跳过，未重复入库。`);
      state.syncNotice = parts.join(' ');
    },

    /** 模拟站点收到另一名巡护员对同一记录的修改（晚到） */
    simulateRemoteEdit: (state, action: PayloadAction<{ targetId: string; note: string; risk: Risk; location?: GeoPoint }>) => {
      parkIncomingObservation(state, action.payload.targetId, { note: action.payload.note, risk: action.payload.risk, location: action.payload.location });
      state.syncNotice = '站点收到同一条记录的另一份修改：已按现场时刻另存为待协调，未覆盖现有版本。';
    },

    /** 协调待处理版本：保留现有 / 采用来件 / 合并双方意见 */
    resolvePending: (state, action: PayloadAction<{ id: string; decision: 'keep' | 'adopt' | 'merge' }>) => {
      const pc = state.pending.find((p) => p.id === action.payload.id);
      if (!pc || pc.resolution) return;
      const obs = state.observations.find((o) => o.id === pc.targetId);
      if (!obs) return;
      if (action.payload.decision === 'adopt') {
        const keyChanged = pc.incoming.risk !== obs.risk ||
          (pc.incoming.location !== undefined &&
            (!obs.location || obs.location.latitude !== pc.incoming.location!.latitude || obs.location.longitude !== pc.incoming.location!.longitude));
        obs.note = pc.incoming.note;
        obs.risk = pc.incoming.risk;
        if (pc.incoming.location) obs.location = pc.incoming.location;
        obs.rev += 1;
        obs.updatedAt = now();
        obs.sync = 'queued';
        if (keyChanged) cascadeInvalidate(state, obs);
        pc.resolution = 'adopted';
      } else if (action.payload.decision === 'merge') {
        obs.note = `${obs.note} ｜协调合并：${pc.incoming.note}`;
        obs.rev += 1;
        obs.updatedAt = now();
        obs.sync = 'queued';
        pc.resolution = 'merged';
      } else {
        pc.resolution = 'kept';
      }
    },

    clearNotice: (state) => { state.syncNotice = null; },
    clearReports: (state) => { state.cascadeReports = []; },

    /** 测试辅助：把某条已入库记录按同一版本重新排队，模拟设备重复回传同一批 */
    __testRequeue: (state, action: PayloadAction<{ kind: 'observation' | 'point' | 'sample'; id: string }>) => {
      const list = action.payload.kind === 'observation' ? state.observations : action.payload.kind === 'point' ? state.points : state.samples;
      const item = list.find((x) => x.id === action.payload.id) as { sync: SyncState } | undefined;
      if (item) item.sync = 'queued';
    }
  }
});

export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) })
});

export const {
  addObservation, addPoint, addSample, editObservation, reviewObservation,
  submitSample, sendLabSample, verifySample, syncQueue, simulateRemoteEdit,
  resolvePending, toggleOnline, clearNotice, clearReports
} = slice.actions;
export const __testRequeue = slice.actions.__testRequeue;

export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware)
});
if (typeof window !== 'undefined') {
  store.subscribe(() => Taro.setStorageSync('yf57-patrol-state', JSON.stringify(store.getState().patrol)));
}

export type RootState = ReturnType<typeof store.getState>;
