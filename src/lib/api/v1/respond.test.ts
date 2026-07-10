import { describe, it, expect } from 'vitest';
import { ConvexError } from 'convex/values';
import { toApiErrorResponse, ApiError } from './respond';

async function bodyOf(res: ReturnType<typeof toApiErrorResponse>) {
  return (await res.json()) as { error: { code: string; message: string } };
}

describe('toApiErrorResponse', () => {
  it('keeps an ApiError\'s own code/status/message', async () => {
    const res = toApiErrorResponse(new ApiError('forbidden', 'nope', 403));
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error).toEqual({ code: 'forbidden', message: 'nope' });
  });

  it('maps a ConvexError UNAUTHORIZED to 401 unauthorized', async () => {
    const res = toApiErrorResponse(new ConvexError({ code: 'UNAUTHORIZED' }));
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe('unauthorized');
  });

  it('maps a ConvexError FORBIDDEN to 403 forbidden, echoing the missing scope', async () => {
    const res = toApiErrorResponse(
      new ConvexError({ code: 'FORBIDDEN', scope: 'messages:send' })
    );
    expect(res.status).toBe(403);
    const body = await bodyOf(res);
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toContain('messages:send');
  });

  it('maps a ConvexError NOT_FOUND to 404 not_found, echoing the entity', async () => {
    const res = toApiErrorResponse(new ConvexError({ code: 'NOT_FOUND', entity: 'contact' }));
    expect(res.status).toBe(404);
    const body = await bodyOf(res);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('contact not found');
  });

  it('maps a ConvexError BAD_REQUEST to 400 bad_request, echoing the message', async () => {
    const res = toApiErrorResponse(
      new ConvexError({ code: 'BAD_REQUEST', message: "'phone' is required" })
    );
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe("'phone' is required");
  });

  it('falls back to a generic 500 for an unrecognized ConvexError code or a plain Error', async () => {
    const unknownCode = toApiErrorResponse(new ConvexError({ code: 'SOMETHING_ELSE' }));
    expect(unknownCode.status).toBe(500);

    const plain = toApiErrorResponse(new Error('boom'));
    expect(plain.status).toBe(500);
    expect((await bodyOf(plain)).error.code).toBe('internal');
  });
});
