# FMO 仪表盘

面向 FMO（业余无线电设备）的实时通联仪表盘：实时显示当前呼叫、最近通联、QTH、方位距离，支持中继切换、日志同步、消息、录音等。

本项目是 **二开（fork）增强版**，由 BG7ZGF 维护，在 [54dashayu/FMO-Dashboard](https://github.com/54dashayu/FMO-Dashboard)（作者 BH1JSS）基础上新增了皮肤布局、连接协议、自动录音等功能，并修复了多个问题。

- 原仪表盘：https://github.com/54dashayu/FMO-Dashboard （BH1JSS）
- 上游开源基础：BH5HSJ 的后视镜开源项目 https://github.com/dingle1122/FmoLogs
- 本二开仓库：`yuwan-jpg/fmo`（BG7ZGF）

---

## 新增 / 增强功能

### 🎨 多皮肤 + 多布局
- **6 款皮肤**：经典蓝、极光绿、暖阳橙、紫罗兰、玫瑰红、海洋蓝，深浅色各自适配
- **4 种布局**：经典、极简、驾驶舱、大屏看板
- 在「设置 → 外观主题」中即时切换并持久化

### 🔌 连接协议与认证
- 支持 `ws://` / `wss://`，以及 `http://` / `https://`
- 支持 FMO 开启「账号密码访问」时使用 `用户名:密码@地址` 认证
- 协议自动识别，地址栏可直接粘贴带协议或不带协议的地址

### 🎙️ 自动录音
- **按发言人自动分段**：发言开始录制、停止保存，文件名含呼号与中继名
- **始终录制（有声音就录）**：VAD 检测，静音自动分段
- 手动录制 / 回放 / 删除，Web 端存 IndexedDB，Android 存本地目录

---

## 本次更新（v2.0.2 修复记录）

### 🔄 日志同步
- **每次打开应用都全量同步一次 FMO 日志**（已添加地址时自动触发），不再受「1 小时内已同步」限制，确保打开即拿到最新通联记录；会话内定时增量同步逻辑保持不变。

### 🎙️ 分段录音修复
- **修复开头漏录**：新增连续预卷缓冲，自动分段开段时把事件到达前的话音开头一并录进来。
- **修复截断 / 没说完就断**：停止/换人时先录完一小段"尾音窗口"再收尾，结尾不再被切掉。
- **修复静音不停止**：新增静音兜底，发言人讲完但下一位不说话时，连续静音 4 秒自动收尾，避免一直录下去。
- **修复与上一条录音重复 0.几秒**：切段时清空预卷，下一段补头不再带进上一段的尾音。

---

## 在线体验

在线体验地址：<https://yuwan-jpg.github.io/>

## 下载与安装（新手必看）

**下载地址**：GitHub Releases → <https://github.com/yuwan-jpg/fmo/releases>

### 先看你的设备属于哪种情况

| 你的情况 | 该下载 / 使用哪个 |
|---|---|
| 什么都不想装，手机、电脑直接用 | 直接打开在线网页版：<https://yuwan-jpg.github.io/> |
| 安卓手机 | `FMO-Dashboard-Android-v2.0.2-debug.apk` |
| Windows 电脑（64 位，现在大多数都是） | `FMO-Dashboard-Windows-Desktop-x64-Setup-v2.0.2.exe`（安装版）<br>或 `FMO-Dashboard-Windows-Portable-x64-v2.0.2.zip`（便携版） |
| Windows 电脑（32 位，很老） | `FMO-Dashboard-Windows-Desktop-x86-Setup-v2.0.2.exe`<br>或 `FMO-Dashboard-Windows-Portable-x86-v2.0.2.zip` |
| Windows 7 老系统 | `FMO-Dashboard-Windows-Legacy-Win7-x86-v2.0.2.zip` |

### 怎么知道我的 Windows 是 64 位还是 32 位？

右键「此电脑 / 我的电脑」→「属性」，看「系统类型」显示的是“64 位操作系统”还是“32 位操作系统”。选错了也没关系，装不上/打不开就换另一个版本试试。

### 安装版和便携版有什么区别？

- **安装版（Setup.exe）**：像普通软件一样安装进系统，会生成桌面图标和开始菜单，一次安装以后直接用。
- **便携版（ZIP）**：免安装、绿色软件。解压后双击里面的 `start-windows.bat` 就能运行，不写系统、不残留，可以放 U 盘带着走。

### 下载后怎么用？

- **安卓 APK**：下载到手机后点击安装，提示“未知来源”时允许即可。
- **Windows 安装版（Setup.exe）**：双击运行，一路「下一步」安装完成。
- **Windows 便携版（ZIP）**：先**解压**（右键 → 全部解压），再双击解压出来的 `start-windows.bat`，浏览器会自动打开界面。
- **网页版**：直接打开 <https://yuwan-jpg.github.io/>，无需安装。

> 校验文件：`SHA256SUMS-*.txt` 是安装包的校验和，用于核对下载文件是否完整，普通用户可忽略。

## 使用

1. 部署网页版，或安装对应平台包
2. 在「设置」中添加你的 FMO 地址（局域网 IP / DDNS，支持账号密码）
3. 打开仪表盘即可看到当前通联现场

## 技术栈

Vite + Vue 3 + Pinia，跨端：Web / Capacitor (Android、iOS) / Tauri (Windows 桌面)

## 协议

本项目基于 MIT 协议开源，保留上游作者版权声明：BH5HSJ（FmoLogs）、BH1JSS（FMO Dashboard）与本二开作者 BG7ZGF，见 [LICENSE](LICENSE)。
