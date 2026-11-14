# 离线单词包 · 运营手册

> 目标：客户用手机浏览器打开一次，添加到主屏幕；再去夸克网盘下载自己阶段的「单词包」导入。之后图片、发音、词条全部在手机里，**不再受服务器线路影响**。以后新增单词，只要给客户发一个新的 `.phemor` 文件。

## 1. 整体结构：三个地方各管一样

| 放哪里 | 放什么 | 大小 | 客户怎么得到 |
|---|---|---|---|
| **GitHub Pages**（经 Cloudflare） | 网页 + 全部词条文字，没有图片和发音 | 约 15 MB | 浏览器打开 `phemor.com/` |
| **夸克网盘** | 单词包（图片、发音） | 每个 120–200 MB | 客户下载后在 App 里「选择单词包文件」导入 |
| **客户手机** | 以上两者的离线副本 | — | 之后不用联网 |

要点：
- 网页首次打开约 4 秒后，会在后台把**全部词条文字**（73 个小文件，约 7 MB）存进手机，所以即使一个包都没装，查词、读释义例句也能离线；没装包的词图片显示为文字插画，发音自动用手机自带的语音朗读。
- 单词包只负责「图片 + 发音」（和新增词条）。包可以分批装、随时装。
- GitHub Pages 站点上限约 1 GB，所以**图片和发音不能放进 GitHub**。构建时用 `ATLAS_MEDIA=0` 自动剔除（见 `deployment.md`）。

> **付费包加密与激活码**：初中包免费，其余 4 个包加密发放，客户凭你签发的激活码安装。流程见 [`license.md`](license.md)。

## 2. 默认套装（发给客户的就是这 5 个，在 `packs/lists/`）

按「学段词表」划分，**后一个包不重复前一个包的词**（高中包只含高中词表里初中包没有的词，以此类推），所以客户按自己的阶段往上装，不会重复下载。

| 文件 | 内容 | 词数 | 大小 |
|---|---|---|---|
| `list-junior.phemor` | 初中包：初中词表里的词 | 1,798 | 约 189 MB |
| `list-senior.phemor` | 高中包：高中词表里，初中包之外的词 | 1,507 | 约 127 MB |
| `list-college.phemor` | 大学包：四、六级词表里，高中包之外的词 | 2,309 | 约 194 MB |
| `list-advanced.phemor` | 雅思进阶包：四、六级之外的高阶与学术词（C1–C2 居多） | 1,684 | 约 145 MB |
| `list-travel.phemor` | 旅游包：旅行、城市话题的词（可与上面任意包重叠） | 449 | 约 44 MB |

词表来源和覆盖情况：

- 初中 / 高中 / 四级 / 六级的词表来自开源仓库 [KyleBing/english-vocabulary](https://github.com/KyleBing/english-vocabulary)（BSD-3-Clause）。**只用它判断「哪些词属于哪个阶段」，释义、例句、图片、发音都是本站自己的**。词表和对照结果在 `data/wordlists/`（`ids-*.txt` 是各包的词，`gaps.json` 是缺口，`cover.py` 是对照脚本）。
- 雅思进阶包不对应任何官方雅思词表（雅思没有官方词表，网上常见的是出版社词汇书，版权不明，没有采用）。它是本站「四六级之外的 1,684 个词」，是我们自己的划分。
- **现有词库只命中四个词表的约一半**（初中 56%、高中 53%、四级 51%、六级 50%）。四个词表合计有约 **1,782 个词本站还没有**（初中 181、高中 379、四级 450、六级 772），清单在 `data/wordlists/gaps.json`。它们需要新生成词条、插画和发音（流程见 `pipeline.md`），生成后用 `build_packs.py words` 打成补充包发给客户即可，不用改上面这 5 个包。
- 「练习」不用单独做：听写、选词等练习由网页根据每个词条的释义和例句现场生成，新词一装好就有。

旧的按 CEFR 难度划分的 4 个套装（`packs/kit-*.phemor`）仍可使用，但和上面这套会重复，**不要同时发给客户**。

另有两类可选文件，一般不用发：
- `core.phemor`（14 MB）：词条文字、音效、封面。网页已自动保存词条，通常不用装。
- `by-level/`：按难度拆开的「插画」「发音」小包（共 12 个，10–98 MB）。

## 3. 一次性上线清单

1. **GitHub**：新建仓库，把项目推上去（不要把 `packs/`、`*.phemor` 提交，`.gitignore` 已排除）。
   - 仓库 Settings → Pages → Source 选 **GitHub Actions**。
   - 自定义域名填 `phemor.com`（工作流会自动写 `CNAME`）。
   - 推荐仓库里**不提交** `public/atlas/img`、`thumb`、`audio`（共约 700 MB）：在 `.gitignore` 加这三行即可，构建不需要它们。
2. **Cloudflare**：
   - DNS：`phemor.com` 的 A 记录指向 GitHub Pages（`185.199.108.153`、`.109.153`、`.110.153`、`.111.153`），云朵保持橙色（代理）。
   - SSL/TLS 加密模式选 **Full**（不要选 Flexible，否则会无限重定向）。
3. **夸克网盘**：把 `packs/lists/` 里的 5 个 `.phemor` 上传到一个文件夹，创建分享链接。
4. **把分享链接放进网页**：GitHub 仓库 Settings → Secrets and variables → Actions → **Variables**，新增
   - `PACK_SHARE_URL` = 夸克分享链接（必须是 `https://` 开头）
   - `PACK_SHARE_CODE` = 提取码（没有就不填）

   然后在 Actions 里重新运行「Deploy to GitHub Pages」。网页的「单词包」页顶部就会出现「第一步 · 去夸克网盘下载」卡片，带「打开夸克网盘」和「复制提取码」按钮。
5. **用真机测一遍**（见第 7 节清单）。

## 4. 生成与检查单词包

```bash
python3 scripts/pack/build_packs.py kits        # 按 CEFR 难度的旧套装 + core，输出到 packs/
# 学段套装（推荐）：词表在 data/wordlists/，例如
python3 scripts/pack/build_packs.py kit --id list-junior --name "初中包" --ids-file data/wordlists/ids-junior.txt --out packs/lists
npm run packs:base -- --out packs/by-level      # 可选：按难度拆的小包
npm run packs:verify                            # 用手机端同一套代码检查每个包（校验和、路径、词条）
```

内容改动后加 `--version 2`（每次加 1）重新生成，并把新文件覆盖上传到夸克。客户再次导入会替换旧版，旧版里多出来的文件会被清理。

## 5. 自定义套装（`kit` 命令）

```bash
# 按难度和话题
python3 scripts/pack/build_packs.py kit --id kit-travel --name "旅游场景" --levels A1 A2 B1 --topics travel city

# 按自己的词表（每行一个词或词条 id，# 后是注释）
python3 scripts/pack/build_packs.py kit --id kit-junior-pep --name "初中人教版" --ids-file lists/junior-pep.txt

# 只带缩略图和英美发音，包更小
python3 scripts/pack/build_packs.py kit --id kit-lite --name "精简包" --levels A1 A2 --parts thumb uk us
```

`--parts` 可选 `img thumb uk us ex ex2`。

## 6. 以后新增单词：做一个新词包

1. 建一个文件夹，例如 `new-2027-01/`：

   ```
   new-2027-01/
     words.json                 词条（见下表）
     img/<id>.webp|png|jpg      插画（可选，会自动缩成 512 / 256 两种尺寸）
     audio/uk/<id>.mp3          英式发音（可选）
     audio/us/<id>.mp3          美式发音（可选）
     audio/ex/<id>.mp3          例句 1 发音（可选）
     audio/ex2/<id>.mp3         例句 2 发音（可选）
   ```

   `<id>` 默认是单词的小写形式（空格等符号变成 `-`），也可以在 `words.json` 里自己写 `id`。

2. `words.json` 是一个数组，每个词的格式和 `data/word-atlas.json` 一样：

   | 字段 | 必填 | 说明 |
   |---|---|---|
   | `w` | ✓ | 单词 |
   | `cefr` | ✓ | `A1` `A2` `B1` `B2` `C1` `C2` 之一，决定它排在学习路线的哪里 |
   | `topic` | ✓ | `education work technology science environment health society government economy media arts travel city nature daily emotion thinking sport history` 之一 |
   | `senses` | ✓ | 释义数组 `{pos, zh, en}`，最多 3 个，第一个会显示在列表里 |
   | `ex` | ✓ | 例句数组 `{en, zh}`，最多 2 个 |
   | `uk` `us` | | 英式、美式音标 |
   | `col` `fam` `syn` `ant` | | 搭配、词族、近义、反义（字符串数组） |
   | `tip` `note` | | 易混提示、用法提醒 |
   | `id` | | 不写就由 `w` 生成 |

3. 生成并检查：

   ```bash
   python3 scripts/pack/build_packs.py words new-2027-01 --id new-2027-01 --name "2027年1月新增词" --out packs
   npm run packs:verify
   ```

   命令会检查每一条（cefr/topic 写错、缺释义、id 重复都会明确报错）。缩放图片需要 `cwebp`（`brew install webp`）或 Pillow。

4. 把 `packs/new-2027-01.phemor` 传到夸克，或直接用微信发给客户。

安装后新词自动并入学习路线，按难度插到对应位置，**不影响已有的学习进度**。

**勘误**：在 `words.json` 里写一个**已有的 id**（例如 `library`）和新的内容，打包后客户安装即替换旧词条。没带图片和发音的勘误，会自动保留原来的图片和发音。

## 7. 真机测试清单（上线前必做）

这几件事在电脑上无法验证，请在一台 iPhone 和一台安卓上各走一遍：

- [ ] 在手机浏览器（iPhone 用 Safari）打开 `phemor.com/`，添加到主屏幕，从桌面图标进入。
- [ ] 夸克网盘：**非会员下载一个 150–200 MB 的包要多久？**（决定要不要把包拆得更小）
- [ ] 下载完成后，在 App 里点「选择单词包文件」，**能不能看到夸克下载的文件**？（iPhone 要先「存储到文件」；若看不到，换成微信发文件的方式）
- [ ] 导入后开飞行模式：看图、点发音、打开一个没浏览过的单词。
- [ ] 退出主屏幕 App 再进入，包还在。

## 8. 限制与注意

- **微信内置浏览器不行**：不能添加到主屏幕，也留不住离线内容。把 `https://phemor.com/#/install` 发给客户，页面里有「在微信里」的指引。
- **文件扩展名别改**：夸克下载下来的 `.phemor` 不要改成 `.zip`（iPhone 的「文件」会自动解压）。
- 夸克没有直链、不允许网页跨域读取，所以只能「先下载到手机，再导入」，不能在 App 里直接点下载。
- **iPhone**：只在 Safari 里用时，系统约一周不打开会清理网页数据；**添加到主屏幕之后不会**。安装包时 App 也会申请「永久保存」。
- **空间**：5 个包合计约 700 MB，空间不够时 App 会提示，客户只装自己阶段的包即可。
- 两个包含有同一个文件时，移除其中一个包会把共有的文件一起删掉，之后该词回到文字插画 + 机器朗读。
- 学习进度存在手机浏览器里，和单词包互不影响；换手机请用「我的 → 数据 → 导出备份」。

## 9. 常见问题

| 现象 | 原因与办法 |
|---|---|
| 「文件不完整，或者不是单词包」 | 文件没下完。重新下载 |
| 「校验失败」 | 传输中损坏，重新下载这个包 |
| 「手机存储空间不足」 | 清理手机空间，或移除不用的包 |
| 微信里点不了导入 | 先把文件保存到「文件」，再在浏览器版 / 主屏幕版里选择 |
| 装了包，离线发音还是没有 | 看「单词包」页第二行是否显示「离线模式已开启」；没有的话联网再打开一次页面 |
| 安卓浏览器没有「添加到主屏幕」 | 换 Chrome / 系统自带浏览器；国产浏览器菜单里通常叫「添加到桌面」 |
| 网页打开是旧版本 | 网页每次联网会检查更新；关掉主屏幕 App 再打开一次 |
| 想临时换另一个包目录 | 打开 `#/packs?url=` 加上以 `.json` 结尾的目录链接（「单词包」页已不再提供粘贴框） |

## 10. 开发者笔记

- 包格式：`pack.json`（`format:1`，`id`，`name`，`version`，…）+ 可选 `words.json`（`{rows, entries}`）+ `files/<站内路径>`。路径白名单见 `src/packs/spec.ts`（只允许 `atlas/`、`sfx/`、`brand/` 下的图片、音频、词条 JSON）。导入时所有来自包的数据都会被重新校验和裁剪（外部媒体地址会被丢弃）。
- 文件（图片、发音）存放在 IndexedDB `phemor-packs` 的 `files` 仓库，一个文件一条记录，键是原来的完整站内网址（`urlFor(path)`），所以页面代码不用改；`sw.js` 先查它，再查小缓存，最后（仅当还有旧格式的包）查 Cache Storage `phemor-packs`，都没有再联网，并支持 Range（iPhone 播放音频必需）。
- 为什么不用 Cache Storage：iPhone 第一次碰一个存了几万个文件的 Cache Storage，要把全部记录读一遍，实测 16 秒以上，这期间所有 `caches.*` 调用都排队，App 启动被拖住。数据库按键取值不受影响。旧格式（`InstalledPack.store` 缺失）的包仍然能用，只是启动慢；移除后重新添加就会换成新格式。`meta/legacy` 记录告诉 `sw.js` 还有没有旧格式的包。
- 词条文字存在 IndexedDB（`phemor-packs`），启动时和 `atlas/index.json` 合并（`src/atlas/merge.ts`）。
- 后台预载：`src/atlas/data.ts` 的 `warmEntries()` 在页面空闲时逐个请求 `atlas/entries/N.json`（间隔 150 ms，省流量模式和断网时跳过）。
- 页面、脚本、样式、`index.json`、词条文字都是「联网优先（浏览器 HTTP 缓存几毫秒就答），联网失败或 4 秒无响应才用本机副本」，副本在 Cache Storage 醒来后才保存，不拖慢首屏；图片发音「本机有就直接用」。
- 测试：`npm test`（格式、合并逻辑）；`npm run packs:verify`（检查生成的包）；`scripts/pack/e2e.py`（真实浏览器里走一遍：预载词条、夸克卡片、下载、导入、断网、断网后播放发音；先用 `scripts/pack/make_e2e_fixture.py` 生成测试站点，用法见文件头，需要 Playwright）。
