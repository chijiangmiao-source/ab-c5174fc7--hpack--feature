'use strict';

// 验收入口（可由 docker compose run verify 或直接 node verify.js 执行）：
//   1) 连续解码规则代码测试（node --test）
//   2) 页面构建检查
//   3) 对页面、健康路径与解码 API 实施 HTTP/API 冒烟（含跨段引用与失败回滚验收主线）
// 全部通过退出码 0，任一失败退出码 1。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { createServer } = require('./src/server');

let failures = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail && !cond ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
}

function step(title) {
  console.log(`\n=== ${title} ===`);
}

async function request(base, method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj));
    const u = new URL(urlPath, base);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        method,
        path: u.pathname + u.search,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitFor(base, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await request(base, 'GET', '/healthz');
      if (r.status === 200) return true;
    } catch { /* 服务尚未起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  // --- 1. 规则代码测试 -------------------------------------------------------
  step('1/3 连续解码规则代码测试 (node --test test/)');
  const t = spawnSync(process.execPath, ['--test', path.join(__dirname, 'test')], {
    cwd: __dirname,
    encoding: 'utf8',
  });
  const m = (t.stdout + t.stderr).match(/# (pass|fail|tests) (\d+)/g);
  console.log((m || ['（未能解析统计）']).join('\n'));
  check('全部单元测试通过', t.status === 0, `退出码 ${t.status}`);

  // --- 2. 页面构建检查 -------------------------------------------------------
  step('2/3 页面构建检查');
  const htmlPath = path.join(__dirname, 'src', 'web', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  check('页面文件存在且非空', html.length > 2000, `${html.length} 字节`);
  check('含 8 个段输入区生成逻辑', /const SEG_COUNT = 8/.test(html) && /i <= SEG_COUNT/.test(html));
  check('段输入按接收顺序标注', /按接收顺序 · 第/.test(html));
  check('含容量上限输入', /动态表容量/.test(html) && /id="cap"/.test(html));
  check('含复核模式选择（仅压缩复核 / 严格请求头）',
    /id="mode"/.test(html) && /value="compression"/.test(html) && /value="strict"/.test(html));
  check('含严格模式快捷示例（合法请求 / 伪首部顺序回滚）',
    /strictok/.test(html) && /strictbad/.test(html));
  check('请求体携带 mode 字段', /JSON\.stringify\(\{ capacity, mode, segments \}\)/.test(html));
  check('严格失败展示裁决规则', /e\.rule/.test(html) && /裁决规则/.test(html));
  check('含清空草稿按钮', /btnClearDraft/.test(html));
  check('含清空草稿和结论按钮', /btnClearAll/.test(html));
  check('含字段/来源/插入驱逐/快照渲染逻辑',
    /renderFields/.test(html) && /renderEvents/.test(html) && /renderSnapshot/.test(html));
  check('错误展示含块内字节偏移', /段内字节偏移/.test(html) && /offsetHex/.test(html));
  // 关键 JS 不能有明显语法错误：提取最后一个 <script> 块用 new Function 解析
  const scriptBody = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</' + 'script>'));
  let scriptOk = true;
  try {
    new Function(scriptBody); // 仅解析，不执行（依赖 DOM）
  } catch (e) {
    scriptOk = false;
    console.log('    脚本语法错误：' + e.message);
  }
  check('内嵌脚本语法有效', scriptOk);

  // --- 3. HTTP / API 冒烟 ----------------------------------------------------
  step('3/3 HTTP / API 冒烟');
  const target = process.env.TARGET_URL;
  let server = null;
  let base;
  if (target) {
    // Compose 模式：对已启动的 app 服务做外部冒烟
    base = target;
    console.log(`    目标服务：${base}（等待健康检查就绪）`);
    const ready = await waitFor(base);
    check('目标服务健康检查就绪', ready);
    if (!ready) {
      console.log(`\n❌ 验收失败 ${failures + 1} 项`);
      process.exit(1);
    }
  } else {
    // 本机模式：在随机端口拉起应用实例
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  try {
    // 3a. 页面
    const home = await request(base, 'GET', '/');
    check('GET / → 200', home.status === 200, `实际 ${home.status}`);
    check('Content-Type 为 text/html; charset=utf-8', /^text\/html/.test(home.headers['content-type'] || ''));
    check('页面含复核台标题与解码按钮', home.raw.includes('HPACK') && home.raw.includes('btnDecode'));

    // 3b. 健康路径
    const hz = await request(base, 'GET', '/healthz');
    check('GET /healthz → 200', hz.status === 200, `实际 ${hz.status}`);
    let hzJson = null;
    try { hzJson = JSON.parse(hz.raw); } catch { /* 下面检查会失败 */ }
    check('健康检查 JSON status=ok 且回传限额',
      !!hzJson && hzJson.status === 'ok' && hzJson.limits.maxCapacity === 4096 &&
      hzJson.limits.maxTotalBytes === 65536 && hzJson.limits.maxSegments === 8);

    // 3c. API 验收主线 A：后块引用前块插入字段
    const cross = await request(base, 'POST', '/api/decode', {
      capacity: 4096,
      segments: ['QBF4LXRlbGVtZXRyeS1yb3V0ZYdA0rDYTSw7', 'vg=='],
    });
    check('跨段引用请求 → 200', cross.status === 200, `实际 ${cross.status}`);
    const crossJson = JSON.parse(cross.raw);
    check('两段全部成功并给出成功结论', crossJson.ok === true && crossJson.conclusion && crossJson.conclusion.blocks === 2);
    const seg2 = crossJson.results && crossJson.results[1];
    check('第二段字段来自动态表 #62（前块插入项）',
      !!seg2 && seg2.fields[0] && seg2.fields[0].source.location === 'dynamic' &&
      seg2.fields[0].source.index === 62 && seg2.fields[0].name === 'x-telemetry-route');
    check('段1 记录含一次插入，段2 无插入/驱逐',
      crossJson.results[0].events.some((e) => e.type === 'insert') &&
      seg2.events.length === 0);

    // 3d. API 验收主线 B：非法后续块不污染已提交表状态、无成功结论
    const bad = await request(base, 'POST', '/api/decode', {
      capacity: 4096,
      segments: ['QBF4LXRlbGVtZXRyeS1yb3V0ZYdA0rDYTSw7', 'QAJ4eAF4wA=='],
    });
    check('含非法后续块的请求 → 422', bad.status === 422, `实际 ${bad.status}`);
    const badJson = JSON.parse(bad.raw);
    check('失败定位为第 2 段、块内偏移 0x6、越界索引',
      !badJson.ok && badJson.error.block === 2 && badJson.error.offset === 6 &&
      badJson.error.code === 'INDEX_OUT_OF_RANGE');
    check('失败响应不携带成功结论', badJson.conclusion === null);
    check('仅提交第 1 段且其段末快照保留插入字段',
      badJson.results.length === 1 && badJson.results[0].snapshot.entries.length === 1 &&
      badJson.results[0].snapshot.entries[0].name === 'x-telemetry-route');

    // 3e. 截断整数错误定位 + 坏 Base64 / 坏容量的 400
    const trunc = await request(base, 'POST', '/api/decode', { capacity: 4096, segments: ['P/8='] });
    // 0x3f 容量更新前缀满且无续字节 -> TRUNCATED_INTEGER at 0
    const truncJson = JSON.parse(trunc.raw);
    check('截断整数 → 422 且偏移 0x0',
      trunc.status === 422 && truncJson.error.code === 'TRUNCATED_INTEGER' && truncJson.error.offset === 0);

    const badB64 = await request(base, 'POST', '/api/decode', { capacity: 4096, segments: ['@@@'] });
    check('非法 Base64 → 400', badB64.status === 400 && JSON.parse(badB64.raw).error.code === 'BASE64_INVALID');
    const badCap = await request(base, 'POST', '/api/decode', { capacity: 9999, segments: ['vg=='] });
    check('容量超 4096 → 400', badCap.status === 400 && JSON.parse(badCap.raw).error.code === 'CAPACITY_INVALID');
    const badMode = await request(base, 'POST', '/api/decode', {
      capacity: 4096, mode: 'strict-ish', segments: ['vg=='],
    });
    check('未知复核模式 → 400 MODE_INVALID',
      badMode.status === 400 && JSON.parse(badMode.raw).error.code === 'MODE_INVALID');

    // 3g. 严格请求头模式验收主线 A：有效严格请求 + 后块引用前块插入字段
    const strictOk = await request(base, 'POST', '/api/decode', {
      capacity: 4096,
      mode: 'strict',
      segments: [
        'goaEQBF4LXRlbGVtZXRyeS1yb3V0ZQpzYXQtYS90bS83', // :method/:scheme/:path + 插入遥测路由
        'goaEvg==', // 自带三伪首部 + 动态索引 62
      ],
    });
    check('严格模式合法请求 → 200', strictOk.status === 200, `实际 ${strictOk.status}`);
    const strictOkJson = JSON.parse(strictOk.raw);
    check('严格模式成功结论 mode=strict 且两段均通过',
      strictOkJson.ok === true && strictOkJson.mode === 'strict' &&
      strictOkJson.conclusion && strictOkJson.conclusion.blocks === 2);
    check('严格模式后块字段来自动态表 #62（前块插入项）',
      strictOkJson.results[1].fields[3] &&
      strictOkJson.results[1].fields[3].source.location === 'dynamic' &&
      strictOkJson.results[1].fields[3].source.index === 62 &&
      strictOkJson.results[1].fields[3].name === 'x-telemetry-route');

    // 3h. 严格模式验收主线 B：伪首部顺序错误 -> 422，定位块号/偏移/规则并回滚
    const strictBad = await request(base, 'POST', '/api/decode', {
      capacity: 4096,
      mode: 'strict',
      segments: [
        'goaEQBF4LXRlbGVtZXRyeS1yb3V0ZQpzYXQtYS90bS83',
        'QANmb28DYmFygg==', // foo=bar 后再 :method -> PSEUDO_AFTER_REGULAR @0x9
      ],
    });
    check('严格模式伪首部顺序错误 → 422', strictBad.status === 422, `实际 ${strictBad.status}`);
    const strictBadJson = JSON.parse(strictBad.raw);
    check('语义失败定位第 2 段、块内偏移 0x9、含规则出处',
      !strictBadJson.ok && strictBadJson.error.block === 2 &&
      strictBadJson.error.offset === 9 &&
      strictBadJson.error.code === 'PSEUDO_AFTER_REGULAR' &&
      /RFC 7540/.test(strictBadJson.error.rule || ''));
    check('严格失败不携带成功结论', strictBadJson.conclusion === null);
    check('严格失败块回滚：仅提交第 1 段且保留其插入快照',
      strictBadJson.results.length === 1 &&
      strictBadJson.results[0].snapshot.entries.length === 1 &&
      strictBadJson.results[0].snapshot.entries[0].name === 'x-telemetry-route');

    // 3i. 严格模式其它规则：连接专用字段 / 大写名 / 缺伪首部
    const conn = await request(base, 'POST', '/api/decode', {
      capacity: 4096, mode: 'strict',
      segments: ['goaEAApjb25uZWN0aW9uBWNsb3Nl'], // connection: close
    });
    check('严格模式拒绝 connection', conn.status === 422 &&
      JSON.parse(conn.raw).error.code === 'CONNECTION_SPECIFIC_HEADER');
    const teOk = await request(base, 'POST', '/api/decode', {
      capacity: 4096, mode: 'strict', segments: ['goaEAAJ0ZQh0cmFpbGVycw=='],
    });
    check('严格模式放行 te: trailers', teOk.status === 200);
    const teBad = await request(base, 'POST', '/api/decode', {
      capacity: 4096, mode: 'strict', segments: ['goaEAAJ0ZQF4'], // te: x
    });
    check('严格模式拒绝 te 的非 trailers 值', teBad.status === 422 &&
      JSON.parse(teBad.raw).error.code === 'CONNECTION_SPECIFIC_HEADER');
    const upper = await request(base, 'POST', '/api/decode', {
      capacity: 4096, mode: 'strict', segments: ['goaEAAhYLUN1c3RvbQF2'], // X-Custom
    });
    check('严格模式拒绝大写字段名', upper.status === 422 &&
      JSON.parse(upper.raw).error.code === 'HEADER_NAME_NOT_LOWERCASE');
    const missing = await request(base, 'POST', '/api/decode', {
      capacity: 4096, mode: 'strict', segments: ['gg=='], // 仅 :method
    });
    check('严格模式拒绝缺少必需伪首部', missing.status === 422 &&
      JSON.parse(missing.raw).error.code === 'PSEUDO_HEADER_MISSING');

    // 3j. 兼容模式：同一条无伪首部的任意合法 HPACK 链路在 compression 下仍成功
    const compat = await request(base, 'POST', '/api/decode', {
      capacity: 4096,
      mode: 'compression',
      segments: ['QBF4LXRlbGVtZXRyeS1yb3V0ZQpzYXQtYS90bS83', 'vg=='],
    });
    check('兼容模式任意合法链路仍 → 200 且结论保留',
      compat.status === 200 && JSON.parse(compat.raw).mode === 'compression' &&
      JSON.parse(compat.raw).conclusion.totalFields === 2);
    // 缺省（不传 mode）行为与 compression 完全一致
    const defaultMode = await request(base, 'POST', '/api/decode', {
      capacity: 4096,
      segments: ['QBF4LXRlbGVtZXRyeS1yb3V0ZQpzYXQtYS90bS83', 'vg=='],
    });
    check('缺省不传 mode 时按仅压缩复核处理',
      defaultMode.status === 200 && JSON.parse(defaultMode.raw).mode === 'compression');

    // 3f. 失败后服务依然健康（无状态污染跨请求）
    const hz2 = await request(base, 'GET', '/healthz');
    check('冒烟后健康路径仍 200', hz2.status === 200);
    const unknown = await request(base, 'GET', '/nope');
    check('未知路径 → 404 JSON', unknown.status === 404);
  } finally {
    if (server) await new Promise((r) => server.close(r));
  }

  console.log(`\n${failures === 0 ? '✅ 验收全部通过' : `❌ 验收失败 ${failures} 项`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exit(1);
});
