import { strict as assert } from 'node:assert';
import test from 'node:test';

const { parse, serialize, MAX_TOTAL_BYTES } = await import('../../dist/cjs/baggage.js');

test('round-trips a simple header', () => {
  const b = parse('user=alice,env=dev');
  assert.equal(b.get('user').value, 'alice');
  assert.equal(b.get('env').value, 'dev');
  assert.equal(serialize(b), 'user=alice,env=dev');
});

test('percent-decodes values and re-encodes them', () => {
  const b = parse('user=alice%40metalbear.com,note=a%2Cb%3Bc');
  assert.equal(b.get('user').value, 'alice@metalbear.com');
  assert.equal(b.get('note').value, 'a,b;c');
  // Re-encoding must escape the delimiters again or the header would reparse wrong.
  assert.equal(serialize(b), 'user=alice%40metalbear.com,note=a%2Cb%3Bc');
  assert.equal(parse(serialize(b)).get('note').value, 'a,b;c');
});

test('preserves opaque properties', () => {
  const b = parse('key=value;metadata=one;flag');
  assert.deepEqual(b.get('key').properties, ['metadata=one', 'flag']);
  assert.equal(serialize(b), 'key=value;metadata=one;flag');
});

test('tolerates OWS around delimiters', () => {
  const b = parse('a=1 ,  b=2 ; p=q');
  assert.equal(b.get('a').value, '1');
  assert.equal(b.get('b').value, '2');
});

test('skips malformed members instead of failing the header', () => {
  const b = parse('good=1,novalue,=orphan,also good=2,fine=3');
  assert.equal(b.get('good').value, '1');
  assert.equal(b.get('fine').value, '3');
  assert.equal(b.has('novalue'), false);
  assert.equal(b.has(''), false);
  // "also good" is not an RFC 7230 token, so it is dropped.
  assert.equal(b.has('also good'), false);
});

test('survives an invalid percent escape', () => {
  const b = parse('broken=100%,ok=1');
  assert.equal(b.get('broken').value, '100%');
  assert.equal(b.get('ok').value, '1');
});

test('joins repeated headers', () => {
  const b = parse(['a=1', 'b=2']);
  assert.equal(b.size, 2);
});

test('caps members at 180', () => {
  const header = Array.from({ length: 300 }, (_, i) => `k${i}=v`).join(',');
  assert.equal(parse(header).size, 180);
});

test('drops the tail rather than emitting an oversized header', () => {
  const big = new Map();
  for (let i = 0; i < 400; i++) big.set(`key${i}`, { value: 'x'.repeat(60) });
  const out = serialize(big);
  assert.ok(out.length <= MAX_TOTAL_BYTES, `got ${out.length} bytes`);
  assert.ok(out.length > 4000, 'should still carry as much as fits');
  assert.equal(out.endsWith(','), false);
  assert.ok(parse(out).size > 0);
});

test('rejects an inbound header over the total limit', () => {
  assert.equal(parse('k=' + 'x'.repeat(MAX_TOTAL_BYTES)).size, 0);
});

test('handles empty and nullish input', () => {
  assert.equal(parse(undefined).size, 0);
  assert.equal(parse(null).size, 0);
  assert.equal(parse('').size, 0);
  assert.equal(serialize(new Map()), '');
  assert.equal(serialize(undefined), '');
});

test('counts multi-byte characters as UTF-8 bytes', () => {
  const b = new Map([['emoji', { value: '🐻' }]]);
  assert.equal(parse(serialize(b)).get('emoji').value, '🐻');
});
