# dsh-file-menu

在对话里直接用默认程序打开文件。

- **左键**（原有行为）：在右侧栏打开预览。
- **双击**：用默认程序打开（第二次点击被插件接管，所以不会预览两次；文件不存在时在底部提示一行）。
- **右键**：菜单 —— 用默认程序打开 / 复制完整路径。

## 组成

| 半边 | 文件 | 作用 |
| --- | --- | --- |
| Host | `index.js` | 注册 `/.dsh-file-menu` 路由（`stat` / `open`），把路径交给桌面打开（`rundll32` / `open` / `xdg-open`）；目录则在文件管理器中打开 |
| Client | `client.js` | `shell.overlay` 里的右键菜单与提示条，拦截对话中文件名的 `contextmenu` 与双击 |

Host 路由通过 `ctx.inject(['webServer'])` 注册：浏览器载体由别的 row 挂载，启动顺序靠后也能装上。

## 路径识别

对话里的文件名是 `<button data-ref-chip>`，路径不一定在 DOM 上（图片 chip 的 `title` 被置空），所以候选来自三处：

1. DOM 属性：`data-path` / `data-file` / `data-href` / `<a href>` / `title` / `aria-label`，含 `dsh-resource://file/session/<id>/<path>` 地址；
2. **React props / fiber** 里的组件属性（如 `file.path`）；
3. 裸文件名（`树名单_本图.csv`）按当前会话工作目录拼成绝对路径。

候选按「离得近的优先、同一距离下有完整路径的优先」排序，再逐个向 Host 核实哪个真的存在，第一个存在的胜出。
去掉 ``` ` ``` 、尖括号、`@`、`:12:3` 行号与 `#L4-L8` 片段；从长句里抠路径时只取带盘符或根的那个子串。

## 配置

无 `config`。卸载或停用该 bundle 即整体移除（Host 路由与浏览器端菜单一起消失）。
