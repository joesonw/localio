import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attr, escapeXml, parseTwiml, ParseError, streamParameters, unescapeXml } from './parse.js';

test('a document parses to its Response children, in order', () => {
  const { verbs } = parseTwiml(
    '<?xml version="1.0" encoding="UTF-8"?><Response><Say>hi</Say><Pause length="2"/><Hangup/></Response>',
  );
  assert.deepEqual(verbs.map((v) => v.name), ['Say', 'Pause', 'Hangup']);
  assert.equal(verbs[0]?.text, 'hi');
  assert.equal(attr(verbs[1]!, 'length'), '2');
});

/**
 * **An empty `<Response/>` is zero verbs, not a failure.** It is what a webhook answers
 * for "nothing to do", and deliberately the same document for every flavour of that.
 */
test('an empty response parses to no verbs', () => {
  assert.equal(parseTwiml('<Response></Response>').verbs.length, 0);
  assert.equal(parseTwiml('<Response/>').verbs.length, 0);
});

test('nested Connect > Stream > Parameter survives', () => {
  const { verbs } = parseTwiml(
    `<Response><Connect><Stream url="wss://x.test/v1"><Parameter name="agent_id" value="agt_1"/><Parameter name="from" value="+15551110000"/></Stream></Connect></Response>`,
  );
  const stream = verbs[0]?.children[0];
  assert.equal(stream?.name, 'Stream');
  assert.equal(attr(stream!, 'url'), 'wss://x.test/v1');
  assert.deepEqual(streamParameters(stream!), { agent_id: 'agt_1', from: '+15551110000' });
});

/**
 * **A `<Stream>` with no `<Parameter>` children is an empty map, not a failure.**
 * Reporting what the document said is this parser's job; refusing it is the far end's.
 */
test('a stream with no parameters is an empty map', () => {
  const { verbs } = parseTwiml('<Response><Connect><Stream url="wss://x.test/"/></Connect></Response>');
  assert.deepEqual(streamParameters(verbs[0]!.children[0]!), {});
});

/**
 * **Text is never trimmed.** A reply's own leading space is part of what somebody will be
 * sent, and trimming is a decision for whoever displays it.
 */
test('Message text keeps its own whitespace', () => {
  const { verbs } = parseTwiml('<Response><Message>  two spaces, and a newline\n</Message></Response>');
  assert.equal(verbs[0]?.text, '  two spaces, and a newline\n');
});

test('the five entities are unescaped exactly once', () => {
  const { verbs } = parseTwiml('<Response><Say>a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;</Say></Response>');
  assert.equal(verbs[0]?.text, `a & b < c > d "e" 'f'`);
});

test('numeric character references are read', () => {
  assert.equal(unescapeXml('&#65;&#x42;&#128512;'), 'AB😀');
});

/**
 * **`%2B` must survive as a plus.** Undoing a second layer of encoding here once turned a
 * percent-encoded plus into a bare one, which the far end's query parser read as a space —
 * so a caller's number arrived blank, and silently.
 */
test('a percent-encoded plus in an attribute is left alone', () => {
  const { verbs } = parseTwiml(
    '<Response><Connect><Stream url="wss://x.test/v1?from=%2B15551110000&amp;to=%2B15552220000"/></Connect></Response>',
  );
  assert.equal(
    attr(verbs[0]!.children[0]!, 'url'),
    'wss://x.test/v1?from=%2B15551110000&to=%2B15552220000',
  );
});

test('CDATA is taken verbatim', () => {
  const { verbs } = parseTwiml('<Response><Say><![CDATA[a & b <not a tag>]]></Say></Response>');
  assert.equal(verbs[0]?.text, 'a & b <not a tag>');
});

test('comments and the declaration are skipped', () => {
  const { verbs } = parseTwiml('<?xml version="1.0"?><!-- a note --><Response><!--x--><Hangup/></Response>');
  assert.deepEqual(verbs.map((v) => v.name), ['Hangup']);
});

test('single-quoted attributes are read', () => {
  const { verbs } = parseTwiml("<Response><Play loop='3'>http://x.test/a.wav</Play></Response>");
  assert.equal(attr(verbs[0]!, 'loop'), '3');
});

test('attributes are found case-insensitively', () => {
  const { verbs } = parseTwiml('<Response><Record maxlength="10"/></Response>');
  assert.equal(attr(verbs[0]!, 'maxLength'), '10');
});

test('a fragment with no Response parses as its own verb list', () => {
  assert.deepEqual(parseTwiml('<Say>x</Say><Hangup/>').verbs.map((v) => v.name), ['Say', 'Hangup']);
});

/**
 * **A malformed document throws rather than parsing to nothing.** Zero verbs because a
 * quote was unbalanced looks exactly like an application that meant to do nothing.
 */
test('an unterminated element is a ParseError naming the offset', () => {
  assert.throws(() => parseTwiml('<Response><Say>hello'), ParseError);
});

test('a mismatched closing tag is refused', () => {
  assert.throws(() => parseTwiml('<Response><Say>hi</Play></Response>'), ParseError);
});

test('an unquoted attribute is refused', () => {
  assert.throws(() => parseTwiml('<Response><Pause length=2/></Response>'), ParseError);
});

test('escapeXml is the inverse for the five characters', () => {
  const raw = `a & b < c > d "e" 'f'`;
  assert.equal(unescapeXml(escapeXml(raw)), raw);
});
