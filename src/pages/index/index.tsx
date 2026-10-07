import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation, addPoint, editObservation, reviewObservation,
  submitSample, sendLabSample, verifySample, syncQueue, simulateRemoteEdit,
  resolvePending, toggleOnline, clearReports,
  type RootState, type Risk, type SyncState, type SampleStatus
} from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

const RISK_LABEL: Record<Risk, string> = { low: '低', medium: '中', high: '高' };
const SYNC_LABEL: Record<SyncState, string> = { local: '仅本地', queued: '待同步', synced: '已入库', failed: '同步中断' };
const SYNC_CLASS: Record<SyncState, string> = { local: '', queued: 'tag-warn', synced: 'tag-ok', failed: 'tag-err' };
const SAMPLE_LABEL: Record<SampleStatus, string> = {
  draft: '草稿', submitted: '待核验', lab: '已送检', verified: '已核验', pending_confirm: '待确认', returned: '退回重做'
};
const RISKS: Risk[] = ['low', 'medium', 'high'];

const locText = (loc?: { latitude: number; longitude: number }) =>
  loc ? `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}` : '无地点';

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', species: '', count: '1' }
  });

  const pendingQueue = (s: SyncState) => s === 'queued' || s === 'failed';
  const queued =
    state.observations.filter((i) => pendingQueue(i.sync)).length +
    state.points.filter((i) => pendingQueue(i.sync)).length +
    state.samples.filter((i) => pendingQueue(i.sync)).length;
  const failed =
    state.observations.filter((i) => i.sync === 'failed').length +
    state.points.filter((i) => i.sync === 'failed').length +
    state.samples.filter((i) => i.sync === 'failed').length;
  const unresolved = state.pending.filter((p) => !p.resolution && !p.stale).length;
  // 所有列表一律按现场时刻排序（升序），与上传先后无关
  const observations = [...state.observations].sort((a, b) => a.time.localeCompare(b.time));
  const points = [...state.points].sort((a, b) => a.time.localeCompare(b.time));

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude }));
    } catch {
      // 弱网/无定位权限时允许手工点
      dispatch(addPoint({ latitude: 30.58 + Math.random() * 0.02, longitude: 103.21 + Math.random() * 0.02, source: 'manual' }));
    }
  };

  const submit = (values: FormValues) => {
    // 观察与同批样本一次登记：地点取最近轨迹点，样本自动关联，后续改地点/风险即可级联
    dispatch(addObservation({
      note: values.note,
      risk: values.risk,
      sample: values.species ? { species: values.species, count: Number(values.count) || 1 } : undefined
    }));
    reset();
  };

  return <View className="page">
    <View className="hero">
      <Text className="eyebrow">FIELD PATROL / PORT 62022</Text>
      <Text className="title">{t.title}</Text>
      <Text className="sub">按现场时刻归并 · 晚到另存待协调 · 重复回传不重复入库 · 风险地点变更级联退回</Text>
    </View>

    {/* 升级回填结果 */}
    {(state.backfilled.observations > 0 || state.backfilled.samples > 0) && (
      <View className="alert info">
        <Text>旧数据升级已完成：{state.backfilled.observations} 条观察记录按最近轨迹点回填地点/编号，{state.backfilled.samples} 个样本补编号。</Text>
      </View>
    )}

    <View className="metrics">
      <View><Text>待同步</Text><Text className="metric warn">{queued}</Text></View>
      <View><Text>中断待补</Text><Text className="metric warn">{failed}</Text></View>
      <View><Text>待协调</Text><Text className="metric warn">{unresolved}</Text></View>
    </View>

    {/* 现场记录 */}
    <View className="card">
      <View className="card-title">现场记录<Text className="count">编号自动生成</Text></View>
      <form onSubmit={handleSubmit(submit)}>
        <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
        <View className="two">
          <Input className="input" placeholder="物种或样本名称（可选）" {...register('species')} />
          <Input className="input" type="number" placeholder="数量" {...register('count')} />
        </View>
        <View className="risk">
          <Text>风险等级</Text>
          <select {...register('risk')}>
            <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
          </select>
        </View>
        <Button className="primary" formType="submit">{t.save}</Button>
        <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
      </form>
    </View>

    {/* 同步控制 */}
    <View className="card">
      <View className="card-title">{t.sync}<Text className="count">{queued} 条排队</Text></View>
      <View className="alert-actions">
        <Button size="mini" onClick={() => dispatch(toggleOnline())}>{state.online ? '切到断网（山里）' : '切回联网（回站）'}</Button>
        <Button size="mini" onClick={() => dispatch(syncQueue())}>{failed > 0 ? `重试（只补 ${failed} 项未合完）` : '按现场时刻同步'}</Button>
        <Button size="mini" onClick={() => dispatch(syncQueue({ failAfter: 1 }))}>模拟弱网：合1项后中断</Button>
        <Button size="mini" onClick={() => dispatch(syncQueue())}>再次回传整批（验重）</Button>
      </View>
      <Text className="hint">当前网络：{state.online ? '在线' : '离线'}；上次同步：{state.lastSync ?? '—'}。同步逐项幂等，已合完的不会重复入库，中断重试只补未合完的项。</Text>
      {state.syncNotice && <View className="alert info"><Text>{state.syncNotice}</Text></View>}
    </View>

    {/* 待协调：两人改过同一条，晚到的另存于此，不覆盖 */}
    {state.pending.length > 0 && (
      <View className="card">
        <View className="card-title">待协调<Text className="count">{unresolved} 条待处理</Text></View>
        {state.pending.map((pc) => {
          const obs = state.observations.find((o) => o.id === pc.targetId);
          return <View className={`pending ${pc.stale ? 'stale' : ''} ${pc.resolution ? 'resolved' : ''}`} key={pc.id}>
            <Text className="obs-title">记录 {pc.targetCode ?? pc.targetId} · 现场时刻 {pc.fieldTime} · 到站 {pc.arrivedAt}</Text>
            {obs && <Text className="muted">现版本（{RISK_LABEL[obs.risk]}风险）：{obs.note}</Text>}
            <Text className="muted">晚到版本（{RISK_LABEL[pc.incoming.risk]}风险，{locText(pc.incoming.location)}）：{pc.incoming.note}</Text>
            {pc.stale && <Text className="muted">该版本更早到，已有更新版本待协调，本条仅留痕。</Text>}
            {pc.resolution
              ? <Text className="muted">已协调：{pc.resolution === 'kept' ? '保留现版本' : pc.resolution === 'adopted' ? '已采用晚到版本' : '已合并双方意见'}</Text>
              : !pc.stale && <View className="alert-actions">
                  <Button size="mini" onClick={() => dispatch(resolvePending({ id: pc.id, decision: 'keep' }))}>保留现版本</Button>
                  <Button size="mini" onClick={() => dispatch(resolvePending({ id: pc.id, decision: 'adopt' }))}>采用晚到版本</Button>
                  <Button size="mini" onClick={() => dispatch(resolvePending({ id: pc.id, decision: 'merge' }))}>合并双方意见</Button>
                  {obs && <Button size="mini" onClick={() => dispatch(simulateRemoteEdit({
                    targetId: obs.id, risk: obs.risk, location: obs.location,
                    note: `又一份更晚到的修改（${new Date().toLocaleTimeString()}）`
                  }))}>再模拟一份更晚到件</Button>}
                </View>}
          </View>;
        })}
      </View>
    )}

    {/* 级联退回报告 */}
    {state.cascadeReports.length > 0 && (
      <View className="card">
        <View className="card-title">核验/复核失效记录<Text className="count" onClick={() => dispatch(clearReports())}>清空</Text></View>
        {state.cascadeReports.map((r) => (
          <View className="pending" key={`${r.observationCode}-${r.at}`}>
            <Text className="obs-title">记录 {r.observationCode}（{r.at}）</Text>
            {r.reviewCleared && <Text className="muted">· 地点或风险等级已变，负责人复核结论失效，需重新复核。</Text>}
            {r.samples.map((s, i) => (
              <Text className="muted" key={i}>
                · 样本 {s.code ?? s.species}：{SAMPLE_LABEL[s.from]} → {SAMPLE_LABEL[s.to]}
                {s.reason === 'lab_pending' ? '（已送检，仅标待确认，不退回）' : '（核验结论失效，退回重做）'}
              </Text>
            ))}
          </View>
        ))}
      </View>
    )}

    {/* 观察记录（按现场时刻排序） */}
    <View className="card">
      <View className="card-title">观察记录<Text className="count">按现场时刻 ↑</Text></View>
      <ScrollView scrollY className="list">
        {observations.map((item) => (
          <View className="observation" key={item.id}>
            <View className="obs-body">
              <Text className="obs-title">
                {item.code} · [{RISK_LABEL[item.risk]}风险] {item.note}
              </Text>
              <Text className="muted">
                {item.time} · {locText(item.location)}
              </Text>
              <Text className={`tag ${SYNC_CLASS[item.sync]}`}>{SYNC_LABEL[item.sync]}</Text>
              {item.reviewed && <Text className="tag tag-ok">已复核</Text>}
              {item.reviewInvalid && <Text className="tag tag-err">复核已失效</Text>}
              <View className="alert-actions">
                <Button size="mini" disabled={item.reviewed} onClick={() => dispatch(reviewObservation(item.id))}>
                  {item.reviewed ? '已复核' : '复核'}
                </Button>
                {RISKS.filter((r) => r !== item.risk).map((r) => (
                  <Button size="mini" key={r} onClick={() => dispatch(editObservation({ id: item.id, risk: r }))}>
                    改{RISK_LABEL[r]}风险
                  </Button>
                ))}
                <Button size="mini" onClick={() => dispatch(editObservation({
                  id: item.id,
                  location: { latitude: 30.6 + Math.random() * 0.02, longitude: 103.24 + Math.random() * 0.02 }
                }))}>改地点</Button>
                <Button size="mini" onClick={() => dispatch(simulateRemoteEdit({
                  targetId: item.id, risk: item.risk === 'low' ? 'high' : 'low',
                  location: item.location, note: `巡护员B现场补记：${item.note}（另见东侧沟口）`
                }))}>模拟另一人的晚到修改</Button>
              </View>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>

    {/* 轨迹与样本 */}
    <View className="card">
      <View className="card-title">轨迹点<Text className="count">按现场时刻 ↑</Text></View>
      {points.map((point) => (
        <View className="sample" key={point.id}>
          <View>
            <Text>{point.latitude.toFixed(4)}, {point.longitude.toFixed(4)}</Text>
            <Text className="muted">{point.time} · {point.source === 'gps' ? 'GPS' : '手工'}</Text>
          </View>
          <Text className={`tag ${SYNC_CLASS[point.sync]}`}>{SYNC_LABEL[point.sync]}</Text>
        </View>
      ))}

      <View className="card-title" style={{ marginTop: 16 }}>样本</View>
      {state.samples.map((sample) => (
        <View className="sample" key={sample.id}>
          <View>
            <Text>{sample.code} · {sample.species} × {sample.count}</Text>
            <Text className={`tag ${sample.status === 'pending_confirm' || sample.status === 'returned' ? 'tag-err' : sample.status === 'verified' ? 'tag-ok' : 'tag-warn'}`}>
              {SAMPLE_LABEL[sample.status]}
            </Text>
          </View>
          <View className="sample-actions">
            {(sample.status === 'draft' || sample.status === 'returned') &&
              <Button size="mini" onClick={() => dispatch(submitSample(sample.id))}>提交核验</Button>}
            {sample.status === 'submitted' &&
              <Button size="mini" onClick={() => dispatch(sendLabSample(sample.id))}>送检</Button>}
            {sample.status === 'submitted' &&
              <Button size="mini" onClick={() => dispatch(verifySample(sample.id))}>核验通过</Button>}
          </View>
        </View>
      ))}
      <Text className="hint">观察记录的地点或风险等级一旦变更：已核验样本退回重做；已送检样本只标“待确认”，不作废。</Text>
    </View>
  </View>;
}
