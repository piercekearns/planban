// A small TOML 1.0 reader for host config files, which plugin scripts read before Planban's dependencies are installed.
// It walks the whole document, so text inside strings, arrays and inline tables can never be read as a key, and it
// rejects invalid documents (including redefined tables and malformed numbers or dates) by throwing.
// Strings, tables and arrays are kept; other values (numbers, booleans, dates) become NON_STRING.

export const NON_STRING = Symbol("non-string TOML value");

const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
const CONTROL = /^[\u0000-\u0008\u000a-\u001f\u007f]$/u;
const DIGITS = "\\d(?:_?\\d)*";
const DECIMAL = "[+-]?(?:0|[1-9](?:_?\\d)*)";
const INTEGER = new RegExp(`^(?:${DECIMAL}|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$`, "u");
const FLOAT = new RegExp(`^(?:${DECIMAL}(?:\\.${DIGITS})?(?:[eE][+-]?${DIGITS})?|[+-]?(?:inf|nan))$`, "u");
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?";
const LOCAL_TIME = new RegExp(`^${TIME}$`, "u");
const DATE_TIME = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})(?:[Tt ]${TIME}(?:[Zz]|[+-](\\d{2}):(\\d{2}))?)?$`, "u");

export function isTomlTable(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTime(hour, minute, second = "00") {
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
}

// Dates must exist on the calendar. Like Python's tomllib, year 0 and leap seconds are rejected.
function validDateTime(token) {
  const local = token.match(LOCAL_TIME);
  if (local) return validTime(local[1], local[2], local[3]);
  const match = token.match(DATE_TIME);
  if (!match) return false;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && monthDays !== undefined && day >= 1 && day <= monthDays
    && (match[4] === undefined || validTime(match[4], match[5], match[6]))
    && (match[7] === undefined || validTime(match[7], match[8]));
}

function validScalar(token) {
  return token === "true" || token === "false" || INTEGER.test(token) || FLOAT.test(token) || validDateTime(token);
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
  const skipComment = () => {
    if (peek() !== "#") return;
    for (i += 1; i < text.length && peek() !== "\n" && !at("\r\n"); i += 1) if (CONTROL.test(peek())) fail();
  };
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
  // Basic strings use " and escapes; literal strings use ' and none. Only the """ and ''' forms span lines,
  // and their line breaks are read as \n. Up to two quotes may sit directly before the closing delimiter.
  const string = (quote) => {
    const delimiter = quote.repeat(3);
    const multiline = at(delimiter);
    i += multiline ? 3 : 1;
    if (multiline) newline();
    let value = "";
    for (;;) {
      if (multiline && at(delimiter)) {
        let extra = 0;
        while (extra < 2 && text[i + 3 + extra] === quote) extra += 1;
        i += 3 + extra;
        return value + quote.repeat(extra);
      }
      if (!multiline && peek() === quote) {
        i += 1;
        return value;
      }
      if (quote === '"' && peek() === "\\") {
        i += 1;
        value += escape(multiline);
      } else if (multiline && newline()) {
        value += "\n";
      } else {
        if (i >= text.length || CONTROL.test(peek())) fail();
        value += text[i++];
      }
    }
  };

  const keyPart = () => {
    if (at('"""') || at("'''")) fail();
    if (peek() === '"' || peek() === "'") return string(peek());
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

  // Each table may be defined once. A [header] defines its table, tables made by dotted keys count as defined
  // once the next header starts, and inline tables and arrays are sealed as soon as they are written.
  const defined = new WeakSet();
  const sealed = new WeakSet();
  let dottedTables = [];
  const seal = (value) => {
    if (value === null || typeof value !== "object") return;
    sealed.add(value);
    Object.values(value).forEach(seal);
  };
  const startSection = () => {
    dottedTables.forEach((node) => defined.add(node));
    dottedTables = [];
  };
  const table = () => Object.create(null);
  // Enter (or create) a sub-table. An array of tables is entered through its latest table.
  const descend = (node, part) => {
    if (sealed.has(node)) fail();
    if (!Object.hasOwn(node, part)) node[part] = table();
    const value = node[part];
    const next = Array.isArray(value) && !sealed.has(value) ? value.at(-1) : value;
    if (!isTomlTable(next)) fail();
    return next;
  };
  const keyValue = (node, inSection) => {
    const parts = key();
    if (peek() !== "=") fail();
    i += 1;
    skipSpace();
    const item = value();
    let parent = node;
    for (const part of parts.slice(0, -1)) {
      parent = descend(parent, part);
      if (!inSection) continue;
      if (defined.has(parent)) fail();
      dottedTables.push(parent);
    }
    const last = parts.at(-1);
    if (sealed.has(parent) || Object.hasOwn(parent, last)) fail();
    parent[last] = item;
    seal(item);
  };

  const value = () => {
    if (peek() === '"' || peek() === "'") return string(peek());
    if (peek() === "[") {
      const array = [];
      for (i += 1; ; i += 1) {
        skipBlank();
        if (peek() === "]") break;
        array.push(value());
        skipBlank();
        if (peek() === "]") break;
        if (peek() !== ",") fail();
      }
      i += 1;
      return array;
    }
    if (peek() === "{") {
      // Inline tables stay on one line and take no trailing comma.
      const inline = table();
      i += 1;
      skipSpace();
      while (peek() !== "}") {
        keyValue(inline, false);
        skipSpace();
        if (peek() === "}") break;
        if (peek() !== ",") fail();
        i += 1;
      }
      i += 1;
      return inline;
    }
    const start = i;
    while (i < text.length && !/^[\s,\]}#]$/u.test(peek())) i += 1;
    // A date and a time may be separated by a single space.
    if (/^\d{4}-\d{2}-\d{2}$/u.test(text.slice(start, i)) && peek() === " " && /^\d$/u.test(peek(1))) {
      i += 1;
      while (i < text.length && !/^[\s,\]}#]$/u.test(peek())) i += 1;
    }
    if (!validScalar(text.slice(start, i))) fail();
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
      startSection();
      const parent = parts.slice(0, -1).reduce(descend, root);
      const last = parts.at(-1);
      if (sealed.has(parent)) fail();
      if (!Object.hasOwn(parent, last)) parent[last] = [];
      if (!Array.isArray(parent[last]) || sealed.has(parent[last])) fail();
      current = table();
      defined.add(current);
      parent[last].push(current);
    } else if (peek() === "[") {
      i += 1;
      const parts = key();
      if (peek() !== "]") fail();
      i += 1;
      startSection();
      current = parts.reduce(descend, root);
      if (defined.has(current) || sealed.has(current)) fail();
      defined.add(current);
    } else {
      keyValue(current, true);
    }
    endLine();
  }
}
