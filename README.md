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
- `GET /history?tuneId=&objectType=&objectId=&operator=`

## 编辑轨迹与乐观锁

曲目、区间、问题都带递增 `version`（首次创建为 1），原接口和字段照常使用，只是对象上多出 `version` 字段。

- **提交修改**（`POST` 创建、`PATCH` 更新）必须在请求体里写明 `operator`（操作人）；更新类请求还要带 `version`（修改前读取到的当前版本）。
- 保存成功后版本 +1，并向只读轨迹追加一条记录，字段为：
  - `seq`：轨迹序号，从 1 开始递增（越旧越小）
  - `objectType` / `objectId` / `tuneId`：对象定位
  - `action`：`create` / `check` / `status`
  - `version`：本次保存后的新版本
  - `before` / `after`：修改前、修改后的对象完整快照（创建时 `before` 为 `null`）
  - `operator`：操作人
  - `at`：保存时间（ISO）
- **版本过期**：提交的 `version` 与当前不一致时返回 `409 Conflict`，响应体带 `error` 和 `latest`（最新对象），本次修改和轨迹都不会写入。客户端应基于 `latest` 重新校对后再提交。
- `GET /history` 按时间倒序（即 `seq` 从大到小）返回轨迹，可用 `tuneId`、`objectType`（`tune`/`section`/`issue`）、`objectId`、`operator` 过滤。
- 轨迹只追加，不提供修改或删除接口。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔","operator":"小林"}'

# 带版本和操作人提交校对
curl -X PATCH http://127.0.0.1:3019/sections/section_demo_2/check \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"operator":"小林","checked":true,"note":"副歌段已校对"}'

# 再拿旧版本 v1 提交会得到 409，响应里带 latest（v2 最新内容）
curl -X PATCH http://127.0.0.1:3019/sections/section_demo_2/check \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"operator":"阿陈","checked":false}'

# 查看轨迹（时间倒序）
curl 'http://127.0.0.1:3019/history?tuneId=tune_demo'
```
