# dsh-file-menu

在对话里直接打开文件：右键选「打开方式」，双击用默认程序打开。

- **左键**（原有行为）：在右侧栏打开预览。
- **双击**：用默认程序打开，且**不再顺带打开右侧预览**——两下点击的间隔在约 0.26 秒内算一次双击，直接启动文件；间隔超过这个窗口就按两次单击处理，只开预览。判定只看这个时间窗，不看浏览器给的点击计数，所以单击和双击不会互相打架。文件不存在时在底部提示一行。
- **右键**：菜单
  - **打开方式** —— 列出这个文件类型能用的程序（与 Windows 自己的「打开方式」列表同源），当前默认程序排第一并标注「默认」；点一个即用它打开；
  - **选择其他应用…** —— 打开 Windows 的「选择一个应用以打开此文件」对话框（可改用别的程序，也可勾选设为默认）；
  - **复制完整路径**。

## 组成

| 半边 | 文件 | 作用 |
| --- | --- | --- |
| Host | `index.js` | 注册 `/.dsh-file-menu` 路由：`stat`（核实路径）、`apps`（列可用程序）、`open`（默认程序或指定程序）、`openwith`（系统对话框）；目录则在文件管理器中打开 |
| Host 辅助 | `openwith.ps1` | 通过 `powershell.exe` 调 Shell 关联接口（`SHAssocEnumHandlers` / `IAssocHandler` / `SHOpenWithDialog`），输出单行 JSON |
| Client | `client.js` | `shell.overlay` 里的右键菜单与提示条，拦截对话中文件名的 `contextmenu` 与双击 |

Host 路由通过 `ctx.inject(['webServer'])` 注册：浏览器载体由别的 row 挂载，启动顺序靠后也能装上。

「打开方式」列表不用注册表拼凑，而是调 `SHAssocEnumHandlers` 拿 Shell 自己那份：显示名是「画图」「WPS 图片」这类本地化名字，应用商店应用（UWP）也在内；默认程序通过 `AssocQueryString(ASSOCSTR_FRIENDLYAPPNAME)` 对照标注。点选后由 `IAssocHandler::Invoke` 带目标文件启动，参数与协议全按该程序注册的来。

`openwith.ps1` 首次运行会把互操作类型编译到 `%TEMP%\dsh-file-menu\assoc-<哈希>.dll` 缓存，之后只加载不编译。

## 平台与降级

- **Windows**：完整功能（列表 + 对话框 + 指定程序打开）。
- **macOS / Linux**：没有等价的「打开方式」枚举接口，菜单退化为原来的「用默认程序打开」一项。
- **Shell 接口不可用**（PowerShell 被策略禁用、脚本缺失等）：`apps` 路由返回失败，菜单同样退化为「用默认程序打开」，不会留下空菜单。

## 路径识别

对话里的文件名是 `<button data-ref-chip>`，路径不一定在 DOM 上（图片 chip 的 `title` 被置空），所以候选来自三处：

1. DOM 属性：`data-path` / `data-file` / `data-href` / `<a href>` / `title` / `aria-label`，含 `dsh-resource://file/session/<id>/<path>` 地址；
2. **React props / fiber** 里的组件属性（如 `file.path`）；
3. 裸文件名（`树名单_本图.csv`）按当前会话工作目录拼成绝对路径。

候选按「离得近的优先、同一距离下有完整路径的优先」排序，再逐个向 Host 核实哪个真的存在，第一个存在的胜出。
去掉 ``` ` ``` 、尖括号、`@`、`:12:3` 行号与 `#L4-L8` 片段；从长句里抠路径时只取带盘符或根的那个子串。

## 配置

无 `config`。卸载或停用该 bundle 即整体移除（Host 路由与浏览器端菜单一起消失）。

## 环境要求

Windows 自带 Windows PowerShell 5.1 即可，不依赖 pwsh 或第三方模块。
