package main

import (
	"context"
	"regexp"
	"strings"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// "@15550000005" in agent text = a real WhatsApp tag. 8-15 digits so prices/times never match.
var mentionRe = regexp.MustCompile(`(^|[^\w@])@(\d{8,15})\b`)

func mentionNumbers(text string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range mentionRe.FindAllStringSubmatch(text, -1) {
		if !seen[m[2]] {
			seen[m[2]] = true
			out = append(out, m[2])
		}
	}
	return out
}

// applyMentions turns @<number> in a text message into tags. Groups now address people by LID, so a
// phone number is swapped for its LID (text and MentionedJID must agree); a number with no known LID
// is tagged as a phone JID, and a number that already is a LID stays as is.
func applyMentions(client *whatsmeow.Client, msg *waProto.Message) {
	text := msg.GetConversation()
	if msg.ExtendedTextMessage != nil {
		text = msg.ExtendedTextMessage.GetText()
	}
	nums := mentionNumbers(text)
	if len(nums) == 0 {
		return
	}
	var jids []string
	for _, n := range nums {
		jid := types.NewJID(n, types.DefaultUserServer)
		if client != nil && client.Store != nil && client.Store.LIDs != nil {
			if lid, err := client.Store.LIDs.GetLIDForPN(context.Background(), jid); err == nil && !lid.IsEmpty() {
				text = strings.ReplaceAll(text, "@"+n, "@"+lid.User)
				jid = lid
			} else if pn, err := client.Store.LIDs.GetPNForLID(context.Background(), types.NewJID(n, types.HiddenUserServer)); err == nil && !pn.IsEmpty() {
				jid = types.NewJID(n, types.HiddenUserServer)
			}
		}
		jids = append(jids, jid.String())
	}
	if msg.ExtendedTextMessage == nil {
		msg.ExtendedTextMessage = &waProto.ExtendedTextMessage{}
		msg.Conversation = nil
	}
	msg.ExtendedTextMessage.Text = proto.String(text)
	if msg.ExtendedTextMessage.ContextInfo == nil {
		msg.ExtendedTextMessage.ContextInfo = &waProto.ContextInfo{}
	}
	msg.ExtendedTextMessage.ContextInfo.MentionedJID = jids
}
