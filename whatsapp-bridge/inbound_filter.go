package main

// Inbound trigger gate.
//
// By default every incoming message is forwarded to the webhook (and thus to
// any AI agent wired up behind it). That means an agent would "see" — and
// could be prompted to act on — every group message and every stranger's DM.
//
// Policy enforced here (reusing the outbound send allow-list as the set of
// known groups + people):
//
//   - Messages we sent ourselves: keep the legacy FORWARD_SELF behaviour.
//   - No allow-list configured: forward everything (legacy, backwards compat).
//   - Group message: forward ONLY if the group is allow-listed AND our own
//     account is @-mentioned in the message. Plain group chatter is ignored.
//   - EXCEPT: a group explicitly listed in WHATSAPP_AMBIENT_GROUPS forwards
//     every message, mention or not — an opt-in, per-group carve-out for
//     "read the whole conversation" participation. Still requires the group
//     to also be in the base allow-list; still N/A to any other group or DM.
//   - Direct (1:1) message: forward ONLY if the sender is allow-listed.
//
// The gate lives in the bridge so it holds even before/without an agent, and
// so a prompt-injected agent never even receives off-policy messages. Ambient
// groups deliberately trade away that per-message opt-in friction, so only
// add a group here with eyes open (any message from anyone in that group now
// reaches a privileged agent, not just ones that @-mention it).

import (
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// inboundAllowlist is the set of allow-listed recipient keys (same value as
// the outbound send allow-list). nil means "no gating — forward everything".
var inboundAllowlist map[string]struct{}

// ambientGroups is the set of groups (subset of inboundAllowlist) that
// forward every message regardless of @-mention. nil/empty means "off" —
// every group still requires a mention (legacy/default behaviour).
var ambientGroups map[string]struct{}

// inboundDecision is the pure policy function (no whatsmeow types) so it can
// be unit-tested exhaustively.
func inboundDecision(isFromMe, forwardSelf bool, allow map[string]struct{}, isGroup bool, chatKey string, botMentioned bool, senderKeys []string, ambient map[string]struct{}) bool {
	if isFromMe {
		return forwardSelf
	}
	if allow == nil {
		return true // not configured: legacy allow-all
	}
	if isGroup {
		if _, ok := allow[chatKey]; !ok {
			return false // message in a group we don't watch
		}
		if _, ok := ambient[chatKey]; ok {
			return true // ambient group: forward every message, no mention required
		}
		return botMentioned // only when our account is @-mentioned
	}
	// Direct message: any allow-listed sender form is enough.
	for _, k := range senderKeys {
		if k == "" {
			continue
		}
		if _, ok := allow[k]; ok {
			return true
		}
	}
	return false
}

// inboundShouldForward applies inboundDecision to a live message.
func inboundShouldForward(client *whatsmeow.Client, msg *events.Message) bool {
	isGroup := msg.Info.Chat.Server == types.GroupServer
	senderKeys := []string{recipientKey(msg.Info.Sender)}
	if !msg.Info.SenderAlt.IsEmpty() {
		senderKeys = append(senderKeys, recipientKey(msg.Info.SenderAlt))
	}
	return inboundDecision(
		msg.Info.IsFromMe,
		forwardSelfMessages,
		inboundAllowlist,
		isGroup,
		recipientKey(msg.Info.Chat),
		botMentioned(client, msg),
		senderKeys,
		ambientGroups,
	)
}

// botMentioned reports whether the message @-mentions our own account, by
// either its phone JID or its LID form (group mentions increasingly use LID).
func botMentioned(client *whatsmeow.Client, msg *events.Message) bool {
	ci := messageContextInfo(msg.Message)
	if ci == nil {
		return false
	}
	mentions := ci.GetMentionedJID()
	if len(mentions) == 0 {
		return false
	}

	selfKeys := make(map[string]struct{}, 2)
	if client.Store.ID != nil {
		selfKeys[recipientKey(*client.Store.ID)] = struct{}{}
	}
	if !client.Store.LID.IsEmpty() {
		selfKeys[recipientKey(client.Store.LID)] = struct{}{}
	}

	for _, j := range mentions {
		parsed, err := types.ParseJID(j)
		if err != nil {
			continue
		}
		if _, ok := selfKeys[recipientKey(parsed)]; ok {
			return true
		}
	}
	return false
}

// messageContextInfo returns the ContextInfo for the common message types
// that can carry @-mentions, or nil.
func messageContextInfo(m *waProto.Message) *waProto.ContextInfo {
	if m == nil {
		return nil
	}
	switch {
	case m.ExtendedTextMessage != nil:
		return m.ExtendedTextMessage.GetContextInfo()
	case m.ImageMessage != nil:
		return m.ImageMessage.GetContextInfo()
	case m.VideoMessage != nil:
		return m.VideoMessage.GetContextInfo()
	case m.DocumentMessage != nil:
		return m.DocumentMessage.GetContextInfo()
	case m.AudioMessage != nil:
		return m.AudioMessage.GetContextInfo()
	case m.StickerMessage != nil:
		return m.StickerMessage.GetContextInfo()
	}
	return nil
}
