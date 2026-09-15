# Orange Local Dictionary v1.2

v1.2 Base Quick 每 entry 最多两个去重义项，沿用 POS 分组及排序；运行时单候选最多两义，双候选各最多一义。
仅 Base 自动 meaning 清理明确的纯词形转指和词形括号，保留其他语义括号；不平衡括号仅移除未配对字符，保留正文并正常分义。
旧 entry admission / ID / POS / Forms / priority / exact-surface IPA 保持不变。清理后空义行保留身份，不占义项槽位。
用户已选择方案 B：所有现有候选均无 lexical meaning 时为 Base semantic MISS，沿用 Model Quick fallback，不新增无释义状态，不强制点击 Detail；不恢复 morphology 噪声。
User Override 完整文本不裁剪，Model Quick 与 Detail 的职责和输入不变，Generated Cache 仍关闭。
builder/dictionary 版本为 1.2.0，schema 仍为 2。发布前需两次独立构建及全库审计。

离线 Builder 只使用 Python 标准库，输入为官方 ECDICT SQLite Release。
运行时只认识 Orange `entries/forms/meta`，不读取上游表结构。

## 已核对的数据源

- Release: https://github.com/skywind3000/ECDICT/releases/tag/1.0.28 （2017-09-20）
- Package: https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip
- ZIP SHA256: `ea01f76a3b3351021ce47077e89234465cc9441c8793054495320d06c0c3f3f6`
- 包内仅 `stardict.db`，851,288,064 bytes；SHA256:
  `2b5b40c2bdba04da0a51c8672e090f166987d5d895f32eb3fbfc5a516455fc75`
- 对应 tag LICENSE 为 MIT，Copyright (c) 2017 Linwei。
- 使用包内 word/phonetic/translation/pos/bnc/frq/exchange；不使用独立 lemma.en.txt。
- 包内未发现额外许可文件。此核对依据发布者公开许可，不代表逐条历史素材权利担保。
- 发布时必须携带 `desktop/src-tauri/resources/dictionary/ECDICT-LICENSE.txt`。

## 构建与复现

在仓库根目录运行（将 source 改为独立下载缓存的绝对路径）：

```powershell
& gateway/.venv/Scripts/python.exe -X utf8 tools/dictionary_builder/build_dictionary.py --source C:/path/to/stardict.db --output desktop/src-tauri/resources/dictionary/orange_dictionary.db
& gateway/.venv/Scripts/python.exe -X utf8 -m unittest discover -s tools/dictionary_builder -p 'test_*.py'
```

Builder 拒绝覆盖已存在的 DB。更新时先构建到新的目录，验证后再替换发布资产。
每次生成同目录 `orange_dictionary_build_report.json`。内容排序确定性；built_at 与构建耗时是运行元数据，不要求文件逐字节相同。
上游下载缓存放系统临时目录，不放源码或发布资源。

## 范围与语义

- 只收当前 Word Quick 可查询的无空白 surface，不扩大 Sentence/phrase 分类。
- Entry identity：NFC、首尾空白清理、小写化，保留标点；`.use` 与 `use` 是不同 entries，不再抢占。
- Lookup：保留现有 NFC、首尾常规标点去除、小写化；内部连字符、撇号保持。
- 去标点 alias（含其 exchange 转指）只在没有 canonical entry 的 surface 回退；有普通词条时不混入标点词条语义。其他 semantic 排序仍为频率主导。
- POS 合并 vt/vi→v，按上游 POS 比例排序；释义按 POS 分组轮流取，词条最多 2 义。
- 领域标签去除，括号内逗号不切分；超过 60 字符的单义不强行截断。
- 纯词形转指说明不当成释义；未知关系不推断，仅由 exchange 建立 forms。
- forms 主键为 `(surface, entry_id)`；频率为主、exact 为辅助排序；最多 2 候选，合并最多 2 义（双候选各最多 1 义）。
- 两个候选仍隐藏 lemma，保持原 POS/meaning 合并规则，不进行语境消歧。
- Schema 2 独立 `surface_phonetics(surface PRIMARY KEY, phonetic)`：在释义过滤前收录 exact lexical surface 非空音标（最多 256 字符），故 gave 即使无独立语义 entry 也保留自身发音。
- 标点 alias 不提供音标。Runtime 用 selected normalized surface 查音标，缺失为空，不借 lemma，不因多候选清空，不联网补全。上游多读音字符串原样保留（仅 trim）。
- schema 1 旧库兼容原行为，schema 2 缺表或超长音标走已有 Base 错误回退；未知 schema 同样回退。仅新 schema 2 提供上述独立音标保证。
- 上游短义排序未必最常用，v1 不用模型挑选或重新解释词义。

## Desktop 集成与打包

`dictionary.rs` 在统一 live Quick claim/current gate 后、Gateway 设置/鉴权之前查询。
本地源独立校验，转成现有内部 Quick 展示结构；网络 strict parser 不变。
本地/网络共用 `apply_quick_success`、Detail Ready 和最终 current publish gate。
本地成功的 HTTP status 为 None；诊断 localDictionary 标明来源，不在 Popup 加标签。
Detail builder 始终仅使用原始 selection target/context/pageTitle/captured mode。

Tauri resources 将资源目录映射到运行目录 `dictionary/`，该目录与 EXE 一起交付，不能单独复制 EXE。
Base 以 SQLite READ_ONLY 打开。用户库位于 app data 的 `orange_user_lexicon.db`，与 `vocabulary.json` 分开。
测试版 release 使用 `npm run tauri -- build --no-bundle -- --offline`；生成后核对 release/dictionary 与源码资产哈希。

User Override 数据层提供 set/remove 和优先查询；没有新增编辑页面或公开 IPC。
Generated exact-surface 存储已具备，但生产安全门默认关闭，忽略已有缓存且不写新缓存。
安全测试只控制 Generated，不阻止 Base。切换模型只影响 MISS 和 Detail，不影响本地命中。
数据库缺失/错误回落模型，缓存写入失败不取消已成功的 Quick。普通日志不记录上下文或释义。

## 验证

```powershell
# desktop/src-tauri 目录
cargo test --offline -q
cargo test --offline --test local_dictionary_real -- --ignored --nocapture
```

真实数据测试显式 opt-in，输出仅固定公共词典样例；首次值含用户库创建，不能视为操作系统冷盘延迟。
真实模型安全测试另需授权，最多 12 次实际请求且禁用重试：
`gateway/.venv/Scripts/python.exe -X utf8 -m gateway.diagnostics.local_dictionary_cache_safety --execute`
不要为了重跑自动增加付费请求。完整 Prompt、响应、凭据不落盘。

真实验收测试读取 `desktop/src-tauri/tests/fixtures/dictionary_public_150.jsonl`，复用原审计中的 150 个公开样本和 source phonetic，真实调用 Rust resolve 比较；源码发布不需要携带私人 report_log。
重复构建以 entries/forms/surface_phonetics 逐行内容、排除 built_at 的 meta 以及排除耗时的 build report 一致为确定性标准；不要求带不同时刻 built_at 的 DB 二进制哈希相同。
