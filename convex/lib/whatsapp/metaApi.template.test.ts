/// <reference types="vite/client" />
import { afterEach, expect, test, vi } from 'vitest';
import { sendTemplateMessage } from './metaApi';

afterEach(() => vi.unstubAllGlobals());

/** Captures the JSON body of the single outbound fetch. */
function stubFetch(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ messages: [{ id: 'wamid.TEST' }] }),
      };
    })
  );
  return { body: () => captured };
}

const BASE = {
  phoneNumberId: 'pn1',
  accessToken: 'tok',
  to: '971500000000',
  templateName: 'welcome',
  language: 'en_US',
};

test('body-only call is unchanged — no components key when there are no params', async () => {
  const f = stubFetch();
  await sendTemplateMessage({ ...BASE });
  expect(f.body().template).toEqual({
    name: 'welcome',
    language: { code: 'en_US' },
  });
});

test('body params still emit a single body component', async () => {
  const f = stubFetch();
  await sendTemplateMessage({ ...BASE, params: ['Ada'] });
  expect((f.body().template as Record<string, unknown>).components).toEqual([
    { type: 'body', parameters: [{ type: 'text', text: 'Ada' }] },
  ]);
});

test('an image header emits a header component BEFORE the body component', async () => {
  const f = stubFetch();
  await sendTemplateMessage({
    ...BASE,
    params: ['Ada'],
    header: { type: 'image', link: 'https://cdn/x.jpg' },
  });
  expect((f.body().template as Record<string, unknown>).components).toEqual([
    {
      type: 'header',
      parameters: [{ type: 'image', image: { link: 'https://cdn/x.jpg' } }],
    },
    { type: 'body', parameters: [{ type: 'text', text: 'Ada' }] },
  ]);
});

test('a header with no body params emits only the header component', async () => {
  const f = stubFetch();
  await sendTemplateMessage({
    ...BASE,
    header: { type: 'document', link: 'https://cdn/q.pdf' },
  });
  expect((f.body().template as Record<string, unknown>).components).toEqual([
    {
      type: 'header',
      parameters: [
        { type: 'document', document: { link: 'https://cdn/q.pdf' } },
      ],
    },
  ]);
});
