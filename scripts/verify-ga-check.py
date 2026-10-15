#!/usr/bin/env python3
"""
G-A 硬门禁 · 独立复核脚本（与 TS 引擎完全独立的代码路径）

输入：/tmp/ga-facts.json（由 scripts/verify-ga-dump.ts 导出：引擎 facts + stat 元信息）
输出：/tmp/ga-check.json + 控制台摘要

复核四类（对齐 personal-space-plan.html 路线图 G-A）：
  1. 跑通率   —— 解析成功率、badJson、嵌套归因、零记录会话
  2. 成本准确度 —— 全量独立复算（每会话逐记录重算 token 与成本），与引擎逐会话比对
  3. 脏数据   —— 负时长/未来时间戳/重复 ID/价目缺失/巨记录/空首 prompt 等
  4. 口径提示 —— 估算价目（混元内部别名）涉及范围，供人工复核判断

运行：python3 scripts/verify-ga-check.py [facts_json_path]
"""

import json
import random
import sys
import time
from datetime import datetime, timezone

FACTS_PATH = sys.argv[1] if len(sys.argv) > 1 else '/tmp/ga-facts.json'
PRICE_PATH = '/Users/dandan/Projects/TencentDB-Agent-Memory/agents/personal-space/model_prices.json'
OUT_PATH = '/tmp/ga-check.json'

# ── 价目（与 facts.ts 的 MODEL_COST_OVERRIDES 同口径：公开混元区间折算，estimated 标记）──
FX_CNY_USD = 1 / 7.1
PRICES = json.load(open(PRICE_PATH))
OVERRIDES = {
    'hy3': {'input': 0.8 * FX_CNY_USD / 1e6, 'output': 2.0 * FX_CNY_USD / 1e6, 'cacheRead': 0.08 * FX_CNY_USD / 1e6},
    'hy3-x': {'input': 0.8 * FX_CNY_USD / 1e6, 'output': 2.0 * FX_CNY_USD / 1e6, 'cacheRead': 0.08 * FX_CNY_USD / 1e6},
    'hy4-preview': {'input': 2.4 * FX_CNY_USD / 1e6, 'output': 9.6 * FX_CNY_USD / 1e6, 'cacheRead': 0.24 * FX_CNY_USD / 1e6},
}


def norm_model(m):
    if not isinstance(m, str) or not m.strip():
        return None
    s = m.strip().lower()
    i = s.find('/')
    if i >= 0:
        s = s[i + 1:]
    return s or None


def resolve_price(model):
    n = norm_model(model)
    if not n:
        return None, False
    if n in OVERRIDES:
        ov = OVERRIDES[n]
        return {
            'input_cost_per_token': ov['input'],
            'output_cost_per_token': ov['output'],
            'cache_read_input_token_cost': ov['cacheRead'],
            'cache_creation_input_token_cost': 0,
        }, True
    p = PRICES.get(n) or PRICES.get('openai/' + n) or PRICES.get('anthropic/' + n) or PRICES.get('google/' + n)
    return (p if isinstance(p, dict) else None), False


def num(v):
    if isinstance(v, str):
        try:
            v = float(v)
        except ValueError:
            return 0.0
    return float(v) if isinstance(v, (int, float)) else 0.0


def dig(obj, *keys):
    """安全取嵌套 dict 值，任一层非 dict 返回 None"""
    cur = obj
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def find_usage(rec):
    cands = [
        rec.get('usage'),
        dig(rec, 'message', 'usage'),
        dig(rec, 'payload', 'usage'),
        dig(rec, 'payload', 'message', 'usage'),
        dig(rec, 'providerData', 'usage'),
        dig(rec, 'providerData', 'response', 'usage'),
        dig(rec, 'providerData', 'response', 'body', 'usage'),
    ]
    for c in cands:
        if isinstance(c, dict):
            return c
    return None


def find_model(rec):
    cands = [
        dig(rec, 'providerData', 'model'),
        dig(rec, 'providerData', 'response', 'model'),
        rec.get('model'),
        dig(rec, 'providerData', 'response', 'body', 'model'),
    ]
    for c in cands:
        if isinstance(c, str) and c.strip():
            return c.strip()
    return None


def extract_tokens(u):
    inp = num(u.get('inputTokens')) or num(u.get('input_tokens')) or num(u.get('prompt_tokens')) or num(u.get('input')) or 0
    out = num(u.get('outputTokens')) or num(u.get('output_tokens')) or num(u.get('completion_tokens')) or num(u.get('output')) or 0
    cache_read = num(u.get('cache_read_input_tokens'))
    if not cache_read:
        det = u.get('inputTokensDetails') or u.get('prompt_tokens_details') or u.get('input_tokens_details')
        if isinstance(det, list):
            for d in det:
                if isinstance(d, dict):
                    cache_read += num(d.get('cached_tokens'))
        elif isinstance(det, dict):
            cache_read += num(det.get('cached_tokens')) or num(det.get('cache_read_input_tokens'))
    cache_create = num(u.get('cache_creation_input_tokens'))
    return inp, out, cache_read, cache_create


def recompute_session(path):
    """独立逐记录复算：返回 (parsed, bad_json, tokens, per_model, cost)"""
    tokens = {'input': 0.0, 'output': 0.0, 'cacheRead': 0.0, 'cacheCreate': 0.0}
    per_model = {}
    parsed = bad = 0
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    bad += 1
                    continue
                if not isinstance(rec, dict):
                    bad += 1
                    continue
                parsed += 1
                usage = find_usage(rec)
                if usage is None:
                    continue
                t = extract_tokens(usage)
                tokens['input'] += t[0]
                tokens['output'] += t[1]
                tokens['cacheRead'] += t[2]
                tokens['cacheCreate'] += t[3]
                model = find_model(rec)
                if model:
                    price, estimated = resolve_price(model)
                    if price:
                        cost = (t[0] * price.get('input_cost_per_token', 0)
                                + t[1] * price.get('output_cost_per_token', 0)
                                + t[2] * price.get('cache_read_input_token_cost', 0)
                                + t[3] * price.get('cache_creation_input_token_cost', 0))
                        mk = norm_model(model) or model
                        pm = per_model.setdefault(mk, {'input': 0.0, 'output': 0.0, 'costUsd': 0.0, 'estimated': False})
                        pm['input'] += t[0]
                        pm['output'] += t[1]
                        pm['costUsd'] += cost
                        pm['estimated'] = pm['estimated'] or estimated
    except FileNotFoundError:
        return None
    cost = sum(m['costUsd'] for m in per_model.values())
    return parsed, bad, tokens, per_model, cost


def main():
    data = json.load(open(FACTS_PATH))
    facts = data['facts']
    meta = {m['sessionId']: m for m in data['meta']}
    now_ms = time.time() * 1000

    print('=' * 78)
    print(f"G-A 独立复核 · {len(facts)} 个会话 · 导出时间 {data['generatedAt']}")
    print('=' * 78)

    # ── 1. 跑通率 ──
    ids = [f['sessionId'] for f in facts]
    dup_ids = sorted({i for i in ids if ids.count(i) > 1})
    nested = [f for f in facts if f['kind'] == 'nested']
    id_set = set(ids)
    nested_no_parent = [f['sessionId'] for f in nested if not f.get('parentId')]
    nested_orphan = [f['sessionId'] for f in nested if f.get('parentId') and f['parentId'] not in id_set]
    zero_records = [f['sessionId'] for f in facts if f['recordCount'] == 0]
    bad_json_total = sum(f.get('badJson', 0) for f in facts)
    print('\n── 1. 跑通率')
    print(f"  总会话        {len(facts)}（顶层 {len(facts) - len(nested)} / 嵌套 {len(nested)}）")
    print(f"  badJson 合计  {bad_json_total}  {'✓' if bad_json_total == 0 else '✗'}")
    print(f"  嵌套归因      {len(nested) - len(nested_no_parent) - len(nested_orphan)}/{len(nested)}  无父ID {len(nested_no_parent)}  孤儿 {len(nested_orphan)}")
    print(f"  重复 sessionId {len(dup_ids)}  零记录会话 {len(zero_records)}")

    # ── 2. 成本全量独立复算 ──
    print('\n── 2. 成本准确度 · 全量独立复算（逐记录重算，与引擎逐会话比对）')
    t0 = time.time()
    mismatches = []
    my_total_cost = 0.0
    eng_total_cost = 0.0
    my_total_tokens = 0
    eng_total_tokens = 0
    bad_json_mine = 0
    checked = 0
    for f in facts:
        m = meta.get(f['sessionId'])
        if not m:
            mismatches.append({'sessionId': f['sessionId'], 'issue': 'meta 缺失（无法定位原始文件）'})
            continue
        r = recompute_session(m['path'])
        if r is None:
            mismatches.append({'sessionId': f['sessionId'], 'issue': '文件不存在: ' + m['path']})
            continue
        parsed, bad, tokens, per_model, cost = r
        checked += 1
        bad_json_mine += bad
        my_total_cost += cost
        eng_total_cost += f['costUsd']
        my_tok = tokens['input'] + tokens['output'] + tokens['cacheRead'] + tokens['cacheCreate']
        my_total_tokens += my_tok
        eng_total_tokens += f['tokens']['total']
        err = abs(cost - f['costUsd']) / f['costUsd'] if f['costUsd'] > 1e-9 else (0.0 if cost < 1e-9 else 1.0)
        tok_diff = abs(my_tok - f['tokens']['total'])
        rec_diff = abs(parsed - f['recordCount'])
        if err > 0.05 or tok_diff > 0 or rec_diff > 0 or bad != f.get('badJson', 0):
            mismatches.append({
                'sessionId': f['sessionId'],
                'engineCost': round(f['costUsd'], 6), 'myCost': round(cost, 6), 'costErr': round(err * 100, 3),
                'engineTokens': f['tokens']['total'], 'myTokens': int(my_tok),
                'engineRecords': f['recordCount'], 'myRecords': parsed,
                'engineBad': f.get('badJson', 0), 'myBad': bad,
            })
    dt = time.time() - t0
    print(f"  复算 {checked} 个会话（{dt:.1f}s）")
    print(f"  总成本  引擎 ${eng_total_cost:.4f} vs 独立 ${my_total_cost:.4f}  偏差 {(abs(my_total_cost - eng_total_cost) / eng_total_cost * 100 if eng_total_cost else 0):.4f}%")
    print(f"  总Token 引擎 {eng_total_tokens:,} vs 独立 {my_total_tokens:,}")
    print(f"  坏行    引擎 {bad_json_total} vs 独立 {bad_json_mine}")
    print(f"  逐会话不一致 {len(mismatches)} 个")
    for x in mismatches[:10]:
        print(f"    ! {x['sessionId'][:60]} {x}")

    # ── 3. 脏数据扫描 ──
    print('\n── 3. 脏数据扫描')
    dirty = {
        '负时长或零时长': [], '未来时间戳': [], '零记录': zero_records,
        '重复ID': dup_ids, '嵌套无父': nested_no_parent, '嵌套孤儿': nested_orphan,
        '有token无成本(价目缺失)': [], '有成本无token': [], '巨记录(>100KB/条)': [],
        '无user消息': [], '空首prompt': [], '顶层无git cwd': [], 'active但mtime>7天': [],
    }
    for f in facts:
        sa, ea, mt = f.get('startedAt'), f.get('endedAt'), f.get('mtime')
        if sa and ea and ea <= sa:
            dirty['负时长或零时长'].append(f['sessionId'])
        for name, v in (('startedAt', sa), ('endedAt', ea), ('mtime', mt)):
            if v and v > now_ms + 3600_000:
                dirty['未来时间戳'].append(f"{f['sessionId'][:40]}({name})")
        if f['tokens']['total'] > 0 and f['costUsd'] <= 1e-9:
            dirty['有token无成本(价目缺失)'].append(f['sessionId'])
        if f['costUsd'] > 1e-9 and f['tokens']['total'] == 0:
            dirty['有成本无token'].append(f['sessionId'])
        if f['recordCount'] > 0 and f['size'] / f['recordCount'] > 100_000:
            dirty['巨记录(>100KB/条)'].append(f['sessionId'])
        if f.get('userTurns', 0) == 0:
            dirty['无user消息'].append(f['sessionId'])
        if not (f.get('firstPrompt') or '').strip():
            dirty['空首prompt'].append(f['sessionId'])
        if f['kind'] == 'top-level' and not (f.get('git') or {}).get('cwd'):
            dirty['顶层无git cwd'].append(f['sessionId'])
        if f['state'] == 'active' and mt and mt < now_ms - 7 * 86400_000:
            dirty['active但mtime>7天'].append(f['sessionId'])
    for k, v in dirty.items():
        mark = '✓' if len(v) == 0 else '△'
        print(f"  {mark} {k:<22} {len(v)}")
        for x in v[:3]:
            print(f"      {x[:70]}")

    # ── 4. 估算口径范围 ──
    est_models = {}
    for f in facts:
        for mm in f.get('models', []):
            if mm.get('estimated'):
                est_models[mm['model']] = est_models.get(mm['model'], 0) + 1
    est_sessions = [f['sessionId'] for f in facts if f.get('costEstimated')]
    est_cost = sum(f['costUsd'] for f in facts if f.get('costEstimated'))
    print('\n── 4. 估算价目口径（人工复核重点）')
    print(f"  估算模型      {est_models or '无'}")
    print(f"  涉及会话      {len(est_sessions)}/{len(facts)}  估算金额合计 ${est_cost:.4f}（占总成本 {est_cost / eng_total_cost * 100:.1f}%）")

    # ── 抽样明细（Top5 + 3 随机）──
    top = sorted((f for f in facts if f['costUsd'] > 0), key=lambda x: -x['costUsd'])[:5]
    rng = random.Random(42)
    rest = [f for f in facts if f['costUsd'] > 0 and f not in top]
    sample = top + (rng.sample(rest, min(3, len(rest))) if rest else [])
    print('\n── 抽样明细（Top5 成本 + 3 随机）')
    samples = []
    for f in sample:
        m = meta[f['sessionId']]
        r = recompute_session(m['path'])
        if r is None:
            continue
        parsed, bad, tokens, per_model, cost = r
        err = abs(cost - f['costUsd']) / f['costUsd'] * 100 if f['costUsd'] > 1e-9 else 0
        samples.append({
            'sessionId': f['sessionId'], 'kind': f['kind'],
            'engineCost': round(f['costUsd'], 4), 'myCost': round(cost, 4), 'errPct': round(err, 3),
            'engineTokens': f['tokens']['total'], 'myTokens': int(tokens['input'] + tokens['output'] + tokens['cacheRead'] + tokens['cacheCreate']),
            'records': f['recordCount'], 'models': sorted(per_model.keys()),
        })
        print(f"  {f['sessionId'][:44]:<44} 引擎 ${f['costUsd']:.4f} / 独立 ${cost:.4f}  偏差 {err:.3f}%  记录 {f['recordCount']}")

    result = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'sessionCount': len(facts),
        'timings': data['timings'],
        'passRate': {
            'total': len(facts), 'topLevel': len(facts) - len(nested), 'nested': len(nested),
            'badJsonEngine': bad_json_total, 'badJsonIndependent': bad_json_mine,
            'nestedAttributed': len(nested) - len(nested_no_parent) - len(nested_orphan),
            'nestedNoParent': nested_no_parent, 'nestedOrphan': nested_orphan,
            'duplicateIds': dup_ids, 'zeroRecordSessions': zero_records,
        },
        'cost': {
            'engineTotal': round(eng_total_cost, 4), 'independentTotal': round(my_total_cost, 4),
            'totalErrPct': round(abs(my_total_cost - eng_total_cost) / eng_total_cost * 100, 4) if eng_total_cost else 0,
            'engineTokens': eng_total_tokens, 'independentTokens': my_total_tokens,
            'mismatchSessions': mismatches, 'samples': samples,
        },
        'dirty': {k: v for k, v in dirty.items()},
        'estimatedPricing': {
            'models': est_models, 'sessionCount': len(est_sessions),
            'costUsd': round(est_cost, 4),
            'sharePct': round(est_cost / eng_total_cost * 100, 1) if eng_total_cost else 0,
        },
    }
    json.dump(result, open(OUT_PATH, 'w'), ensure_ascii=False, indent=2)
    print(f"\n已写出 {OUT_PATH}")
    print('=' * 78)


if __name__ == '__main__':
    main()
