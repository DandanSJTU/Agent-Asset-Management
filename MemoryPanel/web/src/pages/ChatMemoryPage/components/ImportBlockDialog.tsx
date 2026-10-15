import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Modal, Segment, Select, Tag, Text, Upload } from 'tea-component';
import { FilePasteIcon, UploadIcon, BooksIcon } from 'tea-icons-react';
import { type AgentOption } from '../constants/types';
import { fetchPersonalMemories, type PersonalMemory } from '@/lib/api/personal-space';

/** 与 docs/api/chat-memory.md §4.10 import 接口对齐 */
interface ImportMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 与 docs/api/chat-memory.md §4.11 import-records 接口对齐 */
interface ImportRecord {
  content: string;
  type: string;
  priority?: number;
  scene_name?: string;
}

const MAX_MESSAGES = 100;

type ImportMode = 'paste' | 'file' | 'my-memory';

function buildSampleJson(t: (k: string) => string): string {
  return `[
  { "role": "user", "content": "${t('importBlock.sample.user')}" },
  { "role": "assistant", "content": "${t('importBlock.sample.assistant')}" }
]`;
}

type ParseResult =
  | { ok: true; messages: ImportMessage[] }
  | { ok: false; error: string };

export function ImportBlockDialog({
  onClose, onImported, agents, defaultAgentId,
}: {
  onClose: () => void;
  onImported: (params: {
    agent_id: string;
    messages?: ImportMessage[];
    records?: ImportRecord[];
  }) => void | Promise<void>;
  agents: AgentOption[];
  defaultAgentId: string;
}) {
  const { t } = useTranslation();
  const [scopeAgentId, setScopeAgentId] = useState<string>(defaultAgentId || agents[0]?.agent_id || '');
  const [importMode, setImportMode] = useState<ImportMode>('paste');
  const [sessionPayload, setSessionPayload] = useState('');
  const [fileName, setFileName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // ── 「从我的记忆中导入」：个人 L1 原子记忆数据 ──
  const [myMemories, setMyMemories] = useState<PersonalMemory[]>([]);
  const [myMemLoading, setMyMemLoading] = useState(false);
  const [myMemError, setMyMemError] = useState('');
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [myMemSearch, setMyMemSearch] = useState('');
  // myMemNonce：retry 时自增即重新拉取（进入 my-memory 模式也会拉一次）
  const [myMemNonce, setMyMemNonce] = useState(0);
  useEffect(() => {
    if (importMode !== 'my-memory') return;
    let cancelled = false;
    setMyMemLoading(true);
    setMyMemError('');
    fetchPersonalMemories()
      .then((res) => {
        if (cancelled) return;
        setMyMemories(res.memories ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMyMemError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setMyMemLoading(false);
      });
    return () => { cancelled = true; };
  }, [importMode, myMemNonce]);

  const visibleMyMemories = useMemo(() => {
    const q = myMemSearch.trim();
    if (!q) return myMemories;
    return myMemories.filter(
      (m) => (m.content || '').includes(q) || (m.type || '').includes(q),
    );
  }, [myMemories, myMemSearch]);

  const parsed = useMemo((): ParseResult => {
    const trimmed = sessionPayload.trim();
    if (!trimmed) return { ok: false, error: t('importBlock.parse.empty') };
    let p: unknown;
    try { p = JSON.parse(trimmed); } catch { return { ok: false, error: t('importBlock.parse.failed') }; }
    if (!Array.isArray(p)) return { ok: false, error: t('importBlock.parse.notArray') };
    if (p.length === 0) return { ok: false, error: t('importBlock.parse.emptyArray') };
    if (p.length > MAX_MESSAGES) return { ok: false, error: t('importBlock.parse.tooMany', { max: MAX_MESSAGES, count: p.length }) };
    const messages: ImportMessage[] = [];
    for (let i = 0; i < p.length; i++) {
      const m = p[i] as any;
      if (!m || typeof m !== 'object') return { ok: false, error: t('importBlock.parse.notObject', { index: i + 1 }) };
      const role = m.role;
      if (role !== 'user' && role !== 'assistant') return { ok: false, error: t('importBlock.parse.invalidRole', { index: i + 1, role }) };
      const content = m.content;
      if (typeof content !== 'string' || content.length === 0) return { ok: false, error: t('importBlock.parse.invalidContent', { index: i + 1 }) };
      messages.push({ role, content });
    }
    return { ok: true, messages };
  }, [sessionPayload, t]);

  const canSubmit =
    !!scopeAgentId &&
    !submitting &&
    (importMode === 'my-memory' ? pickedIds.size > 0 : parsed.ok);

  function handleFilePicked(file: File): boolean {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setSessionPayload(reader.result as string);
    reader.onerror = () => setSessionPayload('');
    reader.readAsText(file);
    return false;
  }

  function togglePick(id: string) {
    setPickedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!scopeAgentId || submitting) return;
    if (importMode === 'my-memory') {
      if (pickedIds.size === 0) return;
      const picked = myMemories
        .filter((m) => pickedIds.has(m.id))
        .map((m) => ({
          content: m.content,
          type: m.type || 'fact',
          ...(typeof m.priority === 'number' ? { priority: m.priority } : {}),
          ...(m.scene_name ? { scene_name: m.scene_name } : {}),
        }));
      setSubmitting(true);
      try {
        await onImported({ agent_id: scopeAgentId, records: picked });
      } finally {
        if (mountedRef.current) setSubmitting(false);
      }
      return;
    }
    if (!parsed.ok) return;
    setSubmitting(true);
    try {
      await onImported({ agent_id: scopeAgentId, messages: (parsed as { ok: true; messages: ImportMessage[] }).messages });
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={t('importBlock.caption')} size="l" onClose={onClose} disableEscape={submitting}>
      <Modal.Body>
        <Alert type="info">{t('importBlock.hint')}</Alert>
      <Form layout="vertical" style={{ width: '100%' }}>
        <Form.Item label={t('importBlock.agent')} extra={t('importBlock.agent.extra')}>
          {agents.length === 0 ? (
            <Alert type="warning">{t('importBlock.agent.noAgent')}</Alert>
          ) : (
            <Select size="full" value={scopeAgentId} onChange={setScopeAgentId}
              options={agents.map((a) => ({ value: a.agent_id, text: `${a.name}（${a.agent_id}）` }))} />
          )}
        </Form.Item>
      </Form>

      <div style={{ marginTop: 12 }}>
        <Segment value={importMode} onChange={(v) => setImportMode(v as ImportMode)}
          options={[
            { value: 'paste', text: (<><FilePasteIcon size={12} /> {t('importBlock.mode.paste')}</>) },
            { value: 'file', text: (<><UploadIcon size={12} /> {t('importBlock.mode.file')}</>) },
            { value: 'my-memory', text: (<><BooksIcon size={12} /> {t('importBlock.mode.myMemory')}</>) },
          ]} />
      </div>

      {importMode === 'my-memory' ? (
        <div style={{ marginTop: 12 }}>
          <Alert type="info">{t('importBlock.myMemory.hint')}</Alert>

          {/* 工具条：搜索 + 全选/清空 + 已选计数 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Input
              value={myMemSearch}
              onChange={setMyMemSearch}
              placeholder={t('importBlock.myMemory.search')}
              style={{ width: 240 }}
            />
            <Button
              disabled={visibleMyMemories.length === 0}
              onClick={() => setPickedIds(new Set(visibleMyMemories.map((m) => m.id)))}
            >
              {t('importBlock.myMemory.selectAll')}
            </Button>
            <Button disabled={pickedIds.size === 0} onClick={() => setPickedIds(new Set())}>
              {t('importBlock.myMemory.clear')}
            </Button>
            <span style={{ flex: 1 }} />
            <Tag variant="soft">
              {t('importBlock.myMemory.selected', { n: pickedIds.size, total: myMemories.length })}
            </Tag>
          </div>

          {/* 列表 */}
          <div style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {myMemLoading ? (
              <Text theme="label" style={{ fontSize: 12, padding: '12px 4px' }}>
                {t('importBlock.myMemory.loading')}
              </Text>
            ) : myMemError ? (
              <Alert type="error">
                {t('importBlock.myMemory.loadFailed')}：{myMemError}
                <Button onClick={() => setMyMemNonce((n) => n + 1)} style={{ marginLeft: 8 }}>
                  {t('importBlock.myMemory.retry')}
                </Button>
              </Alert>
            ) : myMemories.length === 0 ? (
              <Alert type="warning">
                <div>{t('importBlock.myMemory.empty')}</div>
                <div style={{ fontSize: 11, marginTop: 2 }}>{t('importBlock.myMemory.emptyHint')}</div>
              </Alert>
            ) : visibleMyMemories.length === 0 ? (
              <Text theme="label" style={{ fontSize: 12, padding: '12px 4px' }}>
                {t('importBlock.myMemory.noMatch')}
              </Text>
            ) : (
              visibleMyMemories.map((m) => {
                const on = pickedIds.has(m.id);
                return (
                  <label
                    key={m.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '7px 9px',
                      background: on ? 'var(--tea-color-master-light, #e8f0f9)' : undefined,
                      border: `1px solid ${on ? '#0b3d6b' : '#eef0f4'}`,
                      borderRadius: 6,
                      cursor: 'pointer',
                    }}
                  >
                    <input type="checkbox" checked={on} onChange={() => togglePick(m.id)} style={{ marginTop: 3 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Tag>{m.type || 'fact'}</Tag>
                        {typeof m.priority === 'number' && m.priority >= 0 && (
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>P{m.priority}</span>
                        )}
                        {m.scene_name && <span style={{ fontSize: 11, color: '#185FA5' }}>{m.scene_name}</span>}
                        <span style={{ flex: 1 }} />
                        {m.createdAt && (
                          <Text theme="label" style={{ fontSize: 11 }}>
                            {new Date(m.createdAt).toLocaleDateString()}
                          </Text>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 12.5,
                          lineHeight: 1.5,
                          marginTop: 4,
                          color: '#1f2329',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          wordBreak: 'break-word',
                        }}
                      >
                        {m.content}
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <>
          <Alert type="info" style={{ marginTop: 12 }}>
            <div className="space-y-1">
              <div>{t('importBlock.format.title', { format: '[{role, content}]' })}</div>
              <ul className="list-disc pl-5 text-[11px] space-y-0.5">
                <li><code className="text-[11px]">role</code> {t('importBlock.format.role')}<code className="text-[11px]">"user"</code> / <code className="text-[11px]">"assistant"</code></li>
                <li><code className="text-[11px]">content</code>：{t('importBlock.format.content')}</li>
                <li>{t('importBlock.format.max')} <strong>{MAX_MESSAGES}</strong> {t('importBlock.format.messages')}</li>
              </ul>
            </div>
          </Alert>

          <Form layout="vertical" style={{ width: '100%', marginTop: 12 }}>
            {importMode === 'paste' ? (
              <Form.Item label={t('importBlock.paste.label')}>
                <Input.TextArea size="full" value={sessionPayload} onChange={(v) => setSessionPayload(v)} rows={8}
                  placeholder={buildSampleJson(t)} className="font-mono text-[12px]" style={{ maxHeight: 240, overflowY: 'auto' }} />
              </Form.Item>
            ) : (
              <Form.Item label={t('importBlock.file.label')}>
                <Upload accept=".json,.txt,.md" beforeUpload={handleFilePicked}><Button>{t('importBlock.file.select')}</Button></Upload>
                {fileName && <Text theme="text" parent="div" style={{ marginTop: 6 }}>{t('importBlock.file.selected')}<Text parent="code">{fileName}</Text></Text>}
                {sessionPayload && (
                  <Form.Item label={t('importBlock.file.preview')} style={{ marginTop: 8 }}>
                    <pre className="w-full max-h-48 overflow-y-auto rounded-lg border bg-muted/50 px-2 py-1.5 text-[10px] font-mono text-foreground/70 whitespace-pre-wrap">
                      {sessionPayload.slice(0, 2000)}{sessionPayload.length > 2000 ? t('importBlock.file.truncated') : ''}
                    </pre>
                  </Form.Item>
                )}
              </Form.Item>
            )}
          </Form>

          {sessionPayload.trim() && parsed.ok && (
            <Alert type="success" style={{ marginTop: 12 }}>
              {t('importBlock.parse.success', { count: parsed.messages.length, user: parsed.messages.filter(m => m.role === 'user').length, assistant: parsed.messages.filter(m => m.role === 'assistant').length })}
            </Alert>
          )}
          {sessionPayload.trim() && !parsed.ok && (
            <Alert type="error" style={{ marginTop: 12 }}>{parsed.error}</Alert>
          )}
        </>
      )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" disabled={!canSubmit} loading={submitting} onClick={submit}
          title={
            !scopeAgentId
              ? t('importBlock.noAgentHint')
              : importMode === 'my-memory'
                ? (pickedIds.size === 0 ? t('importBlock.myMemory.nonePicked') : '')
                : (!parsed.ok ? parsed.error : '')
          }>
          {submitting ? t('importBlock.submitting') : t('importBlock.submit')}
        </Button>
        <Button onClick={onClose} disabled={submitting}>{t('importBlock.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
