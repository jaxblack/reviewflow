# HTML 文档生成与维护

ReviewFlow 的在线文档采用“模板为源、静态 HTML 为生成物”的方式维护。

## 目录约定

```text
docs/site/
├── manifest.json       # 页面清单、站点版本、日期和公共 URL
├── pages/*.html        # 可编辑页面模板
└── assets/docs.css     # 文档站样式源文件
scripts/
└── generate-docs.mjs   # 生成器
public/docs/            # 生成结果，由 Vite 复制到 dist/docs/
```

不要直接修改 `public/docs/`。生成器会统一完成以下工作：

- 根据 manifest 生成每页侧边导航和当前页状态。
- 替换站点级 token。
- 注入 generated notice，明确源文件位置。
- 复制共享样式。
- 校验页面 doctype、唯一 H1、导航和未解析 token。
- 在 `--check` 模式比较模板渲染结果与已提交生成物。

## 常用命令

```bash
# 修改模板或 manifest 后重新生成
npm run docs:build

# 只检查生成物是否最新，不写文件
npm run docs:check

# 完整质量门禁
npm run check
```

## 修改页面内容

1. 在 `docs/site/pages/` 修改对应模板。
2. 如果新增页面，在 `docs/site/manifest.json` 增加页面记录。
3. 运行 `npm run docs:build`。
4. 检查 `public/docs/` 的差异。
5. 运行 `npm run check` 和浏览器响应式验证。

页面模板可以使用以下 token：

| Token | 来源 |
| --- | --- |
| `{{SITE_NAME}}` | `manifest.json > site.name` |
| `{{SITE_VERSION}}` | `manifest.json > site.version` |
| `{{UPDATED_AT}}` | `manifest.json > site.updatedAt` |
| `{{REPOSITORY_URL}}` | `manifest.json > site.repositoryUrl` |
| `{{APPLICATION_URL}}` | `manifest.json > site.applicationUrl` |

## 新增页面

复制一份已有模板到 `docs/site/pages/<name>.html`，只修改页面正文、title、description 和顶部辅助操作。侧边导航不用手工维护，生成器会根据 manifest 覆盖模板中的 `<nav aria-label="文档导航">`。

manifest 页面顺序即导航顺序。文件名只能包含小写字母、数字和连字符，并以 `.html` 结尾。

## 更新报告数据

测试数、验收结论、演示数据分布和部署状态属于发布事实，不应在没有证据时修改。推荐顺序：

1. 运行测试、构建、API 和浏览器验证。
2. 更新模板中的报告数据及 `manifest.json` 日期或版本。
3. 生成 HTML。
4. 运行 `docs:check`，确保源码与生成物一致。
5. 发布后再次验证线上 HTML 状态码、静态资源和内部链接。

## 故障排查

- `Generated documentation is stale`：运行 `npm run docs:build` 并提交生成差异。
- `unresolved tokens`：token 拼写不在支持列表中，或 manifest 缺少对应值。
- `document navigation was not found`：模板必须保留 `<nav aria-label="文档导航">`。
- 页面本地链接失败：检查目标文件是否存在于 `public/` 或生成后的 `public/docs/`。
