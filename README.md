# dsh-starmap · 记忆星图

把 DSH 的会话记录和 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)（DSH 的「记忆系统」）画成一张会转的 3D 星图，挂在左侧栏里。只读，不写回任何记忆。

## 现在是什么结构

四层天体，每一层都有自己的公转：

| 层 | 是什么 | 怎么动 |
| --- | --- | --- |
| 银心 | 一个工作区（`cwd`） | 整团缓慢自转 |
| 恒星 | 一次人类对话（`origin !== 'subagent' && users > 0`） | 绕银心公转，越靠内越快 |
| 行星 | 那次对话产出的记忆 | 绕自己的恒星公转，内圈快、外圈慢 |
| 卫星 | 子代理会话（mnemon 子代理写文档的那一次） | 绕它归属的那颗行星公转 |

恒星之间还有一条「时间链」：同一个工作区里按开始时间把相邻两次对话串起来，光点沿链往下传。

## 数据从哪来

- **会话索引**：`~/.dsh/sessions/**/session.v4.jsonl.zstd`。这些日志是**多帧 zstd**，一次 `zstdDecompressSync` 只能拿到第一帧（head 那一行），所以要用 `zstdFrames()` 逐帧切、逐帧解。子代理会话只解首帧（`users/title` 不用），否则一次全解要几十秒。
- **记忆**：`runtime/memories.json` + `MEMORY.md`/`USER.md`（运行时记忆）、`documents/index.json`（项目档案）、`data/<space>/mnemon.db`（记忆空间 insight）。
- **归属**：
  - 项目档案 → 看 `sessionIds`，命中的子代理会话就是它的卫星，1:1 挂上去；
  - 文档若指向的是普通会话，那颗会话就是它的恒星；
  - 运行时记忆没有 session 字段，只能按时间归属：在所有「时间窗包含它」的对话里挑跨度最短的那一个，兜底取时间上最近的对话。
- 记忆仓根默认 `F:\Memory`（存在时），其次 `~/.mnemon`，可用 `DSH_STARMAP_MEMORY` 覆盖。工作区子目录名 = `sha256(cwd)`，和 dsh-mnemon 的 `workspaceStorageId` 同一套算法。**改工作区的显示名不影响它**（路径没变）；改文件夹名才会对不上号。

## 依赖：dsh-mnemon

本插件自己不存记忆，读的是 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)（DSH 的「记忆系统」）落在本机的那份数据。它有三种记忆，星图三种颜色正好一一对应：

| 星图里的 | dsh-mnemon 里的 | 读的文件 |
| --- | --- | --- |
| 运行时记忆（金） | Runtime memory | `runtime/memories.json`、`MEMORY.md`、`USER.md` |
| 项目档案（紫） | Project Documents | `documents/index.json` 里 `status=active` 的那些 |
| 记忆空间（青） | Memory Spaces | `data/<space>/mnemon.db` 的 `insights` 表 |

**只读**：不调 dsh-mnemon 的写入接口，也不改它的任何文件。

前提是 dsh-mnemon 的存储按工作区划分（per workspace），也就是 `<root>/workspaces/<sha256(cwd)>/…` 这套布局。
如果换成了全局存储、集中存储或别的目录，用环境变量 `DSH_STARMAP_MEMORY` 指到实际位置，否则星图会读空。

会话（恒星/卫星）来自 DSH 自己的 `~/.dsh/sessions`，跟 dsh-mnemon 无关。


## 布局

- **主星团**（记忆最多的那个）走五条旋臂：对数螺旋，缠绕约 4.6 弧度，越往外越散，尾巴张开。
- **其他星团**不做螺旋，是不规则云团，最小半径 240 —— 先给以后的新对话把地方留出来。
- 行星轨道 `r = ORBIT_BASE + ORBIT_DR * pow(ring, 1.14)`，同圈再按 id 哈希抖半径、抖相位、抖倾角，不然远看是一串同心花环。
- 团与团之间按半径算环形排布，`CLUSTER_GAP` 留出空隙，不重叠。
- 三个独立时钟：恒星自转、行星公转、卫星公转，各有开关，关掉只是停住、不会跳回原点。远景（镜头拉远）时卫星直接停掉、也不再绘制。

## 视觉

- 星团是「星云团」：中心亮核 + 几团絮状气体 + 暗尘 + 弥散星点，形状按星团 id 生成、各不一样；主团外面再叠一层贴着旋臂的淡雾。
- 近景会主动退场：`fogFade`（气团变淡）、`nearDim`（整体压暗）、`haloFade`（底光退场）、单个气团超过 300px 直接不画。所以「远处看星系，靠近看星星」，贴到脸上不会糊成一片白。
- 空工作区不画星云，只留一个虚线圆 + 一颗暗红小核。
- 数据流：行星 → 自己的恒星、恒星 → 下一颗恒星，各画一条淡线，线上跑三节拖尾的光点，颜色取源节点的星团色。
- 星团配色按工作区 id 哈希钉死，多一个工作区不会让所有配色挪一位。

## 面板里能干的事

- **搜索**：输入片段，命中的亮、其余压暗；回车飞向第一颗命中。
- **时间轴**：拖到某个时间点，只留那之前记下的记忆。
- **记忆构成**：点一行只留那一类（运行时记忆 / 项目档案 / 记忆空间 / 尘埃）。
- **尘埃层**：把记忆里提到的实体名词当背景星尘叠上去。
- **褪色**：越久没被碰过的越暗，但不隐藏。
- **恒星自转 / 记忆公转 / 卫星公转**：三个开关。
- **复位视角**：镜头回到主星团跟前。
- **手感设置**：旋转/平移/缩放速度、阻尼、相机远近上下限。
- **重新读取**：绕开缓存重读记忆仓。

鼠标：左键拖转视角、右键拖平移、滚轮缩放（不跟鼠标跑，滚一格不会漂）。点一下星体出详情卡片；悬停时它牵着的线会亮。

## 性能

- 宿主侧图缓存 20 秒（`/api/graph?refresh=1` 可绕开）。
- 会话索引单独缓存在 `~/.dsh/dsh-starmap/sessions.json`，用「所有会话文件的 size+mtime 指纹 + 版本号」判断要不要重扫；全量扫描约 2 秒（1300+ 个会话、解压后 200MB+）。
- 绘制在 2D canvas 上，30fps 封顶；3D 节点 `nodeOpacity(0)` 只用来拾取，所以缩进缩出时点大小是连续变化的。

## 安装

```bash
# 在 desktop profile 里挂成本地目录依赖
node install-patch.mjs
```

或者手工：在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里加
`"dsh-starmap": "file:<本目录>"`，并把 `dsh-starmap` 加进 `dsh.profile.bundles`。
profile 里 `file:` 依赖是**复制**不是软链，改完源码要重新复制 `lib/` 进 `node_modules/dsh-starmap/lib/`，然后重启 DSH。
