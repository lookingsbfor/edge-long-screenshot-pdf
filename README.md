# edge-long-screenshot-pdf

一个 Tampermonkey / 油猴脚本：把当前网页整页截成长图，按 **A4 比例**拆分成若干块，可导出为分页 PDF，或把每一块单独保存成图片。

## 能解决什么

- 网页太长，浏览器自带截图工具要么截不全、要么只给一张看不清的超长图
- 需要把网页内容打印 / 归档成 A4 尺寸的 PDF
- 需要把长页面切成若干张图片发出去（聊天工具对单张图片尺寸有限制）

## 安装

**方式一：从 GitHub 直接安装**

先装 [Tampermonkey](https://www.tampermonkey.net/)，然后打开：

```
https://github.com/lookingsbfor/edge-long-screenshot-pdf/raw/main/edge-long-screenshot-pdf.user.js
```

Tampermonkey 会自动识别并安装；脚本头带 `@updateURL`，后续可在面板里一键检查更新。

**方式二：本地安装**

Tampermonkey 控制面板 →「实用工具」→ 把仓库里的 `edge-long-screenshot-pdf.user.js` 拖进浏览器窗口 →「安装」。

依赖通过 CDN 加载（`@require`），首次使用需要联网：

- `html2canvas@1.4.1`
- `jspdf@2.5.1`

## 使用

1. 打开任意网页，右下角出现「网页长截屏」面板，点击「开始截图」
2. 脚本自动向下滚动，触发懒加载内容（图片、评论、无限滚动列表等）
3. 渲染完成弹出预览，可选：
   - **导出 PDF（分页）**：A4 纵向分页输出
   - **分割存图片**：逐张下载拆分后的图片（默认 JPEG，质量 0.92）
4. `Alt + Shift + S` 收起 / 展开面板；`Esc` 关闭预览

## 可调参数

脚本顶部 `CONFIG` 对象，改完刷新页面即可生效：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `imageType` | `image/jpeg` | 改成 `image/png` 可无损输出，但体积大很多 |
| `imageQuality` | `0.92` | 仅对 JPEG 生效；PNG 的 quality 参数会被浏览器忽略 |
| `a4WidthMm` / `a4HeightMm` | `210 / 297` | 改这两个值即可输出其他纸张比例 |
| `loadTimeout` | `15000` | 动态内容加载总超时（ms），懒加载慢的站可调大 |
| `scrollDelay` | `800` | 每次滚到底后的等待（ms） |
| `hideFixedElements` | `false` | 置 `true` 过滤页面里 `position:fixed` 的悬浮元素 |
| `maxCanvasPixels` | `180MB` | canvas 面积上限，超长页面会自动下调采样倍率 |

## 实现要点

| 环节 | 做法 |
| --- | --- |
| 动态内容加载 | 按视口高度的 80% 逐步滚动，直到 `scrollHeight` 不再增长或超时 |
| 整页渲染 | `html2canvas` 捕获 `documentElement`，传 `windowWidth/windowHeight/scrollX/scrollY`，避免 fixed 元素重复渲染 |
| 尺寸保护 | 按浏览器 canvas 上限（面积约 2^28 px、单边 65535 px）自动下调 `scale` |
| A4 分页 | 块高 = 画布宽 × (297 / 210)，每块比例恒等于 A4；末页按实际高度计算，不拉伸 |
| 内存控制 | 预览与下载统一走 Blob URL，渲染完成后立即释放原始大画布 |

## 已知限制

- `html2canvas` 不是真实渲染引擎，以下场景可能缺失或错版：`iframe`、视频画面、WebGL / Canvas 画布、复杂 `filter` / `backdrop-filter`、部分字体图标
- 跨域图片需要目标服务器返回 CORS 头，否则该图位置留白（已开启 `useCORS`）
- 超长页面（数万像素）生成耗时较长，PDF 体积偏大；只做归档时建议用 JPEG 图片而非 PDF
- A4 切块是纯几何切分，不保证避开文字或图片的中缝

## 版本

- **3.1**：修正 A4 切块比例错误（旧版未考虑 `devicePixelRatio`，导致分页数量错误且画面被拉伸变形）；新增 canvas 尺寸保护；改用 Blob URL；默认输出 JPEG；多图下载改为间隔触发；`@grant` 改为 `none` 提升兼容性
- **3.0**：新增分图保存
- 更早：基础长截屏与 PDF 分页

## License

MIT © lookingsbfor
