package main

import "testing"

// Mirrors the deployed policy: 2 groups + 3 people, gate ON.
func gateAllow() map[string]struct{} {
	return map[string]struct{}{
		"120363000000000002@g.us":     {}, // STAFF group
		"120363000000000001@g.us":     {}, // SALES group
		"15550000003@s.whatsapp.net":  {}, // Sam (phone)
		"100000000000001@lid":         {}, // Sam (LID)
		"15550000001@s.whatsapp.net":  {}, // Jordan
		"15550000002@s.whatsapp.net":  {}, // Alex
	}
}

func TestInboundDecision_Groups(t *testing.T) {
	allow := gateAllow()
	staff := "120363000000000002@g.us"
	other := "120363000000000004@g.us" // MEMBERS-ONLY, not watched

	cases := []struct {
		name      string
		chatKey   string
		mentioned bool
		want      bool
	}{
		{"watched group, mentioned → forward", staff, true, true},
		{"watched group, NOT mentioned → ignore", staff, false, false},
		{"unwatched group, mentioned → ignore", other, true, false},
		{"unwatched group, not mentioned → ignore", other, false, false},
	}
	for _, c := range cases {
		got := inboundDecision(false, true, allow, true, c.chatKey, c.mentioned, nil, nil)
		if got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestInboundDecision_AmbientGroups(t *testing.T) {
	allow := gateAllow()
	staff := "120363000000000002@g.us"
	sales := "120363000000000001@g.us"
	other := "120363000000000004@g.us" // MEMBERS-ONLY, not watched
	ambient := map[string]struct{}{staff: {}}

	cases := []struct {
		name      string
		chatKey   string
		mentioned bool
		want      bool
	}{
		{"ambient group, mentioned → forward", staff, true, true},
		{"ambient group, NOT mentioned → forward anyway", staff, false, true},
		{"non-ambient watched group, not mentioned → ignore", sales, false, false},
		{"non-ambient watched group, mentioned → forward", sales, true, true},
		{"unwatched group, not mentioned, not ambient-listed → ignore", other, false, false},
	}
	for _, c := range cases {
		got := inboundDecision(false, true, allow, true, c.chatKey, c.mentioned, nil, ambient)
		if got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestInboundDecision_DMs(t *testing.T) {
	allow := gateAllow()

	// Sam via LID sender + phone alt — allowed.
	if !inboundDecision(false, true, allow, false, "", false,
		[]string{"100000000000001@lid", "15550000003@s.whatsapp.net"}, nil) {
		t.Error("Sam DM should be forwarded")
	}
	// Alex — allowed.
	if !inboundDecision(false, true, allow, false, "", false, []string{"15550000002@s.whatsapp.net"}, nil) {
		t.Error("Alex DM should be forwarded")
	}
	// Stranger — blocked.
	if inboundDecision(false, true, allow, false, "", false, []string{"15555550123@s.whatsapp.net"}, nil) {
		t.Error("stranger DM must NOT be forwarded")
	}
	// Owner's own number (not on list) DMing the bot — blocked.
	if inboundDecision(false, true, allow, false, "", false, []string{"15550000004@s.whatsapp.net"}, nil) {
		t.Error("non-listed owner DM must NOT be forwarded")
	}
}

func TestInboundDecision_SelfAndUnset(t *testing.T) {
	allow := gateAllow()
	// Self message honours forwardSelf flag regardless of allow-list.
	if !inboundDecision(true, true, allow, true, "120363000000000002@g.us", false, nil, nil) {
		t.Error("self message should forward when forwardSelf=true")
	}
	if inboundDecision(true, false, allow, true, "120363000000000002@g.us", false, nil, nil) {
		t.Error("self message should NOT forward when forwardSelf=false")
	}
	// nil allow-list → legacy allow-all.
	if !inboundDecision(false, true, nil, true, "anygroup@g.us", false, []string{"x@s.whatsapp.net"}, nil) {
		t.Error("nil allow-list should forward everything")
	}
}
