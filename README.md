# 牛客招聘雷达

一个本地运行的招聘信息聚合面板：定时抓取牛客网校招、实习、社招职位，整理成表格，并在每次成功抓取时生成一个可追溯的版本快照。

## 功能

- 抓取牛客网 `/jobs/school/jobs`、`/jobs/intern/center`、`/jobs/fulltime/center` 三个职位广场。
- 标准化字段：职位名称、公司、类型、城市、薪资、毕业要求、标签、更新时间、详情链接。
- 企业汇总：按公司聚合行业、规模、融资、办公地点、招聘类型、在招职位数，可直接查看公司详情。
- 投递追踪：为每个公司维护“未投递 / 已投递 / 笔试中 / 面试中 / 已拿Offer / 暂不投递”状态和备注，数据保存在本地。
- 每次成功抓取生成 `v0001`、`v0002` 这样的版本，记录新增、更新、移除数量，并保存完整快照。
- 前端支持类型筛选、关键词搜索、城市筛选、分页、版本回看和手动刷新。
- 服务默认每 10 分钟自动抓取一次，可用环境变量调整。

页面视图：

- `http://127.0.0.1:8765/`：职位列表。
- `http://127.0.0.1:8765/?view=companies`：企业汇总。
- `http://127.0.0.1:8765/?view=tracking`：投递追踪。

## 运行

```powershell
python server.py
```

然后访问 `http://127.0.0.1:8765`。

也可以通过环境变量调整端口和抓取间隔：

```powershell
$env:PORT = "9000"
$env:REFRESH_INTERVAL_MINUTES = "5"
python server.py
```

## 数据文件

- `data/latest.json`：最新一次抓取的职位列表。
- `data/versions/index.json`：版本索引。
- `data/versions/v0001.json`：每个版本的完整快照。
- `data/applications.json`：本地投递追踪记录。
- `CHANGELOG.md`：每次抓取自动追加的可读更新记录。

## 部署到 Vercel

项目已内置 Vercel 部署配置：

- `app.py`：FastAPI 入口，提供与本地版相同的 API。
- `vercel.json`：每 6 小时通过 Cron 自动刷新一次。
- `storage.py`：本地开发读写 `data/`；在 Vercel 上自动切换到 Vercel Blob 持久化版本快照和投递记录。
- `seed_data/`：首次部署时的内置种子数据，让线上在创建 Blob Store 之前也能正常展示。

部署步骤：

1. 把代码推送到 GitHub。
2. 打开 [vercel.com/new](https://vercel.com/new)，用 GitHub 账号登录后导入 `wangzhenkun` 仓库。
3. Vercel 会自动识别 Python + FastAPI 并完成首次部署。
4. 进入项目的 `Storage` 页创建 Blob Store，然后在 Blob Store 的 `Projects` 页连接到该项目。
5. 连接后 Vercel 会自动注入 `BLOB_READ_WRITE_TOKEN`，后续 Cron 刷新和投递记录都会持久化到 Blob。

也可以先在本地用 Vercel CLI 登录并直接部署：

```powershell
npx vercel login
npx vercel --prod
```

如需给 Cron 接口加鉴权，在 Vercel 项目设置中添加 `CRON_SECRET` 环境变量即可。

## 说明

牛客的职位检索接口目前有阿里云滑动验证，服务端直接请求分页接口会被拦截；当前版本抓取三个职位广场 SSR 页面中的首批职位（每类约 20 条）。手动刷新和版本记录已经完整可用，后续可以在同一架构上接入浏览器自动化来扩展分页抓取。
