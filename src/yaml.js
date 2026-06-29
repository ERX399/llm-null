// yaml.js — 轻量 YAML 解析器（无需外部依赖）
// 支持特性：注释(#)、嵌套映射、多行文本(| / >)、引号字符串、布尔、数字、空对象{}
// 不支持：数组([])、锚点、流式语法等复杂特性（本项目不需要）

export function parse(text) {
  const lines = text.split('\n');
  return parseBlock(lines, 0, 0).value || {};
}

function parseBlock(lines, start, indent) {
  const result = {};
  let i = start;
  let key = null;
  let pendingMultiline = null; // { key, mode: '|' | '>' }

  while (i < lines.length) {
    let line = lines[i];

    // 跳过空行和注释行
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    // 处理多行文本块
    if (pendingMultiline) {
      const lineIndent = getIndent(line);
      if (line.trim() === '' || lineIndent > indent) {
        // 属于多行块
        pendingMultiline.lines.push(line.slice(indent + 2)); // 去掉缩进
        i++;
        continue;
      } else {
        // 多行块结束
        result[pendingMultiline.key] = joinMultiline(pendingMultiline.lines, pendingMultiline.mode);
        pendingMultiline = null;
        // 不 i++，继续处理当前行
      }
    }

    const lineIndent = getIndent(line);
    if (lineIndent < indent) break;

    const trimmed = line.slice(lineIndent);

    // 解析 key: value
    const colonIdx = findColon(trimmed);
    if (colonIdx === -1) { i++; continue; }

    const k = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();

    // 去掉行内注释（# 前面有空格才算）
    val = stripInlineComment(val);

    if (val === '|' || val === '>' || val === '|-' || val === '>-') {
      // 多行文本块开始
      pendingMultiline = { key: k, mode: val[0], lines: [] };
      i++;
      continue;
    }

    if (val === '') {
      // 嵌套对象或空值
      // 向前看下一行缩进
      let nextIndent = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const nl = lines[j];
        if (nl.trim() === '' || nl.trim().startsWith('#')) continue;
        nextIndent = getIndent(nl);
        break;
      }
      if (nextIndent > lineIndent) {
        const sub = parseBlock(lines, i + 1, nextIndent);
        result[k] = sub.value;
        i = sub.end;
      } else {
        result[k] = {};
      }
      i++;
    } else {
      result[k] = parseScalar(val);
      i++;
    }
  }

  // 收尾多行块
  if (pendingMultiline) {
    result[pendingMultiline.key] = joinMultiline(pendingMultiline.lines, pendingMultiline.mode);
  }

  return { value: result, end: i };
}

function getIndent(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

function findColon(s) {
  // 找到第一个不在引号内的冒号
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === quoteChar) inQuote = false;
    } else {
      if (c === '"' || c === "'") { inQuote = true; quoteChar = c; }
      else if (c === ':') return i;
    }
  }
  return -1;
}

function stripInlineComment(val) {
  // 只去掉 " #" 形式的行内注释
  if (val.startsWith('"') || val.startsWith("'")) return val;
  const m = val.match(/\s+#/);
  if (m) return val.slice(0, m.index).trim();
  return val;
}

function parseScalar(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  if (val === '{}') return {};
  if (val === '[]') return [];
  // 引号字符串
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  // 数字
  if (/^-?\d+$/.test(val)) return parseInt(val);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
  return val;
}

// YAML 序列化（JS 对象 → YAML 字符串）
export function dump(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];

  if (obj === null || obj === undefined) return '';

  if (typeof obj !== 'object') {
    return formatScalar(obj);
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (typeof item === 'object' && item !== null) {
        const sub = dump(item, indent + 1).trimStart();
        lines.push(pad + '- ' + sub);
      } else {
        lines.push(pad + '- ' + formatScalar(item));
      }
    }
    return lines.join('\n');
  }

  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      lines.push(pad + key + ': null');
    } else if (typeof val === 'string' && (val.includes('\n') || val.length > 80)) {
      // 多行文本用 | 语法
      const mlLines = val.split('\n');
      // 去掉末尾空行
      while (mlLines.length && mlLines[mlLines.length - 1] === '') mlLines.pop();
      lines.push(pad + key + ': |');
      for (const ml of mlLines) {
        lines.push(pad + '  ' + ml);
      }
    } else if (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) {
      lines.push(pad + key + ': {}');
    } else if (Array.isArray(val) && val.length === 0) {
      lines.push(pad + key + ': []');
    } else if (typeof val === 'object') {
      const sub = dump(val, indent + 1);
      if (sub) {
        lines.push(pad + key + ':');
        lines.push(sub);
      } else {
        lines.push(pad + key + ': {}');
      }
    } else {
      lines.push(pad + key + ': ' + formatScalar(val));
    }
  }

  return lines.join('\n');
}

function formatScalar(val) {
  if (val === true) return 'true';
  if (val === false) return 'false';
  if (val === null) return 'null';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    // 空字符串
    if (val === '') return '""';
    // 需要引号的情况
    if (val.startsWith(' ') || val.endsWith(' ') ||
        val.includes(': ') || val.startsWith('#') ||
        val.includes('\t') ||
        val === 'true' || val === 'false' || val === 'null' ||
        /^\d+$/.test(val)) {
      return '"' + val.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    return val;
  }
  return String(val);
}

function joinMultiline(lines, mode) {
  // 去掉尾部空行
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (mode === '|') {
    return lines.join('\n') + '\n';
  } else if (mode === '>') {
    // 折叠：连续非空行合并为空格
    let result = '';
    let prevEmpty = false;
    for (const l of lines) {
      if (l.trim() === '') {
        prevEmpty = true;
      } else {
        if (result && !prevEmpty) result += ' ';
        else if (result && prevEmpty) result += '\n';
        result += l;
        prevEmpty = false;
      }
    }
    return result + '\n';
  }
  // |- / >- 不保留尾部换行
  if (mode === '|') return lines.join('\n');
  return lines.join('\n');
}