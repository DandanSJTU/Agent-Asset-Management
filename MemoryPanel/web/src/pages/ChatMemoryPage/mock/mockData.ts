/**
 * mockData.ts — 对话记忆（Chat Memory）tab 的演示数据。
 *
 * 提供 5 个示例记忆块（block），每个都带有完整的 L0（原始对话）/ L1（原子记忆）/
 * L2（场景记忆）/ L3（核心画像）四层内容，用于在没有真实后端数据时展示 tab 效果。
 *
 * 这些数据通过 mockApi 注入 useChatMemory，由 URL `?demo=1` 或面板内
 * 「演示数据」开关触发，对生产逻辑零侵入。
 */
import type { ChatMemoryBlock, ChatMemoryLayerItem } from '@/lib/teamApi';

const NOW = Date.now();
/** 距当前 N 分钟的 ISO 时间戳 */
const ts = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

// ───────────────────────── Block 1：客服助手 · 用户偏好与售后记忆 ─────────────────────────
const csL0: ChatMemoryLayerItem[] = [
  { id: 'cs-l0-1', role: 'user', title: '', body: '你好，我上周买的羽绒服想退货，吊牌还在但洗过一次，能退吗？', created_at: ts(140) },
  { id: 'cs-l0-2', role: 'assistant', title: '', body: '您好～吊牌齐全的情况下，水洗标未剪、不影响二次销售可支持退货；已水洗可能影响判定，我先帮您查一下订单。', created_at: ts(139) },
  { id: 'cs-l0-3', role: 'tool', title: '', body: "get_order → 订单 CM20261008xxxx：商品「羽绒服（深蓝 M）」，下单 2026-10-08，金额 ¥899，状态 已签收。", created_at: ts(138) },
  { id: 'cs-l0-4', role: 'assistant', title: '', body: '查到您的订单啦，是 10-08 签收的，还在 7 天无理由期内。不过您提到已水洗，建议走「质量问题」退货而非无理由，运费由我们承担。', created_at: ts(137) },
  { id: 'cs-l0-5', role: 'user', title: '', body: '哦那走质量问题吧，怎么操作？', created_at: ts(136) },
  { id: 'cs-l0-6', role: 'assistant', title: '', body: '我在后台为您发起质量问题退货，您会收到短信退货地址，寄出后上传单号即可，预计 3 个工作日退款。', created_at: ts(135) },
  { id: 'cs-l0-7', role: 'system', title: '', body: '已为用户 u_8821 创建退货单 RMA20261015-0392（质量问题 · 商家承担运费）。', created_at: ts(134) },
  { id: 'cs-l0-8', role: 'user', title: '', body: '好的谢谢，顺便问下我的会员等级？', created_at: ts(120) },
  { id: 'cs-l0-9', role: 'assistant', title: '', body: '您目前是「黄金会员」，享 95 折与每月 2 次免邮，距离升级铂金还差约 1200 成长值。', created_at: ts(119) },
  { id: 'cs-l0-10', role: 'user', title: '', body: '那我经常买，下次能不能直接提醒我会员日？', created_at: ts(118) },
  { id: 'cs-l0-11', role: 'assistant', title: '', body: '没问题，已记录您的偏好：每月 18 号会员日主动推送优惠。下次到日子我会提醒您。', created_at: ts(117) },
  { id: 'cs-l0-12', role: 'user', title: '', body: '太好了👍', created_at: ts(116) },
];

const csL1: ChatMemoryLayerItem[] = [
  { id: 'cs-l1-1', title: '会员等级与权益', body: '用户 u_8821 为黄金会员，享 95 折、每月 2 次免邮；距铂金还差约 1200 成长值。', tags: ['会员', '等级'], created_at: ts(115) },
  { id: 'cs-l1-2', title: '售后约束：质量问题优先', body: '已水洗 / 影响二次销售的商品，引导走「质量问题」退货而非 7 天无理由，运费由商家承担。', tags: ['售后', '退货'], created_at: ts(114) },
  { id: 'cs-l1-3', title: '偏好：会员日主动提醒', body: '用户希望每月 18 号会员日主动推送优惠提醒。', tags: ['偏好', '会员日'], created_at: ts(113) },
  { id: 'cs-l1-4', title: '事件：质量问题退货单', body: '2026-10-15 为用户 u_8821 创建质量问题退货单 RMA20261015-0392（羽绒服）。', refs: ['RMA20261015-0392'], tags: ['事件', '售后'], created_at: ts(134) },
  { id: 'cs-l1-5', title: '沟通风格：简洁步骤化', body: '用户偏好简洁、步骤化指引，反感冗长套话。', tags: ['沟通风格'], created_at: ts(112) },
  { id: 'cs-l1-6', title: '偏好：给时间预期', body: '退货 / 退款进度类问题，优先给出时间预期（如「预计 3 个工作日退款」）。', tags: ['偏好', '时效'], created_at: ts(111) },
  { id: 'cs-l1-7', title: '约束：7 天无理由条件', body: '7 天无理由退货需吊牌齐全、水洗标未剪。', tags: ['售后'], created_at: ts(110) },
  { id: 'cs-l1-8', title: '信号：emoji 表达满意', body: '用户常用 👍 等 emoji 表达满意，可作为服务到位的信号。', tags: ['信号'], created_at: ts(109) },
];

const csL2: ChatMemoryLayerItem[] = [
  {
    id: 'cs-l2-1',
    title: '退换货标准流程',
    body:
      '## 退换货标准流程（场景记忆）\n\n**触发**：用户提出退货 / 换货诉求。\n\n**判定分支**：\n- 吊牌齐全 + 水洗标未剪 → 7 天无理由（运费用户承担）\n- 已水洗 / 质量问题 → 质量问题退货（运费商家承担）\n\n**执行步骤**：\n1. 先查订单状态与签收时间\n2. 判定退货类型，向用户说明运费归属\n3. 后台发起 RMA，短信下发退货地址\n4. 用户寄回并上传单号 → 3 个工作日内退款\n\n**注意事项**：质量问题退货需引导用户保留瑕疵照片。',
    tags: ['售后', 'SOP'],
    created_at: ts(108),
  },
  {
    id: 'cs-l2-2',
    title: '会员权益与召回',
    body:
      '## 会员权益与召回（场景记忆）\n\n- 黄金会员：95 折、每月 2 次免邮\n- 铂金会员：9 折、每月 4 次免邮 + 生日礼\n- **会员日**：每月 18 号为全站会员日，需提前 1 天主动推送优惠（已为用户 u_8821 开启）\n- 升级提示：当用户距下一等级较近时，主动告知还差多少成长值。',
    tags: ['会员', '运营'],
    created_at: ts(107),
  },
  {
    id: 'cs-l2-3',
    title: '用户沟通风格画像',
    body:
      '## 用户沟通风格（场景记忆）\n\n- 偏好：简洁、步骤化、给时间预期\n- 反感：冗长套话、反复确认\n- 满意信号：👍 等 emoji\n- 应对策略：首句给结论，再分步骤；进度类问题必带时间预期。',
    tags: ['沟通风格'],
    created_at: ts(106),
  },
];

const csL3: ChatMemoryLayerItem[] = [
  {
    id: 'cs-l3-1',
    title: '用户 u_8821 核心画像',
    body:
      '# 用户 u_8821 核心画像（L3）\n\n- **身份**：黄金会员，高频服饰类消费者\n- **偏好**：简洁步骤化指引；重视时效预期；会员日优惠敏感\n- **稳定约束**：质量问题退货优先于无理由；沟通避免套话\n- **价值信号**：使用 👍 等 emoji 表达满意\n- **关系策略**：每次会话结束前主动确认是否需会员日提醒',
    tags: ['persona'],
    created_at: ts(105),
  },
];

// ───────────────────────── Block 2：代码评审 Agent · 技术规范 ─────────────────────────
const revL0: ChatMemoryLayerItem[] = [
  { id: 'rev-l0-1', role: 'user', title: '', body: '帮我 review 一下这段 Go 的错误处理，总觉得哪里不对。', created_at: ts(200) },
  { id: 'rev-l0-2', role: 'assistant', title: '', body: '发我看下。先确认一个原则：Go 里错误要么显式处理（if err != nil），要么用 fmt.Errorf 带 %w 包装后向上抛，不要静默吞掉。', created_at: ts(199) },
  { id: 'rev-l0-3', role: 'user', title: '', body: '对，我就是直接 `return nil` 把 err 丢了。那包装和直接返回有什么区别？', created_at: ts(198) },
  { id: 'rev-l0-4', role: 'assistant', title: '', body: '用 %w 包装后，上游可以用 errors.Is / errors.As 做类型判断与链路追踪；直接 return nil 会导致调用方无法感知失败，是隐性 bug。', created_at: ts(197) },
  { id: 'rev-l0-5', role: 'user', title: '', body: '明白了。那并发安全这块呢？这个 map 我多个 goroutine 写。', created_at: ts(180) },
  { id: 'rev-l0-6', role: 'assistant', title: '', body: '原生 map 不是并发安全的。读多写少用 sync.RWMutex，高频写入考虑 sync.Map，但 sync.Map 适合「读多且 key 集合稳定」的场景，否则性能反而差。', created_at: ts(179) },
  { id: 'rev-l0-7', role: 'user', title: '', body: '好，我换成 RWMutex。还有 context 要怎么传？', created_at: ts(160) },
  { id: 'rev-l0-8', role: 'assistant', title: '', body: '把 ctx 作为函数第一个参数显式传递，不要存进 struct；超时就靠 ctx.WithTimeout，别自己用 time.After 裸写，容易 goroutine 泄漏。', created_at: ts(159) },
  { id: 'rev-l0-9', role: 'tool', title: '', body: 'run_tests → go test ./... 通过，覆盖率 78.2%。', created_at: ts(158) },
  { id: 'rev-l0-10', role: 'assistant', title: '', body: '改动已通过测试。建议补充一个并发写 map 的单元测试，把 race 跑起来（go test -race）确保锁覆盖到位。', created_at: ts(157) },
];

const revL1: ChatMemoryLayerItem[] = [
  { id: 'rev-l1-1', title: '错误必须显式处理或 %w 包装', body: 'Go 中错误要么 if err != nil 处理，要么 fmt.Errorf("...: %w", err) 包装上抛；禁止静默 return nil 丢弃 err。', tags: ['go', 'error'], created_at: ts(156) },
  { id: 'rev-l1-2', title: '包装 vs 直接返回', body: '用 %w 包装后上游可用 errors.Is/As 判断与追踪；直接 return nil 会让调用方无法感知失败。', tags: ['go', 'error'], created_at: ts(155) },
  { id: 'rev-l1-3', title: '并发 map 安全', body: '原生 map 非并发安全；读多写少 → sync.RWMutex，key 稳定高频 → sync.Map，否则性能反而差。', tags: ['go', 'concurrency'], created_at: ts(154) },
  { id: 'rev-l1-4', title: 'context 传递规范', body: 'ctx 作为函数第一个参数显式传递，不要存进 struct；超时用 ctx.WithTimeout，避免裸 time.After 造成 goroutine 泄漏。', tags: ['go', 'context'], created_at: ts(153) },
  { id: 'rev-l1-5', title: '测试要求', body: '并发改动需补 -race 单元测试；提交前跑 go test ./... 确保通过。', tags: ['go', 'test'], created_at: ts(152) },
  { id: 'rev-l1-6', title: '用户水平：中级 Go', body: '用户理解基本语法，需提示「为什么」而不仅是「怎么改」。', tags: ['用户画像'], created_at: ts(151) },
];

const revL2: ChatMemoryLayerItem[] = [
  {
    id: 'rev-l2-1',
    title: 'Go 代码评审检查清单',
    body:
      '## Go 代码评审检查清单（场景记忆）\n\n1. 错误处理：是否丢弃 err？是否应 %w 包装？\n2. 并发：map / 共享状态是否有锁？是否误用 sync.Map？\n3. Context：是否透传？超时是否用 WithTimeout？\n4. 资源：defer 关闭、goroutine 是否泄漏？\n5. 测试：关键路径尤其并发路径是否有 -race 用例？\n\n**口径**：解释「为什么」而非只给「怎么改」，用户为中级水平。',
    tags: ['go', 'review'],
    created_at: ts(150),
  },
  {
    id: 'rev-l2-2',
    title: '解释风格偏好',
    body:
      '## 解释风格（场景记忆）\n\n- 先给结论，再展开原理\n- 用对比（✅ 正确 / ❌ 错误）呈现\n- 关联「隐性 bug」后果，提升用户重视度',
    tags: ['沟通'],
    created_at: ts(149),
  },
];

const revL3: ChatMemoryLayerItem[] = [
  {
    id: 'rev-l3-1',
    title: '代码评审 Agent 准则',
    body:
      '# 代码评审 Agent 准则（L3）\n\n- **核心职责**：在正确性、并发安全、资源管理上把关\n- **解释原则**：结论先行 + 原理展开，面向中级开发者\n- **硬性红线**：禁止静默吞错、禁止裸 map 并发、禁止裸 time.After\n- **交付标准**：评审意见附带「为什么」，关键改动须有 -race 测试',
    tags: ['persona'],
    created_at: ts(148),
  },
];

// ───────────────────────── Block 3：旅行规划 Agent · 目的地知识（L0 较长，演示「加载更多」） ─────────────────────────
const travelL0: ChatMemoryLayerItem[] = [
  { id: 'tr-l0-1', role: 'user', title: '', body: '我想下个月去云南，第一次去，有什么推荐路线吗？', created_at: ts(300) },
  { id: 'tr-l0-2', role: 'assistant', title: '', body: '云南很适合首次出游～经典小环线：昆明 → 大理 → 丽江 → 香格里拉，7 天刚好。想轻松点可以砍掉香格里拉。', created_at: ts(299) },
  { id: 'tr-l0-3', role: 'user', title: '', body: '香格里拉海拔高吗？我有点怕高反。', created_at: ts(298) },
  { id: 'tr-l0-4', role: 'assistant', title: '', body: '香格里拉海拔约 3300m，大部分人只是轻微不适。建议到达第一天不洗澡、慢走、多喝水，备点红景天。', created_at: ts(297) },
  { id: 'tr-l0-5', role: 'user', title: '', body: '那大理和丽江有什么区别？', created_at: ts(290) },
  { id: 'tr-l0-6', role: 'assistant', title: '', body: '大理更安静、适合环洱海骑行的慢生活；丽江古城更热闹、夜生活多，玉龙雪山就在旁边。看你喜欢安静还是热闹。', created_at: ts(289) },
  { id: 'tr-l0-7', role: 'user', title: '', body: '我喜欢安静，那就大理多待。洱海怎么玩？', created_at: ts(280) },
  { id: 'tr-l0-8', role: 'assistant', title: '', body: '洱海建议租电动车或自驾环湖，打卡喜洲古镇、双廊、小普陀。注意环保，现在禁机动车入核心湖区，多靠骑行。', created_at: ts(279) },
  { id: 'tr-l0-9', role: 'user', title: '', body: '美食呢？有什么必吃？', created_at: ts(270) },
  { id: 'tr-l0-10', role: 'assistant', title: '', body: '过桥米线、汽锅鸡、野生菌火锅（雨季最佳）、乳扇、喜洲粑粑。菌子季 6-9 月最鲜，但务必煮熟。', created_at: ts(269) },
  { id: 'tr-l0-11', role: 'user', title: '', body: '几月份去最好？', created_at: ts(260) },
  { id: 'tr-l0-12', role: 'assistant', title: '', body: '3-5 月春暖花开、人少；9-11 月秋高气爽、彩林绝美。7-8 月雨季但也是菌子季。避开十一黄金周，人多价高。', created_at: ts(259) },
  { id: 'tr-l0-13', role: 'user', title: '', body: '交通怎么安排？飞机还是高铁？', created_at: ts(250) },
  { id: 'tr-l0-14', role: 'assistant', title: '', body: '多数城市飞昆明长水机场最方便；省内昆明→大理、大理→丽江都有动车，2 小时内，比自驾省心。', created_at: ts(249) },
  { id: 'tr-l0-15', role: 'user', title: '', body: '住宿有推荐区域吗？', created_at: ts(240) },
  { id: 'tr-l0-16', role: 'assistant', title: '', body: '大理住才村 / 龙龛码头看海方便；丽江住束河古镇比大研更安静；香格里拉住独克宗古城。', created_at: ts(239) },
  { id: 'tr-l0-17', role: 'user', title: '', body: '预算大概多少？', created_at: ts(230) },
  { id: 'tr-l0-18', role: 'assistant', title: '', body: '中等舒适度 7 天人均约 4000-6000（含机票），住宿占大头，古城客栈 300-600/晚即可很有氛围。', created_at: ts(229) },
  { id: 'tr-l0-19', role: 'user', title: '', body: '有什么坑要避开？', created_at: ts(220) },
  { id: 'tr-l0-20', role: 'assistant', title: '', body: '古城拉客的「低价游」、骑马拍照宰客、路边野菌别乱采。正规渠道订票订房，价格透明更安心。', created_at: ts(219) },
  { id: 'tr-l0-21', role: 'user', title: '', body: '玉龙雪山要提前预约吗？', created_at: ts(210) },
  { id: 'tr-l0-22', role: 'assistant', title: '', body: '旺季（节假日 / 暑期）需提前 1-3 天在官方公众号预约大索道票，现场常售罄；选含氧气瓶和防寒服的套票更省心。', created_at: ts(209) },
  { id: 'tr-l0-23', role: 'user', title: '', body: '拍照出片点有推荐吗？', created_at: ts(200) },
  { id: 'tr-l0-24', role: 'assistant', title: '', body: '大理：喜洲黄墙、双廊海地生活；丽江：蓝月谷、千古情；香格里拉：普达措、松赞林寺。清晨人少光好。', created_at: ts(199) },
  { id: 'tr-l0-25', role: 'user', title: '', body: '好，我先按这个思路规划，谢谢！', created_at: ts(198) },
  { id: 'tr-l0-26', role: 'system', title: '', body: '已为用户 u_traveler 生成「云南 7 日小环线」草稿行程（昆明-大理-丽江），待确认。', created_at: ts(197) },
];

const travelL1: ChatMemoryLayerItem[] = [
  { id: 'tr-l1-1', title: '经典路线：云南小环线', body: '首次云南推荐 昆明 → 大理 → 丽江 → 香格里拉，7 天；轻松版可砍掉香格里拉。', tags: ['路线'], created_at: ts(196) },
  { id: 'tr-l1-2', title: '高反提示', body: '香格里拉海拔约 3300m；到达首日不洗澡、慢走、多喝水，备红景天。', tags: ['健康', '香格里拉'], created_at: ts(195) },
  { id: 'tr-l1-3', title: '大理 vs 丽江', body: '大理安静慢生活、适合环洱海骑行；丽江热闹、夜生活多、近玉龙雪山。用户偏好安静 → 推荐大理多留。', tags: ['偏好', '目的地'], created_at: ts(194) },
  { id: 'tr-l1-4', title: '最佳出行月份', body: '3-5 月春、9-11 月秋最佳；6-9 月菌子季；避开十一黄金周。', tags: ['季节'], created_at: ts(193) },
  { id: 'tr-l1-5', title: '预算区间', body: '7 天人均约 4000-6000（含机票），古城客栈 300-600/晚。', tags: ['预算'], created_at: ts(192) },
  { id: 'tr-l1-6', title: '避坑', body: '低价游拉客、骑马宰客、野菌乱采均要避开；走正规渠道订票订房。', tags: ['避坑'], created_at: ts(191) },
];

const travelL2: ChatMemoryLayerItem[] = [
  {
    id: 'tr-l2-1',
    title: '云南出行知识包',
    body:
      '## 云南出行知识包（场景记忆）\n\n- **交通**：飞昆明长水最方便；省内昆明↔大理↔丽江动车 2h 内\n- **住宿**：大理才村/龙龛看海；丽江束河比大研安静；香格里拉独克宗\n- **美食**：过桥米线、汽锅鸡、野生菌火锅（雨季）、乳扇、喜洲粑粑\n- **出片**：喜洲黄墙、双廊、蓝月谷、普达措、松赞林寺（清晨最佳）\n- **预约**：玉龙雪山大索道旺季提前 1-3 天官方预约',
    tags: ['知识包'],
    created_at: ts(190),
  },
  {
    id: 'tr-l2-2',
    title: '用户旅行偏好',
    body:
      '## 用户旅行偏好（场景记忆）\n\n- 偏好安静、慢节奏，避开了丽江热闹古城\n- 关注美食、出片、预算与避坑\n- 首次到访，需要「为什么」式的背景解释',
    tags: ['偏好'],
    created_at: ts(189),
  },
];

const travelL3: ChatMemoryLayerItem[] = [
  {
    id: 'tr-l3-1',
    title: '旅行规划 Agent 画像',
    body:
      '# 旅行规划 Agent 画像（L3）\n\n- **服务风格**：先给路线骨架，再按偏好（安静/热闹、预算、季节）细化\n- **知识重点**：交通接驳、住宿区域、季节窗口、避坑与预约\n- **用户画像**：首次出游者，需背景解释；偏好安静慢节奏\n- **交付标准**：给出可执行的日程草稿 + 预算区间 + 健康提示',
    tags: ['persona'],
    created_at: ts(188),
  },
];

// ───────────────────────── Block 4：投研助手 · 行业图谱 ─────────────────────────
const resL0: ChatMemoryLayerItem[] = [
  { id: 'rs-l0-1', role: 'user', title: '', body: '帮我梳理下半导体设备国产替代这条链的逻辑。', created_at: ts(400) },
  { id: 'rs-l0-2', role: 'assistant', title: '', body: '核心逻辑：外部限制 → 自主可控诉求 → 国产化率提升。拆三层：光刻、刻蚀/薄膜、量测，国产化率依次升高。', created_at: ts(399) },
  { id: 'rs-l0-3', role: 'user', title: '', body: '哪块国产化率最低、弹性最大？', created_at: ts(398) },
  { id: 'rs-l0-4', role: 'assistant', title: '', body: '光刻（尤其光刻机）国产化率最低、卡脖子最严重，弹性也最大；刻蚀/薄膜已有一批上市公司跑出份额。', created_at: ts(397) },
  { id: 'rs-l0-5', role: 'user', title: '', body: '那看业绩要盯什么指标？', created_at: ts(380) },
  { id: 'rs-l0-6', role: 'assistant', title: '', body: '看订单（尤其是大客户重复下单）、存货周转、毛利率趋势，以及研发费用率。设备是订单驱动，收入确认有滞后。', created_at: ts(379) },
  { id: 'rs-l0-7', role: 'user', title: '', body: '风险点呢？', created_at: ts(360) },
  { id: 'rs-l0-8', role: 'assistant', title: '', body: '三风险：①下游晶圆厂资本开支放缓；②技术迭代不及预期；③估值已提前反映预期，利好兑现即兑现。', created_at: ts(359) },
  { id: 'rs-l0-9', role: 'tool', title: '', body: 'query_finance → 板块「半导体设备」近 60 日区间 +18.3%，北向持仓占比 6.1%。', created_at: ts(358) },
  { id: 'rs-l0-10', role: 'assistant', title: '', body: '板块近期走强，但北向占比不算高，说明主要驱动是内资预期。跟踪月度订单数据验证景气。', created_at: ts(357) },
];

const resL1: ChatMemoryLayerItem[] = [
  { id: 'rs-l1-1', title: '国产替代核心逻辑', body: '外部限制 → 自主可控 → 国产化率提升；光刻/刻蚀薄膜/量测国产化率依次升高。', tags: ['半导体', '逻辑'], created_at: ts(356) },
  { id: 'rs-l1-2', title: '弹性最大环节', body: '光刻（尤其光刻机）国产化率最低、卡脖子最严重、弹性最大；刻蚀/薄膜已有份额。', tags: ['半导体', '弹性'], created_at: ts(355) },
  { id: 'rs-l1-3', title: '业绩跟踪指标', body: '盯订单（大客户重复下单）、存货周转、毛利率趋势、研发费用率；设备订单驱动、收入确认滞后。', tags: ['投研', '指标'], created_at: ts(354) },
  { id: 'rs-l1-4', title: '三大风险', body: '①晶圆厂资本开支放缓 ②技术迭代不及预期 ③估值提前反映预期、利好兑现即兑现。', tags: ['风险'], created_at: ts(353) },
  { id: 'rs-l1-5', title: '资金面观察', body: '板块近期走强但北向占比不高 → 内资预期驱动；用月度订单数据验证景气。', tags: ['资金面'], created_at: ts(352) },
  { id: 'rs-l1-6', title: '用户画像：进阶投研', body: '用户懂基本面框架，直接给结论与风险，少铺垫。', tags: ['用户画像'], created_at: ts(351) },
];

const resL2: ChatMemoryLayerItem[] = [
  {
    id: 'rs-l2-1',
    title: '半导体设备研究框架',
    body:
      '## 半导体设备研究框架（场景记忆）\n\n1. **逻辑层**：限制 → 自主可控 → 国产化率\n2. **环节拆分**：光刻(低) / 刻蚀薄膜(中) / 量测(高) 国产化率\n3. **景气验证**：月度订单、晶圆厂 Capex、存货周转\n4. **风险清单**：Capex 放缓、技术不及预期的、估值兑现\n5. **资金面**：北向占比判断内外资驱动',
    tags: ['框架', '半导体'],
    created_at: ts(350),
  },
  {
    id: 'rs-l2-2',
    title: '沟通口径',
    body:
      '## 沟通口径（场景记忆）\n\n- 用户为进阶投研者：结论先行、风险并重\n- 用「逻辑 → 弹性 → 验证 → 风险」四段式\n- 涉及数据必带来源与口径说明',
    tags: ['沟通'],
    created_at: ts(349),
  },
];

const resL3: ChatMemoryLayerItem[] = [
  {
    id: 'rs-l3-1',
    title: '投研助手准则',
    body:
      '# 投研助手准则（L3）\n\n- **定位**：基本面研究框架提供者，非荐股\n- **结构**：逻辑 → 弹性 → 验证 → 风险 四段式\n- **数据纪律**：所有数据标注来源与口径，不臆造\n- **用户画像**：进阶者，结论与风险并重，少铺垫\n- **免责**：观点仅供研究，不构成投资建议',
    tags: ['persona'],
    created_at: ts(348),
  },
];

// ───────────────────────── Block 5：数据分析 Agent · 指标口径 ─────────────────────────
const metL0: ChatMemoryLayerItem[] = [
  { id: 'mt-l0-1', role: 'user', title: '', body: '我们北极星指标到底用 DAU 还是 WAU？', created_at: ts(500) },
  { id: 'mt-l0-2', role: 'assistant', title: '', body: '取决于业务节奏。高频日活类产品看 DAU；低频周活类（如招聘、旅游）WAU 更稳定、噪声更小。先明确产品使用频次再定。', created_at: ts(499) },
  { id: 'mt-l0-3', role: 'user', title: '', body: '我们是一周用两三次的工具，那 WAU？', created_at: ts(498) },
  { id: 'mt-l0-4', role: 'assistant', title: '', body: '对，WAU 更合适。但建议同时监控「周活跃中 3 日以上活跃占比」作为粘性补充指标。', created_at: ts(497) },
  { id: 'mt-l0-5', role: 'user', title: '', body: '留存怎么算口径统一下？', created_at: ts(480) },
  { id: 'mt-l0-6', role: 'assistant', title: '', body: '次日留存 = 第 N+1 日仍活跃用户 / 第 N 日新增；注意「活跃」定义要和北极星一致，且去重到用户粒度，避免设备重复计数。', created_at: ts(479) },
  { id: 'mt-l0-7', role: 'user', title: '', body: '有个看板说留存涨了，但我怀疑是口径变了。', created_at: ts(470) },
  { id: 'mt-l0-8', role: 'assistant', title: '', body: '常见坑：改了「活跃」定义、把老用户回访算进新增、或时间窗偏移。先冻结口径版本，再对比同口径环比。', created_at: ts(469) },
  { id: 'mt-l0-9', role: 'tool', title: '', body: 'query_metric → 本周 WAU 1,284,300，环比 +2.1%；3 日+活跃占比 41.3%。', created_at: ts(468) },
  { id: 'mt-l0-10', role: 'assistant', title: '', body: '同口径下 WAU 环比 +2.1% 是真实增长；3 日+占比 41.3% 说明粘性健康。可放心对外汇报。', created_at: ts(467) },
];

const metL1: ChatMemoryLayerItem[] = [
  { id: 'mt-l1-1', title: '北极星选择', body: '高频产品用 DAU，低频（周活）产品用 WAU；选定后配套粘性指标（如 3 日+活跃占比）。', tags: ['指标', '北极星'], created_at: ts(466) },
  { id: 'mt-l1-2', title: '留存口径', body: '次日留存 = N+1 日仍活跃 / N 日新增；「活跃」定义须与北极星一致，去重到用户粒度。', tags: ['留存', '口径'], created_at: ts(465) },
  { id: 'mt-l1-3', title: '口径漂移预警', body: '看板「异常上涨」先排查口径变更：活跃定义、新增口径、时间窗偏移。冻结口径版本再对比。', tags: ['口径', '风险'], created_at: ts(464) },
  { id: 'mt-l1-4', title: '数据真实性', body: '汇报前确认同口径环比；异动先看口径再看业务。', tags: ['纪律'], created_at: ts(463) },
  { id: 'mt-l1-5', title: '用户画像：数据负责人', body: '用户为指标口径 owner，关注口径一致性与可解释性。', tags: ['用户画像'], created_at: ts(462) },
];

const metL2: ChatMemoryLayerItem[] = [
  {
    id: 'mt-l2-1',
    title: '指标口径字典',
    body:
      '## 指标口径字典（场景记忆）\n\n- **WAU**：自然周内去重活跃用户（用户粒度）\n- **次日留存**：(N+1 日活跃 ∩ N 日新增) / N 日新增\n- **3 日+活跃占比**：周内活跃 ≥3 天用户 / WAU\n- **活跃定义**：完成核心动作（非仅打开），与北极星一致\n- **口径版本**：每次变更打版，对比必须同版本',
    tags: ['口径', '字典'],
    created_at: ts(461),
  },
  {
    id: 'mt-l2-2',
    title: '异常排查 SOP',
    body:
      '## 指标异常排查 SOP（场景记忆）\n\n1. 先确认口径版本是否被改\n2. 核对时间窗与去重粒度\n3. 同口径环比 / 同比\n4. 拆解分子分母定位来源\n5. 业务侧交叉验证后再下结论',
    tags: ['SOP', '异常'],
    created_at: ts(460),
  },
];

const metL3: ChatMemoryLayerItem[] = [
  {
    id: 'mt-l3-1',
    title: '数据分析 Agent 准则',
    body:
      '# 数据分析 Agent 准则（L3）\n\n- **第一原则**：口径一致、定义可追溯、版本可冻结\n- **解读结构**：指标定义 → 同口径对比 → 拆解归因 → 业务验证\n- **用户画像**：指标口径 owner，重视可解释性与防误读\n- **红线**：不跨口径比较、不臆造口径、异动先查口径',
    tags: ['persona'],
    created_at: ts(459),
  },
];

// ───────────────────────── 组装 ─────────────────────────
function block(
  id: string,
  title: string,
  summary: string,
  uploadedBy: string,
  updatedMinAgo: number,
  l0: ChatMemoryLayerItem[],
  l1: ChatMemoryLayerItem[],
  l2: ChatMemoryLayerItem[],
  l3: ChatMemoryLayerItem[],
): ChatMemoryBlock {
  return {
    id,
    title,
    summary,
    uploaded_by_user_id: uploadedBy,
    updated_at_ms: NOW - updatedMinAgo * 60_000,
    layer_counts: { L0_messages: l0.length, L1: l1.length, L2: l2.length, L3: l3.length },
    scope: 'team',
  };
}

export const MOCK_BLOCKS: ChatMemoryBlock[] = [
  block('block-cs-pref', '客服助手 · 用户偏好与售后记忆', '沉淀高频用户的退换货偏好、会员等级与沟通风格，支撑个性化服务。', 'u_dandan', 30, csL0, csL1, csL2, csL3),
  block('block-reviewer', '代码评审 Agent · 技术规范', 'Go 错误处理、并发安全、context 与测试规范的评审知识沉淀。', 'u_zhang', 150, revL0, revL1, revL2, revL3),
  block('block-travel', '旅行规划 Agent · 目的地知识', '云南出行知识包：路线、季节、住宿、美食、避坑与预约。', 'u_lin', 190, travelL0, travelL1, travelL2, travelL3),
  block('block-research', '投研助手 · 行业图谱', '半导体设备国产替代的研究框架、弹性环节、验证指标与风险。', 'u_zhao', 350, resL0, resL1, resL2, resL3),
  block('block-metrics', '数据分析 Agent · 指标口径', '北极星、留存与异常排查的口径字典与 SOP，保障可解释性。', 'u_dandan', 460, metL0, metL1, metL2, metL3),
];

/** 按 `blockId::layer` 读取某块的某层模拟数据 */
export function getMockLayer(blockId: string, layer: string): ChatMemoryLayerItem[] {
  const map: Record<string, ChatMemoryLayerItem[]> = {
    'block-cs-pref::L0': csL0,
    'block-cs-pref::L1': csL1,
    'block-cs-pref::L2': csL2,
    'block-cs-pref::L3': csL3,
    'block-reviewer::L0': revL0,
    'block-reviewer::L1': revL1,
    'block-reviewer::L2': revL2,
    'block-reviewer::L3': revL3,
    'block-travel::L0': travelL0,
    'block-travel::L1': travelL1,
    'block-travel::L2': travelL2,
    'block-travel::L3': travelL3,
    'block-research::L0': resL0,
    'block-research::L1': resL1,
    'block-research::L2': resL2,
    'block-research::L3': resL3,
    'block-metrics::L0': metL0,
    'block-metrics::L1': metL1,
    'block-metrics::L2': metL2,
    'block-metrics::L3': metL3,
  };
  return map[`${blockId}::${layer}`] ?? [];
}
