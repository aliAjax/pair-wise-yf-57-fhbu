# pair-wise-yf-57 野外巡护离线调查应用

## 源提示词摘要
巡护员离线记录观察、轨迹点、样本编号、风险等级和现场情况，回到有网络环境后同步给站点负责人。负责人复核重复观察、位置异常、证据缺失和能力范围外事项；多人修改同一记录时保留版本并允许合并，应用需要适配手机屏幕、电量、弱网和后台恢复。

## 技术栈
Taro 3 + React + TypeScript + NutUI + Redux Toolkit + RTK Query + React Hook Form + Zod + Taro 国际化方案。

## 已实现闭环
- 观察记录、轨迹点、样本三类业务对象。
- 新建现场记录、记录 GPS 轨迹点、提交样本、负责人复核与样本核验。
- 离线队列、模拟联网同步、记录级冲突选择本地或合并云端意见。
- Taro 本地存储持久化和移动端布局。

## 同步引擎（按现场时刻整理）
- **现场时刻排序**：记录以现场时刻（`time`/`version`）排序与合并，不按上传顺序覆盖。
- **并发修改另存待协调**：两人改过同一条记录时，晚到版本不覆盖原记录，另存为 `id#origin` 并标记待协调（`pendingCoordination`），可在「待协调」列表处理。
- **失效退回**：观察记录的地点或风险等级一变，样本核验与复核结论立即失效退回；已送检样本只标记待确认（`pending_confirmation`），不退回草稿。
- **幂等重试**：同步失败后重试只补没合完的项（`mergedClientIds`），重复回传不重复入库。
- **按最近轨迹点回填**：旧数据缺编号或缺少位置关联时，升级按现场时刻最近的轨迹点回填编号与位置。

## 启动
```bash
npm install
npm run dev
```
开发端口：62022

## 逻辑测试
```bash
npx esbuild src/store/engine.test.ts --bundle --platform=node --format=esm --outfile=/tmp/engine.test.mjs && node /tmp/engine.test.mjs
```
