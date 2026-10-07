import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog, NoticeBar, Tag } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
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
  sortByFieldTime,
  type RootState,
  type Risk,
  type SampleStatus,
  type SyncBatch,
} from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

const riskLabel: Record<Risk, string> = { low: '低', medium: '中', high: '高' };
const riskType: Record<Risk, 'success' | 'warning' | 'danger'> = { low: 'success', medium: 'warning', high: 'danger' };
const sampleMeta: Record<SampleStatus, { label: string; type: 'default' | 'primary' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: '草稿', type: 'default' },
  submitted: { label: '已送检', type: 'primary' },
  verified: { label: '已核验', type: 'success' },
  pending_confirmation: { label: '待确认', type: 'warning' },
};
const resultType: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
  merged: 'success',
  skipped: 'default',
  conflict: 'danger',
};

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { note: '', risk: 'low', species: '', count: '1' } });

  const activeBatch: SyncBatch | undefined = state.batches.find((b) => b.batchId === state.activeBatchId);
  const pendingCount =
    state.observations.filter((o) => o.sync !== 'synced').length +
    state.points.filter((p) => !p.synced).length +
    state.samples.filter((s) => !s.synced).length +
    state.remoteInbox.length;
  const coordinationObs = state.coordination
    .map((id) => state.observations.find((o) => o.id === id))
    .filter((o): o is NonNullable<typeof o> => Boolean(o));
  const sortedObservations = sortByFieldTime(state.observations);

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude }));
    } catch {
      dispatch(addPoint({ latitude: 30.5, longitude: 103.2 }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    reset();
  };

  const cycleRisk = (id: string, current: Risk) => {
    const order: Risk[] = ['low', 'medium', 'high'];
    const next = order[(order.indexOf(current) + 1) % order.length];
    dispatch(editObservationRisk({ id, risk: next }));
  };

  return (
    <View className="page">
      <View className="hero">
        <Text className="eyebrow">FIELD PATROL / PORT 62022</Text>
        <Text className="title">{t.title}</Text>
        <Text className="sub">弱网也能记录，联网后按现场时刻统一合并；两人改同一条时晚到版本另存待协调，不按上传顺序覆盖。</Text>
      </View>

      <View className="metrics">
        <View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View>
        <View><Text>待同步</Text><Text className="metric warn">{pendingCount}</Text></View>
        <View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View>
        <View><Text>待协调</Text><Text className="metric danger">{state.coordination.length}</Text></View>
      </View>

      {state.notice && (
        <NoticeBar
          className="banner"
          content={state.notice}
          closeable
          wrap
          onClose={() => dispatch(dismissNotice())}
        />
      )}
      {state.conflict && (
        <View className="alert conflict">
          <Text>{state.conflict}</Text>
          <View className="alert-actions">
            <Button size="mini" onClick={() => dispatch(dismissConflict())}>知道了</Button>
          </View>
        </View>
      )}

      <View className="card">
        <View className="card-title">
          {t.sync}
          <Text className="count">{pendingCount} 项待合入</Text>
        </View>
        <Button className="primary" onClick={() => dispatch(syncQueue())}>模拟恢复联网并同步</Button>
        <View className="sync-row">
          <Button size="mini" className="ghost" onClick={() => dispatch(simulateRemoteEdit())}>模拟队友并发修改</Button>
        </View>

        {activeBatch && (
          <View className="batch">
            <View className="batch-head">
              <Text className="muted">批次 {activeBatch.batchId.slice(-6)} · 第 {activeBatch.attempt} 次尝试</Text>
              <Tag type={activeBatch.status === 'done' ? 'success' : 'warning'}>{activeBatch.status === 'done' ? '已完成' : '部分合入'}</Tag>
            </View>
            <View className="batch-progress">
              已合入 {activeBatch.mergedClientIds.length}/{activeBatch.items.length} 项
            </View>
            <ScrollView scrollY className="batch-results">
              {activeBatch.results.map((r, i) => (
                <View key={i} className="batch-result">
                  <Tag type={resultType[r.status]}>{r.status === 'merged' ? '已合并' : r.status === 'skipped' ? '已跳过' : '待协调'}</Tag>
                  <Text className="muted">{r.message}</Text>
                </View>
              ))}
            </ScrollView>
            {activeBatch.status === 'partial' ? (
              <Button className="primary" onClick={() => dispatch(retryBatch())}>重试未完成项（剩 {activeBatch.items.length - activeBatch.mergedClientIds.length} 项）</Button>
            ) : (
              <Button className="secondary" onClick={() => dispatch(reuploadBatch())}>重复回传本批</Button>
            )}
          </View>
        )}
        <Text className="hint">同步失败后重试只补没合完的项；重复回传不重复入库。</Text>
      </View>

      {coordinationObs.length > 0 && (
        <View className="card">
          <View className="card-title">待协调<Text className="count">{coordinationObs.length} 条</Text></View>
          {coordinationObs.map((o) => (
            <View key={o.id} className="observation">
              <View>
                <Text className="obs-title">{o.code} · {o.note}</Text>
                <Text className="muted">{o.time} · 原记录 {o.conflictOf}</Text>
              </View>
              <Button size="mini" onClick={() => dispatch(resolveCoordination(o.id))}>已协调</Button>
            </View>
          ))}
        </View>
      )}

      <View className="card">
        <View className="card-title">现场记录</View>
        <form onSubmit={handleSubmit(submit)}>
          <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
          <View className="two">
            <Input className="input" placeholder="物种或样本名称" {...register('species')} />
            <Input className="input" type="number" placeholder="数量" {...register('count')} />
          </View>
          <View className="risk">
            <Text>风险等级</Text>
            <select {...register('risk')}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </View>
          <Button className="primary" formType="submit">{t.save}</Button>
          <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
        </form>
      </View>

      <View className="card">
        <View className="card-title">观察记录<Text className="count">{sortedObservations.length} 条（按现场时刻）</Text></View>
        <ScrollView scrollY className="list">
          {sortedObservations.map((item) => (
            <View className="observation" key={item.id}>
              <View className="obs-main">
                <View className="obs-tags">
                  {item.code ? <Tag type="info">{item.code}</Tag> : null}
                  <Tag type={riskType[item.risk]}>{riskLabel[item.risk]}风险</Tag>
                  {item.pendingCoordination ? <Tag type="danger">待协调</Tag> : null}
                  {item.migrated ? <Tag type="default">已回填</Tag> : null}
                </View>
                <Text className="obs-title">{item.note}</Text>
                <Text className="muted">
                  {item.time} · {item.sync}
                  {item.location ? ` · ${item.location.latitude.toFixed(4)}, ${item.location.longitude.toFixed(4)}` : ''}
                </Text>
                <View className="obs-actions">
                  <Button size="mini" className="ghost" onClick={() => cycleRisk(item.id, item.risk)}>改风险</Button>
                  <Button size="mini" className="ghost" onClick={() => dispatch(relinkObservationLocation(item.id))}>换地点</Button>
                  <Button size="mini" disabled={item.reviewed || item.risk === 'low'} onClick={() => dispatch(reviewObservation(item.id))}>
                    {item.reviewed ? '已复核' : '复核'}
                  </Button>
                </View>
              </View>
            </View>
          ))}
        </ScrollView>
      </View>

      <View className="card">
        <View className="card-title">轨迹与样本</View>
        {state.points.slice(-3).map((point) => (
          <NutCell key={point.id} title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`} description={`${point.at} · ${point.source}`} />
        ))}
        {state.samples.map((sample) => {
          const meta = sampleMeta[sample.status];
          const canVerify = sample.status === 'draft';
          const canSubmit = sample.status === 'draft';
          return (
            <View className="sample" key={sample.id}>
              <View className="obs-main">
                <View className="obs-tags">
                  <Tag type="info">{sample.code}</Tag>
                  <Tag type={meta.type}>{meta.label}</Tag>
                </View>
                <Text className="obs-title">{sample.species} × {sample.count}</Text>
              </View>
              <View className="obs-actions">
                {canSubmit && <Button size="mini" className="ghost" onClick={() => dispatch(submitSample(sample.id))}>送检</Button>}
                <Button size="mini" disabled={!canVerify} onClick={() => dispatch(verifySample(sample.id))}>
                  {sample.status === 'verified' ? '已核验' : sample.status === 'pending_confirmation' ? '待确认' : '核验'}
                </Button>
              </View>
            </View>
          );
        })}
      </View>

      <NutDialog title="离线说明" content="轨迹点和记录会写入本地存储，恢复网络后按现场时刻合并；两人改同一条时晚到版本另存待协调。" visible={false} />
    </View>
  );
}
