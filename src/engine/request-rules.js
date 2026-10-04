'use strict';

// 严格请求头模式（HTTP/2 请求头规则，RFC 7540 §8.1.2 + HPACK 层面的请求约束）：
// 对每个块解出的字段序列逐条裁决，首个违规字段即判该块语义失败。
//
// 规则：
//   PSEUDO_ORDER        伪首部必须全部先于普通字段（普通字段之后再出现伪首部即违规）
//   PSEUDO_DUPLICATE    :method / :scheme / :path 各恰有一次（重复即违规）
//   PSEUDO_UNKNOWN      请求头块中只允许 :method :scheme :path :authority（:status 等拒绝）
//   PSEUDO_MISSING      块结束时 :method :scheme :path 未全部恰好出现一次
//   UPPERCASE_HEADER    字段名必须全部小写（含伪首部）
//   CONNECTION_HEADER   拒绝连接专用首部（connection、keep-alive、proxy-connection、
//                        transfer-encoding、upgrade；te 见 TE_INVALID）
//   TE_INVALID          te 只允许取值 "trailers"（其余一律拒绝）
//
// 裁决只读取字段名/值（按字节解码后的 UTF-8 文本比较），不触碰动态表；
// 语义失败由调用方按块级失败整体回滚（插入/驱逐/容量变更均不提交）。

const { HPACKError } = require('./hpack');

const REQUIRED_PSEUDO = new Set([':method', ':scheme', ':path']);
const REQUEST_PSEUDO = new Set([':method', ':scheme', ':path', ':authority']);
const CONNECTION_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te', // te 本身也是连接专用首部，仅取值 trailers 时放行
]);

// 对一个已成功解出的块的字段序列做请求头裁决；违规则抛 HPACKError。
// fields 元素至少含 { offset, name, value }，offset 为字段在块内的起始字节偏移。
// blockLength 用于在缺少必需伪首部（不存在“违规字段”）时把偏移定位到块尾。
function adjudicateRequestBlock(fields, blockLength) {
  const seenPseudo = new Set();
  let regularStarted = false;

  for (const f of fields) {
    const name = f.name;
    const isPseudo = name.length > 0 && name.charCodeAt(0) === 0x3a; // ':'

    // 字段名必须保持小写。伪首部名（":method" 等）本身也全为小写；
    // 任何大写 ASCII 字母（A-Z，0x41..0x5a）都违规。
    for (let i = 0; i < name.length; i += 1) {
      const c = name.charCodeAt(i);
      if (c >= 0x41 && c <= 0x5a) {
        throw new HPACKError(
          'UPPERCASE_HEADER',
          f.offset,
          `字段名 "${name}" 含大写字母；HTTP/2 字段名必须全部小写`
        );
      }
    }

    if (isPseudo) {
      if (regularStarted) {
        throw new HPACKError(
          'PSEUDO_ORDER',
          f.offset,
          `伪首部 "${name}" 出现在普通字段之后；伪首部必须全部先于普通字段`
        );
      }
      if (!REQUEST_PSEUDO.has(name)) {
        throw new HPACKError(
          'PSEUDO_UNKNOWN',
          f.offset,
          `请求头块不允许伪首部 "${name}"（仅允许 :method :scheme :path :authority）`
        );
      }
      if (seenPseudo.has(name)) {
        throw new HPACKError(
          'PSEUDO_DUPLICATE',
          f.offset,
          `伪首部 "${name}" 在同一块中重复出现；同一伪首部至多一次，且 :method/:scheme/:path 各恰有一次`
        );
      }
      seenPseudo.add(name);
    } else {
      regularStarted = true;

      if (CONNECTION_HEADERS.has(name)) {
        if (name === 'te') {
          // RFC 7540 §8.1.2.2：TE 仅在值为 "trailers" 时合法
          if (f.value !== 'trailers') {
            throw new HPACKError(
              'TE_INVALID',
              f.offset,
              `te 字段值为 "${f.value}"；HTTP/2 请求中 te 只允许取值 "trailers"`
            );
          }
        } else {
          throw new HPACKError(
            'CONNECTION_HEADER',
            f.offset,
            `连接专用首部 "${name}" 不得出现在 HTTP/2 请求头块中`
          );
        }
      }
    }
  }

  for (const p of REQUIRED_PSEUDO) {
    if (!seenPseudo.has(p)) {
      // 缺失类违规没有“违规字段”，偏移定位到块尾（最后一个字节之后）
      throw new HPACKError(
        'PSEUDO_MISSING',
        blockLength,
        `块结束时缺少必需伪首部 "${p}"；:method/:scheme/:path 各恰有一次`
      );
    }
  }
}

module.exports = { adjudicateRequestBlock };
