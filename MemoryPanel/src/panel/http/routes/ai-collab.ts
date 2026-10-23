/**
 * /api/v1/ai-collab/ask —— 「AI 协作」记忆资产对比演示路由（demo 版）。
 *
 * 设计：docs/ai-collab-design.md。本路由为**演示首版**，直接返回示例文档
 * docs/mem0-vs-agent-memory-example.md 的脚本化内容（基线回答 / 增强回答 /
 * 记忆·Skill·Wiki 检索明细），不依赖实时大模型调用，保证本地开箱即用、结果确定。
 *
 * 前端通过 useMemory / useSkill / useWiki 三个开关控制"增强栏注入了哪些资产类型"，
 * 后端据此过滤 retrieval（基线永远无资产上下文；增强回答以完整脚本为基准）。
 *
 * 后续接真实能力（docs/ai-collab-design.md §四 方案 A）时，把 DEMO 分支替换为：
 *   1) 并行检索三类真实资产（记忆→gateway /personal/memories；Skill→skillKernel；Wiki→knowledgeClient）
 *   2) 拼两套 prompt，经 gateway /v3/internal/llm/chat 调 DeepSeek ×2
 *   3) 返回真实 baseline / enhanced / retrieval。契约不变。
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';

/** 演示数据集 —— 与 docs/mem0-vs-agent-memory-example.md 第二节严格一致。 */
interface DemoMemory {
  id: string;
  content: string;
  type: string;
}
interface DemoSkill {
  name: string;
  description: string;
}
interface DemoWiki {
  title: string;
  snippet: string;
  score: number;
}

const DEMO_QUESTION =
  '上周把双塔的 user embedding 维度从 64 调到 128，离线 AUC 涨了 0.8%，但线上 CTR 反而降了 0.1%，奇怪';

const DEMO_BASELINE = {
  answer: '可能是过拟合了，建议检查一下线上和离线的特征分布是否一致。可以试试加正则化。',
  ms: 820,
  tokens: 58,
};

const DEMO_ENHANCED = {
  answer:
    'Alex，等一下——结合你之前的情况，这个现象更像是你提到过的模型热加载导致的 serving 不一致问题。你上次说 bucketing 用的是 hash user_id，线上有偏移。\n\n' +
    '我建议先排查两件事：\n' +
    '1. 新模型和旧模型是不是同时在 serving —— 如果是热加载切换，部分流量可能还在用旧模型，导致 CTR 看似下降。\n' +
    '2. 多目标冲突的延续 —— 你之前怀疑时长目标跟 CTR 冲突。embedding 维度变大后，时长目标的表征空间也更丰富，可能加剧了冲突。\n\n' +
    '不如先在一个小流量上同时监控 CTR 和时长，看看是否负相关。排除这两个原因后，再考虑过拟合问题。',
  ms: 1460,
  tokens: 312,
};

const DEMO_MEMORIES: DemoMemory[] = [
  { id: 'm1', content: '你负责推荐系统召回策略，主要用双塔模型和 FM', type: 'model_architecture' },
  { id: 'm2', content: '之前 CTR 掉了 0.3%，怀疑是用户冷启动问题', type: 'experiment_results' },
  { id: 'm3', content: '试过用 item title embedding 做 content 特征，效果不明显', type: 'experiment_results' },
  { id: 'm4', content: '怀疑多目标优化里「时长目标」和「CTR 目标」冲突', type: 'hypothesis_analysis' },
  { id: 'm5', content: 'AB 实验平台用 hash(user_id) 分桶，线上有偏移', type: 'infra_bottlenecks' },
  { id: 'm6', content: '怀疑模型热加载导致线上 serving 不一致', type: 'infra_bottlenecks' },
  { id: 'm7', content: '实验流量从 10% 提到 30%，观测周期从 2 周缩至 5 天', type: 'experiment_results' },
];

const DEMO_SKILLS: DemoSkill[] = [
  {
    name: '推荐系统召回调参 · 双塔/FM',
    description:
      '沉淀了双塔模型 + FM 的 embedding 维度调整经验，以及离线 AUC 与线上 CTR 背离时的排查清单（特征分布、serving 一致性、多目标冲突）。',
  },
  {
    name: 'AB 实验平台排坑 · hash 分桶',
    description:
      '记录 hash(user_id) 分桶线上偏移、热加载 serving 不一致、多目标冲突等实验陷阱与定位 SOP，避免重复踩坑。',
  },
];

const DEMO_WIKI: DemoWiki[] = [
  {
    title: '推荐系统 Serving 一致性排查手册',
    snippet: '覆盖模型热加载切换、新旧模型流量共存、serving 不一致导致的指标回退定位方法与应急回滚步骤。',
    score: 0.92,
  },
  {
    title: '多目标优化冲突处理',
    snippet: '时长目标与 CTR 目标权衡、embedding 维度放大对表征空间与冲突加剧的影响分析与 mitigation。',
    score: 0.87,
  },
];

interface AiCollabAskReq {
  question?: string;
  useMemory?: boolean;
  useSkill?: boolean;
  useWiki?: boolean;
}

export function registerAiCollabRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/ai-collab/ask', async (c) => {
    let body: AiCollabAskReq = {};
    try {
      body = (await c.req.json()) as AiCollabAskReq;
    } catch {
      /* 空 body 视为默认全开 */
    }

    const useMemory = body.useMemory !== false; // 默认 true
    const useSkill = body.useSkill !== false; // 默认 true
    const useWiki = body.useWiki !== false; // 默认 true

    deps.logger.info('[ai-collab] ask (demo)', {
      useMemory,
      useSkill,
      useWiki,
      qlen: typeof body.question === 'string' ? body.question.length : 0,
    });

    const retrieval = {
      memories: useMemory ? DEMO_MEMORIES : [],
      skills: useSkill ? DEMO_SKILLS : [],
      wiki: useWiki ? DEMO_WIKI : [],
    };

    return c.json({
      code: 0,
      message: 'OK',
      data: {
        question: DEMO_QUESTION,
        baseline: DEMO_BASELINE,
        enhanced: DEMO_ENHANCED,
        retrieval,
        demo: true,
      },
    });
  });
}
