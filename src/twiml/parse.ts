/**
 * TwiML, read.
 *
 * The app this was extracted from matched three verbs with three regular expressions,
 * which was honest about what it supported and stopped being enough the moment `<Record>`
 * had to nest under nothing and `<Connect>` had to nest over `<Stream>` over
 * `<Parameter>`. So this is a small XML reader instead — small because TwiML is small:
 * elements, attributes, text and the five predefined entities. No namespaces, no CDATA,
 * no DTD, no processing instructions beyond the declaration, and no entity definitions.
 *
 * Two rules that look like details and are not:
 *
 * - **Text content is never trimmed.** A `<Message>` body's own leading space is part of
 *   what somebody will be sent, and a `<Say>`'s is part of what was written. Trimming is
 *   a decision for whoever displays it.
 * - **A `<Stream>` with no `<Parameter>` children parses to an empty map, not a failure.**
 *   Reporting what the document said is this parser's job; refusing it is the far end's,
 *   and that is where the refusal belongs — a gateway that needs an agent id and was
 *   given none should say so itself.
 *
 * A malformed document is a `ParseError` naming the offset, never a silent empty list: a
 * `<Response>` that produced no verbs because a quote was unbalanced looks exactly like
 * an application that meant to do nothing.
 */

export interface Element {
  name: string;
  attributes: Record<string, string>;
  children: Element[];
  /** The element's own text, with its children's markup removed but their text kept out. */
  text: string;
}

export class ParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = 'ParseError';
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Undo XML escaping, including numeric character references.
 *
 * **Exactly one layer, and this is the only place it happens.** The app this came from
 * once applied two — percent-encoding a stream URL's query and then escaping the whole
 * thing — and undoing the inner layer here turned a `%2B` into a bare `+` that a query
 * parser downstream read as a space, so a caller's number arrived blank and silently.
 * An attribute value is handed on exactly as the document wrote it, once unescaped.
 */
export function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

/** The inverse, for the documents this app emits. Five characters, no more. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class Reader {
  offset = 0;

  constructor(readonly source: string) {}

  get done(): boolean {
    return this.offset >= this.source.length;
  }

  peek(ahead = 0): string {
    return this.source[this.offset + ahead] ?? '';
  }

  startsWith(text: string): boolean {
    return this.source.startsWith(text, this.offset);
  }

  skipWhitespace(): void {
    while (!this.done && /\s/.test(this.peek())) this.offset += 1;
  }

  /** Read to the end of a construct we are not interested in keeping. */
  skipUntil(terminator: string): void {
    const at = this.source.indexOf(terminator, this.offset);
    this.offset = at === -1 ? this.source.length : at + terminator.length;
  }

  readName(): string {
    const start = this.offset;
    while (!this.done && /[\w:.-]/.test(this.peek())) this.offset += 1;
    if (this.offset === start) throw new ParseError('expected a name', start);
    return this.source.slice(start, this.offset);
  }
}

/**
 * Parse a document into its root elements.
 *
 * Plural because a document may legitimately have leading whitespace, a declaration and a
 * comment before `<Response>`, and because a caller may hand this a fragment.
 */
export function parseXml(source: string): Element[] {
  const reader = new Reader(source);
  const roots: Element[] = [];
  for (;;) {
    skipProlog(reader);
    if (reader.done) break;
    if (!reader.startsWith('<')) {
      // Text outside any element. Whitespace between elements is ordinary; anything
      // else is a document we would be guessing about.
      const next = reader.source.indexOf('<', reader.offset);
      const stray = reader.source.slice(reader.offset, next === -1 ? undefined : next);
      if (stray.trim().length > 0) throw new ParseError('text outside the root element', reader.offset);
      reader.offset = next === -1 ? reader.source.length : next;
      continue;
    }
    roots.push(parseElement(reader));
  }
  return roots;
}

function skipProlog(reader: Reader): void {
  for (;;) {
    reader.skipWhitespace();
    if (reader.startsWith('<?')) {
      reader.skipUntil('?>');
      continue;
    }
    if (reader.startsWith('<!--')) {
      reader.skipUntil('-->');
      continue;
    }
    if (reader.startsWith('<!')) {
      reader.skipUntil('>');
      continue;
    }
    return;
  }
}

function parseElement(reader: Reader): Element {
  const start = reader.offset;
  if (reader.peek() !== '<') throw new ParseError('expected an element', start);
  reader.offset += 1;
  const name = reader.readName();
  const attributes: Record<string, string> = {};

  for (;;) {
    reader.skipWhitespace();
    if (reader.done) throw new ParseError(`unclosed <${name}>`, start);
    if (reader.startsWith('/>')) {
      reader.offset += 2;
      return { name, attributes, children: [], text: '' };
    }
    if (reader.peek() === '>') {
      reader.offset += 1;
      break;
    }
    const attributeName = reader.readName();
    reader.skipWhitespace();
    if (reader.peek() !== '=') throw new ParseError(`attribute ${attributeName} has no value`, reader.offset);
    reader.offset += 1;
    reader.skipWhitespace();
    const quote = reader.peek();
    if (quote !== '"' && quote !== "'") {
      throw new ParseError(`attribute ${attributeName} is not quoted`, reader.offset);
    }
    reader.offset += 1;
    const valueStart = reader.offset;
    const valueEnd = reader.source.indexOf(quote, valueStart);
    if (valueEnd === -1) throw new ParseError(`unterminated value for ${attributeName}`, valueStart);
    attributes[attributeName] = unescapeXml(reader.source.slice(valueStart, valueEnd));
    reader.offset = valueEnd + 1;
  }

  const children: Element[] = [];
  let text = '';
  for (;;) {
    if (reader.done) throw new ParseError(`unclosed <${name}>`, start);
    if (reader.startsWith('</')) {
      reader.offset += 2;
      const closing = reader.readName();
      reader.skipWhitespace();
      if (reader.peek() !== '>') throw new ParseError(`malformed </${closing}>`, reader.offset);
      reader.offset += 1;
      if (closing !== name) throw new ParseError(`</${closing}> closes <${name}>`, reader.offset);
      return { name, attributes, children, text };
    }
    if (reader.startsWith('<!--')) {
      reader.skipUntil('-->');
      continue;
    }
    if (reader.startsWith('<![CDATA[')) {
      const end = reader.source.indexOf(']]>', reader.offset);
      if (end === -1) throw new ParseError('unterminated CDATA', reader.offset);
      // Verbatim: the whole point of CDATA is that nothing in it is escaped.
      text += reader.source.slice(reader.offset + 9, end);
      reader.offset = end + 3;
      continue;
    }
    if (reader.peek() === '<') {
      children.push(parseElement(reader));
      continue;
    }
    const next = reader.source.indexOf('<', reader.offset);
    const chunk = reader.source.slice(reader.offset, next === -1 ? undefined : next);
    // Not trimmed. See the header.
    text += unescapeXml(chunk);
    reader.offset = next === -1 ? reader.source.length : next;
  }
}

/* ------------------------------------------------------------------ the verbs */

export interface Verb {
  name: string;
  attributes: Record<string, string>;
  text: string;
  children: Verb[];
}

function toVerb(element: Element): Verb {
  return {
    name: element.name,
    attributes: element.attributes,
    text: element.text,
    children: element.children.map(toVerb),
  };
}

export interface Twiml {
  verbs: Verb[];
  /** What the document actually was, kept for the event log. */
  source: string;
}

/**
 * Read a TwiML document: its `<Response>`'s children, in order.
 *
 * A document with no `<Response>` is not an error — a fragment is parsed as its own verb
 * list, which is what makes this usable on a hand-written test string. An **empty**
 * `<Response/>` parses to zero verbs, which is a result and not a failure: it is what a
 * webhook answers for "nothing to do", and it is deliberately the same document for
 * every flavour of that.
 */
export function parseTwiml(source: string): Twiml {
  const roots = parseXml(source);
  const response = roots.find((element) => element.name === 'Response');
  const elements = response ? response.children : roots;
  return { verbs: elements.map(toVerb), source };
}

/** An attribute, case-insensitively — Twilio's own docs are inconsistent about casing. */
export function attr(verb: Verb, name: string): string | undefined {
  const direct = verb.attributes[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(verb.attributes)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export function numberAttr(verb: Verb, name: string, fallback: number): number {
  const raw = attr(verb, name);
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function boolAttr(verb: Verb, name: string, fallback: boolean): boolean {
  const raw = attr(verb, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === 'yes' || raw === '1';
}

/**
 * The `<Parameter>` children of a `<Stream>`, as the map that goes into the `start`
 * frame. Empty rather than absent when there are none; see the header.
 */
export function streamParameters(stream: Verb): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const child of stream.children) {
    if (child.name !== 'Parameter') continue;
    const name = attr(child, 'name');
    if (name === undefined) continue;
    parameters[name] = attr(child, 'value') ?? '';
  }
  return parameters;
}
