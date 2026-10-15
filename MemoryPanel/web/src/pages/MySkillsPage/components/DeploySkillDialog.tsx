/**
 * DeploySkillDialog — 「我的技能」· 一键部署到客户端。
 *
 * 目标客户端为固定三项（非团队 Agent 列表）：
 *   - WorkBuddy   → ~/.workbuddy/skills/<name>/SKILL.md
 *   - Cursor      → .cursor/rules/<name>.mdc（项目级 Cursor Rules）
 *   - Claude Code → ~/.claude/skills/<name>/SKILL.md
 *
 * 「部署到 agent」在本功能中的语义 = 把技能发布到上述三类 AI 编码客户端，
 * 使其在对应工具里可直接调用。
 *
 * 范围说明（与用户约定「只需要前端打通」一致）：本组件为前端 demo 语义，
 * 逐客户端模拟写入状态并展示目标路径；若要让技能**真正落盘**到上述目录，
 * 需在 panel 后端新增一个文件写入路由（当前未做，见交付说明）。
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Modal } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import '../styles/deploy-skill-dialog.css';

type DeployStatus = 'pending' | 'running' | 'success' | 'failed';

interface ClientTarget {
  id: 'workbuddy' | 'cursor' | 'claudecode';
  /** 展示名 */
  name: string;
  /** 一句话说明该客户端如何消费该技能 */
  desc: string;
  /** 部署到的本地路径（按技能名插值） */
  path: (skillName: string) => string;
}

const CLIENTS: ClientTarget[] = [
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    desc: '写入用户级技能目录，在当前 WorkBuddy 会话中可直接调用。',
    path: (n) => `~/.workbuddy/skills/${n}/SKILL.md`,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    desc: '生成为 Cursor Rules（.mdc），放入项目或用户级 rules 目录。',
    path: (n) => `.cursor/rules/${n}.mdc`,
  },
  {
    id: 'claudecode',
    name: 'Claude Code',
    desc: '写入 Claude Code 用户级技能目录，可在 Claude Code 中调用。',
    path: (n) => `~/.claude/skills/${n}/SKILL.md`,
  },
];

export default function DeploySkillDialog(props: {
  /** 待部署 skill 的 ID（展示用，前端 demo 暂不直接读取正文） */
  skillId: string;
  /** 待部署 skill 的名称（沿用为副本名） */
  skillName: string;
  onClose: () => void;
  /** 部署完成（无论成败）后回调，用于父组件刷新/关闭 */
  onDeployed?: () => void;
}) {
  const { t } = useTranslation();

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(CLIENTS.map((c) => c.id)),
  );
  const [deploying, setDeploying] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, DeployStatus>>({});

  const allSelected = selected.size === CLIENTS.length;
  const someSelected = selected.size > 0 && !allSelected;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(CLIENTS.map((c) => c.id)));
  };

  const runDeploy = useCallback(async () => {
    const targets = CLIENTS.filter((c) => selected.has(c.id));
    if (targets.length === 0 || deploying) return;

    setDeploying(true);
    setStatuses(Object.fromEntries(targets.map((c) => [c.id, 'pending' as DeployStatus])));

    // 逐客户端模拟写入（前端 demo 语义）。
    // 真实落盘需 panel 后端写文件路由，此处用延时模拟「等待中→部署中→已部署」。
    let success = 0;
    for (const c of targets) {
      setStatuses((s) => ({ ...s, [c.id]: 'running' }));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 650));
      setStatuses((s) => ({ ...s, [c.id]: 'success' }));
      success += 1;
    }

    setDeploying(false);
    tea.notify.success(t('mySkills.deploy.summary', { success, failed: 0 }));
    // 不自动关窗，让用户看到每个客户端的最终状态与汇总，「完成」按钮触发 onDeployed。
  }, [selected, deploying, t]);

  const phase = deploying
    ? 'deploying'
    : Object.keys(statuses).length > 0
      ? 'done'
      : 'selecting';

  const finish = useCallback(() => {
    if (props.onDeployed) props.onDeployed();
    else props.onClose();
  }, [props]);

  const handleClose = phase === 'done' ? finish : props.onClose;

  return (
    <Modal
      visible
      caption={t('mySkills.deploy.caption', { name: props.skillName })}
      size="l"
      onClose={deploying ? undefined : handleClose}
      disableEscape={deploying}
    >
      <Modal.Body>
        <Alert type="info">{t('mySkills.deploy.hint')}</Alert>

        <div className="_memory-dsd-toolbar">
          <label className="_memory-dsd-selectall">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected;
              }}
              onChange={toggleAll}
              disabled={deploying}
            />
            <span>{t('mySkills.deploy.selectAll')}</span>
          </label>
          <span className="_memory-dsd-count">
            {t('mySkills.deploy.selected', { count: selected.size, total: CLIENTS.length })}
          </span>
        </div>

        <ul className="_memory-dsd-list">
          {CLIENTS.map((c) => {
            const status = statuses[c.id];
            return (
              <li
                key={c.id}
                className={
                  '_memory-dsd-item' + (selected.has(c.id) ? ' _memory-dsd-item--on' : '')
                }
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                  disabled={deploying}
                />
                <div className="_memory-dsd-item-main">
                  <div className="_memory-dsd-item-name">{c.name}</div>
                  <div className="_memory-dsd-item-desc">{c.desc}</div>
                  <code className="_memory-dsd-item-path">
                    {t('mySkills.deploy.targetPath')}：{c.path(props.skillName)}
                  </code>
                </div>
                {status && <DeployStatusPill status={status} t={t} />}
              </li>
            );
          })}
        </ul>
      </Modal.Body>
      <Modal.Footer>
        {phase === 'done' && (
          <span className="_memory-dsd-footer-summary">
            {t('mySkills.deploy.summary', {
              success: Object.values(statuses).filter((s) => s === 'success').length,
              failed: Object.values(statuses).filter((s) => s === 'failed').length,
            })}
          </span>
        )}
        <span className="_memory-dsd-spacer" />
        <Button
          type="primary"
          onClick={() => void runDeploy()}
          disabled={selected.size === 0 || deploying}
          loading={deploying}
        >
          {t('mySkills.deploy.submit', { count: selected.size })}
        </Button>
        <Button onClick={handleClose} disabled={deploying}>
          {phase === 'done' ? t('mySkills.deploy.close') : t('mySkills.deploy.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function DeployStatusPill({
  status,
  t,
}: {
  status: DeployStatus;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const map: Record<DeployStatus, { cls: string; label: string }> = {
    pending: { cls: 'pending', label: t('mySkills.deploy.status.pending') },
    running: { cls: 'running', label: t('mySkills.deploy.status.running') },
    success: { cls: 'success', label: t('mySkills.deploy.status.success') },
    failed: { cls: 'failed', label: t('mySkills.deploy.status.failed') },
  };
  const m = map[status];
  return <span className={`_memory-dsd-pill _memory-dsd-pill--${m.cls}`}>{m.label}</span>;
}
