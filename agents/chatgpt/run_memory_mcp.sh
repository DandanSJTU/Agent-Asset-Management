#!/bin/bash
# team7-memory MCP Server 启动器（ChatGPT 本地 STDIO 用）
# 本脚本把环境变量 + 受管 python 绝对路径全部写死，
# 这样无论 ChatGPT 的 MCP 入口要「单条命令」还是「命令+参数」都能直接填本文件绝对路径。
#
# ⚠️ 绝对路径是必须的：从 Dock/Finder 启动的 GUI 客户端继承不到终端的 PATH 与 venv。

export MEMORY_ENDPOINT="http://127.0.0.1:8420"
export MEMORY_API_KEY="sk-mem-local-admin"
export SERVICE_ID="default"
export TEAM_ID="team-7xulumcvyl"
export KNOWLEDGE_ENDPOINT="http://127.0.0.1:8424"

exec /Users/dandan/.workbuddy/binaries/python/envs/default/bin/python \
  /Users/dandan/Projects/TencentDB-Agent-Memory/agents/chatgpt/memory_mcp_server.py
