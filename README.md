# 校园清单 · AI 截图提取功能

在原有「校园清单」页面基础上，新增了一个 **🤖 AI 截图提取** 标签页。
上传一张聊天截图后，后端会调用多模态大模型，自动读出截图里的全部文字，
再从中提取关键词、生成结构化待办清单。

---

## 目录结构

```
.
├── public/
│   └── index.html      # 前端完整页面（原有功能全部保留，新增 AI 标签页）
├── server.js           # Node.js 后端：托管前端 + /api/ocr 接口
├── package.json
├── .env.example       # 环境变量模板
├── .gitignore
└── README.md
```

---

## 一、它是怎么工作的（为什么要后端）

```
浏览器（前端）                你的服务器（后端）              大模型 API
     │                            │                              │
     │  选截图 → 压缩成 base64    │                              │
     │ ───────────────────────→ │                              │
     │                            │  ① 带图片调用视觉模型       │
     │                            │ ─────────────────────────→ │
     │                            │ ←── 返回截图里的全部文字 ── │
     │                            │                              │
     │                            │  ② 带文字调用文本模型       │
     │                            │ ─────────────────────────→ │
     │                            │ ←── 返回关键词+待办 JSON ── │
     │ ←── 返回 {原文,关键词,待办} │                              │
     │  分三区展示 + 一键复制      │                              │
```

**API Key 只存在服务器的环境变量里**，前端代码里一个密钥字符都没有，
别人打开浏览器 F12 也看不到，不会泄露。

---

## 二、配置 API Key

### 第 1 步：复制配置文件

```bash
cp .env.example .env
```

### 第 2 步：编辑 `.env`，填入你的密钥

```bash
# 你的大模型 API Key（必填）
OPENAI_API_KEY=sk-你的密钥

# API 地址（默认 OpenAI，国内用户改成对应平台）
OPENAI_API_BASE=https://api.openai.com/v1

# 视觉模型（第一步读图，必须支持图片输入）
VISION_MODEL=gpt-4o

# 文本模型（第二步提取关键词/待办，可以用便宜的文本模型）
TEXT_MODEL=gpt-4o
```

### 各平台怎么填（任选一个你有 Key 的）

| 平台 | `OPENAI_API_BASE` | `VISION_MODEL` 举例 |
|---|---|---|
| OpenAI 官方 | `https://api.openai.com/v1` | `gpt-4o` / `gpt-4o-mini` |
| 通义千问（阿里云） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` / `qwen-vl-plus` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash`（便宜）/ `glm-4v-plus` |
| Moonshot 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-vision` |
| DeepSeek | `https://api.deepseek.com/v1` | （DeepSeek 暂无视觉模型，需换上面的） |

> 第二步的 `TEXT_MODEL` 可以用更便宜的纯文本模型（如 `gpt-4o-mini`、`qwen-plus`、`glm-4-flash`），省钱。

---

## 三、启动项目

### 1. 安装依赖（需要 Node.js ≥ 18）

```bash
npm install
```

### 2. 启动

```bash
npm start
```

看到下面的输出就成功了：

```
✅ 服务器已启动: http://localhost:3000
   视觉模型: gpt-4o
   文本模型: gpt-4o
```

浏览器打开 **http://localhost:3000** 即可。

### 3. 使用

1. 点右上角紫色按钮 **「＋ 录入待办」**
2. 在弹出的录入中心里，点最右边的标签 **「🤖 AI 截图提取」**
3. 把聊天截图拖进去（或点选文件、或直接 `Ctrl+V` 粘贴）
4. 点 **「🚀 开始 AI 识别」**
5. 等几秒，页面分三区展示：
   - 📝 **原始识别文字** —— 大模型读出的全文，右上角「📋 复制全文」一键复制
   - 🏷️ **提取关键词** —— 自动提炼的主题标签
   - ✅ **待办事项列表** —— 每条待办带标题、截止时间、优先级色条

---

## 四、部署到公网（让别人也能用）

因为是 Node.js 项目，和普通网站部署一样：

**最简单：用 Render / Railway / Vercel / 自己的云服务器**

1. 把代码推到 GitHub
2. 在部署平台上：
   - Build 命令：`npm install`
   - Start 命令：`npm start`
   - 在平台的环境变量设置里填上 `OPENAI_API_KEY`、`OPENAI_API_BASE`、`VISION_MODEL`、`TEXT_MODEL`
     （不需要在服务器上放 .env 文件，直接在平台后台加环境变量即可）
3. 部署完成后，别人访问你的域名就能用了

> ⚠️ 务必确认部署平台是**你的服务器在调大模型 API**，而不是浏览器直接调。
> 本项目架构已经是这样——前端只请求你自己的 `/api/ocr`，密钥永远不出服务器。

---

## 五、安全说明

- `.env` 已加入 `.gitignore`，不会被误传到 GitHub
- 前端所有请求都走 `/api/ocr`（相对路径），不包含任何密钥
- 后端 `express.json({ limit: '12mb' })` 限制了上传体积，防止超大图片打爆服务器
- 如果要给完全公开的人用，建议再加一层简单的限流（express-rate-limit），防止有人刷爆你的 API 额度
