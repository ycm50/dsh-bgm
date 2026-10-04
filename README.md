# dsh-bgm

**DSH 背景音乐插件** —— 指定一个音乐文件夹，在对话中播放其中的音乐。

在「设置 → 通用设置」页面最下方（「当前版本」之下）新增一行**文件夹输入框**；
播放时屏幕上出现一个**可拖动的小卡片**，随时可以暂停或切歌。

**不改 DSH 本体任何一行源码。**

```
背景音乐文件夹                     [A:\Music        ] [浏览…] [播放] [下一首] [音量──] [✔]播放背景音乐
指定一个音乐文件夹，对话时自动播放其中的音乐
正在播放：月色小调.mp3
13 首
```

---

## 特性

| | |
|---|---|
| **文件夹输入框** | 手输路径，回车或失焦即保存；留空则不播放 |
| **浏览…** | 调用 DSH 原生目录选择器 |
| **播放控制** | 播放 / 暂停 / 下一首 / 音量 / 总开关 |
| **自动续播** | 一首放完自动下一首，整个文件夹当播放列表 |
| **可拖动卡片** | 播放时出现在屏幕上，拖到任意位置，位置会被记住 |
| **永远在最上层** | 不会被对话框、遮罩或全屏预览盖住 |
| **跟随文件夹变化** | 在资源管理器里删/加文件，不改任何设置也会被感知 |
| **不挡操作** | 浮层点击穿透；卡片只在播放时出现，空闲时完全不渲染 |
| **多格式** | mp3 / m4a / aac / flac / wav / ogg / opus / webm |
| **中文文件名** | 完整支持（正确的百分号编码与 UTF-8 传输） |
| **Range 支持** | `206` 请求，浏览器可跳转、长音频无需整段缓冲 |

---

## 安装

插件按 DSH 的 **bundle 层**接入 profile（默认 `~/.dsh/profiles/desktop`）。

### 1. 取得代码

```bash
git clone https://github.com/ycm50/dsh-bgm.git
```

包可以放在任意位置。下例假设放在 `D:\dsh-bgm`。

### 2. 链接进 profile

在 profile 的 `node_modules/` 下建一个目录联接（junction / symlink）：

```powershell
# Windows
New-Item -ItemType Junction `
  -Path  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-bgm" `
  -Target "D:\dsh-bgm"
```

```bash
# macOS / Linux
ln -s /path/to/dsh-bgm ~/.dsh/profiles/desktop/node_modules/dsh-bgm
```

### 3. 声明为 bundle

编辑 `~/.dsh/profiles/desktop/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-bgm": "file:D:/dsh-bgm"        // 或 link:D:/dsh-bgm
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …已有条目…
        "dsh-bgm"
      ]
    }
  }
}
```

### 4. 重启 DSH

> **为什么必须重启**：客户端模块图是**启动时快照** —— `client-modules` 在启动时
> 扫描 loader 条目、组合客户端 bundle。Host 半（音频路由）改完刷新页面即可生效，
> 但浏览器半要等重启才会被组合进模块图。

重启后打开「设置 → 通用设置」，拉到底部即可看到新的一行。

---

## 使用

1. 在输入框里填入音乐文件夹的绝对路径（例如 `A:\Music`），或点「浏览…」选择；
   按回车或点击别处即保存。
2. 状态行会如实报告当前情况：`还没有指定文件夹` / `这个文件夹不存在或无法读取` /
   `这个文件夹里没有可播放的音频` / `正在播放：<曲名>`。
3. 点「播放」。卡片出现在屏幕右下角，可拖动。
4. **关掉设置页，音乐继续播放。** 这是刻意的设计，见下文架构说明。

---

## 架构

```
dsh-bgm/
├── package.json         dsh.bundle.patch + dsh.client.platform
├── cordis.patch.yml     - insert: { id: dsh-bgm, name: dsh-bgm }
├── index.js             Host 半：Config schema + 两条音频路由
├── client.js            浏览器半：设置行 + 常驻播放器
└── _smoke/              102 条离线测试
```

### Host 半（`index.js`）

**设置声明。** `export const Config` 定义 `folder` / `enabled` / `volume`，三个字段
**全部 `.volatile()`**。这是关键：`dsh-settings` 只投影 volatile 字段，没有 volatile
字段的条目会被 `describe()` 整个跳过 —— 设置行永远不会出现。读值时要走
`readField()`，因为 volatile 字段在 `apply(ctx, config)` 里给的不是值，而是一个
`{ get() }` 引用。

**两条 HTTP 路由。** 浏览器不能读任意 `file://` 路径，而音乐文件夹在 web 根之外，
所以由 Host 通过现有的 `webServer` 暴露：

| 路由 | 作用 |
|---|---|
| `exact /plugins/dsh-bgm/manifest.json` | 扫描文件夹，返回曲目列表与状态 |
| `prefix /plugins/dsh-bgm/track` | 流式回传音频字节，支持 `Range` / `206` / `416` |

> **为什么不用一条 prefix 覆盖 `/plugins/dsh-bgm`**：web server 按最长前缀匹配，
> 那样会吃掉 `/plugins/dsh-bgm/client.js` —— 也就是本插件自己客户端 bundle 的 URL。
> 那个请求会命中本插件的 404，bundle 永远物化不出来，设置行也就永远注册不上。

**安全。** 只读取目录的**一层**；音频类型走白名单；曲目名必须是单一路径段
（禁 `/`、`\`、`..`、NUL），并做 `startsWith(folder + sep)` 兜底。

### 浏览器半（`client.js`）

贡献**两个条目**，它们之间的拆分就是整个设计的核心：

| 槽位 | id | 职责 | 生命周期 |
|---|---|---|---|
| `settings.general.item` | `dsh-bgm-folder` | 文件夹输入框 + 播放控件 | 仅设置面板打开时 |
| `shell.overlay` | `dsh-bgm-player` | **唯一的 `<audio>` 元素** + 卡片 | **帧级常驻** |

`shell.overlay` 是帧级浮层，位于所有面板的滚动容器之外、整个网格之上，所以那里的
条目**关设置页、切会话、切面板都仍在**。播放器不能和被它配置的那个界面共存亡。

两个条目通过**一个共享 store**（`createPlaybackStore`）通信，它缓存在 `globalThis`
上，以便客户端 HMR 重新求值 bundle 时复用那个活着的元素，而不是留下第二个哑掉的
播放器。**React context 做不到这件事**：行和播放器由不同的 owner 挂载，两条树都不
归本插件控制。

#### 卡片的拖动

用 **pointer events** 而不是 mouse events：一套代码覆盖鼠标/触屏/手写笔，而且支持
`setPointerCapture` —— 指针跑得比 React 重渲染快、或移出元素时，拖动依然有效。

- **点击 vs 拖动按距离区分**（4px 阈值），不按时长，所以卡片里的按钮仍能正常按。
- **抓取偏移从卡片自己实测的 `getBoundingClientRect()` 读取**，不是从 state 读。
  未放置时卡片用 `right`/`bottom` 定位，它的真实角只存在于布局里。
- **夹取**：每次移动和窗口 resize 都夹进视口。卡片自己就是唯一能停掉音乐的控件，
  不能让它跑出屏幕。
- **持久化**在 `localStorage`，读写都做防御（沙箱 frame 里会抛异常、可能存着坏值），
  两种情况都退回默认角落而不是崩掉。

---

## 测试

两个零依赖的离线套件，共 **102 条断言**：

```bash
npm test                          # 两个都跑
node _smoke/logic-smoke.mjs       # 51 条：Host 半
node _smoke/client-smoke.mjs      # 51 条：浏览器半
```

**无需 `npm install`。** `index.js` 里的 `@deepseek-ai/schemastery` 是 DSH 提供的
peer 依赖（本插件绝不自带副本 —— 那是让 Config schema 投影失败的原因），所以
`_smoke/` 里的解析钩子会去 DSH 的实际安装位置找它：先看插件自己的 `node_modules`，
再看各 DSH profile，最后直接从 `app.asar` 里读。找不到时会明确列出所有尝试过的
路径，也可以设 `DSH_SCHEMASTER_PATH` 手动指定。

**`logic-smoke.mjs`**（Host）覆盖：配置读取的两种形态、音频白名单、
**路径穿越 / 嵌套目录 / 绝对路径走私 / NUL / 畸形百分号编码**全部拒绝、
真实文件系统扫描、三种 manifest 状态，以及把两条路由挂在桩 `webServer` 上
真跑 HTTP 语义（`HEAD` 无 body、整档、中段/开放/后缀 Range、`416`、`404`、
中文文件名完整流出、**manifest 里每条 src 都能被字节路由真正流出**、
改文件夹后同一路由立刻改答案、坏文件夹回 200 空列表而不抛）。
最后一条断言直接检查 **Config 三个字段的 `meta.volatile === true`** ——
这正是「设置行会不会出现」的唯一闸门。

**`client-smoke.mjs`**（浏览器）把 `client.js` 装进桩 `__ModuleLoader__` 真求值、
用桩 React 真渲染两个条目，断言：恰好贡献两个条目；输入框的 value 来自设置文档
而非常量；**设置行里没有 `<audio>` 而浮层里有且仅有一个**（「关设置页音乐就停」
的回归闸门）；浮层空闲时不渲染；所有音量控件显示同一个值；以及拖动行为的
14 条断言（抓取偏移逐像素精确、阈值、夹取、pointer capture、按钮上不起拖、
非主键忽略、外来 pointerId 不能劫持、无按下时移动无效、持久化与还原、
坏 localStorage 值退化）。

### 开发中抓到的六个真 bug

测试不是装饰，这六个都是实际拦住的问题（其中两个由用户报告）：

1. **行组件用 `useContext` 取注入的 owner，但插件没有提供 provider** ——
   设置页直接挂载注册的组件，外面没有我们的包装层，于是 owner 恒为 `undefined`：
   输入框渲染出来但是空的、点了没用。改为通过 props 传 owner。
2. **`useState(folder)` 在首帧给 draft 播种，而首帧设置文档往往还没到** ——
   把空字符串永久冻进了 state，而负责纠偏的 effect 在同一帧读到的 `folder`
   也是空的，救不回来。改用 `null` 哨兵。
3. **关掉设置页音乐就停**（用户报告）—— `<audio>` 归设置行所有，行被卸载元素即
   消失。离线套件当时没有覆盖「卸载设置行之后播放是否继续」这个维度。
   修复见上文 `shell.overlay`，并补上了回归断言。
4. **拖动第一版有两个错** —— (a) 读存档的函数在没有记录时返回 `undefined` 而非
   `null`，绕过了所有 `position === null` 守卫；(b) 更隐蔽：`Object.assign` 把
   定位锚点合并到了 **props 对象**而不是 `style` 里，于是 `right`/`bottom` 变成了
   无意义的自定义属性，卡片一直停在浏览器默认位置 —— **看起来"能拖"，实际锚点
   从未生效**。第二个只有断言真实 px 值才能抓到。
5. **删掉的音乐还在播**（用户报告）—— 浏览器只在「文件夹设置变了」时才重读清单，
   而删文件不改任何设置，于是手里的曲目列表永远是旧的。见下方「已知陷阱」。
6. **卡片被对话框盖住**（用户报告）—— `zIndex: 40` 是本插件凭空定的数字，
   而 DSH 自己的层级是 1000–1100。见下方「已知陷阱」。
7. **拖卡片变成了拖整个窗口**（用户报告）—— 卡片飘到窗口顶部时落进了
   Electron 的窗口拖动区（`-webkit-app-region: drag`），操作系统抢走了手势，
   我的 `pointerdown` 根本没被调用。见下方「已知陷阱」。

### 一个关于测试自身的教训

第 5、6 个 bug 修复后，我先写了测试，跑出来是绿的 —— **但它们是假绿的**。
`sandbox` 里的 `check()` 是同步函数，`fn()` 没有 `await`：每个 `async` 测试体
返回一个 pending promise，里面的断言抛错根本传不到 `catch`，测试在函数返回的
那一刻就打印了 `ok`。

改 `check` 为 `async` + `await fn()` 之后，**当场有两个既有测试变红**，包括一条
从写完就没真正执行过的「revision 重试」断言。所以：**新增的每条断言都要反向验证
一遍（把修复撤掉，确认它会红）**，否则「测试通过」不代表任何事。本文档里五个
新测试都做了这个反向验证。

---

## 已知陷阱：文件夹是「别人家的状态」

这个插件最反直觉的一点：**音乐文件夹的内容不归它管**。用户在资源管理器里删一个
文件，DSH 侧不会收到任何事件 —— 没有设置变更、没有文件监听。第一版只在
「文件夹设置发生变化」时才重新读取，于是：

- 删掉的音乐**继续播放**；
- 更隐蔽的是，如果按索引跨刷新保留选中项，删掉靠前的文件会让后面所有文件**位置前移**，
  用户会突然听到**另一首歌**。

修复是三件事，缺一不可：

1. **按名字**而不是按索引跨刷新保留当前曲目；
2. 当前曲目消失时**停下来**，而不是滑到占用该位置的新歌；
3. 装上真正会触发的重读：`setInterval`（15 秒 TTL）、`visibilitychange`
   与窗口 `focus` —— 「回到标签页」正是刚删完文件的用户期待生效的时刻。

配套测试用可观测的定时器驱动真实 effect，并在打补丁前后各跑一遍确认它会红。

## 已知陷阱：`z-index` 不能用自己编的数字

卡片第一版写的是 `zIndex: 40` —— 一个本插件凭空定的数。DSH 自己的层级是
**1000–1100**（`1000` 是遮罩/对话框层，`1100` 是菜单层），所以卡片会被对话框、
全屏预览直接盖住。

这个值是**从打包产物里读出来的**，不是猜的：扫 `app.asar` 里所有 `z-index`
得到一个层级表，卡片取该表之上。测试里断言 `z-index > 1100`，回退到 `40` 会立刻变红。

## 已知陷阱：Electron 的窗口拖动区会吃掉手势

卡片飘到窗口顶部时**拖不动，拖动变成了拖整个窗口**。

原因在 DSH 的无边框窗口上：外壳用一条标题栏条带让窗口可拖动 ——

```css
[data-windows-titlebar] .BynINW_frame:before {
  height: var(--dsh-windows-titlebar-height);
  -webkit-app-region: drag;
}
```

**落在该条带上的任何子元素都会继承这个行为**，然后**操作系统在手势进入 JS 之前
就把它抢走了** —— 我的 `pointerdown` 连一次都没被调用。这也解释了为什么它只在
窗口顶部复现：`shell.overlay` 浮层覆盖整帧，卡片只有飘到那条带子上时才"落在"里面。

修复两层：

1. **CSS**：卡片声明 `-webkit-app-region: no-drag`。这是外壳自己的退出方式 ——
   那条带子上每个可交互元素都这么写（`_2H3hWW_toggle`、onboarding 卡片、webview）。
2. **JS**：`pointerdown`/真实移动时 `stopPropagation()`，这样即使页面里有别的
   祖先也带有按压语义，也不会同一次手势被处理两遍。

两条都有回归测试，且都反向验证过（撤掉任一修复，测试立刻变红）。
`no-drag` 只加在卡片上，**不影响窗口其他地方拖动**。

## 已验证的运行时事实

对本机运行中的 DSH 0.2.0-rc.2 实测：

- `cordis_inspect` → `include:dsh-bgm`，`status: "schema"`，三个字段均带
  `x-cordis.volatile: true`。
- 插件管理器 → `dsh-bgm` 已注册：`enabled: true, installed: true`。
- 客户端模块图 → 已组合进 application 批次，`clientPath` 解析到实际文件，
  并采集了 artifact 基线。
- `shell.overlay` 实时清单 → `dsh-bgm-player`（order 60）已在其中且 active。
- 实时 HTTP → manifest 列出真实曲目（含中文文件名的正确百分号编码），
  且 `Range: bytes=0-99` 回 **`206` + `bytes 0-99/1341066`**，MIME `audio/mpeg`。

## 未验证的部分

如实说明，以下是离线测试**证明不了**、只有真机能确认的：

- **视觉呈现**（真实主题下的间距、对齐、配色）。桩 React 能拦住「接线错了 /
  渲染抛了 / 值没接上」，拦不住「样式在真主题下难看」。
- **声音是否真的从扬声器出来**。
- **拖动的手感**（跟手程度、触屏表现）。
- Host 音频路由在**真实进程内**的端到端脚本未能通过 profile 的 `insert` 行挂上
  （同样的 `insert` 形式在两轮 HMR 之间行为不一致），故该路径的进程内验证未完成；
  同一批断言已由 `logic-smoke.mjs` 在桩 server 上覆盖并通过。

---

## 兼容性

| | |
|---|---|
| DSH | 0.2.0-rc.2（已验证） |
| 依赖 | 仅 `@deepseek-ai/schemastery`（peer，由 Host 提供） |
| 平台 | Web 客户端（桌面版 / 浏览器版） |

## License

MIT
