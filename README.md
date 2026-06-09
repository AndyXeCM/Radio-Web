# Radio-Web

业余无线电 CRAC 2025 新 A/B/C 类题库 Web 服务与 Web 学习台。

## 功能

- CRAC 2025 A/B/C 类题库浏览与随机刷题。
- 错题本、复习队列、题目拆解、薄弱知识点分析。
- 摩斯电码课程、输入练习、WPM 播放。
- 中继查询模板与本地新增中继模板。
- 管理后台：中继数据管理、题库 JSON 导入/导出/恢复、刷题数据清理。
- Demo 用户、本地进度记录、进度导出/清空。
- Sign in with Apple 服务端配置与验签接口模板。

## 运行

```bash
node server/server.js
```

打开 `http://localhost:5173`。

## 在线版本

GitHub Pages:

https://andyxecm.github.io/Radio-Web/

Pages 版本为纯静态模式：题库从仓库内 JSON 读取，刷题进度、错题、中继模板保存到浏览器 `localStorage`。

## 管理后台

页面侧栏进入“后台”，或在账号页点击“管理员登录”。

- 默认本地管理密码：`radio-admin`
- Node 服务端生产部署请设置环境变量：`ADMIN_PASSWORD`
- GitHub Pages 版本没有真实服务端，后台只管理当前浏览器的 `localStorage`
- 中继演示数据已移除，默认中继列表为空

## 题库

已内置 `data/processed/question_bank.compact.json`，共 3108 道题。

如需重新生成题库，把 CRAC 官方 PDF 放到 `data/raw/`：

- `crac_2025_a.pdf`
- `crac_2025_b.pdf`
- `crac_2025_c.pdf`

然后安装 `pypdf` 并运行：

```bash
python3 scripts/build_question_bank.py
```

## Apple 登录配置

本地接口：

- `GET /api/auth/apple/config`
- `POST /api/auth/apple/verify`

生产环境需要配置：

- `APPLE_SERVICE_ID`
- `APPLE_TEAM_ID`
- `APPLE_KEY_ID`
- `APPLE_PRIVATE_KEY`
- `APPLE_REDIRECT_URI`
