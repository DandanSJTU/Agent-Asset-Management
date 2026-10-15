/**
 * ImportSkillDialog — 导入 Skill 弹窗。支持三种导入方式：
 *
 *   1. 目录导入（directory）
 *      用户选一个本地目录，前端把里面的 File 拆成「主文件」（SKILL.md，
 *      必须在根目录或 <skill-name>/ 下）和「资源文件」（其他文件，保留
 *      相对路径）。走 v3 create 一次性落库（含资源，新建即 v1）。
 *      浏览器目录选择无 Tea 组件等价物，保留原生 <input type="file"
 *      webkitdirectory>，隐藏后由 Tea Button 触发。
 *
 *   2. 从我的技能导入（personal）
 *      用户从个人技能库（team_id='personal'，Panel 服务端注入身份）多选
 *      已有 skill，前端逐个走「get → files/read → create」把 SKILL.md +
 *      资源文件整体复制到当前团队的目标 agent 下（与 ForkSkillDialog 同一
 *      搬运范式，区别是源为个人库且支持批量）。metadata 记录
 *      imported_from='personal' + source_skill_id 便于溯源。
 *      重名预检（方案 A）：目标 agent 下已存在同名的项在列表中置灰禁用，
 *      不参与导入 —— 唯一约束 (team_id, owner_agent_id, name) 由内核
 *      skill-store 强制（42201），提前拦截避免批量中途失败。
 *
 *   3. 对话导入（session）
 *      用户粘贴一段与该 agent 的对话（skill/extract 接口入参 JSON，
 *      含 messages 数组）。前端只做 JSON 校验 + 用当前上下文 ID 覆盖
 *      身份字段，然后调 extractSkills。服务端 LLM 从对话里自动归纳
 *      skill 的 name / description / content，通过工具调用直接落库
 *      （走 SkillCore.create/update 同一条链路），不经过审核。
 *      支持 sync（直接返回结果）和 async（返回 task_id 即视为已受理，
 *      提示用户预计出结果时间后关闭弹窗，不在前端阻塞轮询 —— 结果会异步
 *      沉淀到该 agent 的 skill 列表，用户后续手动刷新即可看到）。
 *
 * 移除说明：原有的「粘贴 SKILL.md 文本」模式已下线 —— 目录导入已覆盖
 * 该场景，且用户手写 frontmatter 极易踩坑（name/description 缺失、
 * YAML 语法错），改由目录导入引导用户放好 SKILL.md 更稳。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createSkill,
  extractSkills,
  listSkills,
  personalListSkills,
  personalSkillApi,
  type SkillResourcePayload,
  type ExtractParams,
  type SkillSummary,
} from '@/lib/api/skill-api';
import { assetsApi } from '@/lib/teamApi';
import { Alert, Button, Checkbox, Form, Input, Modal, Segment, Select } from 'tea-component';
import { FolderOpenIcon } from 'tea-icons-react';
import i18n from '@/i18n';
import '../styles/import-skill-dialog.css';

type Mode = 'directory' | 'session' | 'personal';

/** 拉取个人技能库列表的上限（与 MySkillsPage 一致）。 */
const PERSONAL_LIST_LIMIT = 200;

/**
 * Read a File as base64. Used for binary/executable resources where we
 * can't safely treat bytes as utf8.
 */
async function readAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // Browser-side base64: chunked to avoid stack-overflow on big files.
  let bin = '';
  const arr = new Uint8Array(buf);
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function readAsUtf8(file: File): Promise<string> {
  return file.text();
}

/**
 * Heuristic: extension-based + small-size = text. The gateway already
 * enforces a 5MB cap, but we want to send big binaries as base64 not
 * as a 5MB-of-mojibake string.
 */
function looksLikeText(file: File): boolean {
  const lower = file.name.toLowerCase();
  if (/\.(md|markdown|txt|json|yaml|yml|sh|js|ts|tsx|py|go|rs|toml|html|css|csv|conf|cfg)$/.test(lower)) {
    return true;
  }
  if (file.size < 64 * 1024) return true;
  return false;
}

/**
 * Walk webkitRelativePath like "my-skill/SKILL.md" or "my-skill/files/scripts/x.sh".
 * Returns { skillName, mainFile, resources }; resource paths are
 * normalised relative to `<skill-name>/files/`.
 */
function partitionFiles(files: File[]): {
  skillName: string | null;
  mainFile: File | null;
  resources: Array<{ path: string; file: File }>;
  warning?: string;
} {
  let mainFile: File | null = null;
  let mainRelPath = '';
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    const segments = rel.split('/');
    const lastSegment = segments[segments.length - 1] ?? '';
    if (lastSegment === 'SKILL.md') {
      // Prefer the shallowest SKILL.md (depth = number of segments).
      if (!mainFile || segments.length < mainRelPath.split('/').length) {
        mainFile = f;
        mainRelPath = rel;
      }
    }
  }
  if (!mainFile) {
    return {
      skillName: null,
      mainFile: null,
      resources: [],
      warning: i18n.t('importSkill.directory.warning'),
    };
  }
  const mainSegments = mainRelPath.split('/');
  const baseDir = mainSegments.slice(0, -1).join('/');
  const skillName = mainSegments.length >= 2 ? mainSegments[mainSegments.length - 2] : null;

  const resources: Array<{ path: string; file: File }> = [];
  for (const f of files) {
    if (f === mainFile) continue;
    let rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    if (baseDir && rel.startsWith(baseDir + '/')) {
      rel = rel.slice(baseDir.length + 1);
    }
    if (rel.startsWith('files/')) rel = rel.slice('files/'.length);
    if (!rel) continue;
    resources.push({ path: rel, file: f });
  }
  return { skillName, mainFile, resources };
}

export default function ImportSkillDialog(props: {
  onClose: () => void;
  onImported: () => void;
  /** 当前激活 team（skill 归属，create 必填） */
  teamId: string;
  /** Import target: 'team' = team pool (default), 'fixed' = agent fixed assets. */
  target?: 'team' | 'fixed';
  /** Agent roster (for fixed-target agent selector). */
  agents?: Array<{ id: string; name: string }>;
  /** Pre-selected agent id (when target='fixed'). */
  agentId?: string;
  /** 当前用户 ID（v3 API 必传） */
  userId: string;
  /**
   * 注入的 skill 数据面 API（createSkill 必填；extractSkills 仅在对话导入时需要）。
   * 默认 = 团队 skill API。个人技能库传 personal 版本 + allowedModes=['directory']。
   */
  api?: { createSkill: typeof createSkill; extractSkills?: typeof extractSkills };
  /** 允许的导入方式；默认 directory + session。个人库只开放 directory。 */
  allowedModes?: Mode[];
}) {
  const [mode, setMode] = useState<Mode>('directory');
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  // session-import：用户粘贴 skill/extract 接口入参（含 messages 数组）。
  // 服务端 LLM 从 messages 自行归纳 skill 的 name / description / content。
  const [sessionPayload, setSessionPayload] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(props.agentId ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();
  const skillApi = props.api ?? { createSkill, extractSkills };
  const modes: Mode[] = props.allowedModes ?? ['directory', 'session', 'personal'];

  // ==== personal mode（从我的技能导入）状态 ====
  const [personalSkills, setPersonalSkills] = useState<SkillSummary[]>([]);
  const [personalLoading, setPersonalLoading] = useState(false);
  const [personalLoadError, setPersonalLoadError] = useState<string | null>(null);
  /** 勾选的个人 skill_id 集合 */
  const [selectedPersonalIds, setSelectedPersonalIds] = useState<Set<string>>(new Set());
  /** 重名预检：目标 agent 下已存在的 skill name 集合（方案 A 置灰禁用） */
  const [duplicateNames, setDuplicateNames] = useState<Set<string>>(new Set());
  const [precheckLoading, setPrecheckLoading] = useState(false);
  /** 批量导入进度文案，如「正在导入 2/5：theme-leader」 */
  const [importProgress, setImportProgress] = useState<string | null>(null);

  // 切到 personal mode 时拉取个人技能库列表（Panel 服务端注入身份，只能看到本人技能）。
  // personalLoadedRef 防止空库 / 切 tab 时反复请求。
  const personalLoadedRef = useRef(false);
  const loadPersonalSkills = useCallback(async () => {
    setPersonalLoading(true);
    setPersonalLoadError(null);
    try {
      const res = await personalListSkills({ pagination: { limit: PERSONAL_LIST_LIMIT, offset: 0 } });
      setPersonalSkills(res.items);
      personalLoadedRef.current = true;
    } catch (err) {
      personalLoadedRef.current = false;
      setPersonalLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setPersonalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === 'personal' && !personalLoadedRef.current && !personalLoading && !personalLoadError) {
      void loadPersonalSkills();
    }
  }, [mode, personalLoading, personalLoadError, loadPersonalSkills]);

  // 重名预检：目标 agent 变化（或 team 变化）时重拉目标 agent 已有 skill 名集合。
  // 唯一约束 (team_id, owner_agent_id, name) 见 MemoryCore skill-store（42201）。
  const precheckAgentId = props.target === 'fixed' ? (selectedAgentId || props.agentId || '') : '';
  useEffect(() => {
    if (mode !== 'personal') return;
    if (props.target === 'fixed' && !precheckAgentId) {
      setDuplicateNames(new Set());
      return;
    }
    if (!props.teamId) return;
    let cancelled = false;
    setPrecheckLoading(true);
    void (async () => {
      try {
        const existing = await listSkills({
          team_id: props.teamId,
          agent_id: precheckAgentId || undefined,
          filters: precheckAgentId ? { owner_agent_id: precheckAgentId, status: ['active'] } : {},
          pagination: { limit: 200 },
        });
        if (!cancelled) setDuplicateNames(new Set(existing.items.map((s) => s.name)));
      } catch {
        // 预检失败不阻塞导入：submit 时后端 42201 仍会兜底拦截（与 ForkSkillDialog 一致）。
        if (!cancelled) setDuplicateNames(new Set());
      } finally {
        if (!cancelled) setPrecheckLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, props.target, props.teamId, precheckAgentId]);

  // 归属 Agent 必选：弹窗打开时（team tab 不传 agentId）自动兜底选第一个 agent，
  // 否则用户勾完技能才发现导入按钮因未选 agent 置灰、且无可见原因。
  // （SkillsPanel 打开弹窗处的注释即约定「下拉自行兜底选第一个」，此前未实现。）
  // agents 异步到达时也会补选；用户之后仍可自行改选。
  useEffect(() => {
    if (props.target !== 'fixed') return;
    if (selectedAgentId || props.agentId) return;
    const first = props.agents?.[0];
    if (first) setSelectedAgentId(first.id);
  }, [props.target, props.agentId, props.agents, selectedAgentId]);

  const partition = useMemo(() => (mode === 'directory' ? partitionFiles(pickedFiles) : null), [
    mode,
    pickedFiles
  ]);

  async function submit(): Promise<void> {
    setError(null);
    setResult(null);
    setImportProgress(null);
    setSubmitting(true);
    try {
      const agentId = props.target === 'fixed' ? (selectedAgentId || props.agentId || '') : '';
      if (props.target === 'fixed' && !agentId) {
        throw new Error(t('importSkill.error.noAgent'));
      }
      if (!props.teamId) throw new Error(t('importSkill.error.noTeam'));

      // ==== 对话导入：直接调 skill/extract ====
      if (mode === 'session') {
        if (!skillApi.extractSkills) {
          throw new Error(t('importSkill.error.sessionUnsupported'));
        }
        const raw = sessionPayload.trim();
        if (!raw) throw new Error(t('importSkill.error.noPayload'));
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          throw new Error(t('importSkill.error.jsonParse', { msg: e instanceof Error ? e.message : String(e) }));
        }
        if (!Array.isArray((parsed as { messages?: unknown }).messages)) {
          throw new Error(t('importSkill.error.noMessages'));
        }
        const msgs = (parsed as { messages: unknown[] }).messages;
        if (msgs.length === 0) {
          throw new Error(t('importSkill.error.emptyMessages'));
        }
        // 后端 extract 接口限制 messages 最多 500 条（见 iWiki §3.13），
        if (msgs.length > 500) {
          throw new Error(t('importSkill.error.tooManyMessages', { count: msgs.length }));
        }

        // 组装 extract 入参。身份字段（user_id/team_id/agent_id）强制用当前 UI
        // 上下文覆盖，避免用户粘错 team / 伪造他人身份 —— 参见 <security_rules> §3。
        // space_id 不需要显式传：跟其他 skill 接口一致, 后端从 X-Tdai-Service-Id
        // header (= panelSession.instanceId) 取。session_id / task_id 也不传,
        // 让后端生成 —— 避免前端硬编码 "default" / "import-${Date.now()}" 污染归档路径。
        // extract 接口本身不接受 name/description 字段（skill 名和描述由 LLM
        // 从 messages 中自行归纳），JSON 中即便带了这两个字段也不会透传给服务端。
        const extractParams: ExtractParams = {
          user_id: props.userId,
          team_id: props.teamId,
          agent_id: agentId || props.userId,
          task_id: typeof parsed.task_id === 'string' && parsed.task_id ? parsed.task_id : undefined,
          session_id:
            typeof parsed.session_id === 'string' && parsed.session_id
              ? parsed.session_id
              : undefined,
          messages: parsed.messages as ExtractParams['messages'],
          reason:
            typeof parsed.reason === 'string' && parsed.reason
              ? parsed.reason
              : 'manual import from console',
          options:
            typeof parsed.options === 'object' && parsed.options !== null
              ? (parsed.options as ExtractParams['options'])
              : undefined,
          // 显式导入即共享：落库的 skill asset 直接置 team（后端 extract
          // worker 的 sink 消费 task.visibility），避免「导入成功但团队
          // 资产 tab 不可见」（2026-10-15 实测：新建 skill 默认 private，
          // 而该 tab 只列 team 共享）。personal 命名空间无 asset 概念，不传。
          visibility: props.teamId === 'personal' ? undefined : 'team',
        };

        // 后端 extract 恒走 archive → agent 队列 → worker 异步链路,
        // 永远返回 task_id (没有 sync candidates 分支了)。前端拿到 task_id 即
        // 视为"已受理"，提示预计出结果时间后关闭弹窗；结果由 SkillCoreSink 异步
        // 写入 skill 表，用户回列表刷新即可看到。
        //
        // 前端软超时兜底（5s）：archive 链路涉及 COS 顺序读写（读 _tasks.json →
        // 写 data-xxx.jsonl → 写 _tasks.json），当 COS 慢时整体耗时容易超过
        // Panel 后端 15s 硬超时（KERNEL_TIMEOUT/504），从而在 UI 上误报失败。
        // 实际上请求已经在服务端排入队列，后端会继续跑完 archive。因此这里
        // 5s 内后端有响应就按真结果走；5s 到点还没回就直接展示"已受理"文案，
        // 不再阻塞用户 —— 后端调用在浏览器 fetch 层继续跑（不 abort），最坏
        // 情况是 15s 后 Panel 回 504，我们的 catch 静默吞掉（用户已经看到成功了）。
        const TIMEOUT_MS = 5000;
        let softTimedOut = false;
        const extractPromise = skillApi.extractSkills!(extractParams).catch((e) => {
          // 如果已经软超时展示了成功文案，这里就静默吞掉后续错误（504 等）。
          if (softTimedOut) return null;
          throw e;
        });
        const timeoutPromise = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), TIMEOUT_MS),
        );
        const raced = await Promise.race([extractPromise, timeoutPromise]);
        if (raced === 'timeout') {
          softTimedOut = true;
          setResult(t('importSkill.result.session.accepted'));
        } else if (raced) {
          setResult(t('importSkill.result.session', { taskId: raced.task_id }));
        } else {
          // extractPromise 被软超时后 catch 成 null 的分支（正常不会走到这里，
          // 因为软超时已经先设过 result 了），兜底保持一致文案。
          setResult(t('importSkill.result.session.accepted'));
        }
        setTimeout(() => props.onImported(), 1500);
        return;
      }

      // ==== 从我的技能导入：逐个「get → files/read → create」复制到目标 agent ====
      if (mode === 'personal') {
        // 双保险：勾选集合 × 重名预检集合，任一命中重名都不导入（方案 A）。
        const targets = personalSkills.filter(
          (s) => selectedPersonalIds.has(s.skill_id) && !duplicateNames.has(s.name),
        );
        if (targets.length === 0) {
          throw new Error(t('importSkill.error.noPersonalSelection'));
        }
        const agentId = props.target === 'fixed' ? (selectedAgentId || props.agentId || '') : '';
        let okCount = 0;
        const failures: string[] = [];
        // 共享失败警告（不影响导入结果本身）：skill 已落库但 asset 仍是 private。
        const visWarnings: string[] = [];
        for (let i = 0; i < targets.length; i++) {
          const src = targets[i];
          setImportProgress(
            t('importSkill.personal.progress', { index: i + 1, total: targets.length, name: src.name }),
          );
          try {
            // Step 1: 拉个人 skill 详情（content + manifest）。
            const full = await personalSkillApi.getSkill({
              skill_id: src.skill_id,
              include_content: true,
              include_manifest: true,
            });
            // Step 2: 逐个读资源文件（单个失败跳过，不阻断主流程 —— 与 ForkSkillDialog 一致）。
            const resources: SkillResourcePayload[] = [];
            for (const entry of full.manifest ?? []) {
              try {
                const f = await personalSkillApi.readSkillFile({
                  skill_id: src.skill_id,
                  path: entry.path,
                });
                resources.push({
                  path: f.path,
                  content: f.content,
                  encoding: f.encoding,
                  mime_type: f.mime_type || undefined,
                  is_executable: entry.is_executable || undefined,
                });
              } catch {
                /* 单个资源读取失败则跳过 */
              }
            }
            // Step 3: 落到当前团队 / 目标 agent 下（新 skill_id，version 从 v1 起）。
            // metadata 记录来源，便于后续溯源「这个团队 skill 是从哪份个人技能复制的」。
            const created = await skillApi.createSkill({
              user_id: props.userId,
              team_id: props.teamId,
              agent_id: agentId || props.userId,
              name: src.name,
              content: full.content,
              resources: resources.length ? resources : undefined,
              metadata: {
                imported_from: 'personal',
                source_skill_id: src.skill_id,
                source_version: src.version,
              },
            });
            // Step 4: 显式置为团队共享（visibility=team）。
            // 为什么必须显式置：新建 skill 的 asset 默认 private，而技能页
            // 「团队资产」tab 的数据源只返回 visibility=team 的技能
            // （asset/list-accessible + visibility='team'，服务端二次白名单
            // 过滤）；能看到 private 的「我的资产分配 / Agent 资产」tab 当前
            // 按产品需求隐藏。不置 team 的话导入成功却在任何入口都不可见
            // （2026-10-15 用户实测：导入成功后页面不展示）。
            // skill_id === asset_id；资产登记与 skill 创建同步完成（实测
            // created_at 一致，无竞态），可直接 update。
            try {
              await assetsApi.update(created.skill_id, { visibility: 'team' });
            } catch {
              // 置共享失败不推翻导入结果（skill 已落库），但明确告知暂不可见。
              visWarnings.push(src.name);
            }
            okCount++;
          } catch (err) {
            failures.push(`${src.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        setImportProgress(null);
        if (okCount === 0) {
          throw new Error(t('importSkill.personal.allFailed', { detail: failures.join('; ') }));
        }
        // 汇总文案：导入结果 + （如有）共享失败警告。
        let msg =
          failures.length > 0
            ? t('importSkill.personal.partial', {
                ok: okCount,
                total: targets.length,
                detail: failures.join('; '),
              })
            : t('importSkill.personal.success', { count: okCount });
        if (visWarnings.length > 0) {
          msg += `\n${t('importSkill.personal.visFailed', { names: visWarnings.join('、') })}`;
        }
        setResult(msg);
        setTimeout(() => props.onImported(), 1500);
        return;
      }

      // ==== 目录导入：走 v3 create + files/write ====
      if (!partition?.mainFile) {
        throw new Error(partition?.warning ?? t('importSkill.error.noMainFile'));
      }
      const content = await readAsUtf8(partition.mainFile);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const nameMatch = fmMatch?.[1].match(/^name:\s*(.+)$/m);
      const name = nameMatch?.[1].trim().replace(/^["']|["']$/g, '') || partition.skillName || '';
      if (!name) {
        throw new Error(t('importSkill.error.noName'));
      }
      const resourceFiles: { path: string; file: File; isBinary: boolean }[] = partition.resources.map(
        ({ path, file }) => ({ path, file, isBinary: !looksLikeText(file) }),
      );

      // 确保 content 以 `---\n` 开头（v3 frontmatter 格式要求）。
      const safeContent = content.trimStart().startsWith('---') ? content : `---\nname: ${name}\n---\n\n${content}`;

      // 资源文件随 create 一次性落库（单版本 v1）。
      // 修复：原实现是 create(resources=[] → v1) + files/write(→ v2) 两步，
      // 导致任何带资源的导入 skill 一落库就是 v2（version 语义错乱）。
      // v3 create 本身支持 resources 数组，合并为一次调用即可保证新建 skill = v1。
      const resources: SkillResourcePayload[] = resourceFiles.length > 0
        ? await Promise.all(
            resourceFiles.map(async ({ path, file, isBinary }) =>
              isBinary
                ? { path, content: await readAsBase64(file), encoding: 'base64' as const }
                : { path, content: await readAsUtf8(file), encoding: 'utf-8' as const },
            ),
          )
        : [];

      const created = await skillApi.createSkill({
        user_id: props.userId,
        team_id: props.teamId,
        agent_id: agentId || props.userId, // v3 要求 agent_id，固定模式用选中的，否则用 userId 兜底
        name,
        content: safeContent,
        resources: resources.length ? resources : undefined,
      });

      // 置为团队共享（visibility=team）—— 与 personal 导入同款修复
      // （2026-10-15）：新建 skill 的 asset 默认 private，而「团队资产」
      // tab 只列 team 共享的技能（能看到 private 的「我的资产分配」tab
      // 按产品需求隐藏），不置的话目录导入成功也在任何入口不可见。
      // 失败不推翻导入结果（skill 已落库），仅在结果文案里警告。
      let dirVisWarn = false;
      try {
        await assetsApi.update(created.skill_id, { visibility: 'team' });
      } catch {
        dirVisWarn = true;
      }

      setResult(
        dirVisWarn
          ? `${t('importSkill.result.directory', { name, count: resourceFiles.length })}\n${t(
              'importSkill.personal.visFailed',
              { names: name },
            )}`
          : t('importSkill.result.directory', { name, count: resourceFiles.length }),
      );
      setTimeout(() => props.onImported(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // 是否需要在弹窗内显示「归属 Agent」选择器：
  //   - 仅 fixed-target 才有 agent 归属概念
  //   - 必须传了 agents 才能渲染下拉
  const showAgentPicker = props.target === 'fixed' && !!props.agents;

  return (
    <Modal visible caption={t('importSkill.caption')} size="l" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Alert type="info">{t('importSkill.hint')}</Alert>
      {/* 归属 Agent —— 必选项。始终展示在导入方式上方，
          与 ChatMemoryPanel.ImportBlockDialog 一致：即便外层已经传了 agentId
          也允许在弹窗里重选。 */}
      {showAgentPicker && (
        <Form layout="vertical" style={{ width: '100%' }}>
          <Form.Item
            label={t('importSkill.agent')}
            extra={t('importSkill.agent.extra')}
          >
            {props.agents!.length === 0 ? (
              <Alert type="warning">{t('importSkill.agent.noAgent')}</Alert>
            ) : (
              <>
                <Select
                  size="full"
                  value={selectedAgentId}
                  onChange={setSelectedAgentId}
                  placeholder={t('importSkill.agent.placeholder')}
                  options={props.agents!.map((a) => ({ value: a.id, text: `${a.name}（${a.id}）` }))}
                />
                {/* 未选归属 Agent 时导入按钮会置灰 —— 在此给出可见原因，避免用户困惑 */}
                {!selectedAgentId && (
                  <div className="_memory-isd-agent-required">{t('importSkill.agent.requiredHint')}</div>
                )}
              </>
            )}
          </Form.Item>
        </Form>
      )}

      {/* Mode tabs：directory（目录导入）/ personal（从我的技能导入）/ session（对话导入） */}
      <Segment
        className="_memory-isd-mode-segment"
        value={mode}
        onChange={(v) => {
          setImportProgress(null);
          setMode(v as Mode);
        }}
        options={modes.map((m) => ({
          value: m,
          text:
            m === 'directory'
              ? t('importSkill.mode.directory')
              : m === 'personal'
                ? t('importSkill.mode.personal')
                : t('importSkill.mode.session'),
        }))}
      />

      {mode === 'personal' && (
        <div className="_memory-isd-section">
          <Alert type="info">{t('importSkill.personal.hint')}</Alert>
          {personalLoading ? (
            <span className="_memory-isd-label">{t('importSkill.personal.loading')}</span>
          ) : personalLoadError ? (
            <div className="_memory-isd-section">
              <Alert type="error">{personalLoadError}</Alert>
              <Button onClick={() => void loadPersonalSkills()}>{t('importSkill.personal.retry')}</Button>
            </div>
          ) : personalSkills.length === 0 ? (
            <span className="_memory-isd-label">{t('importSkill.personal.empty')}</span>
          ) : (
            <>
              <div className="_memory-isd-personal-toolbar">
                <Checkbox
                  value={
                    personalSkills.filter((s) => !duplicateNames.has(s.name)).length > 0 &&
                    personalSkills
                      .filter((s) => !duplicateNames.has(s.name))
                      .every((s) => selectedPersonalIds.has(s.skill_id))
                  }
                  onChange={(checked) => {
                    const importable = personalSkills.filter((s) => !duplicateNames.has(s.name));
                    setSelectedPersonalIds(
                      checked ? new Set(importable.map((s) => s.skill_id)) : new Set<string>(),
                    );
                  }}
                >
                  {t('importSkill.personal.selectAll')}
                </Checkbox>
                <span className="_memory-isd-picked-count">
                  {t('importSkill.personal.selectedCount', { count: selectedPersonalIds.size })}
                  {precheckLoading ? ` · ${t('importSkill.personal.prechecking')}` : ''}
                </span>
              </div>
              <ul className="_memory-isd-personal-list">
                {personalSkills.map((s) => {
                  const dup = duplicateNames.has(s.name);
                  const checked = selectedPersonalIds.has(s.skill_id);
                  return (
                    <li key={s.skill_id} className={dup ? '_memory-isd-personal-item is-disabled' : '_memory-isd-personal-item'}>
                      <Checkbox
                        value={checked}
                        disabled={dup}
                        onChange={(next) => {
                          setSelectedPersonalIds((prev) => {
                            const copy = new Set(prev);
                            if (next) copy.add(s.skill_id);
                            else copy.delete(s.skill_id);
                            return copy;
                          });
                        }}
                      >
                        <span className="_memory-isd-personal-name">{s.name}</span>
                        <span className="_memory-isd-personal-meta">v{s.version}</span>
                        {dup && <span className="_memory-isd-personal-dup">{t('importSkill.personal.duplicate')}</span>}
                      </Checkbox>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}

      {mode === 'directory' && (
        <div className="_memory-isd-section">
          <div className="_memory-isd-label">{t('importSkill.directory.label')}</div>
          {/*
            目录选择无 Tea 组件等价物，此处保留原生 input 作为唯一豁免，隐藏后由下方
            Tea Button 触发点击。webkitdirectory/directory 是非标准但广泛支持的浏览器
            属性，React 类型定义未收录，用 spread + any 透传而非逐属性 @ts-expect-error。
          */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => {
              const list = e.target.files;
              if (!list) return;
              setPickedFiles(Array.from(list));
            }}
            className="_memory-isd-hidden-file-input"
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          />
          <Button onClick={() => fileInputRef.current?.click()}>
            <FolderOpenIcon size={14} /> {t('importSkill.directory.selectFile')}
          </Button>
          {pickedFiles.length > 0 && (
            <span className="_memory-isd-picked-count">{t('importSkill.directory.picked', { count: pickedFiles.length })}</span>
          )}
          {pickedFiles.length > 0 && partition && (
            <div className="_memory-isd-partition-box">
              <div>
                {t('importSkill.directory.mainFile')}
                {partition.mainFile ? (
                  <span className="_memory-isd-main-file">
                    {partition.mainFile.webkitRelativePath || partition.mainFile.name}
                  </span>
                ) : (
                  <span className="_memory-isd-error-text">{t('importSkill.directory.noSkillMd')}</span>
                )}
              </div>
              <div>{t('importSkill.directory.resources', { count: partition.resources.length })}</div>
              {partition.resources.length > 0 && (
                <ul className="_memory-isd-resource-list">
                  {partition.resources.map((r) => (
                    <li key={r.path}>· {r.path} ({Math.round(r.file.size / 1024)}KB)</li>
                  ))}
                </ul>
              )}
              {partition.warning && (
                <div className="_memory-isd-warning-text">{partition.warning}</div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'session' && (
        <div className="_memory-isd-section">
          <Alert type="info">
            {t('importSkill.session.hintPrefix')}
            <span className="_memory-isd-mono-inline">messages</span>
            {t('importSkill.session.hintSuffix')}
          </Alert>
          <Form layout="vertical" style={{ width: '100%' }}>
            <Form.Item label={t('importSkill.session.label')}>
              <Input.TextArea
                size="full"
                value={sessionPayload}
                onChange={setSessionPayload}
                rows={16}
                placeholder={JSON.stringify(
                  {
                    session_id: 'demo-user-extract-demo-1',
                    task_id: 'default',
                    messages: [
                      { role: 'user', content: t('importSkill.sample.user') },
                      { role: 'assistant', content: t('importSkill.sample.assistant') },
                      { role: 'tool_call', content: t('importSkill.sample.toolCall') },
                      { role: 'tool_result', content: t('importSkill.sample.toolResult') },
                      { role: 'assistant', content: t('importSkill.sample.assistant2') },
                    ],
                  },
                  null,
                  2,
                )}
                className="_memory-isd-mono-input"
              />
            </Form.Item>
          </Form>
        </div>
      )}

      {error && <Alert type="error">{error}</Alert>}
      {importProgress && (
        <Alert type="info"><span className="_memory-isd-result-text">{importProgress}</span></Alert>
      )}
      {result && <Alert type="success"><span className="_memory-isd-result-text">{result}</span></Alert>}
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          onClick={() => void submit()}
          disabled={
            submitting
            || (mode === 'directory'
              ? !partition?.mainFile
              : mode === 'personal'
                ? selectedPersonalIds.size === 0
                : !sessionPayload.trim())
            || (props.target === 'fixed' && !selectedAgentId)
          }
          title={props.target === 'fixed' && !selectedAgentId ? t('importSkill.error.noAgentHint') : ''}
          loading={submitting}
        >
          {mode === 'session'
            ? t('importSkill.session.submit')
            : mode === 'personal'
              ? t('importSkill.personal.submit')
              : t('importSkill.submit')}
        </Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('importSkill.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
