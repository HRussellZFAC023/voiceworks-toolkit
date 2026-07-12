# ASMR.one 终极增强

社区驱动的 [asmr.one](https://asmr.one) 增强套件，以 [Tampermonkey](https://www.tampermonkey.net/) 用户脚本形式运行。提供本地 AI 语音转录、实时翻译、语义搜索等 25+ 项功能，兼顾性能与学习体验。

## 功能

### 语言学习

#### 学习模式 — 双语字幕
实时同步字幕，专为沉浸式日语学习设计。日文显示为主行，英文翻译可模糊显示在下方。自动加载 LRC 歌词文件，并与 Whisper 实时转录集成。中文字幕通过 Google Translate 自动翻译为日文，便于持续保持日语主线学习。

#### 实时转录 — 本地语音转文字
直接从播放器捕获有上限的实时音频；正常路径无需上传文件，也不会重复下载整条大型音轨。[Transformers.js](https://huggingface.co/docs/transformers.js) 在独立 Worker 中运行多语言 Whisper，可靠时使用 WebGPU，受限设备自动采用较小的 `whisper-tiny`/WASM 路径。实时捕获不可用时会先尝试宿主的低质量流；只有宿主明确报告不超过 32 MiB 时才允许完整流兼容解码。模型加载、推理、流读取和解码均有超时与恢复边界。转录结果按音轨缓存（90 天 TTL），支持导出 LRC、VTT 或未翻译的日语 TXT。

#### 神经翻译 - Web 翻译管线
翻译走远程 Web 管线（Google Translate 端点），具备主机轮换、重试退避、限流冷却、请求去重、原文回显检测以及共享缓存。面向用户的文本会跟随当前界面语言；中文界面可将日文标题、标签、评论和元数据直接翻译为中文。

可选填 OpenAI 兼容的翻译端点、模型和 API 密钥；失败时自动回退到 Google。系统会拒绝原文回显。原始日文转录可单独导出为 TXT。

#### 紧急播放列表备份
站点不稳定时仍可把个人播放列表与社区/公共播放列表分开导出为 JSON、CSV 或 TXT；最新 JSON 同时保存在用户脚本存储中。可选 Google Drive 上传会创建两个明确命名的文件，使用最小权限 `drive.file`。区域限制下，播放列表 API 会在直连失败后使用东京只读代理。

#### 界面翻译
按当前英文、中文或日文界面语言本地化平台的中日文 UI 字符串，并为常用控件使用快速静态映射。

### 搜索与发现

#### 语义搜索 — AI 驱动的发现
通过含义而非关键词匹配查找作品。使用 Jina v3 嵌入 API 对标题和描述进行向量化，存储于本地 IndexedDB。支持多语言查询和分页结果。

#### 高级搜索 — 多条件查询构建器
支持标签、社团、声优、日期范围、评分和价格的结构化搜索，支持 AND/OR 逻辑组合。包含搜索历史记录。

### 播放与沉浸

#### 电台模式 — 连续随机播放
跨整个库的随机连续播放。自动选择随机作品并按顺序播放所有音轨。健康检查和自动恢复机制确保流畅播放。播放状态跨页面刷新持久化。

#### 播放列表模式 — 顺序作品播放
精选播放列表播放，在播放栏中注入前进/后退导航控件。当前作品播放完毕后自动跳转至下一个。配合播放列表发现面板浏览和激活社区播放列表。

#### 随机播放
增强的播放列表随机播放，与宿主应用的原生随机控件集成。

#### 音频缓存 — 离线播放
可选的 IndexedDB 音频缓存，可用于离线重播并减少再次访问时的带宽。完整音轨的后台下载默认关闭，以免与播放器流重复下载；需要本地副本时可在设置中启用“离线音频缓存”。

### 媒体与可视化

#### 媒体查看器 — 内联画廊
支持图片和视频的点击展开灯箱，并提供始终可见的鼠标控件和独立打开按钮。图片按需验证后才显示；DLsite 图片优先使用日本中继，Cloudflare 返回的 HTTP 200 限制占位图会被识别并跳过。支持 JPG、PNG、GIF、WebP、MP4、WebM、MOV、PDF 等格式。

#### 播放器画廊 — 专辑封面浏览
集成于播放器封面区域的图片画廊，支持高对比度箭头/打开控件、滑动、键盘快捷键和相邻图片懒加载。

#### 音频可视化 — 实时频谱显示
使用 Web Audio API 的 40 条频率可视化。可折叠的紧凑视图和扩展的播放器集成视图。

#### 播放器全屏
基于 CSS 的播放器区域全屏扩展，快捷键：F。

### 进度与整理

#### 自动进度跟踪
自动跟踪收听进度。播放开始时标记为"正在收听"，音轨达到 80% 完成度时升级为"已收听"。进度标记显示在站点各处的作品卡片上。

#### 文件夹深入 — 智能目录导航
智能导航嵌套作品目录结构以查找音频内容。使用文件夹评分算法，按音频文件数量和内容相关性加权。

#### 平铺视图 — 替代文件浏览器
侧边抽屉面板，以平铺列表显示作品的所有文件。支持直接播放、灯箱图片查看和文件路径复制。

#### 作品树复制
批量复制作品文件路径和目录结构为格式化文本到剪贴板。

### 元数据与信息

#### 作品元数据面板
增强的元数据显示，包括社团信息、声优信息、发售日期等默认 UI 未显示的字段。

#### HVDB 交叉引用
在作品页面添加到 HVDB 数据库的一键链接，方便跨数据库查询。

#### 评论区
注入到作品页面的社区评论区，支持 localStorage 持久化存储和回复线程。

### 生活质量

#### 键盘快捷键
全面的键盘控制：Space/K（播放/暂停）、方向键（跳转/音量）、括号键（速度）、数字键（跳转百分比）、M（静音）、F（全屏）、B（模糊切换）、J（日语字幕切换）。

#### 无限滚动
使用 IntersectionObserver 替换分页，在首页、分类和搜索页面实现无限滚动。

#### 系统媒体集成
更新系统媒体控件（通知中心、锁屏）的作品元数据和封面。从系统媒体键控制播放。

#### 动态图标
将当前播放作品的封面显示为浏览器标签页图标。

#### 标签过滤
点击任意标签即时过滤，支持跨导航持久化过滤。

#### 路由状态同步
将视图状态（过滤器、排序、搜索查询）同步到 URL 查询参数，页面刷新后恢复。

#### JOI 工具 — 互动边缘游戏
集成 Whisper 实时转录的互动边缘游戏，监听语音命令，支持可配置难度。

#### SFW 模式 — 安全浏览
隐藏站点所有图片和缩略图，适合公共场所浏览。

#### 设置备份 — 导出/导入
将所有设置和偏好导出为 JSON 文件，可在新浏览器上导入恢复。

#### 播放器翻译 — 音轨标题翻译
通过 Web 翻译管线实时将播放器中的日文和中文音轨标题翻译为当前界面语言。

#### CJK 标签翻译
将整个 UI 中的 CJK 标签（作品卡片、搜索、过滤器）翻译为当前界面语言，并缓存翻译结果。

#### CORS 修复
透明代理解决跨域内容加载限制。

#### 区域语言封锁自动恢复
如果 ASMR.one 显示英文语言封锁页，用户脚本会通过中文优先的特权请求原地恢复可信前端，并预加载经过验证的延迟路由资源，避免后续页面切换再次触发英文优先请求；真实站点来源、登录和本地存储都会保留，也不会修改 Firefox 的全局网站语言设置。

#### 本地化
完整的英文、中文和日文 UI 本地化。所有用户可见字符串使用 `I18n.t()` 和 `I18n.format()` 插值。

## 安装

1. 在浏览器中安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 克隆仓库并安装依赖：
   ```bash
   git clone https://github.com/HRussellZFAC023/voiceworks-toolkit.git
   cd voiceworks-toolkit/asmr-one-ultimate
   npm install
   ```
3. **开发模式**：
   ```bash
   npm run dev
   ```
   打开 `http://localhost:5173/asmr-one-ultimate.user.js` 安装脚本。保持开发服务器运行，同时浏览 `https://asmr.one/`。

4. **生产构建**：
   ```bash
   npm run build
   ```
   在浏览器中打开 `dist/asmr-one-ultimate.user.js` 通过 Tampermonkey 安装。

## 测试

```bash
npm test                # Vitest 单元测试
npm run test:e2e        # Playwright E2E（无头 Chromium）
npm run test:e2e:headed # E2E 可视化浏览器
npm run test:e2e:ui     # Playwright UI 模式
npm run test:e2e:debug  # 逐步调试
```

测试在无头 Chromium 浏览器中运行，自动注入用户脚本，无需手动设置浏览器或安装 Tampermonkey。GM_* API 使用 localStorage 模拟。

## 架构

**用户脚本注入** — 通过 `KikoeruBridge` 单例挂钩宿主站点的 Vue 2.6 + Quasar 框架，暴露应用的 Vuex 存储、Vue Router 和 Axios HTTP 客户端。功能模块作为独立模块挂载，注册到中央生命周期。

```
src/
├── features/          功能模块（30+ 独立功能）
│   ├── components/    通过 FeatureController 挂载的 Vue 3 SFC
│   ├── radio/         电台模式子系统
│   ├── playlist/      播放列表模式子系统
│   ├── media/         媒体查看器子系统
│   └── settings/      设置面板和控件
├── services/          TranslationService、WorkService、DLsiteService
├── infrastructure/    KikoeruBridge、AudioCache、HttpClient、StorageManager
├── core/              Config、Utils、Cache、EventBus、Logger、CentralObserver
├── store/             AppStore（响应式状态）、ConfigStore
├── api/               REST API 客户端（Auth、Work、Playlist、History 等）
├── ui/                共享 UI 组件和辅助工具
├── composables/       Vue 3 组合式函数（可复用的响应式逻辑）
├── scrapers/          DLsite 及外部站点爬虫
├── styles/            CSS 变量、组件样式、布局修复
└── types/             TypeScript 类型定义
```

### 关键技术模式

- **CentralObserver** — document.body 上的单一 MutationObserver，功能模块注册回调以高效监听 DOM 变化
- **Web Workers** - Whisper 转录在主线程外运行，保证 UI 响应
- **WebGPU + WASM** - Whisper 采用 WebGPU 优先；嵌入模型可按设备能力回退到 WASM
- **远程翻译管线** - 主机轮换、重试退避、限流冷却、可取消任务与共享缓存，保证实时播放与拖动时的稳定翻译
- **IndexedDB** — 使用 `idb` 库存储向量嵌入、音频缓存和转录
- **GM Storage** — 通过 Tampermonkey 的 `GM_getValue`/`GM_setValue` 持久化用户偏好

### 技术栈

| 类别 | 技术 |
|------|------|
| 构建 | Vite + [vite-plugin-monkey](https://github.com/nicennnnnnnlee/tampermonkey-vite) |
| 语言 | TypeScript |
| UI 组件 | Vue 3 SFC（挂载到 Vue 2 宿主） |
| ML 推理 | [Transformers.js](https://huggingface.co/docs/transformers.js)（Whisper） |
| GPU 加速 | WebGPU API + WASM 回退 |
| 向量搜索 | Jina Embeddings v3 API + IndexedDB |
| 音频分析 | Web Audio API（AnalyserNode） |
| 测试 | Vitest（单元）+ Playwright（E2E） |
| 模糊搜索 | Fuse.js |

## 许可证

MIT
