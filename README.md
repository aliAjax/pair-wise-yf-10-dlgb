# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间和试奏问题。

## 启动

```bash
PORT=3019 node server.js
```

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`
- `GET /audit-logs?tuneId=&objectType=&objectId=`（按时间倒序）

## 版本与编辑轨迹

曲目、区间、问题各自带从 1 开始递增的 `version`（旧数据自动补为 1）。

- 提交修改时在请求体里带上 `version`（修改前看到的版本）和 `operator`（操作人，缺省为 `anonymous`）。
- 保存成功后对象版本 +1，并追加一条只读轨迹（序号 `seq` 从 1 开始），记录对象、`before`/`after` 前后值、操作人和 `createdAt` 时间。
- 提交的版本与当前不一致时返回 **409**，响应体含 `currentVersion` 和最新对象 `data`，本次修改与轨迹都不会写入；客户端应基于最新内容重试。
- 不带 `version` 的旧调用仍可保存（仅不参与乐观锁校验），原有接口字段保持不变。
- `GET /audit-logs` 按时间倒序返回轨迹，可用 `tuneId`、`objectType`（`tune`/`section`/`issue`）、`objectId` 过滤。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔","operator":"甲"}'

# 带版本与操作人修改；别人已先保存导致版本过期时，返回 409 和最新内容
curl -X PATCH http://127.0.0.1:3019/sections/section_demo_2/check \
  -H 'Content-Type: application/json' \
  -d '{"checked":true,"note":"副歌校对完成","version":1,"operator":"乙"}'

curl http://127.0.0.1:3019/audit-logs?tuneId=tune_demo
```
