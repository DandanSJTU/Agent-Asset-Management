# Cursor 接入 team-7xulumcvyl 记忆资产

把推荐策略组（team-7xulumcvyl）4 位成员的 **对话记忆(L0-L3) / Skill / Wiki**
通过 MCP 暴露给 Cursor，让 Cursor 里的 Agent 能按需检索。

## 1. 准备（一次性）

```bash
# 建一个 venv 并装依赖（mcp 不在沙箱默认 venv 里）
python3 -m venv .venv
. .venv/bin/activate
pip install -r agents/cursor/mcp-server/requirements.txt
```

若用本仓库已装 httpx 的 venv，只需补 `mcp`（**必须锁 <2**，mcp 2.x 改名 FastMCP→MCPServer）：
```bash
<你的受管 python 解释器绝对路径> -m pip install "mcp>=1.9,<2"
```

## 2. 让 Cursor 加载 MCP

把 `agents/cursor/.cursor/mcp.json` 复制到你的**项目根目录** `.cursor/mcp.json`
（或全局 `~/.cursor/mcp.json`）。注意改里面的绝对路径为你本机路径：

- `command`：装有 `mcp` 的 python 解释器绝对路径
- `args[0]`：`memory_mcp_server.py` 的绝对路径
- `env.MEMORY_ENDPOINT` / `KNOWLEDGE_ENDPOINT`：core(8420) / KS(**8424，不是 8421**) 地址
- `env.MEMORY_API_KEY`：本地为 `sk-mem-local-admin`；生产用面板「API Key」页的业务 user_key
- `env.TEAM_ID`：`team-7xulumcvyl`

把 `agents/cursor/.cursorrules` 也复制到项目根目录 `.cursorrules`（或在 Cursor 的
Project Rules 里粘贴其内容），让 Agent 知道何时调哪个工具。

## 3. 在 Cursor 里使用

重启 Cursor → Settings → MCP → 看到 `team7-memory` 且工具全绿。
然后直接问，例如：

- “我们团队关于「曝光衰减打压」都有什么沉淀？” → 触发 `memory_search(member="all")`
- “工程同学（engineering）的 Skill 里有没有 code review 相关？” → `skill_search(scope="team")`
- “产品的长期画像是什么？” → `persona_read(member="product")`
- “团队 Wiki 里关于实验方法论怎么讲？” → `wiki_list` + `wiki_search`

## 4. 验证

```bash
# 不依赖 Cursor，先用脚本确认 4 位成员数据可达（需 core:8420 在跑）
python /tmp/verify_team7.py        # 或在仓库内另存一份后运行
# 或在 Cursor 里直接调用 team_status 工具看逐成员资产计数
```

## 5. 范围说明
- 对话记忆 / Skill 走 **core:8420 v3 数据面**，按 (team_id, agent_id, user_id) 隔离。
- Wiki 走 **KS:8424**（不是文档里偶尔写的 8421）；Wiki 是团队共享（agent_id=null，owner=admin），用 `wiki_key` 参数（shared/product/...）即可，无需手查 wiki_id。
- 本 server 只做**只读检索**，不写回记忆（符合「给 Agent 检索调用」的定位）。
- 换团队 / 换成员：改 `memory_mcp_server.py` 顶部的 `MEMBERS` 字典 + `TEAM_ID` 即可。
