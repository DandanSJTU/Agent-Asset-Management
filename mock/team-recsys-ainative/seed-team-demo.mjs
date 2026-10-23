#!/usr/bin/env node
/**
 * seed-team-demo.mjs — 「推荐策略组 · AI-Native 四角色」团队资产种子。
 *
 * 把 mock/team-recsys-ainative/dataset 下的四角色（产品 / 工程 / 算法 / 测试）资产
 * 按真实写入格式灌进本地库，供资产库演示与后续数据模拟使用：
 *
 *   Agent    meta_agents（metadata 库，面板团队/Agent 列表的权威来源）+ entity_agents 镜像
 *   对话记忆 l1_records + l1_fts（team scope，work_fact / work_task / work_method /
 *           work_artifact 四类，带 priority / scene_name / session_id）
 *   L2      profiles/<encoded scope>/scene_blocks/*.md + .metadata/scene_index.json
 *   L3      profiles/<encoded scope>/persona.md（Team Operating Doctrine 格式）
 *   Skill   skills + skill_fts + 落盘 skills/<skill_id>/v1/SKILL.md
 *   Wiki    data/knowledge/default/<team_id>/<wiki_id>/ 下 md + index.db（page_meta /
 *           wiki_fts / source / graph_edge），注册进 knowledge.db 的 knowledge_wiki
 *
 * 两种模式：
 *   1) 绑定模式（默认，dataset/mapping.json 存在时）：资产按角色绑到**真实团队**的真实成员
 *      与其 Agent 上。团队 / 成员不动（它们在 metadata 库里已存在），只写 Agent 与资产。
 *      复用已有 Agent 时脚本会备份原 name/description/prompt，--remove 时还原。
 *   2) 自建模式（无 mapping.json）：连团队 / 成员 / Agent 一起自建一套 team-mockrec01，
 *      用于独立演示，--remove 时整体删除。
 *
 * **它不是业务数据**：所有 id 带 `-rec-` / `-mock-` 标记，写入清单记入
 * `.team-demo-seed-manifest.json`，可随时用 --remove 精确清除，不影响其他真实数据。
 *
 * 用法：
 *   node mock/team-recsys-ainative/seed-team-demo.mjs            # 写入（先清同 id 旧数据再灌）
 *   node mock/team-recsys-ainative/seed-team-demo.mjs --remove   # 清除本脚本写入的全部数据
 *   node mock/team-recsys-ainative/seed-team-demo.mjs --dry-run  # 只统计不写库
 *
 * 说明：
 * - L2/L3 目录命名与 buildProfileIsolationScope 一致：`team:<teamId>|agent:<agentId>`
 *   （URL encode 后作为目录名，`:`→%3A、`|`→%7C）。
 * - Wiki 走 knowledge 落盘格式；新注册的 wiki 需要重启 knowledge 服务（:8424）后才在面板可见。
 * - FTS 用「CJK 二元分词 + 拉丁/数字整词保留」近似分词效果，零依赖（仅 node:sqlite）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATASET_DIR = path.join(__dirname, 'dataset');
const CORE_DIR = path.join(REPO_ROOT, 'local-deploy', 'data', 'core');
const DB_PATH = path.join(CORE_DIR, 'vectors.db');
const METADATA_DB_PATH = path.join(CORE_DIR, 'metadata', 'tdai_metadata_default', 'metadata.db');
const MAPPING_PATH = path.join(DATASET_DIR, 'mapping.json');
const KNOWLEDGE_DIR = path.join(REPO_ROOT, 'local-deploy', 'data', 'knowledge');
const KNOWLEDGE_DB_PATH = path.join(KNOWLEDGE_DIR, 'knowledge.db');
const WIKI_SOURCES = path.join(KNOWLEDGE_DIR, '_wiki_engines', 'wiki-sources.json');
const MANIFEST_PATH = path.join(__dirname, '.team-demo-seed-manifest.json');

const VENDOR = 'mock';
/** id 片段：绑定模式 = rec、自建模式 = mock。所有 id 都带它，清除时按它精确识别。 */
let ID_TAG = 'rec';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const ms = (v) => (v ? new Date(v).getTime() : Date.now());
const randId = (n = 12) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < n; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
};

/** CJK 二元分词 + 拉丁/数字整词保留（近似 jieba cutForSearch 检索效果，零依赖）。 */
function tokenizeForFts(raw) {
  const tokens = [];
  for (const m of raw.matchAll(/[\p{L}\p{N}_]+/gu)) {
    if (/\p{Script=Han}/u.test(m[0])) continue;
    tokens.push(m[0]);
  }
  for (const m of raw.matchAll(/\p{Script=Han}+/gu)) {
    const run = m[0];
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
    tokens.push(run);
  }
  return [...new Set(tokens)].join(' ');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { data, body: m[2] };
}

function profileDirName(teamId, agentId) {
  return encodeURIComponent(`team:${teamId}|agent:${agentId}`);
}

// ────────────────────────────── 收集 dataset ──────────────────────────────

function collect() {
  const entities = readJson(path.join(DATASET_DIR, 'entities.json'));
  const team = entities.team;
  const roles = [];

  for (const role of entities.roles) {
    const base = path.join(DATASET_DIR, 'roles', role.slug);
    const memories = readJson(path.join(base, 'l1-memories.json'));
    const scenes = fs
      .readdirSync(path.join(base, 'scenes'))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((filename, i) => {
        const raw = fs.readFileSync(path.join(base, 'scenes', filename), 'utf-8');
        const m = raw.match(/^## (.+)$/m);
        return {
          filename,
          title: m ? m[1].trim() : filename.replace(/\.md$/, ''),
          heat: 5 - Math.min(i, 3), // 首个场景热度最高，仅用于演示排序
          body: raw,
        };
      });
    const persona = fs.readFileSync(path.join(base, 'persona.md'), 'utf-8');
    const skills = fs
      .readdirSync(path.join(base, 'skills'))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((filename) => {
        const raw = fs.readFileSync(path.join(base, 'skills', filename), 'utf-8');
        const { data } = parseFrontmatter(raw);
        return {
          filename,
          name: data.name || filename.replace(/\.md$/, ''),
          description: data.description || '',
          content: raw,
        };
      });
    const wiki = fs
      .readdirSync(path.join(base, 'wiki'))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((filename) => {
        const raw = fs.readFileSync(path.join(base, 'wiki', filename), 'utf-8');
        const m = raw.match(/^# (.+)$/m);
        return { filename, title: m ? m[1].trim() : filename.replace(/\.md$/, ''), content: raw };
      });
    roles.push({ ...role, memories, scenes, persona, skills, wiki });
  }

  const sharedWiki = fs
    .readdirSync(path.join(DATASET_DIR, 'shared', 'wiki'))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((filename) => {
      const raw = fs.readFileSync(path.join(DATASET_DIR, 'shared', 'wiki', filename), 'utf-8');
      const m = raw.match(/^# (.+)$/m);
      return { filename, title: m ? m[1].trim() : filename.replace(/\.md$/, ''), content: raw };
    });

  return applyMapping({ entities, team, roles, sharedWiki });
}

/**
 * 绑定模式：把角色资产重定向到 mapping.json 指定的真实团队 / 成员 / Agent。
 * 只有 dataset/mapping.json 存在时才生效；否则保持自建 mock 团队。
 */
function applyMapping(data) {
  if (!fs.existsSync(MAPPING_PATH)) {
    ID_TAG = 'mock';
    return data;
  }
  ID_TAG = 'rec';
  const mapping = readJson(MAPPING_PATH);
  const teamId = mapping.teamId;
  const now = iso(Date.now());

  const boundRoles = [];
  const agents = [];
  for (const role of data.roles) {
    const b = mapping.bindings[role.slug];
    if (!b) throw new Error(`mapping.json 缺少角色绑定：${role.slug}`);
    const agentId = b.reuseAgentId || `agt-${ID_TAG}-${role.slug}`;
    boundRoles.push({
      ...role,
      teamId,
      userId: b.userId,
      userName: b.userName,
      agentId,
      agentName: b.agentName,
      reuseAgentId: b.reuseAgentId || null,
    });
    agents.push({
      agentId,
      name: b.agentName,
      description: b.agentDescription || '',
      prompt: b.agentPrompt || '',
      ownerUserId: b.userId,
      visibility: 'team',
      reuse: !!b.reuseAgentId,
      icon: b.icon || '',
      accent: b.accent || '',
    });
  }

  const wikis = [
    {
      slug: 'shared',
      wikiId: `wiki-${ID_TAG}-shared`,
      name: '推荐策略组 · 共享百科',
      agentId: mapping.sharedWiki?.agentId ?? null,
      ownerUserId: mapping.sharedWiki?.ownerUserId ?? mapping.bindings.product.userId,
      shared: true,
    },
    ...boundRoles.map((r) => ({
      slug: r.slug,
      wikiId: `wiki-${ID_TAG}-${r.slug}`,
      name: `${r.agentName} · 百科`,
      agentId: r.agentId,
      ownerUserId: r.userId,
      shared: false,
    })),
  ];

  return {
    ...data,
    mode: 'bind',
    teamId,
    team: {
      teamId,
      name: mapping.teamName || data.team.name,
      description: data.team.description,
      ownerUserId: mapping.sharedWiki?.ownerUserId ?? data.team.ownerUserId,
      status: 'active',
      createdAt: now,
    },
    roles: boundRoles,
    entities: { ...data.entities, agents, wikis },
    mapping,
  };
}

// ────────────────────────────── 写入：实体 ──────────────────────────────

function upsertEntityAgentMirror(db, a, teamId) {
  db.prepare(
    `INSERT INTO entity_agents (agent_id, team_id, name, description, prompt, owner_user_id, visibility, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET name=excluded.name, description=excluded.description,
       prompt=excluded.prompt, owner_user_id=excluded.owner_user_id,
       visibility=excluded.visibility, updated_at=excluded.updated_at`,
  ).run(a.agentId, teamId, a.name, a.description, a.prompt, a.ownerUserId, a.visibility, 'active', a.createdAt, a.updatedAt);
}

function seedEntities(db, meta, data, manifest) {
  const { team, entities, mode } = data;
  const now = iso(Date.now());

  // ── 绑定模式：团队/成员是真实数据，一个字都不动，只保证角色 Agent 载体存在 ──
  if (mode === 'bind') {
    let created = 0;
    let reused = 0;
    for (const a of entities.agents) {
      const agent = { ...a, createdAt: now, updatedAt: now };
      const metaJson = JSON.stringify({
        ui: { role_prompt: a.prompt, rules_prompt: '', icon: a.icon, accent: a.accent },
        demo_seeded: true,
      });
      if (agent.reuse) {
        // 复用已有 Agent：先备份原值，--remove 时原样还原
        const old = meta
          ?.prepare('SELECT name, description, prompt, metadata_json FROM meta_agents WHERE agent_id = ?')
          .get(agent.agentId);
        if (old) {
          manifest.agentRestores.push({
            agentId: agent.agentId,
            name: old.name,
            description: old.description ?? '',
            prompt: old.prompt ?? '',
            metadata_json: old.metadata_json ?? '{}',
          });
        }
        meta
          ?.prepare(
            `UPDATE meta_agents SET name = ?, description = ?, prompt = ?, metadata_json = ?, updated_at = ?
             WHERE agent_id = ?`,
          )
          .run(agent.name, agent.description, agent.prompt, metaJson, now, agent.agentId);
        manifest.agentReusedIds.push(agent.agentId);
        reused += 1;
      } else {
        meta
          ?.prepare(
            `INSERT INTO meta_agents (agent_id, team_id, owner_user_id, name, description, prompt, visibility, status, created_at, updated_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
             ON CONFLICT(agent_id) DO UPDATE SET name=excluded.name, description=excluded.description,
               prompt=excluded.prompt, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
          )
          .run(agent.agentId, team.teamId, agent.ownerUserId, agent.name, agent.description, agent.prompt, agent.visibility, now, now, metaJson);
        manifest.agentIds.push(agent.agentId);
        created += 1;
      }
      upsertEntityAgentMirror(db, agent, team.teamId);
    }
    console.log(
      `[seed] Agent：${created} 个新建 + ${reused} 个复用改名 → team_id=${team.teamId}（团队/成员为真实数据，未改动）`,
    );
    return;
  }

  db.prepare(
    `INSERT INTO entity_teams (team_id, name, description, owner_user_id, user_ids_json, agent_ids_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET name=excluded.name, description=excluded.description,
       owner_user_id=excluded.owner_user_id, user_ids_json=excluded.user_ids_json,
       agent_ids_json=excluded.agent_ids_json, status=excluded.status, updated_at=excluded.updated_at`,
  ).run(
    team.teamId,
    team.name,
    team.description,
    team.ownerUserId,
    JSON.stringify(entities.users.map((u) => u.userId)),
    JSON.stringify(entities.agents.map((a) => a.agentId)),
    team.status,
    team.createdAt,
    now,
  );

  for (const u of entities.users) {
    db.prepare(
      `INSERT INTO entity_users (user_id, name, job_description, team_ids_json, task_ids_json, owned_agent_ids_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, job_description=excluded.job_description,
         team_ids_json=excluded.team_ids_json, owned_agent_ids_json=excluded.owned_agent_ids_json,
         updated_at=excluded.updated_at`,
    ).run(
      u.userId,
      u.name,
      u.jobDescription,
      JSON.stringify([team.teamId]),
      '[]',
      JSON.stringify(u.ownedAgentIds),
      'active',
      team.createdAt,
      now,
    );
  }

  for (const a of entities.agents) {
    db.prepare(
      `INSERT INTO entity_agents (agent_id, team_id, name, description, prompt, owner_user_id, visibility, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET name=excluded.name, description=excluded.description,
         prompt=excluded.prompt, owner_user_id=excluded.owner_user_id,
         visibility=excluded.visibility, updated_at=excluded.updated_at`,
    ).run(
      a.agentId,
      team.teamId,
      a.name,
      a.description,
      a.prompt || '',
      a.ownerUserId,
      a.visibility || 'team',
      'active',
      team.createdAt,
      now,
    );
  }

  manifest.teamIds.push(team.teamId);
  manifest.userIds.push(...entities.users.map((u) => u.userId));
  manifest.agentIds.push(...entities.agents.map((a) => a.agentId));
  console.log(
    `[seed] 实体：1 团队 + ${entities.users.length} 成员 + ${entities.agents.length} Agent（team_id=${team.teamId}）`,
  );
}

// ────────────────────────────── 写入：L1 对话记忆 ──────────────────────────────

function seedMemories(db, data, manifest) {
  const { team, roles } = data;
  const insertMeta = db.prepare(`
    INSERT INTO l1_records (
      record_id, content, type, priority, scene_name, session_key, session_id,
      team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_start,
      timestamp_end, created_time, updated_time, metadata_json, scope, owner_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      content=excluded.content, type=excluded.type, priority=excluded.priority,
      scene_name=excluded.scene_name, session_key=excluded.session_key, session_id=excluded.session_id,
      team_id=excluded.team_id, task_id=excluded.task_id, user_id=excluded.user_id,
      agent_id=excluded.agent_id, version=excluded.version, timestamp_str=excluded.timestamp_str,
      timestamp_start=excluded.timestamp_start, timestamp_end=excluded.timestamp_end,
      created_time=excluded.created_time, updated_time=excluded.updated_time,
      metadata_json=excluded.metadata_json, scope=excluded.scope, owner_user_id=excluded.owner_user_id
  `);
  let insertFts = null;
  try {
    insertFts = db.prepare(`
      INSERT INTO l1_fts (content, content_original, record_id, type, priority, scene_name,
        session_key, session_id, team_id, task_id, user_id, agent_id, scope, owner_user_id, version,
        timestamp_str, timestamp_start, timestamp_end, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  } catch (e) {
    console.warn('  ! l1_fts 不可用，跳过 FTS 同步：', e.message);
  }

  let total = 0;
  db.exec('BEGIN');
  try {
    for (const role of roles) {
      role.memories.sessions.forEach((s, si) => {
        const sessionKey = sha1(`${VENDOR}|${s.sessionId}`);
        const tsStart = iso(ms(s.startedAt));
        const tsEnd = iso(ms(s.endedAt));
        s.memories.forEach((m, mi) => {
          const seq = si * 100 + mi + 1;
          const recordId = `${role.slug}-${ID_TAG}-${String(seq).padStart(3, '0')}`;
          const metadata = JSON.stringify({
            demo: true,
            seeded_by: 'seed-team-demo.mjs',
            role: role.slug,
            session_title: s.title || '',
            ...(m.metadata || {}),
          });
          const args = [
            recordId,
            m.content,
            m.type,
            m.priority,
            m.scene_name,
            sessionKey,
            s.sessionId,
            team.teamId,
            '',
            role.userId,
            role.agentId,
            1,
            tsStart,
            tsStart,
            tsEnd,
            tsStart,
            tsEnd,
            metadata,
            'team',
            role.userId,
          ];
          insertMeta.run(...args);
          if (insertFts) {
            insertFts.run(
              tokenizeForFts(m.content), // content（分词后，供 FTS 检索）
              m.content, // content_original（展示用原文）
              recordId,
              m.type,
              m.priority,
              m.scene_name,
              sessionKey,
              s.sessionId,
              team.teamId,
              '',
              role.userId,
              role.agentId,
              'team',
              role.userId,
              1,
              tsStart,
              tsStart,
              tsEnd,
              metadata,
            );
          }
          manifest.memoryIds.push(recordId);
          total += 1;
        });
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[seed] L1：写入 ${total} 条团队原子工作记忆（${roles.length} 个角色 Agent，team scope）`);
}

// ────────────────────────────── 写入：L2 / L3 ──────────────────────────────

function seedProfiles(data, manifest) {
  const { team, roles } = data;
  let sceneCount = 0;
  for (const role of roles) {
    const dir = path.join(CORE_DIR, 'profiles', profileDirName(team.teamId, role.agentId));
    const sceneDir = path.join(dir, 'scene_blocks');
    const metaDir = path.join(dir, '.metadata');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.mkdirSync(metaDir, { recursive: true });

    const index = [];
    for (const sc of role.scenes) {
      const updated = iso(ms(role.memories.sessions.slice(-1)[0]?.endedAt));
      const summary = (sc.body.match(/^## 工作场景\n(.*)$/m)?.[1] || sc.title).slice(0, 60);
      const header =
        `-----META-START-----\ncreated: ${updated}\nupdated: ${updated}\n` +
        `summary: ${summary}\nheat: ${sc.heat}\n-----META-END-----\n\n`;
      fs.writeFileSync(path.join(sceneDir, sc.filename), `${header}${sc.body}`, 'utf-8');
      index.push({ filename: sc.filename, summary, heat: sc.heat, created: updated, updated });
      sceneCount += 1;
    }
    fs.writeFileSync(path.join(metaDir, 'scene_index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(path.join(dir, 'persona.md'), role.persona, 'utf-8');
    manifest.profileDirs.push(path.relative(REPO_ROOT, dir));
  }
  console.log(`[seed] L2：写入 ${sceneCount} 个场景块（每角色 ${roles[0].scenes.length} 个）+ scene_index.json`);
  console.log(`[seed] L3：写入 ${roles.length} 份 persona.md（Team Operating Doctrine 格式）`);
}

// ────────────────────────────── 写入：Skill ──────────────────────────────

function seedSkills(db, data, manifest) {
  const { team, roles } = data;
  const insert = db.prepare(`
    INSERT INTO skills (row_id, skill_id, version, is_head, user_id, owner_agent_id, team_id, task_id,
      name, description, content, content_hash, manifest_json, storage_dir, status, metadata_json,
      created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, 1, ?, ?, ?, '', ?, ?, ?, ?, '[]', ?, 'active', ?, ?, ?)
    ON CONFLICT(row_id) DO UPDATE SET name=excluded.name, description=excluded.description,
      content=excluded.content, content_hash=excluded.content_hash, updated_at_ms=excluded.updated_at_ms
  `);
  let insertFts = null;
  try {
    insertFts = db.prepare(`
      INSERT INTO skill_fts (name, description, content, skill_id, team_id, owner_agent_id, task_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, '', ?)
    `);
  } catch (e) {
    console.warn('  ! skill_fts 不可用，跳过 FTS 同步：', e.message);
  }

  let count = 0;
  const now = Date.now();
  for (const role of roles) {
    for (const sk of role.skills) {
      const skillId = `skl-${role.slug}-${ID_TAG}-${sk.name}`;
      const storageDir = `skills/${skillId}/v1`;
      const rowId = randId(12);
      insert.run(
        rowId,
        skillId,
        1,
        role.userId,
        role.agentId,
        team.teamId,
        sk.name,
        sk.description,
        sk.content,
        sha256(sk.content),
        storageDir,
        JSON.stringify({ demo: true, seeded_by: 'seed-team-demo.mjs', role: role.slug }),
        now,
        now,
      );
      if (insertFts) {
        insertFts.run(sk.name, sk.description, sk.content, skillId, team.teamId, role.agentId, role.userId);
      }
      const dir = path.join(CORE_DIR, 'skills', skillId, 'v1');
      fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), sk.content, 'utf-8');
      manifest.skillIds.push(skillId);
      manifest.skillRowIds.push(rowId);
      manifest.skillDirs.push(path.relative(REPO_ROOT, path.join(CORE_DIR, 'skills', skillId)));
      count += 1;
    }
  }
  console.log(`[seed] Skill：写入 ${count} 个团队技能（每角色 ${roles[0].skills.length} 个）+ 落盘 SKILL.md`);
}

// ─────────────────── 写入：metadata 资产注册 + Agent 挂载 ──────────────────────────────

/**
 * 面板「团队资产」列表、技能页团队 tab、Wiki 列表、资产统计，读的都是 metadata 库的
 * meta_assets（且 visibility='team'）+ meta_agent_fixed_assets（挂载关系）；
 * 数据面（vectors.db skills / knowledge.db）只存内容、不进列表。两层都要写。
 */
function seedMetaAssets(meta, data, manifest) {
  if (!meta) return;
  const { team, roles, entities } = data;
  const now = iso(Date.now());

  const upsertAsset = meta.prepare(`
    INSERT INTO meta_assets (asset_id, team_id, asset_type, name, description, owner_user_id, source_type,
      source_ref, version, visibility, status, content_ref, usage_count, created_at, updated_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', ?, 0, ?, ?, ?)
    ON CONFLICT(asset_id) DO UPDATE SET name=excluded.name, description=excluded.description,
      owner_user_id=excluded.owner_user_id, visibility=excluded.visibility, status='active',
      content_ref=excluded.content_ref, updated_at=excluded.updated_at
  `);
  const mount = meta.prepare(`
    INSERT OR IGNORE INTO meta_agent_fixed_assets
      (id, agent_id, asset_id, asset_type, injection_mode, priority, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 50, ?, ?)
  `);
  const addMount = (agentId, assetId, type, mode, ownerId) => {
    if (mount.run(crypto.randomUUID(), agentId, assetId, type, mode, ownerId, now).changes > 0) {
      manifest.fixedAssetKeys.push(`${agentId}::${assetId}`);
    }
  };

  // Skill：数据面 skill_id 与元数据面 asset_id 同名，两边对得上才能打开详情
  for (const role of roles) {
    for (const sk of role.skills) {
      const skillId = `skl-${role.slug}-${ID_TAG}-${sk.name}`;
      upsertAsset.run(
        skillId,
        team.teamId,
        'skill',
        sk.name,
        sk.description,
        role.userId,
        'extracted',
        null,
        'team',
        `skills/${skillId}/v1`,
        now,
        now,
        JSON.stringify({ demo: true, seeded_by: 'seed-team-demo.mjs', role: role.slug }),
      );
      addMount(role.agentId, skillId, 'skill', 'reference', role.userId);
      manifest.assetIds.push(skillId);
    }
  }

  // Wiki：共享库不绑 Agent（团队级可见），角色库绑各自 Agent
  for (const w of entities.wikis) {
    upsertAsset.run(
      w.wikiId,
      team.teamId,
      'llm_wiki',
      w.name,
      `${w.name}（3 篇，推荐策略组演示数据）`,
      w.ownerUserId,
      'manual',
      'http://127.0.0.1:8424/v3',
      'team',
      'http://127.0.0.1:8424/v3',
      now,
      now,
      '{}',
    );
    if (w.agentId) addMount(w.agentId, w.wikiId, 'llm_wiki', 'reference', w.ownerUserId);
    manifest.assetIds.push(w.wikiId);
  }

  // 对话记忆资产：agent 级唯一资产，名字跟随 Agent 名。
  // visibility 用 team —— 平台默认 self memory 为 private（只有 owner 可见），
  // 但「团队资产 → 对话记忆」池只列 team 可见的，本项目定位是团队共享资产库，故设为 team。
  for (const role of roles) {
    const memId = `chat_memory-${team.teamId}-${role.agentId}`;
    const old = meta.prepare('SELECT name, visibility FROM meta_assets WHERE asset_id = ?').get(memId);
    if (old) {
      manifest.assetRestores.push({ assetId: memId, name: old.name, visibility: old.visibility });
    }
    upsertAsset.run(
      memId,
      team.teamId,
      'chat_memory',
      `Memory of ${role.agentName}`,
      null,
      role.userId,
      'auto',
      null,
      'team',
      null,
      now,
      now,
      '{}',
    );
    addMount(role.agentId, memId, 'chat_memory', 'summary', role.userId);
    manifest.assetIds.push(memId);
  }

  console.log(
    `[seed] 资产注册：${manifest.assetIds.length} 条 meta_assets（12 Skill + 5 Wiki + 4 对话记忆）` +
      ` + ${manifest.fixedAssetKeys.length} 条 Agent 挂载`,
  );
}

// ────────────────────────────── 写入：Wiki ──────────────────────────────

function buildWikiIndex(wikiDir, pages, teamId) {
  fs.mkdirSync(wikiDir, { recursive: true });
  const dbPath = path.join(wikiDir, 'index.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const wdb = new DatabaseSync(dbPath);
  wdb.exec(`
    CREATE VIRTUAL TABLE wiki_fts USING fts5(page_id UNINDEXED, title_tok, content_tok, tokenize = 'unicode61 remove_diacritics 0');
    CREATE TABLE page_meta (page_id TEXT PRIMARY KEY, title TEXT, type TEXT, rel_path TEXT, snippet TEXT);
    CREATE TABLE graph_edge (source_id TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY (source_id, target_id));
    CREATE TABLE source (filename TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_modified_by TEXT, ingested_at TEXT, ingest_error TEXT);
  `);
  const nowIso = new Date().toISOString();
  // 双链 [[标题]] 常省略括号后缀（"推荐指标口径速查" vs "推荐指标口径速查（团队共享）"），
  // 建索引时用规范化标题（去尾部括号）作为键，保证链接能连上。
  const normTitle = (t) =>
    t
      .replace(/[（(][^）)]*[)）]\s*$/u, '')
      .replace(/\s+/gu, '')
      .trim();
  const titleToId = new Map(pages.map((p) => [normTitle(p.title), `pg-${sha1(p.title).slice(0, 12)}`]));
  const insertPage = wdb.prepare('INSERT INTO page_meta (page_id, title, type, rel_path, snippet) VALUES (?, ?, ?, ?, ?)');
  const insertFts = wdb.prepare('INSERT INTO wiki_fts (page_id, title_tok, content_tok) VALUES (?, ?, ?)');
  const insertSrc = wdb.prepare(
    `INSERT INTO source (filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error)
     VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, NULL)`,
  );
  const insertEdge = wdb.prepare('INSERT OR IGNORE INTO graph_edge (source_id, target_id) VALUES (?, ?)');

  for (const p of pages) {
    const pageId = titleToId.get(normTitle(p.title));
    const snippet = p.content.replace(/^#.*$/m, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    insertPage.run(pageId, p.title, 'doc', p.filename, snippet);
    insertFts.run(pageId, tokenizeForFts(p.title), tokenizeForFts(p.content));
    fs.writeFileSync(path.join(wikiDir, p.filename), p.content, 'utf-8');
    insertSrc.run(p.filename, sha256(p.content), Buffer.byteLength(p.content, 'utf-8'), nowIso, nowIso, 'seed-team-demo', nowIso);
  }
  // [[双链]] → graph_edge
  for (const p of pages) {
    const from = titleToId.get(normTitle(p.title));
    for (const m of p.content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const to = titleToId.get(normTitle(m[1].trim()));
      if (to && to !== from) insertEdge.run(from, to);
    }
  }
  wdb.close();
  void teamId;
  return pages.length;
}

function seedWikis(db, data, manifest) {
  const { team, roles, sharedWiki, entities } = data;
  const wikiRoot = path.join(KNOWLEDGE_DIR, 'default', team.teamId);
  fs.mkdirSync(wikiRoot, { recursive: true });

  const sources = fs.existsSync(WIKI_SOURCES) ? JSON.parse(fs.readFileSync(WIKI_SOURCES, 'utf-8')) : {};
  let pageTotal = 0;
  let wikiCount = 0;

  const upsertKnowledge = db.prepare(`
    INSERT INTO entity_knowledge (knowledge_id, type, service_url, name, summary, team_id, agent_id, user_id, created_at, updated_at)
    VALUES (?, 'wiki', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(knowledge_id) DO UPDATE SET name=excluded.name, summary=excluded.summary, updated_at=excluded.updated_at
  `);
  // knowledge 服务自身的注册表（面板 / Wiki 列表读的是它，不只是 core 的 entity_knowledge）
  const kdb = fs.existsSync(KNOWLEDGE_DB_PATH) ? new DatabaseSync(KNOWLEDGE_DB_PATH) : null;
  if (!kdb) console.warn('  ! 未找到 knowledge.db，跳过 wiki 注册表写入：', KNOWLEDGE_DB_PATH);
  const upsertWikiRegistry = kdb?.prepare(`
    INSERT INTO knowledge_wiki (wiki_id, service_id, team_id, name, owner_user_id, user_id, agent_id,
      visibility, status, page_count, version, last_sync_at, created_at, updated_at, service_url, summary)
    VALUES (?, 'default', ?, ?, ?, ?, ?, 'team', 'ready', ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(wiki_id) DO UPDATE SET name=excluded.name, page_count=excluded.page_count,
      status='ready', last_sync_at=excluded.last_sync_at, updated_at=excluded.updated_at,
      summary=excluded.summary, deleted_at=NULL
  `);

  const writeWiki = (wiki, pages, ownerUserId) => {
    const dir = path.join(wikiRoot, wiki.wikiId);
    const n = buildWikiIndex(dir, pages, team.teamId);
    sources[wiki.wikiId] = {
      name: wiki.wikiId,
      path: dir,
      status: 'ready',
      pageCount: n,
      lastSyncAt: new Date().toISOString(),
    };
    upsertKnowledge.run(
      wiki.wikiId,
      `local://${team.teamId}/${wiki.wikiId}`,
      wiki.name,
      `${wiki.name}（${n} 篇，mock 演示数据）`,
      team.teamId,
      wiki.agentId || '',
      ownerUserId,
      iso(Date.now()),
      iso(Date.now()),
    );
    upsertWikiRegistry?.run(
      wiki.wikiId,
      team.teamId,
      wiki.name,
      ownerUserId,
      ownerUserId,
      wiki.agentId || null,
      n,
      iso(Date.now()),
      iso(Date.now()),
      iso(Date.now()),
      'http://127.0.0.1:8424/v3',
      `${wiki.name}（${n} 篇，mock 演示数据）`,
    );
    manifest.wikiIds.push(wiki.wikiId);
    manifest.wikiDirs.push(path.relative(REPO_ROOT, dir));
    pageTotal += n;
    wikiCount += 1;
  };

  const shared = entities.wikis.find((w) => w.slug === 'shared');
  writeWiki(shared, sharedWiki, team.ownerUserId);
  for (const role of roles) {
    const wiki = entities.wikis.find((w) => w.slug === role.slug);
    writeWiki(wiki, role.wiki, role.userId);
  }
  kdb?.close();

  fs.mkdirSync(path.dirname(WIKI_SOURCES), { recursive: true });
  fs.writeFileSync(WIKI_SOURCES, `${JSON.stringify(sources, null, 2)}\n`, 'utf-8');
  console.log(`[seed] Wiki：写入 ${wikiCount} 个知识库 / ${pageTotal} 篇文档 → ${path.relative(REPO_ROOT, wikiRoot)}`);
  console.log('[seed] 提示：新注册 wiki 需重启 knowledge 服务（默认 :8424）后面板才可见。');
}

// ────────────────────────────── 清除 ──────────────────────────────

/**
 * 清除本脚本写入的数据。
 *
 * 删除集合完全由 dataset 推导（role.slug + ID_TAG + 角色名 + wiki id + agent id），
 * 不依赖清单、也不按 team_id 兜底——绑定模式下团队里还有别人的真实资产，
 * 按 team_id 删会误伤，所以一律精确点名。
 */
function remove(db, meta, data) {
  const { team, entities, roles, mode } = data;
  const teamId = team.teamId;

  // 注：node:sqlite 的 run().changes 对 DELETE 报告不稳定，这里用删除前后 count 差值统计。
  const delIn = (table, col, ids) => {
    if (!ids.length) return 0;
    const ph = ids.map(() => '?').join(',');
    const count = () => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} IN (${ph})`).get(...ids)?.n ?? 0;
    const before = count();
    db.prepare(`DELETE FROM ${table} WHERE ${col} IN (${ph})`).run(...ids);
    return before - count();
  };
  const rmDir = (dir) => {
    if (!dir || !fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  };

  // ── 待删清单（全部由 dataset 推导，重复运行结果一致）──
  const memoryIds = [];
  for (const role of roles) {
    role.memories.sessions.forEach((s, si) => {
      s.memories.forEach((_, mi) => {
        memoryIds.push(`${role.slug}-${ID_TAG}-${String(si * 100 + mi + 1).padStart(3, '0')}`);
      });
    });
  }
  const skillIds = roles.flatMap((r) => r.skills.map((sk) => `skl-${r.slug}-${ID_TAG}-${sk.name}`));
  const wikiIds = entities.wikis.map((w) => w.wikiId);
  const profileDirs = roles.map((r) => path.join(CORE_DIR, 'profiles', profileDirName(teamId, r.agentId)));
  const createdAgentIds = entities.agents.filter((a) => !a.reuse).map((a) => a.agentId);
  const reusedAgentIds = entities.agents.filter((a) => a.reuse).map((a) => a.agentId);
  const saved = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) : null;

  const mem = { changes: delIn('l1_records', 'record_id', memoryIds) };
  let memFts = { changes: 0 };
  try {
    memFts = { changes: delIn('l1_fts', 'record_id', memoryIds) };
  } catch { /* fts may be absent */ }

  // skills 表有 UNIQUE(team_id, owner_agent_id, name)，残留行会让下一次 seed 直接冲突，
  // 所以按 skill_id 精确删，宁可多删本脚本自己写的，也不能按 team_id 连带别人的。
  const skill = { changes: delIn('skills', 'skill_id', skillIds) };
  try {
    delIn('skill_fts', 'skill_id', skillIds);
  } catch { /* ignore */ }
  let skillDirs = 0;
  for (const id of skillIds) if (rmDir(path.join(CORE_DIR, 'skills', id))) skillDirs += 1;

  let profileRemoved = 0;
  for (const dir of profileDirs) if (rmDir(dir)) profileRemoved += 1;

  // ── Wiki：逐个删库目录，绝不删团队根目录（里面有别人的 wiki）──
  for (const id of wikiIds) rmDir(path.join(KNOWLEDGE_DIR, 'default', teamId, id));
  if (fs.existsSync(WIKI_SOURCES)) {
    const sources = JSON.parse(fs.readFileSync(WIKI_SOURCES, 'utf-8'));
    for (const id of wikiIds) delete sources[id];
    fs.writeFileSync(WIKI_SOURCES, `${JSON.stringify(sources, null, 2)}\n`, 'utf-8');
  }
  for (const id of wikiIds) db.prepare('DELETE FROM entity_knowledge WHERE knowledge_id = ?').run(id);
  if (fs.existsSync(KNOWLEDGE_DB_PATH)) {
    const kdb = new DatabaseSync(KNOWLEDGE_DB_PATH);
    try {
      for (const id of wikiIds) kdb.prepare('DELETE FROM knowledge_wiki WHERE wiki_id = ?').run(id);
    } finally {
      kdb.close();
    }
  }

  // ── 元数据面：资产注册 + Agent 挂载（面板团队资产列表读这一层）──
  // 复用 Agent 的对话记忆资产是成员自带的，只还原名字、不删除条目
  const chatMemIds = roles.filter((r) => !r.reuseAgentId).map((r) => `chat_memory-${teamId}-${r.agentId}`);
  const assetIds = [...skillIds, ...wikiIds, ...chatMemIds];
  for (const id of assetIds) meta?.prepare('DELETE FROM meta_assets WHERE asset_id = ?').run(id);
  let mounts = 0;
  const unmount = (agentId, assetId) => {
    const { changes } = meta
      ?.prepare('DELETE FROM meta_agent_fixed_assets WHERE agent_id = ? AND asset_id = ?')
      .run(agentId, assetId) ?? { changes: 0 };
    if (changes > 0) mounts += 1;
  };
  for (const role of roles) {
    for (const sk of role.skills) unmount(role.agentId, `skl-${role.slug}-${ID_TAG}-${sk.name}`);
    // 绑定模式：对话记忆挂载是成员自带 Agent 原有的，不碰（本次 seed 也用 INSERT OR IGNORE 复用它）
    if (mode !== 'bind') unmount(role.agentId, `chat_memory-${teamId}-${role.agentId}`);
  }
  for (const w of entities.wikis) if (w.agentId) unmount(w.agentId, w.wikiId);

  // ── Agent：新建的删掉，复用的还原原状 ──
  let restored = 0;
  for (const r of saved?.agentRestores ?? []) {
    meta
      ?.prepare(
        `UPDATE meta_agents SET name = ?, description = ?, prompt = ?, metadata_json = ?, updated_at = ?
         WHERE agent_id = ?`,
      )
      .run(r.name, r.description, r.prompt, r.metadata_json, iso(Date.now()), r.agentId);
    db.prepare(
      `UPDATE entity_agents SET name = ?, description = ?, prompt = ?, updated_at = ? WHERE agent_id = ?`,
    ).run(r.name, r.description, r.prompt, iso(Date.now()), r.agentId);
    restored += 1;
  }
  for (const id of createdAgentIds) {
    meta?.prepare('DELETE FROM meta_agents WHERE agent_id = ?').run(id);
    db.prepare('DELETE FROM entity_agents WHERE agent_id = ?').run(id);
  }
  // 对话记忆资产名跟随 Agent 名，一起还原
  let memRestored = 0;
  for (const role of roles) {
    const b = data.mapping?.bindings?.[role.slug];
    if (!b?.reuseAgentId) continue;
    const memId = `chat_memory-${teamId}-${role.agentId}`;
    const entry = saved?.assetRestores?.find((x) => x.assetId === memId);
    const name = entry?.name ?? (b.originalAgentName ? `Memory of ${b.originalAgentName}` : null);
    if (name) {
      meta
        ?.prepare('UPDATE meta_assets SET name = ?, visibility = ?, updated_at = ? WHERE asset_id = ?')
        .run(name, entry?.visibility ?? 'private', iso(Date.now()), memId);
      memRestored += 1;
    }
  }

  if (mode !== 'bind') {
    // 自建模式：团队/成员也是本脚本建的，一并删掉
    for (const id of reusedAgentIds) {
      meta?.prepare('DELETE FROM meta_agents WHERE agent_id = ?').run(id);
      db.prepare('DELETE FROM entity_agents WHERE agent_id = ?').run(id);
    }
    for (const u of entities.users) db.prepare('DELETE FROM entity_users WHERE user_id = ?').run(u.userId);
    db.prepare('DELETE FROM entity_teams WHERE team_id = ?').run(teamId);
    rmDir(path.join(KNOWLEDGE_DIR, 'default', teamId));
  }

  if (fs.existsSync(MANIFEST_PATH)) fs.unlinkSync(MANIFEST_PATH);
  console.log(
    mode === 'bind'
      ? `[remove] L1 ${mem.changes} 行（fts ${memFts.changes}）· Skill ${skill.changes} 行（落盘 ${skillDirs} 目录）· ` +
          `场景/persona ${profileRemoved} 目录 · Wiki ${wikiIds.length} 库 · ` +
          `资产注册 ${assetIds.length} 条 / 挂载 ${mounts} 条 · ` +
          `Agent 删除 ${createdAgentIds.length} 个 / 还原 ${restored} 个（记忆资产名还原 ${memRestored} 个，团队与成员未动）`
      : `[remove] L1 ${mem.changes} 行（fts ${memFts.changes}）· Skill ${skill.changes} 行（落盘 ${skillDirs} 目录）· ` +
          `场景/persona ${profileRemoved} 目录 · Wiki ${wikiIds.length} 库 · ` +
          `实体 1 团队 + ${entities.users.length} 人 + ${entities.agents.length} Agent`,
  );
}

// ────────────────────────────── main ──────────────────────────────

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const data = collect();
  const roleSummary = data.roles
    .map((r) => {
      const mem = r.memories.sessions.reduce((n, s) => n + s.memories.length, 0);
      return `${r.displayName}(记忆${mem}/场景${r.scenes.length}/技能${r.skills.length}/Wiki${r.wiki.length})`;
    })
    .join(' · ');
  console.log('[seed] dataset 读取完成：' + roleSummary + ` · 共享Wiki ${data.sharedWiki.length} 篇`);
  if (data.mode === 'bind') {
    const bind = data.roles
      .map((r) => `${r.agentName} ← ${r.userName}`)
      .join(' · ');
    console.log(`[seed] 绑定模式：team_id=${data.team.teamId}（${data.team.name}）`);
    console.log('[seed] 角色归属：' + bind);
    if (data.mapping.sharedWiki?.agentId == null) {
      console.log('[seed] 共享 Wiki：团队级（owner=admin，不绑 Agent）');
    }
  } else {
    console.log(`[seed] 自建模式：将创建 team_id=${data.team.teamId}（未找到 dataset/mapping.json）`);
  }
  if (dryRun) {
    console.log('[dry-run] 未写库。');
    return;
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error(`找不到数据库：${DB_PATH}\n请先启动 core（bash local-deploy/start-services.sh）。`);
    process.exit(1);
  }

  const manifest = {
    seeded_at: new Date().toISOString(),
    mode: data.mode ?? 'self',
    teamIds: [],
    userIds: [],
    agentIds: [],
    agentReusedIds: [],
    agentRestores: [],
    memoryIds: [],
    skillIds: [],
    skillRowIds: [],
    skillDirs: [],
    profileDirs: [],
    wikiIds: [],
    wikiDirs: [],
    assetIds: [],
    fixedAssetKeys: [],
    assetRestores: [],
  };

  const db = new DatabaseSync(DB_PATH);
  const meta = fs.existsSync(METADATA_DB_PATH) ? new DatabaseSync(METADATA_DB_PATH) : null;
  if (!meta) console.warn('  ! 未找到 metadata.db，Agent 只会写向量库镜像：', METADATA_DB_PATH);
  for (const conn of [db, meta]) {
    try {
      conn?.exec('PRAGMA busy_timeout = 8000');
    } catch { /* ignore */ }
  }
  try {
    // 先按 id 精确清除本脚本上次写入的数据（幂等），再写入：
    // 避免中途失败留下的残留触发唯一约束。
    remove(db, meta, data);
    seedEntities(db, meta, data, manifest);
    seedMemories(db, data, manifest);
    seedProfiles(data, manifest);
    seedSkills(db, data, manifest);
    seedWikis(db, data, manifest);
    seedMetaAssets(meta, data, manifest);
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    console.log('[seed] 完成。清单：' + path.relative(REPO_ROOT, MANIFEST_PATH));
  } finally {
    db.close();
    meta?.close();
  }
}

if (process.argv.includes('--remove')) {
  const db = new DatabaseSync(DB_PATH);
  const meta = fs.existsSync(METADATA_DB_PATH) ? new DatabaseSync(METADATA_DB_PATH) : null;
  try {
    remove(db, meta, collect());
  } finally {
    db.close();
    meta?.close();
  }
} else {
  main();
}
