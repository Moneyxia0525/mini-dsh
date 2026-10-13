import type { BenchmarkTask, TaskEvaluation } from "./types";
import { writeFiles, runNode, readTrim, fileExists } from "./helpers";

/**
 * 20-task Benchmark（对应文档 §7.1）。
 * 每个任务：初始化文件 -> 交给 Agent -> 客观判定。
 * 判定方式以「运行代码 / 检查产物」为主，避免人工主观打分。
 */

/* ------------------------------------------------------------------ *
 * 1. 代码理解（4）
 * ------------------------------------------------------------------ */

const understandingTasks: BenchmarkTask[] = [
  {
    id: "u1_config_value",
    category: "code_understanding",
    description: "读取 src/config.ts 中 API_BASE 常量的值，把该值（不带引号、不带多余文字）写入 answer.txt。",
    setup: (d) =>
      writeFiles(d, {
        "src/config.ts": `export const APP_NAME = "demo";\nexport const API_BASE = "https://api.example.com/v2";\nexport const TIMEOUT = 5000;\n`,
      }),
    evaluate: (d) => {
      const v = readTrim(d, "answer.txt");
      return v === "https://api.example.com/v2"
        ? { passed: true, detail: `answer.txt = ${v}` }
        : { passed: false, detail: `answer.txt 期望 https://api.example.com/v2，实际 "${v}"` };
    },
  },
  {
    id: "u2_word_count",
    category: "code_understanding",
    description: "统计 data/words.txt 中的单词总数（以空白分隔），把数字写入 answer.txt。",
    setup: (d) => writeFiles(d, { "data/words.txt": "hello world mini dsh harness agent\ncoding tool loop\nsession context\n" }),
    evaluate: (d) => {
      const v = readTrim(d, "answer.txt");
      return v === "12"
        ? { passed: true, detail: "单词数 12" }
        : { passed: false, detail: `期望 12，实际 "${v}"` };
    },
  },
  {
    id: "u3_default_value",
    category: "code_understanding",
    description: "读取 src/user.ts，找出 email 字段的默认值，把该默认值写入 answer.txt。",
    setup: (d) =>
      writeFiles(d, {
        "src/user.ts": `interface User { name: string; email: string; active: boolean }\nconst defaults: User = { name: "anonymous", email: "nobody@example.com", active: true };\nexport default defaults;\n`,
      }),
    evaluate: (d) => {
      const v = readTrim(d, "answer.txt");
      return v === "nobody@example.com"
        ? { passed: true, detail: `email 默认值 ${v}` }
        : { passed: false, detail: `期望 nobody@example.com，实际 "${v}"` };
    },
  },
  {
    id: "u4_list_md",
    category: "code_understanding",
    description: "列出项目根目录下所有 .md 文件，把文件名逐行写入 answer.txt（每行一个文件名）。",
    setup: (d) =>
      writeFiles(d, {
        "README.md": "# demo",
        "docs/DESIGN.md": "# design",
        "docs/NOTES.md": "# notes",
        "src/index.ts": "export {};\n",
      }),
    evaluate: (d) => {
      const v = readTrim(d, "answer.txt");
      const lines = v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
      const ok = lines.length >= 3 && lines.includes("README.md") && lines.includes("DESIGN.md") && lines.includes("NOTES.md");
      return ok ? { passed: true, detail: `找到 ${lines.length} 个 .md` } : { passed: false, detail: `answer.txt: "${v}"` };
    },
  },
];

/* ------------------------------------------------------------------ *
 * 2. Bug 修复（4）
 * ------------------------------------------------------------------ */

const bugFixTasks: BenchmarkTask[] = [
  {
    id: "b1_add",
    category: "bug_fix",
    description: "修复 src/calc.js 中 add 函数的 bug，使 add(2,3) 返回 5、add(10,5) 返回 15。",
    setup: (d) => writeFiles(d, { "src/calc.js": `module.exports = { add: function (a, b) { return a - b; } };\n` }),
    evaluate: (d) => {
      const r = runNode(d, `const { add } = require('./src/calc.js'); if (add(2,3)!==5 || add(10,5)!==15) process.exit(1); console.log('ok');`);
      return r.exitCode === 0 ? { passed: true, detail: "add 计算正确" } : { passed: false, detail: r.stderr || r.stdout || "add 结果错误" };
    },
  },
  {
    id: "b2_fizzbuzz",
    category: "bug_fix",
    description: "修复 src/fizzbuzz.js：当前 FizzBuzz 分支永远不会命中。修复后 fizzbuzz(15) 的第 15 个元素应为 \"FizzBuzz\"。",
    setup: (d) =>
      writeFiles(d, {
        "src/fizzbuzz.js": `module.exports = function fizzbuzz(n) {\n  const out = [];\n  for (let i = 1; i <= n; i++) {\n    if (i % 3 === 0) out.push("Fizz");\n    else if (i % 5 === 0) out.push("Buzz");\n    else if (i % 15 === 0) out.push("FizzBuzz");\n    else out.push(i);\n  }\n  return out;\n};\n`,
      }),
    evaluate: (d) => {
      const r = runNode(d, `const f = require('./src/fizzbuzz.js'); const a = f(15); if (a[14] !== "FizzBuzz") process.exit(1); if (a[2] !== "Fizz" || a[4] !== "Buzz") process.exit(1); console.log('ok');`);
      return r.exitCode === 0 ? { passed: true, detail: "FizzBuzz 逻辑正确" } : { passed: false, detail: r.stderr || "逻辑仍错误" };
    },
  },
  {
    id: "b3_parse_guard",
    category: "bug_fix",
    description: "修复 src/parse.js 的 parseJson：当输入为 null/undefined 或非法 JSON 时返回 null（而非抛异常），合法 JSON 仍正常解析。",
    setup: (d) => writeFiles(d, { "src/parse.js": `module.exports = function parseJson(str) { return JSON.parse(str); };\n` }),
    evaluate: (d) => {
      const r = runNode(
        d,
        `const p = require('./src/parse.js'); if (p(null) !== null || p(undefined) !== null) process.exit(1); if (p('not json') !== null) process.exit(1); if (p('{"a":1}').a !== 1) process.exit(1); console.log('ok');`,
      );
      return r.exitCode === 0 ? { passed: true, detail: "异常输入已防护" } : { passed: false, detail: r.stderr || "仍会抛异常" };
    },
  },
  {
    id: "b4_sort_desc",
    category: "bug_fix",
    description: "修复 src/sort.js：sortDesc 应返回降序数组，当前却返回升序。修复后 sortDesc([1,5,2]) 应等于 [5,2,1]。",
    setup: (d) => writeFiles(d, { "src/sort.js": `module.exports = function sortDesc(arr) { return arr.slice().sort((a, b) => a - b); };\n` }),
    evaluate: (d) => {
      const r = runNode(d, `const s = require('./src/sort.js'); const a = s([1,5,2]); if (JSON.stringify(a) !== '[5,2,1]') process.exit(1); console.log('ok');`);
      return r.exitCode === 0 ? { passed: true, detail: "降序排序正确" } : { passed: false, detail: r.stderr || "排序仍错误" };
    },
  },
];

/* ------------------------------------------------------------------ *
 * 3. 功能实现（4）
 * ------------------------------------------------------------------ */

const featureTasks: BenchmarkTask[] = [
  {
    id: "f1_sum",
    category: "feature_impl",
    description: "实现 src/sum.js 的 sum 函数：返回数组所有元素之和（空数组返回 0）。",
    setup: (d) => writeFiles(d, { "src/sum.js": `// TODO: 实现 sum\nmodule.exports = function sum(arr) { return 0; };\n` }),
    evaluate: (d) => {
      const r = runNode(d, `const sum = require('./src/sum.js'); if (sum([1,2,3]) !== 6) process.exit(1); if (sum([]) !== 0) process.exit(1); if (sum([-1,1]) !== 0) process.exit(1); console.log('ok');`);
      return r.exitCode === 0 ? { passed: true, detail: "sum 正确" } : { passed: false, detail: r.stderr || "sum 错误" };
    },
  },
  {
    id: "f2_factorial",
    category: "feature_impl",
    description: "实现 src/factorial.js 的 factorial 函数：计算 n 的阶乘，factorial(0) 应为 1。",
    setup: (d) => writeFiles(d, { "src/factorial.js": `module.exports = function factorial(n) { return 1; };\n` }),
    evaluate: (d) => {
      const r = runNode(d, `const f = require('./src/factorial.js'); if (f(5) !== 120) process.exit(1); if (f(0) !== 1) process.exit(1); console.log('ok');`);
      return r.exitCode === 0 ? { passed: true, detail: "factorial 正确" } : { passed: false, detail: r.stderr || "factorial 错误" };
    },
  },
  {
    id: "f3_reverse",
    category: "feature_impl",
    description: "实现 src/reverse.js 的 reverse 函数：反转字符串。reverse(\"abc\") 应返回 \"cba\"。",
    setup: (d) => writeFiles(d, { "src/reverse.js": `module.exports = function reverse(s) { return s; };\n` }),
    evaluate: (d) => {
      const r = runNode(d, `const rev = require('./src/reverse.js'); if (rev('abc') !== 'cba') process.exit(1); if (rev('a') !== 'a') process.exit(1); console.log('ok');`);
      return r.exitCode === 0 ? { passed: true, detail: "reverse 正确" } : { passed: false, detail: r.stderr || "reverse 错误" };
    },
  },
  {
    id: "f4_filter_even",
    category: "feature_impl",
    description: "实现 src/filterEven.js 的 filterEven 函数：返回数组中所有偶数组成的新数组。",
    setup: (d) => writeFiles(d, { "src/filterEven.js": `module.exports = function filterEven(arr) { return []; };\n` }),
    evaluate: (d) => {
      const r = runNode(d, `const fe = require('./src/filterEven.js'); const a = fe([1,2,3,4,6]); if (JSON.stringify(a) !== '[2,4,6]') process.exit(1); console.log('ok');`);
      return r.exitCode === 0 ? { passed: true, detail: "filterEven 正确" } : { passed: false, detail: r.stderr || "filterEven 错误" };
    },
  },
];

/* ------------------------------------------------------------------ *
 * 4. 重构（4）
 * ------------------------------------------------------------------ */

const refactorTasks: BenchmarkTask[] = [
  {
    id: "r1_rename",
    category: "refactor",
    description: "把 src/rename.js 中的 oldFn 重命名为 double，并保持功能不变（double(x) 返回 x*2）。",
    setup: (d) => writeFiles(d, { "src/rename.js": `module.exports = { oldFn: (x) => x * 2 };\n` }),
    evaluate: (d) => {
      const r = runNode(d, `const m = require('./src/rename.js'); if (typeof m.double !== 'function') process.exit(1); if (m.double(4) !== 8) process.exit(1); if ('oldFn' in m) process.exit(1); console.log('ok');`);
      return r.exitCode === 0 ? { passed: true, detail: "已重命名且行为不变" } : { passed: false, detail: r.stderr || "重命名失败" };
    },
  },
  {
    id: "r2_extract_constant",
    category: "refactor",
    description: "重构 src/price.js：把魔法数字 1.08 提取为常量 TAX_RATE，priceWithTax 行为不变。",
    setup: (d) => writeFiles(d, { "src/price.js": `module.exports = function priceWithTax(price) { return price * 1.08; };\n` }),
    evaluate: (d) => {
      const src = readTrim(d, "src/price.js");
      const r = runNode(d, `const p = require('./src/price.js'); if (p(100) !== 108) process.exit(1); console.log('ok');`);
      if (r.exitCode !== 0) return { passed: false, detail: r.stderr || "行为改变" };
      if (!src.includes("TAX_RATE")) return { passed: false, detail: "未提取 TAX_RATE 常量" };
      return { passed: true, detail: "已提取常量且行为不变" };
    },
  },
  {
    id: "r3_extract_validate",
    category: "refactor",
    description: "重构 src/order.js：提取独立的 validate 函数用于校验订单，processOrder 内部调用它，行为不变。",
    setup: (d) =>
      writeFiles(d, {
        "src/order.js": `module.exports = function processOrder(order) {\n  if (!order || typeof order.amount !== "number" || order.amount <= 0) return { ok: false };\n  return { ok: true, total: order.amount };\n};\n`,
      }),
    evaluate: (d) => {
      const src = readTrim(d, "src/order.js");
      const r = runNode(d, `const p = require('./src/order.js'); if (p({ amount: -1 }).ok !== false) process.exit(1); if (p({ amount: 100 }).total !== 100) process.exit(1); console.log('ok');`);
      if (r.exitCode !== 0) return { passed: false, detail: r.stderr || "行为改变" };
      if (!src.includes("function validate")) return { passed: false, detail: "未提取 validate 函数" };
      return { passed: true, detail: "已提取 validate 且行为不变" };
    },
  },
  {
    id: "r4_extract_transform",
    category: "refactor",
    description: "重构 src/util.js：提取重复的 map 遍历为一个通用的 transform 辅助函数，upperAll 与 upperFirst 复用它，行为不变。",
    setup: (d) =>
      writeFiles(d, {
        "src/util.js": `module.exports = {\n  upperAll: (arr) => arr.map((s) => s.toUpperCase()),\n  upperFirst: (arr) => arr.map((s) => (s.length ? s[0].toUpperCase() + s.slice(1) : s)),\n};\n`,
      }),
    evaluate: (d) => {
      const src = readTrim(d, "src/util.js");
      const r = runNode(d, `const u = require('./src/util.js'); if (u.upperAll(['a'])[0] !== 'A') process.exit(1); if (u.upperFirst(['ab'])[0] !== 'Ab') process.exit(1); console.log('ok');`);
      if (r.exitCode !== 0) return { passed: false, detail: r.stderr || "行为改变" };
      if (!src.includes("function transform")) return { passed: false, detail: "未提取 transform 辅助函数" };
      return { passed: true, detail: "已提取 transform 且行为不变" };
    },
  },
];

/* ------------------------------------------------------------------ *
 * 5. 测试编写（4）
 * ------------------------------------------------------------------ */

function testTask(id: string, modFile: string, testFile: string, desc: string, moduleSrc: string): BenchmarkTask {
  return {
    id,
    category: "test_write",
    description: desc,
    setup: (d) => writeFiles(d, { [modFile]: moduleSrc }),
    evaluate: (d) => {
      if (!fileExists(d, testFile)) return { passed: false, detail: `测试文件 ${testFile} 不存在` };
      const content = readTrim(d, testFile);
      if (!content.includes("assert")) return { passed: false, detail: "测试未使用 node:assert" };
      const r = runNode(d, `require(${JSON.stringify("./" + testFile)});`);
      return r.exitCode === 0
        ? { passed: true, detail: "测试运行通过" }
        : { passed: false, detail: r.stderr || "测试运行失败" };
    },
  };
}

const testTasks: BenchmarkTask[] = [
  testTask(
    "t1_math_test",
    "src/math.js",
    "test/math.test.js",
    "为 src/math.js 编写单元测试，写入 test/math.test.js：使用 node:assert 断言 add(1,2)===3、add(-1,1)===0、subtract(5,3)===2。测试应能通过 `node test/math.test.js` 运行。",
    `module.exports = { add: (a, b) => a + b, subtract: (a, b) => a - b };\n`,
  ),
  testTask(
    "t2_string_test",
    "src/string.js",
    "test/string.test.js",
    "为 src/string.js 编写单元测试，写入 test/string.test.js：使用 node:assert 断言 upper(\"abc\")===\"ABC\"、lower(\"ABC\")===\"abc\"。",
    `module.exports = { upper: (s) => s.toUpperCase(), lower: (s) => s.toLowerCase() };\n`,
  ),
  testTask(
    "t3_array_test",
    "src/array.js",
    "test/array.test.js",
    "为 src/array.js 编写单元测试，写入 test/array.test.js：使用 node:assert 断言 last([1,2,3])===3、last([])===undefined。",
    `module.exports = { last: (arr) => arr[arr.length - 1] };\n`,
  ),
  testTask(
    "t4_bool_test",
    "src/bool.js",
    "test/bool.test.js",
    "为 src/bool.js 编写单元测试，写入 test/bool.test.js：使用 node:assert 断言 isPositive(5)===true、isPositive(-1)===false、isPositive(0)===false。",
    `module.exports = { isPositive: (n) => n > 0 };\n`,
  ),
];

export const benchmarkTasks: BenchmarkTask[] = [
  ...understandingTasks,
  ...bugFixTasks,
  ...featureTasks,
  ...refactorTasks,
  ...testTasks,
];

export const tasksByCategory = (category: BenchmarkTask["category"]): BenchmarkTask[] =>
  benchmarkTasks.filter((t) => t.category === category);
