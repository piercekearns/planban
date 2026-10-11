// A small TOML reader for host config files, which plugin scripts read before Planban's dependencies are installed.
// It walks the whole document, so text inside strings, arrays and inline tables can never be read as a key.
// Strings, tables and arrays are kept; other values (numbers, booleans, dates) become NON_STRING.
// Invalid documents throw.

export const NON_STRING = Symbol("non-string TOML value");

const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" };
const SCALAR = /^(?:true|false|[+-]?(?:inf|nan)|[+-]?\d[\w.:+-]*(?: \d[\w.:+-]*)?)$/u;

export function isTomlTable(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseToml(text) {
  let i = 0;
  const fail = () => { throw new Error(`Invalid TOML at offset ${i}`); };
  const peek = (offset = 0) => text[i + offset] ?? "";
  const at = (token) => text.startsWith(token, i);
  const newline = () => {
    if (peek() === "\n") i += 1;
    else if (at("\r\n")) i += 2;
    else return false;
    return true;
  };
  const skipSpace = () => { while (peek() === " " || peek() === "\t") i += 1; };
  const skipComment = () => { if (peek() === "#") while (i < text.length && peek() !== "\n" && !at("\r\n")) i += 1; };
  const skipBlank = () => { do { skipSpace(); skipComment(); } while (newline()); };
  const endLine = () => {
    skipSpace();
    skipComment();
    if (i < text.length && !newline()) fail();
  };

  const hex = (length) => {
    const digits = text.slice(i, i + length);
    if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`, "u").test(digits)) fail();
    i += length;
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) fail();
    return String.fromCodePoint(codePoint);
  };
  const escape = (multiline) => {
    const char = text[i++];
    if (Object.hasOwn(ESCAPES, char)) return ESCAPES[char];
    if (char === "x") return hex(2);
    if (char === "u") return hex(4);
    if (char === "U") return hex(8);
    if (multiline) {
      // A backslash at the end of a line trims the line break and any whitespace that follows it.
      i -= 1;
      skipSpace();
      if (!newline()) fail();
      do skipSpace(); while (newline());
      return "";
    }
    return fail();
  };
  const closeMultiline = (quote) => {
    // Up to two quotes may sit directly before the closing delimiter and belong to the content.
    let extra = 0;
    while (extra < 2 && text[i + 3 + extra] === quote) extra += 1;
    i += 3 + extra;
    return quote.repeat(extra);
  };
  const basicString = () => {
    const multiline = at('"""');
    i += multiline ? 3 : 1;
    if (multiline) newline();
    let value = "";
    for (;;) {
      if (i >= text.length) fail();
      if (multiline && at('"""')) return value + closeMultiline('"');
      const char = text[i++];
      if (!multiline && char === '"') return value;
      if (char === "\\") value += escape(multiline);
      else if (!multiline && (char === "\n" || char === "\r")) fail();
      else value += char;
    }
  };
  const literalString = () => {
    const multiline = at("'''");
    i += multiline ? 3 : 1;
    if (multiline) newline();
    const end = text.indexOf(multiline ? "'''" : "'", i);
    if (end < 0) fail();
    let value = text.slice(i, end);
    if (!multiline && /[\r\n]/u.test(value)) fail();
    i = end;
    if (multiline) value += closeMultiline("'");
    else i += 1;
    return value;
  };

  const keyPart = () => {
    if (at('"""') || at("'''")) fail();
    if (peek() === '"') return basicString();
    if (peek() === "'") return literalString();
    const start = i;
    while (/^[A-Za-z0-9_-]$/u.test(peek())) i += 1;
    if (i === start) fail();
    return text.slice(start, i);
  };
  const key = () => {
    const parts = [];
    for (;;) {
      skipSpace();
      parts.push(keyPart());
      skipSpace();
      if (peek() !== ".") return parts;
      i += 1;
    }
  };
  const table = () => Object.create(null);
  const descend = (node, part) => {
    if (!Object.hasOwn(node, part)) node[part] = table();
    const next = Array.isArray(node[part]) ? node[part].at(-1) : node[part];
    if (!isTomlTable(next)) fail();
    return next;
  };
  const assign = (node, parts, value) => {
    const parent = parts.slice(0, -1).reduce(descend, node);
    const last = parts.at(-1);
    if (Object.hasOwn(parent, last)) fail();
    parent[last] = value;
  };
  const keyValue = (node) => {
    const parts = key();
    if (peek() !== "=") fail();
    i += 1;
    skipSpace();
    assign(node, parts, value());
  };

  const value = () => {
    if (peek() === '"') return basicString();
    if (peek() === "'") return literalString();
    if (peek() === "[" || peek() === "{") {
      const isArray = peek() === "[";
      const close = isArray ? "]" : "}";
      const collection = isArray ? [] : table();
      i += 1;
      for (;;) {
        skipBlank();
        if (peek() === close) break;
        if (isArray) collection.push(value());
        else keyValue(collection);
        skipBlank();
        if (peek() === ",") i += 1;
        else if (peek() !== close) fail();
      }
      i += 1;
      return collection;
    }
    const start = i;
    while (i < text.length && !/^[\s,\]}#]$/u.test(peek())) i += 1;
    // A date and a time may be separated by a single space.
    if (/^\d{4}-\d{2}-\d{2}$/u.test(text.slice(start, i)) && peek() === " " && /^\d$/u.test(peek(1))) {
      i += 1;
      while (i < text.length && !/^[\s,\]}#]$/u.test(peek())) i += 1;
    }
    if (!SCALAR.test(text.slice(start, i))) fail();
    return NON_STRING;
  };

  const root = table();
  let current = root;
  for (;;) {
    skipBlank();
    if (i >= text.length) return root;
    if (at("[[")) {
      i += 2;
      const parts = key();
      if (!at("]]")) fail();
      i += 2;
      const parent = parts.slice(0, -1).reduce(descend, root);
      const last = parts.at(-1);
      if (!Object.hasOwn(parent, last)) parent[last] = [];
      if (!Array.isArray(parent[last])) fail();
      current = table();
      parent[last].push(current);
    } else if (peek() === "[") {
      i += 1;
      const parts = key();
      if (peek() !== "]") fail();
      i += 1;
      current = parts.reduce(descend, root);
    } else {
      keyValue(current);
    }
    endLine();
  }
}
