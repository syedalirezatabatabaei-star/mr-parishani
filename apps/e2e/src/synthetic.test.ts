import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mobile, nationalId, personName, sheba } from './synthetic.ts';

// Task 9-4: the made-up values pass the same checks the API makes (contracts).

void test('a national id has ten digits and a right check digit', () => {
  for (let i = 0; i < 200; i++) {
    const id = nationalId();
    assert.match(id, /^\d{10}$/);
    const sum = Array.from(id.slice(0, 9)).reduce((s, d, k) => s + Number(d) * (10 - k), 0) % 11;
    assert.equal(Number(id[9]), sum < 2 ? sum : 11 - sum);
  }
});

void test('a sheba is IR, 24 digits, and mod 97 equals 1', () => {
  for (let i = 0; i < 200; i++) {
    const value = sheba();
    assert.match(value, /^IR\d{24}$/);
    const moved = `${value.slice(4)}1827${value.slice(2, 4)}`;
    let rest = 0;
    for (const ch of moved) rest = (rest * 10 + Number(ch)) % 97;
    assert.equal(rest, 1);
  }
});

void test('names are two Persian words; mobiles are 9XXXXXXXXX', () => {
  assert.match(personName(), /^[؀-ۿ]+ [؀-ۿ]+$/);
  assert.match(mobile(), /^914\d{7}$/);
  assert.match(mobile('915'), /^915\d{7}$/);
});
