// 冒烟测试：不开浏览器，直接把 client.js 的纯计算部分跑一遍。
// 覆盖：模型三段拆分、识图归属、命令归类、清理、格式化。
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

let captured;
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      captured = definition;
    },
  },
};

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
new Function("window", source)(globalThis.window);

const ReactStub = { createElement: () => null };
const mod = captured.factory((name) => {
  if (name === "react") return ReactStub;
  throw new Error(`unexpected require: ${name}`);
});
const { analyze, classify, format, turnNumberOf } = mod.__internals;

const event = (type, time, data = {}) => ({ type, time, data });
const chunk = (type, time, extra = {}) => ({ type: "chunk", time, chunk: { type, ...extra } });

// 第 1 轮：模型一次（含推理+正文）→ 跑测试 → 看截图 → 再一次模型 → 清理
const turn1 = [
  event("turn/start", 0, { turn: 1 }),
  event("step/start", 1000, { turn: 1, step: 1 }),
  event("assistant/message", 9000, {
    turn: 1,
    step: 1,
    stream: [
      { type: "reasoning-chunks", time0: 3000, index: 0, dt: [0, 1000], texts: ["a", "b", "c"] },
      { type: "text-chunks", time0: 6000, index: 1, dt: [500], texts: ["d", "e"] },
    ],
  }),
  event("tool/call", 9000, { turn: 1, step: 2, callId: "c1", name: "bash", arguments: '{"command":"npm test"}' }),
  event("tool/result", 19000, { turn: 1, step: 2, message: { toolCallId: "c1", isError: false } }),
  event("tool/call", 19000, { turn: 1, step: 3, callId: "c2", name: "read_image", arguments: '{"path":"/tmp/a.png"}' }),
  event("tool/result", 19100, { turn: 1, step: 3, message: { toolCallId: "c2", isError: false } }),
  event("step/start", 19100, { turn: 1, step: 4 }),
  event("assistant/message", 39100, {
    turn: 1,
    step: 4,
    stream: [{ type: "text-chunks", time0: 20000, index: 0, dt: [0], texts: ["x", "y"] }],
  }),
  event("tool/call", 39100, { turn: 1, step: 5, callId: "c3", name: "bash", arguments: '{"command":"rm -rf /tmp/a.png"}' }),
  event("tool/result", 41500, { turn: 1, step: 5, message: { toolCallId: "c3", isError: false } }),
  event("turn/end", 42000, { turn: 1, reason: { kind: "completed" } }),
];

// 第 2 轮：只有一次模型调用
const turn2 = [
  event("turn/start", 50000, { turn: 2 }),
  event("step/start", 51000, { turn: 2, step: 1 }),
  event("assistant/message", 61000, {
    turn: 2,
    step: 1,
    stream: [{ type: "reasoning-chunks", time0: 53000, index: 0, dt: [], texts: ["only"] }],
  }),
  event("turn/end", 62000, { turn: 2, reason: { kind: "completed" } }),
];

const report = analyze([...turn1, ...turn2].map((e) => ({ seq: 0, event: e })));

// ── 轮次与总时长 ───────────────────────────────────────────────
assert.equal(report.size, 2, "应折出两轮");
assert.equal(report.get(1).total, 42000);
assert.equal(report.get(2).total, 12000);

// ── 模型三段 ──────────────────────────────────────────────────
const model1 = report.get(1).model;
assert.equal(model1.ms, 8000 + 20000, "两次模型调用合计");
assert.equal(model1.ttft, 2000 + 900, "等首字 = 首个 delta − step/start");
assert.equal(model1.reasoning, 1000, "推理流跨度");
assert.equal(model1.text, 500, "正文流跨度");

// ── 识图挂到测试，并把那次模型调用整段计入 ─────────────────────
const test1 = report.get(1).buckets.get("测试");
assert.ok(test1, "应有测试分类");
assert.equal(test1.ms, 10000 + 20000 + 100, "命令测试 10s + 识图 20s + 截图工具 0.1s");
assert.equal(report.get(1).visionCount, 1);

// ── 清理 ─────────────────────────────────────────────────────
const cleanup = report.get(1).buckets.get("清理");
assert.ok(cleanup, "应有清理分类");
assert.equal(cleanup.ms, 2400);

// ── 其它分类不该被误吞 ─────────────────────────────────────────
assert.equal(report.get(2).buckets.get("测试"), undefined, "第二轮的推理不能被算成测试");

// ── 命令归类 ─────────────────────────────────────────────────
const cases = [
  ['{"command":"pnpm vitest run"}', ["测试", "命令测试"]],
  ['{"command":"mvn -q clean verify"}', ["测试", "命令测试"]],
  ['{"command":"mvn -q compile"}', ["构建", "构建"]],
  ['{"command":"pnpm install"}', ["构建", "安装"]],
  ['{"command":"npx eslint src"}', ["构建", "静态检查"]],
  ['{"command":"rm -rf /tmp/build.log"}', ["清理", "临时文件"]],
  ['{"command":"pkill -f vite"}', ["清理", "进程"]],
  ['{"command":"git checkout -- src/a.ts"}', ["清理", "还原"]],
  ['{"command":"cat package.json | grep test"}', ["编码", "搜索"]],
  ['{"command":"cat > /tmp/x.py"}', ["编码", "编辑"]],
  ['{"command":"cd /repo && ls -la"}', ["编码", "目录"]],
  ['{"command":"git status --short"}', ["编码", "git"]],
  ['{"command":"node scripts/check.mjs"}', ["编码", "脚本"]],
  ['{"command":"head -20 src/index.ts"}', ["编码", "看文件"]],
  ['{"command":"python3 -c import os"}', ["编码", "脚本"]],
];
for (const [args, expected] of cases) {
  assert.deepEqual(classify("bash", args), expected, `归类错误：${args}`);
}
assert.deepEqual(classify("edit", "{}"), ["编码", "编辑"]);
assert.deepEqual(classify("read", '{"file_path":"/a.ts"}'), ["编码", "看文件"]);
assert.deepEqual(classify("read_image", "{}"), ["测试", "识图"]);

// ── 格式化 ───────────────────────────────────────────────────
assert.equal(format(65000), "1m05s");
assert.equal(format(4200), "4s");
assert.equal(format(900), "0.9s");

// ── 打包过程中的假数据不应产生离谱时长 ─────────────────────────
const replay = [
  event("tool/call", 0, { turn: 9, step: 1, callId: "dup", name: "read", arguments: "{}" }),
  event("tool/call", 1000000, { turn: 9, step: 1, callId: "dup", name: "read", arguments: "{}" }),
  event("tool/result", 1000100, { turn: 9, step: 1, message: { toolCallId: "dup" } }),
  event("turn/start", 1000000, { turn: 9 }),
  event("turn/end", 1000100, { turn: 9 }),
];
const replayed = analyze(replay.map((e) => ({ seq: 0, event: e })));
assert.equal(replayed.get(9).buckets.get("编码").ms, 100, "FIFO 配对：应配到最近的那次调用");

// ── 轮次取值：槽位传的是 Turn 对象 ─────────────────────────────
assert.equal(turnNumberOf({ turn: 7, start: null, end: null, steps: [] }), 7);
assert.equal(turnNumberOf(3), 3);
assert.equal(turnNumberOf("4"), undefined, "字符串不猜");
assert.equal(turnNumberOf(undefined), undefined);

console.log("smoke: 9 组归类 + 轮次折叠 + 模型三段 + 识图归属 + FIFO 配对 全部通过");
