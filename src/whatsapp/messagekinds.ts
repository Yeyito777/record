/**
 * What an unrendered WhatsApp message is, from the field names kept with it.
 * Shared by the worker (which converts) and the UI (which shows cached ones).
 */

/** Fields that travel with a message but say nothing about what it is. */
const ENVELOPE_FIELDS = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);

/** Control messages: they change state elsewhere and are never chat messages. */
const HIDDEN_TYPES = new Set([
  "protocolMessage", "reactionMessage", "albumMessage", "secretEncryptedMessage", "associatedChildMessage",
  "messageHistoryNotice", "messageHistoryBundle", "pinInChatMessage", "keepInChatMessage", "pollUpdateMessage",
  "encReactionMessage", "encCommentMessage", "encEventResponseMessage",
]);

/**
 * The message type worth naming to the reader, or null when there is nothing
 * to show: a control message, or an envelope with no content at all (such as
 * a group key handed out on its own).
 */
export function whatsAppUnsupportedType(content: { sourceType?: string; sourceFields?: readonly string[] }): string | null {
  const fields = content.sourceFields?.length ? content.sourceFields : content.sourceType ? [content.sourceType] : [];
  const named = fields.filter((field) => !ENVELOPE_FIELDS.has(field));
  if (named.length === 0) return null;
  return named.find((field) => !HIDDEN_TYPES.has(field)) ?? null;
}
