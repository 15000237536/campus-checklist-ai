/**
 * ==========================================================================
 *  校园清单 · AI 截图提取后端中转服务器
 * ==========================================================================
 *  作用：
 *    1. 托管前端静态页面（public/index.html）
 *    2. 提供 POST /api/ocr 接口：接收前端传来的 base64 图片，
 *       在服务器端调用多模态视觉大模型，分两步：
 *         第一步：视觉模型读出截图里的全部文字
 *         第二步：文本模型从全文中提取关键词 + 结构化待办清单
 *    3. API Key 只存在服务器环境变量里，前端永远看不到，杜绝泄露。
 *
 *  兼容所有 OpenAI 协议的视觉模型接口（OpenAI / DeepSeek / 通义千问 /
 *  智谱 GLM-4V / Moonshot / 本地 vLLM 等），只需改环境变量即可切换。
 * ==========================================================================
 */

const express = require('express');
const path = require('path');

// 自动从项目根目录的 .env 文件读取环境变量（如果存在）
try { require('dotenv').config(); } catch (_) { /* 生产环境可直接用系统环境变量 */ }

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// 配置（全部从环境变量读取，不要把密钥硬编码在这里！）
// ---------------------------------------------------------------------------
const API_KEY    = process.env.OPENAI_API_KEY || '';
const API_BASE   = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const VISION_MODEL = process.env.VISION_MODEL || 'gpt-4o';
const TEXT_MODEL    = process.env.TEXT_MODEL    || process.env.VISION_MODEL || 'gpt-4o';

if (!API_KEY) {
  console.warn('⚠️  警告：未设置 OPENAI_API_KEY 环境变量，/api/ocr 将无法工作。');
  console.warn('   请参考 README.md 配置后再启动。');
}

// ---------------------------------------------------------------------------
// 中间件
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '12mb' })); // 图片 base64 可能较大，放宽 body 限制
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 工具：调用 OpenAI 兼容的 /chat/completions 接口
//   model 参数显式指定用哪个模型（视觉模型 / 文本模型），不再靠猜
// ---------------------------------------------------------------------------
async function callLLM(messages, model, { jsonMode = false } = {}) {
  const body = {
    model,
    messages,
    temperature: 0.2,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`大模型接口返回 ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ---------------------------------------------------------------------------
// 工具：从 data:image/xxx;base64,yyyy 中拆出 mime 和纯 base64
// ---------------------------------------------------------------------------
function parseDataURL(dataURL) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataURL || '');
  if (!m) throw new Error('图片格式不正确，应为 data:image/...;base64,...');
  return { mimeType: m[1], base64: m[2] };
}

// ---------------------------------------------------------------------------
// 健康检查：浏览器访问 /api/health 可确认后端在跑、Key 配了没
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasApiKey: !!API_KEY,
    visionModel: VISION_MODEL,
    textModel: TEXT_MODEL,
    apiBase: API_BASE,
  });
});

// ---------------------------------------------------------------------------
// POST /api/ocr
// 请求体：{ image: "data:image/jpeg;base64,...." }
// 返回：  { rawText, keywords: [...], todos: [{title, deadline, description, priority}] }
// ---------------------------------------------------------------------------
app.post('/api/ocr', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: '服务器未配置 OPENAI_API_KEY' });
    }
    const { image } = req.body || {};
    if (!image) {
      return res.status(400).json({ error: '缺少 image 字段' });
    }
    const { mimeType } = parseDataURL(image);

    // —— 第一步：视觉模型读出截图里的全部文字 ——
    const visionPrompt = [
      '这是一张微信班级群聊天截图（深色模式）。请仔细逐行识别图片中所有文字，要求：',
      '1. 保留每条消息的发言人名字，格式如"张三: 消息内容"；',
      '2. 顶部被截断的置顶/重要提醒也要完整提取（即使文字显示不全，把能看到的部分都写出来）；',
      '3. 群聊里转发的聊天记录也要提取，标注为"[转发记录]"；',
      '4. 忽略"xxx移除了一条置顶消息""xxx置顶了一条消息"这类灰色系统提示；',
      '5. 忽略头像、表情包、图片占位符、输入框按钮；',
      '6. 按从上到下的顺序输出，保留时间标记（如13:54）；',
      '7. 不要猜测看不清的字，不确定的字用□代替。',
      '只输出识别到的纯文本，不要任何解释或总结。'
    ].join('\n');
    const rawText = await callLLM([
      {
        role: 'user',
        content: [
          { type: 'text', text: visionPrompt },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ], VISION_MODEL);  // ← 明确用视觉模型读图

    if (!rawText) {
      return res.json({ rawText: '', keywords: [], todos: [], note: '未识别到文字' });
    }

    // —— 第二步：文本模型从全文中提取关键词 + 结构化待办 ——
    // 重点：这是大学校园微信群/QQ群的聊天截图，要从闲聊中捞出真正重要的通知
    const secondPrompt = `以下是从一张大学班级群/课程群/社团群的聊天截图里提取出的全部文字：

"""
${rawText}
"""

你的任务：从上面乱糟糟的聊天记录里，**只挑出对学生真正重要、需要行动的通知**，忽略闲聊。

【哪些内容要重点关注】
- 讲座 / 宣讲会 / 分享会：名称、时间、地点、报名方式
- 报名 / 招募 / 竞选：什么活动、给谁报、截止时间、怎么报
- 作业 / 论文 / 实验报告：科目、题目要求、提交截止时间
- 考试 / 测验 / 缓考：科目、时间、地点、注意事项
- 缴费 / 选课 / 退补选：事项、截止时间、操作入口
- 会议 / 班会 / 团建：时间、地点、谁必须参加
- 比赛 / 项目招募 / 实习信息：名称、截止时间、面向谁
- 任何带明确 DDL、时间节点、需要"做什么"的通知

【哪些内容要忽略，不要提取】
- 同学之间的寒暄、"收到"、"谢谢"、表情包文字
- 老师说"好的"、"嗯"之类的回应
- 已经过期很久、只是被翻出来的旧通知
- 纯通知没有任何行动要求的（比如"明天天气不错"）

【输出要求】
1. keywords：3-8 个关键词，要具体——比如"外交部宣讲会报名"、"极限作业"、"青马班"这种，而不是"通知"、"学习"这种空泛词。优先提取：课程名、活动全称、组织名、关键时间词。
2. todos：每条是一个具体可执行的动作。
   - title：一句话说清楚要做什么（例："报名外交部考录宣讲会"、"提交第一章极限作业"）
   - deadline：原文提到的截止时间，保留原文写法（如"10月9日11:00"、"下周五23:59"），没有就留空
   - description：补充信息——地点、参与方式、面向对象、注意事项，没有就留空
   - priority：
     * high = 7天内截止、或明确要求"尽快/紧急"
     * mid = 一两周内、或需要报名但不急
     * low = 远期（超过一个月）、或可选参加的活动

严格只返回如下 JSON，不要有任何额外文字：
{
  "keywords": ["具体关键词1", "具体关键词2"],
  "todos": [
    {"title": "...", "deadline": "...", "description": "...", "priority": "high|mid|low"}
  ]
}`;

    let structured = { keywords: [], todos: [] };
    try {
      const jsonStr = await callLLM([
        { role: 'system', content: '你是一个大学生的群聊通知提取助手。你擅长从嘈杂的微信群聊里一眼看出哪些是真正需要行动的通知，忽略寒暄和闲聊。只输出合法 JSON。' },
        { role: 'user', content: secondPrompt },
      ], TEXT_MODEL, { jsonMode: true });  // ← 第二步用文本模型

      // 兜底：万一模型返回了 ```json 包裹，剥掉
      const cleaned = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      structured = JSON.parse(cleaned);
      if (!Array.isArray(structured.keywords)) structured.keywords = [];
      if (!Array.isArray(structured.todos)) structured.todos = [];
    } catch (parseErr) {
      console.error('第二步大模型输出解析失败：', parseErr.message);
      // 即使第二步失败，也把第一步的原文返回给前端
    }

    res.json({
      rawText,
      keywords: structured.keywords,
      todos: structured.todos,
    });
  } catch (err) {
    console.error('/api/ocr 错误：', err);
    res.status(500).json({ error: err.message || '识别失败' });
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ 服务器已启动: http://localhost:${PORT}`);
  console.log(`   视觉模型: ${VISION_MODEL}`);
  console.log(`   文本模型: ${TEXT_MODEL}`);
  console.log(`   API 地址: ${API_BASE}`);
});
