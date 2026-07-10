// ============================================================
// POST /api/v1/messages — send a WhatsApp message via the public API.
//
// The headline public endpoint (issue #245). Unlike the dashboard's
// `/api/whatsapp/send` (which takes an internal `conversation_id`),
// this takes a phone number — what an external automation actually
// has — resolves-or-creates the contact + conversation, then sends.
//
// Auth: API key with the `messages:send` scope.
//
// Body:
//   {
//     "to": "+14155550123",                 // required, E.164
//     "type": "text",                        // text|template|image|video|document|audio|interactive (default: text)
//     "text": "Hello!",                      // text body, or media caption
//     "media_url": "https://…/file.pdf",     // required for image/video/document/audio
//     "filename": "invoice.pdf",             // optional, document filename
//     "template": {                          // required when type=template
//       "name": "order_update",
//       "language": "en_US",
//       "params": ["A123"]                    // positional body params only —
//                                              // structured { body, header, buttons }
//                                              // params are not yet supported via
//                                              // Convex (see convex/apiV1.ts)
//     },
//     "interactive_payload": { ... },        // required when type=interactive
//     "reply_to_message_id": "<id>",         // optional, must be in the same conversation
//     "name": "Jane Doe"                     // optional, names a newly-created contact
//   }
//
// Response (201):
//   { "data": { "message_id", "whatsapp_message_id", "conversation_id",
//               "contact_id", "contact_created" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getConvexClient, api, type Id } from '@/lib/convex/server-client';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!to) {
      return fail('bad_request', "'to' is required", 400);
    }

    const type = typeof body.type === 'string' ? body.type : 'text';

    const template =
      body.template && typeof body.template === 'object'
        ? (body.template as Record<string, unknown>)
        : null;

    // `params` as an array = legacy positional body params (supported);
    // as an object = structured header/body/button params. The Convex
    // send path (`convex/metaSend.ts`'s `sendTemplate`) only supports
    // the positional form today — see that op's own doc comment — so a
    // structured request 400s explicitly rather than silently sending
    // an unpersonalized template.
    if (template?.params && !Array.isArray(template.params)) {
      return fail(
        'bad_request',
        "Structured 'template.params' (header/body/button objects) is not yet supported; use a positional array instead",
        400
      );
    }
    const templateParams = Array.isArray(template?.params)
      ? (template.params as unknown[]).filter(
          (p): p is string => typeof p === 'string'
        )
      : undefined;

    const interactivePayload =
      body.interactive_payload && typeof body.interactive_payload === 'object'
        ? body.interactive_payload
        : undefined;

    const result = await getConvexClient().action(api.apiV1.sendMessage, {
      keyHash: ctx.keyHash,
      to,
      name: typeof body.name === 'string' ? body.name : undefined,
      type,
      text: typeof body.text === 'string' ? body.text : undefined,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : undefined,
      filename: typeof body.filename === 'string' ? body.filename : undefined,
      template: template?.name
        ? {
            name: template.name as string,
            language:
              typeof template.language === 'string' ? template.language : undefined,
            params: templateParams,
          }
        : undefined,
      interactive: interactivePayload,
      replyToMessageId:
        typeof body.reply_to_message_id === 'string'
          ? (body.reply_to_message_id as Id<'messages'>)
          : undefined,
    });

    return ok(
      {
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
        conversation_id: result.conversationId,
        contact_id: result.contactId,
        contact_created: result.contactCreated,
      },
      201
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
