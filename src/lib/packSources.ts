/* Pure pack-source helpers (spike 032). No React, no network, no api import.
 * packReach and packReachInfo share walkPackReach. A maybe-forward is tracked
 * with its own flag: a route that has neither id nor name is still maybe. */

export type PackReach = 'yes' | 'maybe' | 'no';

export type PackRoute = {
  filter?: string;
  final?: boolean;
  disabled?: boolean;
  targetContext?: string;
  output?: string;
  id?: string;
  name?: string;
};

export type PackReachInfo = { reach: PackReach; routeId?: string };

/** `<type>:<pack>.<id>` — the `__inputId` key a pack source actually carries. */
export function packInputKey(type: string, pack: string, id: string): string {
  return `${type}:${pack}.${id}`;
}

/* A filter is evaluated for this source with three values: true (the route takes it),
 * false (it does not) and unknown (it depends on something other than `__inputId`).
 * Understood terms: `true`, `false`, `__inputId.startsWith('<s>')`, and `__inputId` compared
 * with a string by `==`, `===`, `!=` or `!==` (either side), joined by `!`, `&&`, `||` and
 * parentheses. Any other term is unknown. The source's id is taken to be exactly `key`. */

type Tri = boolean | undefined;
type Tok = { t: 'str' | 'id' | 'op' | 'other'; v: string };

const OPS = ['===', '!==', '==', '!=', '&&', '||', '(', ')', '!', ','];

/** Undefined when the text cannot be split safely (an open string or a template literal). */
function tokenize(text: string): Tok[] | undefined {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '`') return undefined;
    if (c === "'" || c === '"') {
      let j = i + 1;
      let body = '';
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\' && j + 1 < text.length) {
          body += text[j + 1];
          j += 2;
          continue;
        }
        body += text[j];
        j++;
      }
      if (j >= text.length) return undefined;
      out.push({ t: 'str', v: body });
      i = j + 1;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/.exec(text.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0].replace(/\s+/g, '') });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op) {
      out.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    out.push({ t: 'other', v: c });
    i++;
  }
  return out;
}

const not = (a: Tri): Tri => (a === undefined ? undefined : !a);
const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === true && b === true ? true : undefined);
const or = (a: Tri, b: Tri): Tri => (a === true || b === true ? true : a === false && b === false ? false : undefined);

function compare(op: string, a: string, b: string): boolean {
  return op === '==' || op === '===' ? a === b : a !== b;
}

/** Recursive descent over `||`, `&&`, `!` and terms. Throws when the filter cannot be read. */
function isOp(tok: Tok | undefined, v: string): boolean {
  return tok?.t === 'op' && tok.v === v;
}

function isCmp(tok: Tok | undefined): tok is Tok {
  return tok?.t === 'op' && ['==', '===', '!=', '!=='].includes(tok.v);
}

class FilterReader {
  private pos = 0;
  private readonly toks: Tok[];
  private readonly key: string;

  constructor(toks: Tok[], key: string) {
    this.toks = toks;
    this.key = key;
  }

  read(): Tri {
    const v = this.orExpr();
    if (this.pos !== this.toks.length) throw new Error('unreadable filter');
    return v;
  }

  private peek(k = 0): Tok | undefined {
    return this.toks[this.pos + k];
  }

  /** The token `n` ahead ends the term: end of filter, `&&`, `||` or `)`. */
  private endsAt(n: number): boolean {
    const next = this.peek(n);
    return next === undefined || isOp(next, '&&') || isOp(next, '||') || isOp(next, ')');
  }

  private orExpr(): Tri {
    let v = this.andExpr();
    while (isOp(this.peek(), '||')) {
      this.pos++;
      v = or(v, this.andExpr());
    }
    return v;
  }

  private andExpr(): Tri {
    let v = this.unary();
    while (isOp(this.peek(), '&&')) {
      this.pos++;
      v = and(v, this.unary());
    }
    return v;
  }

  private unary(): Tri {
    if (!isOp(this.peek(), '!')) return this.term();
    this.pos++;
    /* `!__inputId === 'x'` negates `__inputId` before comparing, so it is not read. */
    if (this.peek()?.t !== 'op' && isCmp(this.peek(1))) return this.skipUnknown();
    return not(this.unary());
  }

  /** Skips an unread term up to the next `&&`, `||` or closing parenthesis at this depth. */
  private skipUnknown(): Tri {
    let depth = 0;
    const start = this.pos;
    while (this.pos < this.toks.length) {
      const tok = this.toks[this.pos];
      if (depth === 0 && (isOp(tok, '&&') || isOp(tok, '||') || isOp(tok, ')'))) break;
      if (isOp(tok, '(')) depth++;
      if (isOp(tok, ')')) depth--;
      this.pos++;
    }
    if (this.pos === start || depth !== 0) throw new Error('unreadable filter');
    return undefined;
  }

  private term(): Tri {
    const a = this.peek();
    const b = this.peek(1);
    const c = this.peek(2);
    if (isOp(a, '(')) {
      const save = this.pos;
      this.pos++;
      const v = this.orExpr();
      if (isOp(this.peek(), ')') && this.endsAt(1)) {
        this.pos++;
        return v;
      }
      this.pos = save;
      return this.skipUnknown();
    }
    if (a?.t === 'id' && (a.v === 'true' || a.v === 'false') && this.endsAt(1)) {
      this.pos++;
      return a.v === 'true';
    }
    if (a?.t === 'id' && a.v === '__inputId' && isCmp(b) && c?.t === 'str' && this.endsAt(3)) {
      this.pos += 3;
      return compare(b.v, this.key, c.v);
    }
    if (a?.t === 'str' && isCmp(b) && c?.t === 'id' && c.v === '__inputId' && this.endsAt(3)) {
      this.pos += 3;
      return compare(b.v, a.v, this.key);
    }
    if (a?.t === 'id' && a.v === '__inputId.startsWith' && isOp(b, '(') && c?.t === 'str' && isOp(this.peek(3), ')') && this.endsAt(4)) {
      this.pos += 4;
      return this.key.startsWith(c.v);
    }
    return this.skipUnknown();
  }
}

/** `match`: the filter takes this source; `otherInput`: it does not; `other`: it cannot be told. */
function filterClass(filter: string | undefined, key: string): 'match' | 'otherInput' | 'other' {
  const toks = tokenize(filter ?? '');
  if (!toks || toks.length === 0) return 'other';
  let v: Tri;
  try {
    v = new FilterReader(toks, key).read();
  } catch {
    return 'other';
  }
  if (v === true) return 'match';
  if (v === false) return 'otherInput';
  return 'other';
}

function routeLabel(route: PackRoute): string | undefined {
  if (route.id !== undefined) return route.id;
  if (route.name !== undefined) return route.name;
  return undefined;
}

function walkPackReach(routes: readonly PackRoute[], key: string): PackReachInfo {
  let sawMaybe = false;
  let routeId: string | undefined;
  for (const route of routes) {
    if (route.disabled) continue;
    const kind = filterClass(route.filter, key);
    const toGroup = route.targetContext === 'group';
    const isFinal = route.final !== false;
    if (kind === 'match') {
      if (toGroup) return { reach: 'yes' };
      if (isFinal) return { reach: 'no' };
      continue;
    }
    if (kind === 'otherInput') continue;
    if (toGroup && !sawMaybe) {
      sawMaybe = true;
      routeId = routeLabel(route);
    }
  }
  if (sawMaybe) return routeId === undefined ? { reach: 'maybe' } : { reach: 'maybe', routeId };
  return { reach: 'no' };
}

export function packReachInfo(routes: readonly PackRoute[], key: string): PackReachInfo {
  return walkPackReach(routes, key);
}

export function packReach(routes: readonly PackRoute[], key: string): PackReach {
  return walkPackReach(routes, key).reach;
}

/**
 * Stream can send pack events to the worker-group routes from 4.17 on.
 * A version with no major.minor is unknown, and unknown is not treated as old.
 */
export function streamPackForward(version: string | undefined): boolean {
  if (typeof version !== 'string') return true;
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 4 || (major === 4 && minor >= 17);
}
