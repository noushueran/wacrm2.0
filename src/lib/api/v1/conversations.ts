// ============================================================
// Public API (v1) serializers for conversations + messages.
//
// The dashboard's `Conversation`/`Message` rows carry internal columns
// that shouldn't leak onto the public wire. These serializers project
// the stable public subset and rename the Meta id (`messageId` →
// `whatsapp_message_id`) to match the send endpoint's response
// vocabulary. Data ops (list/get, account+conversation ownership
// checks) now live in Convex (`convex/apiV1.ts`) — this module is down
// to projecting THAT shape (Convex docs: camelCase, `_id`/
// `_creationTime`) into the same public `ApiConversation`/`ApiMessage`
// output this endpoint has always returned.
// ============================================================

export interface ApiConversation {
  id: string;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
    tags: { id: string; name: string; color: string }[];
  } | null;
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  whatsapp_message_id: string | null;
  status: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  created_at: string;
}

/** The shape `convex/apiV1.ts`'s `listConversations`/`getConversation`
 *  return: a `conversations` doc with its `contact` (+ that contact's
 *  `tags`) embedded. */
export interface ConvexApiConversation {
  _id: string;
  _creationTime: number;
  contactId: string;
  status: string;
  assignedToUserId?: string;
  lastMessageText?: string;
  lastMessageAt?: number;
  unreadCount: number;
  updatedAt?: number;
  contact:
    | {
        _id: string;
        phone: string;
        name?: string;
        email?: string;
        company?: string;
        tags: { _id: string; name: string; color: string }[];
      }
    | null;
}

/** The shape `convex/apiV1.ts`'s `listMessages` returns: bare `messages`
 *  docs. */
export interface ConvexApiMessage {
  _id: string;
  _creationTime: number;
  conversationId: string;
  senderType: string;
  contentType: string;
  contentText?: string;
  mediaUrl?: string;
  templateName?: string;
  messageId?: string;
  status: string;
  replyToMessageId?: string;
  interactiveReplyId?: string;
}

/** Project a Convex conversation doc (+ embedded contact/tags) into the
 *  public shape. */
export function serializeConversation(
  doc: ConvexApiConversation
): ApiConversation {
  const createdAt = new Date(doc._creationTime).toISOString();
  const c = doc.contact;
  return {
    id: doc._id,
    contact_id: doc.contactId,
    status: doc.status,
    assigned_agent_id: doc.assignedToUserId ?? null,
    last_message_text: doc.lastMessageText ?? null,
    last_message_at: doc.lastMessageAt
      ? new Date(doc.lastMessageAt).toISOString()
      : null,
    unread_count: doc.unreadCount ?? 0,
    created_at: createdAt,
    updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : createdAt,
    contact: c
      ? {
          id: c._id,
          phone: c.phone,
          name: c.name ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          tags: c.tags.map((t) => ({ id: t._id, name: t.name, color: t.color })),
        }
      : null,
  };
}

/** Project a Convex `messages` doc into the public shape. */
export function serializeMessage(doc: ConvexApiMessage): ApiMessage {
  return {
    id: doc._id,
    conversation_id: doc.conversationId,
    // `customer` = inbound (from the contact); anything else is outbound.
    direction: doc.senderType === 'customer' ? 'inbound' : 'outbound',
    sender_type: doc.senderType,
    content_type: doc.contentType,
    content_text: doc.contentText ?? null,
    media_url: doc.mediaUrl ?? null,
    template_name: doc.templateName ?? null,
    whatsapp_message_id: doc.messageId ?? null,
    status: doc.status,
    reply_to_message_id: doc.replyToMessageId ?? null,
    interactive_reply_id: doc.interactiveReplyId ?? null,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}
