/**
 * A small XML reader for the QuakeML the earliest-solutions collector reads (src/first-solutions.ts). The project has
 * no XML dependency and the adapters in custom.ts match RSS items with regular expressions; QuakeML nests origins,
 * magnitudes and creationInfo blocks inside events, so this builds a tree instead. It handles what FDSN event services
 * send: the XML declaration, comments, CDATA, a DOCTYPE, attributes, self-closing tags and the predefined and numeric
 * entities. Namespace prefixes are dropped from element names (`q:quakeml` is `quakeml`). It is not a validating parser.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const localName = (qname: string): string => {
  const i = qname.indexOf(':');
  return i >= 0 ? qname.slice(i + 1) : qname;
};

/** Parse a document into its root element. Throws on a document that is not well-formed enough to build a tree. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) stack[stack.length - 1]!.text += decodeEntities(src.slice(i, textEnd));
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('xml: unterminated comment');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new Error('xml: unterminated CDATA');
      stack[stack.length - 1]!.text += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw new Error('xml: unterminated processing instruction');
      i = end + 2;
    } else if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      if (end < 0) throw new Error('xml: unterminated declaration');
      i = end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt + 2);
      if (end < 0) throw new Error('xml: unterminated end tag');
      const name = localName(src.slice(lt + 2, end).trim());
      const top = stack.pop();
      if (!top || top === root || top.name !== name) throw new Error(`xml: unexpected </${name}>`);
      i = end + 1;
    } else {
      // A start tag: find its end outside quoted attribute values.
      let j = lt + 1;
      let quote: string | null = null;
      for (; j < n; j++) {
        const c = src[j]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= n) throw new Error('xml: unterminated start tag');
      let body = src.slice(lt + 1, j);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) throw new Error('xml: empty tag');
      const node: XmlNode = { name: localName(m[1]!), attrs: {}, children: [], text: '' };
      for (const a of body.slice(m[1]!.length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        node.attrs[localName(a[1]!)] = decodeEntities(a[3] ?? a[4] ?? '');
      }
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`xml: unclosed <${stack[stack.length - 1]!.name}>`);
  const top = root.children[0];
  if (!top) throw new Error('xml: no root element');
  return top;
}

/** The first child element of that (local) name. */
export const child = (node: XmlNode | undefined, name: string): XmlNode | undefined => node?.children.find((c) => c.name === name);

/** Every child element of that (local) name. */
export const childrenNamed = (node: XmlNode | undefined, name: string): XmlNode[] => node?.children.filter((c) => c.name === name) ?? [];

/** The trimmed text at a path of child names (`textAt(origin, 'time', 'value')`), or null when absent or empty. */
export function textAt(node: XmlNode | undefined, ...path: string[]): string | null {
  let cur = node;
  for (const p of path) cur = child(cur, p);
  const t = cur?.text.trim();
  return t ? t : null;
}

/** Every element of that (local) name anywhere below `node`, in document order. */
export function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}
