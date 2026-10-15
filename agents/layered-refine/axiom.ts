/**
 * layered-refine · L3 Axiom 蒸馏（axiom.ts）。
 *
 * 把一条已通过人审、决定晋升的候选规则，蒸馏为四段结构公理：
 *   核心含义 / 深度推演 / 应用判定 / 来源。
 * 走 LLM（AXIOM_SYSTEM）产出；CLI 不可用或返回非 JSON 时回退模板，保证闭环可跑。
 *
 * 红线（沿用设计文档）：来源字段必须真实对应输入里的观测 id，禁止从外部世界观编造。
 */

import { resolveConfig, nextAxiomId, saveAxiom } from './store.ts';
import { AXIOM_SYSTEM, buildAxiomUserPrompt } from './prompts.ts';
import { runLayeredCli } from './llm-cli.ts';
import type { Axiom } from './types.ts';

const AXIOM_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    tag: { type: 'string' },
    core: { type: 'string' },
    reasoning: { type: 'string' },
    application: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'core', 'reasoning', 'application'],
  additionalProperties: false,
};

/** 蒸馏单条候选为公理；返回保存后的 Axiom（含生成的 id）。 */
export async function distillAxiom(text: string, sources: string[]): Promise<Axiom> {
  const cfg = resolveConfig();
  const userPrompt = buildAxiomUserPrompt(text, sources);
  const parsed = (await runLayeredCli(AXIOM_SYSTEM, userPrompt, AXIOM_SCHEMA, cfg)) as
    | {
        title?: string;
        tag?: string;
        core?: string;
        reasoning?: string;
        application?: string;
        sources?: string[];
      }
    | null;

  const id = nextAxiomId();
  const now = Date.now();
  const axiom: Axiom = {
    id,
    title: (parsed?.title || text).replace(/\s+/g, ' ').trim().slice(0, 60),
    tag: (parsed?.tag || 'principle').toLowerCase().replace(/[^\w-]/g, '-').slice(0, 24),
    core: (parsed?.core || text).trim(),
    reasoning: (parsed?.reasoning || '（蒸馏未生成深度推演，待补充）').trim(),
    application: (parsed?.application || '（蒸馏未生成应用判定，待补充）').trim(),
    sources: parsed?.sources?.length ? parsed.sources : sources,
    createdAt: now,
    updatedAt: now,
  };
  saveAxiom(axiom);
  return axiom;
}
