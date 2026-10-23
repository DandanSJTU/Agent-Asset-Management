#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
team7-memory —— 推荐策略组(team-7xulumcvyl) 统一记忆检索 MCP Server (stdio)

把本项目的「对话记忆(L0-L3) / Skill / Wiki」三类知识通过 MCP 工具暴露给 Cursor，
让 Cursor 里的 Agent 能按需检索 4 位真实成员的资产。

数据流（与本项目其它 agent 客户端完全一致，走 v3 数据面）：
    Cursor  ──MCP(stdio)──▶  本脚本  ──HTTP /v3/*──▶  MemoryCore(8420)  /  MemoryKnowledge(8424)

鉴权：Authorization: Bearer <API_KEY>  +  x-tdai-service-id: <SERVICE_ID>
作用域：每个检索都带 (team_id, agent_id, user_id) 隔离三元组；`member` 参数决定查哪一位成员。

成员映射（team-7xulumcvyl，终态绑定关系）：
    product      → 产品  agt-rec-product   / usr-0rwbvul43m(admin)
    engineering  → 工程  agt-ar4478rrd5   / usr-ar449snyl0(PengShi)
    algorithm    → 算法  agt-ar6gyp3yv7   / usr-ar6gbwfwon(PengChengZhuo)
    qa           → 质量  agt-ar6z1agmqn   / usr-ar6zd4p8vv(YaoYao)

`member="all"` 会对 4 位成员分别检索并合并结果（每个结果带 member 标签），
等价于「这个团队关于 X 都知道什么」。

运行：
    pip install "mcp>=1.9,<2" httpx   # 注意必须锁 <2：mcp 2.x 把 FastMCP 改名为 MCPServer
    python memory_mcp_server.py
Cursor 通过 .cursor/mcp.json 拉起（见同目录示例）。
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional

import httpx
from mcp.server.fastmcp import FastMCP

# ── 配置（全部可经环境变量覆盖）──────────────────────────────────────────────
ENDPOINT = os.environ.get("MEMORY_ENDPOINT", "http://127.0.0.1:8420")
API_KEY = os.environ.get("MEMORY_API_KEY", "sk-mem-local-admin")
SERVICE_ID = os.environ.get("SERVICE_ID", "default")
TEAM_ID = os.environ.get("TEAM_ID", "team-7xulumcvyl")
# 注意：MemoryKnowledge 实际监听 :8424（见 local-deploy/knowledge-wrapper.sh 的 PORT=8424），
# 不是文档里偶尔写到的 8421。8421 在本机没有任何服务。
KS_ENDPOINT = os.environ.get("KNOWLEDGE_ENDPOINT", "http://127.0.0.1:8424")
KS_TOKEN = os.environ.get("KNOWLEDGE_API_TOKEN", "")

# 4 位成员的隔离三元组。改团队时同步改这里 + TEAM_ID 即可。
MEMBERS: Dict[str, Dict[str, str]] = {
    "product": {"agent_id": "agt-rec-product", "user_id": "usr-0rwbvul43m", "role": "产品"},
    "engineering": {"agent_id": "agt-ar4478rrd5", "user_id": "usr-ar449snyl0", "role": "工程"},
    "algorithm": {"agent_id": "agt-ar6gyp3yv7", "user_id": "usr-ar6gbwfwon", "role": "算法"},
    "qa": {"agent_id": "agt-ar6z1agmqn", "user_id": "usr-ar6zd4p8vv", "role": "质量"},
}
ALL_MEMBERS = list(MEMBERS.keys())

# team-7xulumcvyl 的 Wiki（KS:8424 实测均 ready）。成员各一个 + 一个组共享。
# 改团队时同步改这里 + TEAM_ID 即可。
WIKI_IDS: Dict[str, str] = {
    "shared": "wiki-rec-shared",          # 推荐策略组 · 共享百科（团队级首选）
    "product": "wiki-rec-product",
    "engineering": "wiki-rec-engineering",
    "algorithm": "wiki-rec-algorithm",
    "qa": "wiki-rec-qa",
}
ALL_WIKI_KEYS = list(WIKI_IDS.keys())

mcp = FastMCP("team7-memory")


# ── 底层 HTTP（与 SDK 同款信封：code==0 → data，否则报错）──────────────────────
def _core_headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {API_KEY}",
        "x-tdai-service-id": SERVICE_ID,
        "Content-Type": "application/json",
    }


def _ks_headers() -> Dict[str, str]:
    # KS 与 core 共用同一 service-id 隔离；缺 x-tdai-service-id 会直接 400
    h = {"Content-Type": "application/json", "x-tdai-service-id": SERVICE_ID}
    if KS_TOKEN:
        h["Authorization"] = f"Bearer {KS_TOKEN}"
    return h


def _call(path: str, body: Dict[str, Any], base: str, headers: Dict[str, str]) -> Dict[str, Any]:
    try:
        resp = httpx.post(base + path, json=body, headers=headers, timeout=25)
        resp.raise_for_status()
        j = resp.json()
    except Exception as e:  # noqa: BLE001
        return {"error": f"HTTP 调用失败: {e}"}
    if not isinstance(j, dict):
        return {"error": f"非预期响应类型: {type(j).__name__}"}
    # 错误信封优先（仅当响应真的带 code 且非 0 时视为业务错误）
    if "code" in j and j.get("code") not in (None, 0):
        return {"error": j.get("message", "unknown"), "code": j.get("code")}
    # 兼容两种成功信封：{code:0, data:{...}} 或 直接平铺 {items:[...]}（search 类端点）
    return j.get("data", j)


def call_core(path: str, body: Dict[str, Any]) -> Dict[str, Any]:
    return _call(path, body, ENDPOINT, _core_headers())


def call_ks(path: str, body: Dict[str, Any]) -> Dict[str, Any]:
    return _call(path, body, KS_ENDPOINT, _ks_headers())


def iso(member: str) -> Dict[str, str]:
    """某成员的隔离三元组。"""
    m = MEMBERS[member]
    return {"team_id": TEAM_ID, "agent_id": m["agent_id"], "user_id": m["user_id"]}


def resolve_members(member: str) -> List[str]:
    if member == "all":
        return ALL_MEMBERS
    if member not in MEMBERS:
        raise ValueError(f"未知 member={member!r}，可选: all | {' | '.join(ALL_MEMBERS)}")
    return [member]


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, default=str)


# ── 工具：团队 / 成员元信息 ─────────────────────────────────────────────────
@mcp.tool()
def list_members() -> str:
    """列出 team-7xulumcvyl 的 4 位成员及其 agent_id / user_id / 角色。检索类工具的 member 参数即取自此处的 key。"""
    return _dumps([
        {"member": k, "role": v["role"], "agent_id": v["agent_id"], "user_id": v["user_id"]}
        for k, v in MEMBERS.items()
    ])


@mcp.tool()
def team_status() -> str:
    """团队资产快照：逐成员统计 L1 原子记忆条数、L2 场景块数、L3 画像是否存在、Skill 数。用于快速确认数据已灌入。"""
    out = {}
    for m in ALL_MEMBERS:
        i = iso(m)
        atomic = call_core("/v3/atomic/count", i)
        scenario = call_core("/v3/scenario/count", i)
        core = call_core("/v3/core/read", i)
        skill = call_core("/v3/skill/list", {**i, "pagination": {"limit": 1}})
        out[m] = {
            "role": MEMBERS[m]["role"],
            # 计数接口返回 data.total（不是 data.count）
            "l1_atomic_count": atomic.get("total") if isinstance(atomic, dict) else None,
            "l2_scenario_count": scenario.get("total") if isinstance(scenario, dict) else None,
            "l3_persona_exists": bool(core and core.get("content")),
            # skill/list 返回 data.total（不是 data.pagination.total）
            "skill_total": skill.get("total") if isinstance(skill, dict) else None,
            "error": (atomic.get("error") if isinstance(atomic, dict) else None)
                     or (scenario.get("error") if isinstance(scenario, dict) else None)
                     or (core.get("error") if isinstance(core, dict) else None)
                     or (skill.get("error") if isinstance(skill, dict) else None),
        }
    return _dumps(out)


# ── 工具：对话记忆 L0-L3 ─────────────────────────────────────────────────────
@mcp.tool()
def memory_search(query: str, member: str = "all", limit: int = 5, type: Optional[str] = None) -> str:
    """检索某成员(或全团队)的 L1 原子记忆（结构化偏好/规则/事件/事实）。
    member: all|product|engineering|algorithm|qa；type 可选过滤：preference|rule|event|fact。"""
    out = {}
    for m in resolve_members(member):
        body = {**iso(m), "query": query, "limit": limit}
        if type:
            body["type"] = type
        out[m] = call_core("/v3/atomic/search", body)
    return _dumps(out)


@mcp.tool()
def conversation_search(query: str, member: str = "all", limit: int = 5) -> str:
    """检索某成员(或全团队)的 L0 原始对话片段（用于核对原文/上下文）。"""
    out = {}
    for m in resolve_members(member):
        out[m] = call_core("/v3/conversation/search", {**iso(m), "query": query, "limit": limit})
    return _dumps(out)


@mcp.tool()
def scene_read(path: str, member: str = "product") -> str:
    """读取某成员的 L2 场景块全文（路径来自 memory_search 的返回或 list_scenarios）。member 必填。"""
    return _dumps(call_core("/v3/scenario/read", {**iso(member), "path": path}))


@mcp.tool()
def list_scenarios(member: str = "all") -> str:
    """列出某成员(或全团队)的 L2 场景块路径索引（只读路径，不读正文）。"""
    out = {}
    for m in resolve_members(member):
        out[m] = call_core("/v3/scenario/ls", iso(m))
    return _dumps(out)


@mcp.tool()
def persona_read(member: str = "all") -> str:
    """读取某成员(或全团队)的 L3 用户画像 persona.md（长期身份/偏好/原则）。"""
    out = {}
    for m in resolve_members(member):
        out[m] = call_core("/v3/core/read", iso(m))
    return _dumps(out)


# ── 工具：Skill ──────────────────────────────────────────────────────────────
@mcp.tool()
def skill_search(query: str, member: str = "all", scope: str = "team", limit: int = 10) -> str:
    """检索 Skill（可复用 SOP/配方）。
    scope=team → 跨 4 位成员团队级检索（忽略 agent 隔离）；
    scope=member 且 member 指定单人 → 只查该成员；member=all 且 scope=member → 逐成员扇出合并。"""
    if scope == "team":
        return _dumps(call_core("/v3/skill/search", {"team_id": TEAM_ID, "query": query, "top_k": limit, "scope": "team"}))
    out = {}
    for m in resolve_members(member):
        out[m] = call_core("/v3/skill/search", {**iso(m), "query": query, "top_k": limit})
    return _dumps(out)


@mcp.tool()
def skill_view(skill_id: str, member: str = "product") -> str:
    """读取单个 Skill 的 SKILL.md 全文 + 资源清单（manifest）。member 必填，决定从哪位成员名下取。"""
    return _dumps(call_core("/v3/skill/get", {**iso(member), "skill_id": skill_id, "include_content": True, "include_manifest": True}))


# ── 工具：Wiki（团队共享，agent_id=null，owner=admin）─────────────────────────
def _resolve_wiki_ids(wiki_key: str) -> List[str]:
    """wiki_key: shared|product|engineering|algorithm|qa|all，解析成一组 wiki_id。"""
    if wiki_key == "all":
        return [WIKI_IDS[k] for k in ALL_WIKI_KEYS if k != "shared"] + [WIKI_IDS["shared"]]
    if wiki_key not in WIKI_IDS:
        raise ValueError(f"未知 wiki_key={wiki_key!r}，可选: {' | '.join(ALL_WIKI_KEYS)} | all")
    return [WIKI_IDS[wiki_key]]


@mcp.tool()
def wiki_search(query: str, wiki_key: str = "shared", limit: int = 20, hop: int = 0) -> str:
    """检索团队 Wiki 页面（BM25 全文 + 可选图谱多跳）。
    wiki_key 直接取成员名，无需手查 wiki_id：shared(推荐策略组·共享百科,默认) | product | engineering | algorithm | qa | all(全 5 个合并)。"""
    out = {}
    for wid in _resolve_wiki_ids(wiki_key):
        out[wid] = call_ks("/v3/wiki/search", {"wiki_id": wid, "query": query, "limit": limit, "hop": hop})
    return _dumps(out)


@mcp.tool()
def wiki_read(wiki_key: str = "shared", refs: Optional[List[str]] = None) -> str:
    """按页面 id 或相对路径读取 Wiki 正文。wiki_key 见 wiki_search 说明；refs 为页面引用数组（如 ["wiki/overview.md"]）。"""
    refs = refs or []
    wid = _resolve_wiki_ids(wiki_key)[0]
    return _dumps(call_ks("/v3/wiki/page/read", {"wiki_id": wid, "refs": refs}))


@mcp.tool()
def wiki_list(wiki_key: str = "shared") -> str:
    """列出某 Wiki 下的全部页面（标题/类型/路径）。wiki_key 见 wiki_search 说明。"""
    wid = _resolve_wiki_ids(wiki_key)[0]
    return _dumps(call_ks("/v3/wiki/page/ls", {"wiki_id": wid}))


if __name__ == "__main__":
    mcp.run()
