const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const script = readFileSync(path.join(__dirname, '..', 'app-shell-pagination.js'), 'utf8');
const css = readFileSync(path.join(__dirname, '..', 'app-shell-pagination.css'), 'utf8');
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
});
after(async () => { await browser?.close(); });

async function fixture(t, count = 9) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  t.after(() => page.close());
  await page.route('**/*', route => route.abort());
  await page.setContent('<html lang="en"><body><div id="mount"><div id="bubble"></div><div class="turn-action-controls"></div></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.evaluate(() => {
    globalThis.__CHATGPT_EDIT_PAGINATION_PATCH_TEST__ = true;
    // Drive reconciliation explicitly; do not discover any real website runtime.
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
  });
  await page.addScriptTag({ content: script });
  await page.evaluate(count => {
    const api = globalThis.__chatgptBatchPaginationTest;
    const atom = { kind: 'signal-family' };
    const state = globalThis.fixture = { api, calls: [], pass: 0, pending: false, fail: false };
    state.makePayload = total => {
      const mapping = { root: { parent: null, children: [], message: null } };
      for (let n = 1; n <= total; n++) {
        mapping.root.children.push(`u${n}`);
        mapping[`u${n}`] = { parent: 'root', children: [`a${n}`], message: {
          author: { role: 'user' }, create_time: n, content: { content_type: 'text', parts: [`User version ${n}`] },
        } };
        mapping[`a${n}`] = { parent: `u${n}`, children: [], message: {
          author: { role: 'assistant' }, create_time: n, content: { content_type: 'text', parts: [`Reply ${n}`] },
        } };
      }
      return { conversation_id: 'synthetic-conversation', current_node: 'a1', mapping };
    };
    const payload = state.makePayload(count);
    state.mapping = payload.mapping;
    state.scope = {
      scope: { __scopeBrand: 'AppScope' },
      node: { familyBindings: new Map([[atom, true]]) },
      get: () => state.mapping,
      set: (_atom, _id, mapping) => { state.mapping = mapping; },
    };
    state.context = { conversationId: payload.conversation_id, messageId: 'u1', scope: state.scope };
    state.bubble = document.getElementById('bubble');
    state.bind = bubble => { bubble.__reactFiber$fixture = {
      memoizedState: { memoizedState: state.scope },
      memoizedProps: { item: { type: 'user-message', messageId: state.context.messageId }, conversationId: payload.conversation_id },
    }; };
    state.bind(state.bubble);
    api.captureBatch([payload], 'synthetic');
    state.graph = api.graphFor(state.context);
    state.paint = () => api.paintUserPagination(state.bubble, state.context, state.graph, {
      mount: document.getElementById('mount'), row: document.querySelector('.turn-action-controls'),
    }, ++state.pass);
    const runtime = { m: {}, c: { fixture: { exports: {
      nativeSelect: async function (scope, conversationId, target) {
        // Discovery markers for the existing native-switcher contract:
        // current_node_id /conversation/{conversation_id}
        state.calls.push({ conversationId, target });
        if (state.pending) await new Promise(resolve => { state.release = resolve; });
        if (state.fail) throw new Error('Synthetic save failure');
        state.context.messageId = target;
        state.bind(state.bubble);
      },
    } } } };
    api.attachRuntime(runtime);
    state.paint();
  }, count);
  return page;
}

test('renders numbers, directly selects a distant version once, and keeps arrows', async t => {
  const page = await fixture(t);
  assert.deepEqual(await page.locator('[data-batch-version-numbers] button').allTextContents(), ['1','2','3','4','5','6','7','8','9']);
  assert.equal(await page.locator('[aria-current="page"]').textContent(), '1');
  assert.equal(await page.getByRole('button', { name: 'Previous version', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Go to version 1', exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.calls.length), 0);
  await page.getByRole('button', { name: 'Go to version 5', exact: true }).click();
  await page.evaluate(() => fixture.paint());
  assert.deepEqual(await page.evaluate(() => fixture.calls.map(x => x.target)), ['u5']);
  assert.equal(await page.locator('[aria-current="page"]').textContent(), '5');
  await page.getByRole('button', { name: 'Previous version', exact: true }).click();
  await page.evaluate(() => fixture.paint());
  assert.equal(await page.locator('[aria-current="page"]').textContent(), '4');
});

test('disables all controls during save and retains the native failure announcement', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { fixture.pending = true; fixture.fail = true; });
  await page.getByRole('button', { name: 'Go to version 5', exact: true }).click();
  await page.evaluate(() => fixture.paint());
  assert.equal(await page.locator('[data-batch-edit-pagination]').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('[data-batch-edit-pagination] button:not(:disabled)').count(), 0);
  await page.evaluate(() => fixture.api.switchVersion(fixture.bubble, { targetMessageId: 'u6' }));
  assert.equal(await page.evaluate(() => fixture.calls.length), 1);
  await page.evaluate(async () => { fixture.release(); await new Promise(r => setTimeout(r, 0)); fixture.paint(); });
  assert.equal(await page.locator('[data-batch-edit-pagination]').getAttribute('aria-busy'), 'false');
  assert.match(await page.locator('[data-batch-version-status]').getAttribute('aria-label'), /Could not switch/);
  assert.equal(await page.locator('[aria-current="page"]').textContent(), '1');
  assert.equal(await page.getByRole('button', { name: 'Go to version 5', exact: true }).isDisabled(), false);
});

test('rejects stale, foreign and current targets without calling the native switcher', async t => {
  const page = await fixture(t);
  await page.evaluate(async () => {
    for (const target of ['missing', 'a1', 'u1']) await fixture.api.switchVersion(fixture.bubble, { targetMessageId: target });
    await fixture.api.switchVersion(fixture.bubble, { direction: -1 });
  });
  assert.equal(await page.evaluate(() => fixture.calls.length), 0);
});

test('retargets handlers when React replaces the bubble but reuses its controls', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    fixture.context.messageId = 'u3';
    const replacement = document.createElement('div');
    fixture.bubble.replaceWith(replacement);
    fixture.bubble = replacement;
    fixture.bind(replacement);
    fixture.paint();
  });
  await page.getByRole('button', { name: 'Next version', exact: true }).click();
  await page.evaluate(() => fixture.paint());
  assert.equal(await page.locator('[aria-current="page"]').textContent(), '4');
  assert.deepEqual(await page.evaluate(() => fixture.calls.map(x => x.target)), ['u4']);
});

test('grows, shrinks and removes controls without duplicate numbers', async t => {
  const page = await fixture(t, 3);
  for (const total of [5, 2, 1]) {
    await page.evaluate(total => {
      const payload = fixture.makePayload(total);
      fixture.mapping = payload.mapping;
      fixture.api.captureBatch([payload], 'synthetic');
      fixture.graph = fixture.api.graphFor(fixture.context);
      fixture.paint();
    }, total);
    assert.equal(await page.locator('[data-batch-version-numbers] button').count(), total === 1 ? 0 : total);
  }
});

test('long lists stay bounded, reveal the active number, and support keyboard activation', async t => {
  const page = await fixture(t, 50);
  await page.evaluate(() => {
    fixture.context.messageId = 'u50'; fixture.bind(fixture.bubble); fixture.paint();
  });
  const metrics = await page.locator('[data-batch-version-numbers]').evaluate(el => ({
    width: el.clientWidth, overflow: el.scrollWidth > el.clientWidth, scroll: el.scrollLeft,
    visible: el.lastElementChild.offsetLeft + el.lastElementChild.offsetWidth <= el.scrollLeft + el.clientWidth + 1,
  }));
  assert.ok(metrics.width <= 240 && metrics.overflow && metrics.scroll > 0 && metrics.visible);
  await page.getByRole('button', { name: 'Go to version 3', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => fixture.paint());
  assert.equal(await page.locator('[aria-current="page"]').textContent(), '3');
  await page.getByRole('button', { name: 'Go to version 2', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.evaluate(() => fixture.paint());
  assert.equal(await page.locator('[aria-current="page"]').textContent(), '2');
});

test('assistant controls retain their original arrows and counter', async t => {
  const page = await fixture(t, 2);
  await page.evaluate(() => {
    const payload = fixture.makePayload(2);
    payload.mapping.u1.children.push('alternate');
    payload.mapping.alternate = { ...payload.mapping.a1, message: { ...payload.mapping.a1.message, create_time: 3 } };
    const graph = fixture.api.createGraphState(payload);
    const message = document.createElement('div');
    message.setAttribute('data-chatgpt-selection-message-id', 'a1');
    const row = document.createElement('div'); document.body.append(message, row);
    fixture.api.paintAssistantPagination(message, fixture.context, graph, row, ++fixture.pass);
  });
  const controls = page.locator('[data-batch-assistant-pagination]');
  assert.equal(await controls.locator('button').count(), 2);
  assert.equal(await controls.locator('[data-batch-version-numbers]').count(), 0);
  assert.equal(await controls.textContent(), '1/2');
});

test('localizes numbered button labels in Russian', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { document.documentElement.lang = 'ru'; fixture.paint(); });
  assert.equal(await page.getByRole('button', { name: 'Перейти к версии 5', exact: true }).count(), 1);
});
