import { expect, test } from 'bun:test';
import { PROTOCOL_PLUGINS } from '../src/protocols/registry';

test('protocol registry keeps dependency-safe discovery order', () => {
  expect(PROTOCOL_PLUGINS.map(plugin => plugin.id)).toEqual(['v2', 'v3', 'carbon']);
});
