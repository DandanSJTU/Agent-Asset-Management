/**
 * AiCollabPage — 「AI 协作」记忆资产对比演示。
 *
 * 演示目的：对比「无记忆（基线）」与「检索记忆/Skill/Wiki 资产后（增强）」两种情况下，
 * 大模型对同一问题的回答差异，直观体现记忆资产对回答质量的价值。
 *
 * demo 版：后端路由 ai-collab.ts 直接返回脚本化内容（docs/mem0-vs-agent-memory-example.md），
 * 不依赖实时大模型。前端通过记忆/Skill/Wiki 三个开关控制增强栏注入的资产类型。
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Tag, Text } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { postAiCollabAsk, type AiCollabResult } from '@/lib/api/ai-collab';
import './styles/ai-collab.css';

const EXAMPLE_QUESTION =
  '上周把双塔的 user embedding 维度从 64 调到 128，离线 AUC 涨了 0.8%，但线上 CTR 反而降了 0.1%，奇怪';

type AssetKey = 'memory' | 'skill' | 'wiki';

export function AiCollabPage() {
  const { t } = useTranslation();
  const [question, setQuestion] = useState<string>(EXAMPLE_QUESTION);
  const [toggles, setToggles] = useState<Record<AssetKey, boolean>>({
    memory: true,
    skill: true,
    wiki: true,
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiCollabResult | null>(null);
  const [showAssets, setShowAssets] = useState<boolean>(true);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await postAiCollabAsk({
        question,
        useMemory: toggles.memory,
        useSkill: toggles.skill,
        useWiki: toggles.wiki,
      });
      setResult(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      tea.notify.error(err);
    } finally {
      setLoading(false);
    }
  }, [question, toggles]);

  const toggleAsset = (key: AssetKey) =>
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));

  const totalAssets = result
    ? result.retrieval.memories.length +
      result.retrieval.skills.length +
      result.retrieval.wiki.length
    : 0;

  return (
    <div className="_aic-page">
      <div className="_aic-header">
        <div className="_aic-title-row">
          <Text theme="strong" className="_aic-title">
            {t('aiCollab.title')}
          </Text>
          <span className="_aic-demo-badge">{t('aiCollab.demoBadge')}</span>
        </div>
        <Text className="_aic-subtitle">{t('aiCollab.subtitle')}</Text>
      </div>

      {/* ===== 控制区 ===== */}
      <Card className="_aic-control-card">
        <div className="_aic-field">
          <Text theme="strong" className="_aic-label">
            {t('aiCollab.questionLabel')}
          </Text>
          <textarea
            className="_aic-textarea"
            value={question}
            placeholder={t('aiCollab.questionPlaceholder')}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
          />
        </div>

        <div className="_aic-toolbar">
          <div className="_aic-toggles">
            {(['memory', 'skill', 'wiki'] as AssetKey[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`_aic-toggle ${toggles[key] ? 'is-on' : 'is-off'}`}
                onClick={() => toggleAsset(key)}
              >
                <span className="_aic-toggle-dot" />
                {t(`aiCollab.toggle${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
              </button>
            ))}
          </div>
          <Button type="primary" loading={loading} onClick={run}>
            {loading ? t('aiCollab.running') : t('aiCollab.run')}
          </Button>
        </div>
      </Card>

      {/* ===== 错误态 ===== */}
      {error && !loading && (
        <Card className="_aic-error-card">
          <Text theme="danger">{t('aiCollab.error')}：{error}</Text>
          <Button onClick={run} style={{ marginLeft: 12 }}>
            {t('aiCollab.retry')}
          </Button>
        </Card>
      )}

      {/* ===== 对比区 ===== */}
      {result && !error && (
        <div className="_aic-compare">
          {/* 左：基线 */}
          <Card className="_aic-col">
            <div className="_aic-col-head">
              <Text theme="strong">{t('aiCollab.baselineTitle')}</Text>
            </div>
            <Text className="_aic-col-hint">{t('aiCollab.baselineHint')}</Text>
            <div className="_aic-answer">{result.baseline.answer}</div>
            <div className="_aic-metrics">
              <Tag>{`${t('aiCollab.metricTime')} ${result.baseline.ms}ms`}</Tag>
              <Tag>{`${t('aiCollab.metricTokens')} ${result.baseline.tokens}`}</Tag>
            </div>
          </Card>

          {/* 右：增强 */}
          <Card className="_aic-col _aic-col-enhanced">
            <div className="_aic-col-head">
              <Text theme="strong">{t('aiCollab.enhancedTitle')}</Text>
            </div>
            <Text className="_aic-col-hint">{t('aiCollab.enhancedHint')}</Text>

            {/* 检索轨迹 chips */}
            <div className="_aic-retrieval">
              <Text theme="weak" className="_aic-retrieval-label">
                {t('aiCollab.retrievalTitle')}
              </Text>
              {totalAssets === 0 ? (
                <Text theme="weak" className="_aic-retrieval-empty">
                  {t('aiCollab.emptyRetrieval')}
                </Text>
              ) : (
                <div className="_aic-chips">
                  {result.retrieval.memories.length > 0 && (
                    <span className="_aic-chip">
                      {t('aiCollab.memoriesCount')} {result.retrieval.memories.length}
                    </span>
                  )}
                  {result.retrieval.skills.length > 0 && (
                    <span className="_aic-chip">
                      {t('aiCollab.skillsCount')} {result.retrieval.skills.length}
                    </span>
                  )}
                  {result.retrieval.wiki.length > 0 && (
                    <span className="_aic-chip">
                      {t('aiCollab.wikiCount')} {result.retrieval.wiki.length}
                    </span>
                  )}
                  <button
                    type="button"
                    className="_aic-expand-btn"
                    onClick={() => setShowAssets((v) => !v)}
                  >
                    {showAssets ? t('aiCollab.collapseAssets') : t('aiCollab.expandAssets')}
                  </button>
                </div>
              )}
            </div>

            {/* 资产明细 */}
            {showAssets && totalAssets > 0 && (
              <div className="_aic-asset-detail">
                {result.retrieval.memories.map((m) => (
                  <div key={m.id} className="_aic-asset-item">
                    <span className="_aic-asset-type _aic-type-memory">{t('aiCollab.memoriesCount')}</span>
                    <span className="_aic-asset-body">{m.content}</span>
                  </div>
                ))}
                {result.retrieval.skills.map((s, i) => (
                  <div key={`s-${i}`} className="_aic-asset-item">
                    <span className="_aic-asset-type _aic-type-skill">{t('aiCollab.skillsCount')}</span>
                    <span className="_aic-asset-body">
                      <strong>{s.name}</strong> — {s.description}
                    </span>
                  </div>
                ))}
                {result.retrieval.wiki.map((w, i) => (
                  <div key={`w-${i}`} className="_aic-asset-item">
                    <span className="_aic-asset-type _aic-type-wiki">{t('aiCollab.wikiCount')}</span>
                    <span className="_aic-asset-body">
                      <strong>{w.title}</strong>{' '}
                      <span className="_aic-asset-score">({t('aiCollab.score')} {w.score.toFixed(2)})</span>
                      — {w.snippet}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="_aic-answer _aic-answer-enhanced">{result.enhanced.answer}</div>
            <div className="_aic-metrics">
              <Tag theme="success">{`${t('aiCollab.metricTime')} ${result.enhanced.ms}ms`}</Tag>
              <Tag theme="success">{`${t('aiCollab.metricTokens')} ${result.enhanced.tokens}`}</Tag>
            </div>
          </Card>
        </div>
      )}

      {/* 空态提示 */}
      {!result && !loading && !error && (
        <Card className="_aic-empty-card">
          <Text theme="weak">{t('aiCollab.questionPlaceholder')}</Text>
        </Card>
      )}
    </div>
  );
}

export default AiCollabPage;
