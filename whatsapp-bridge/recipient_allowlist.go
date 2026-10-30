package main

// Outbound recipient confinement.
//
// By default the bridge will send a WhatsApp message (or reaction, or typing
// indicator) to ANY recipient the caller names, as long as the caller holds
// the bearer token. That makes the bridge a "text anyone" primitive — and if
// an MCP-driven agent is ever prompt-injected by an incoming message, it can
// be coerced into messaging arbitrary contacts.
//
// WHATSAPP_SEND_ALLOWLIST confines the set of recipients /api/send,
// /api/react and /api/typing may target. It is a comma- or whitespace-
// separated list of phone numbers (e.g. 15550000004) and/or full JIDs
// (e.g. 120363000000000002@g.us).
//
// Semantics:
//   - env unset            → no allow-list; allow any recipient (legacy).
//   - env set, has entries → enforce; reject anything not listed with 403.
//   - env set but empty     → error at startup (fail closed, never silently
//     allow everything because of a typo'd value).

import (
	"fmt"
	"os"
	"strings"

	"go.mau.fi/whatsmeow/types"
)

const sendAllowlistEnv = "WHATSAPP_SEND_ALLOWLIST"

// inboundAllowlistEnv decouples the inbound trigger gate from the outbound
// send allow-list. When set, it defines which senders/groups reach the
// webhook agent, regardless of WHATSAPP_SEND_ALLOWLIST — so sends can be
// unrestricted (env unset) while inbound triggers stay confined to trusted
// people. When unset, the inbound gate reuses the send allow-list (legacy).
const inboundAllowlistEnv = "WHATSAPP_INBOUND_ALLOWLIST"

// ambientGroupsEnv lists groups (must also be in WHATSAPP_INBOUND_ALLOWLIST)
// that forward every message, not just @-mentions. See inbound_filter.go.
const ambientGroupsEnv = "WHATSAPP_AMBIENT_GROUPS"

// resolveAmbientGroups parses WHATSAPP_AMBIENT_GROUPS. A nil result means
// "not configured — no ambient groups, every group still needs a mention".
func resolveAmbientGroups() (map[string]struct{}, error) {
	return resolveRecipientSet(ambientGroupsEnv)
}

// resolveAllowedRecipients parses WHATSAPP_SEND_ALLOWLIST into a set of
// normalised recipient keys. A nil result means "not configured — allow all".
func resolveAllowedRecipients() (map[string]struct{}, error) {
	return resolveRecipientSet(sendAllowlistEnv)
}

// resolveInboundAllowlist parses WHATSAPP_INBOUND_ALLOWLIST. A nil result
// means "not configured — fall back to the send allow-list".
func resolveInboundAllowlist() (map[string]struct{}, error) {
	return resolveRecipientSet(inboundAllowlistEnv)
}

func resolveRecipientSet(envName string) (map[string]struct{}, error) {
	raw, ok := os.LookupEnv(envName)
	if !ok {
		return nil, nil // not configured: allow all (backwards compatible)
	}

	set := make(map[string]struct{})
	for _, field := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
	}) {
		jid, err := parseRecipientArg(field)
		if err != nil {
			return nil, fmt.Errorf("%s entry %q is not a valid recipient: %w", envName, field, err)
		}
		set[recipientKey(jid)] = struct{}{}
	}
	if len(set) == 0 {
		return nil, fmt.Errorf("%s is set but lists no valid recipients (refusing to allow all)", envName)
	}
	return set, nil
}

// parseRecipientArg turns either a bare phone number or a full JID string
// into a types.JID, mirroring how the REST handlers interpret req.Recipient.
func parseRecipientArg(recipient string) (types.JID, error) {
	recipient = strings.TrimSpace(recipient)
	if recipient == "" {
		return types.JID{}, fmt.Errorf("empty recipient")
	}
	if strings.ContainsRune(recipient, '@') {
		jid, err := types.ParseJID(recipient)
		if err != nil {
			return types.JID{}, err
		}
		if jid.User == "" || jid.Server == "" {
			return types.JID{}, fmt.Errorf("incomplete JID %q", recipient)
		}
		return jid, nil
	}
	// Bare number → an individual chat. Tolerate a leading '+'.
	return types.JID{User: strings.TrimPrefix(recipient, "+"), Server: types.DefaultUserServer}, nil
}

// recipientKey normalises a JID to a comparison key that ignores device and
// agent parts, so 15550000004:4@s.whatsapp.net matches 15550000004@s.whatsapp.net.
func recipientKey(jid types.JID) string {
	j := jid.ToNonAD()
	return strings.ToLower(j.User + "@" + j.Server)
}

// recipientAllowed reports whether sending to recipient is permitted. A nil
// allow-list means enforcement is off (allow all).
func recipientAllowed(allow map[string]struct{}, recipientArg string) (bool, error) {
	if allow == nil {
		return true, nil
	}
	jid, err := parseRecipientArg(recipientArg)
	if err != nil {
		return false, err
	}
	_, ok := allow[recipientKey(jid)]
	return ok, nil
}
