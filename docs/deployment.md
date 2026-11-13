# 部署 / Deployment

`npm run build` 生成纯静态站点 `dist/`，可以放到任何静态托管（GitHub Pages、Cloudflare Pages、Nginx 等）。

## 推荐方案：GitHub Pages + Cloudflare + 夸克网盘

```
phemor.com ──Cloudflare（DNS + CDN，SSL: Full）──▶ GitHub Pages
   /          非莫词汇：网页 + 词条文字，约 15 MB，无图片无发音
   /words/    旧地址，自动跳转到 /

夸克网盘      单词包（.phemor），客户下载后在 App 里导入
```

### 构建（不含图片和发音）

```bash
ATLAS_MEDIA=0 npm run build
```

- `ATLAS_BASE`：站点子路径，默认 `/`（部署在域名根目录）。放在子路径时才需要设置，例如 `ATLAS_BASE=/words/`。
- `ATLAS_MEDIA=0`：构建结束时删除 `dist/atlas/img`、`thumb`、`audio`（Pages 站点上限约 1 GB，这些约 700 MB 走单词包）。不设则保留，适合自建服务器。
- `VITE_PACK_SHARE_URL`、`VITE_PACK_SHARE_CODE`、`VITE_PACK_SHARE_NAME`：「单词包」页里夸克卡片的链接、提取码、网盘名称（默认「夸克网盘」）。链接必须是 `https://`，不设就不显示卡片。

### GitHub Pages

仓库带有 `.github/workflows/pages.yml`：推送到 `main` 即自动测试、构建、发布。

1. 仓库 Settings → Pages → Source 选 **GitHub Actions**，Custom domain 填 `phemor.com`。
2. Settings → Secrets and variables → Actions → **Variables** 里添加 `PACK_SHARE_URL`（夸克分享链接）和 `PACK_SHARE_CODE`（提取码）。改了之后重新运行工作流。
3. 工作流把非莫放在站点根目录，另外生成一个 `/words/` 跳转页（兼容旧链接和旧的主屏幕图标），并写入 `CNAME` 和 `.nojekyll`。`homepage/` 目录不再发布。
4. 仓库里不需要也不应提交 `packs/`、`*.phemor`（已在 `.gitignore`）。推荐连 `public/atlas/img`、`thumb`、`audio` 也不提交（构建不需要）。

### Cloudflare

- DNS：`phemor.com` 指向 GitHub Pages（A 记录 `185.199.108.153` / `.109.153` / `.110.153` / `.111.153`），保持橙色云朵。
- SSL/TLS 加密模式：**Full**（Flexible 会导致无限重定向）。
- GitHub Pages 不能自定义缓存头；页面和 `sw.js` 的更新由 Pages 默认的短缓存加上 Service Worker 的「联网优先」策略保证。若发现更新很慢，可以在 Cloudflare 里给 `/sw.js`、`/index.html`、`/atlas/index.json` 建一条 Cache Rule：Bypass cache。

## 自建服务器（Nginx 示例）

```nginx
location ^~ /words/ {
    alias /var/www/word-atlas/;
    try_files $uri $uri/ /words/index.html;
    expires 7d;
}

# 离线服务脚本和页面入口必须每次校验，否则更新会被浏览器缓存挡住
location = /words/sw.js           { alias /var/www/word-atlas/sw.js;     add_header Cache-Control "no-cache"; }
location = /words/index.html      { alias /var/www/word-atlas/index.html; add_header Cache-Control "no-cache"; }
location = /words/atlas/index.json { alias /var/www/word-atlas/atlas/index.json; add_header Cache-Control "no-cache"; }
```

自建时可以不设 `ATLAS_MEDIA=0`，并把 `packs/` 上传到 `/words/packs/`：App 的「单词包」页会列出在线目录（`packs.json`），客户直接点「下载」。包放在别的域名时，需要给它加 `Access-Control-Allow-Origin: https://phemor.com`。

## 体积

| 内容 | 大小 |
|---|---|
| 网页本体 | 约 0.5 MB |
| 词条文字（`atlas/entries/`） | 约 7 MB |
| 全部插画 + 发音 | 约 700 MB（走单词包） |

单词包的生成、分发和客户端用法见 [packs.md](packs.md) 和 [customer-guide.md](customer-guide.md)。
