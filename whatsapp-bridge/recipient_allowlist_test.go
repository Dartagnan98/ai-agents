package main

import "testing"

// The exact allow-list configured for this deployment: 2 groups + 3 people
// (Sam by both phone and LID form).
const deploymentAllowlist = "120363000000000002@g.us,120363000000000001@g.us," +
	"15550000003,100000000000001@lid,15550000001,15550000002"

func TestResolveAllowedRecipients_Deployment(t *testing.T) {
	t.Setenv(sendAllowlistEnv, deploymentAllowlist)
	allow, err := resolveAllowedRecipients()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 6 distinct keys (the phone and LID forms of Sam are separate keys).
	if len(allow) != 6 {
		t.Fatalf("expected 6 recipients, got %d: %v", len(allow), allow)
	}

	allowed := []string{
		"120363000000000002@g.us",        // STAFF group
		"120363000000000001@g.us",        // SALES group
		"15550000003",                    // Sam (phone, bare)
		"15550000003@s.whatsapp.net",     // Sam (phone, full JID)
		"15550000003:4@s.whatsapp.net",   // Sam (with device id — must still match)
		"+15550000003",                   // Sam (with leading +)
		"100000000000001@lid",            // Sam (LID form)
		"15550000001",                    // Jordan
		"15550000002",                    // Alex
	}
	for _, r := range allowed {
		ok, err := recipientAllowed(allow, r)
		if err != nil {
			t.Errorf("recipientAllowed(%q) errored: %v", r, err)
			continue
		}
		if !ok {
			t.Errorf("expected %q to be ALLOWED, got blocked", r)
		}
	}

	denied := []string{
		"15550000004",                 // the owner's own number — intentionally NOT listed
		"15555550123",                 // random stranger
		"120363000000000004@g.us",     // MEMBERS-ONLY group (not allowed)
		"120363000000000003@g.us",     // WOMEN-ONLY group (not allowed)
	}
	for _, r := range denied {
		ok, err := recipientAllowed(allow, r)
		if err != nil {
			t.Errorf("recipientAllowed(%q) errored: %v", r, err)
			continue
		}
		if ok {
			t.Errorf("expected %q to be BLOCKED, got allowed", r)
		}
	}
}

func TestResolveAllowedRecipients_UnsetAllowsAll(t *testing.T) {
	// Ensure the var is not set in this test's environment.
	allow, err := resolveAllowedRecipients()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if allow != nil {
		t.Fatalf("expected nil (allow-all) when env unset, got %v", allow)
	}
	ok, err := recipientAllowed(allow, "15555550123")
	if err != nil || !ok {
		t.Fatalf("nil allow-list should permit any recipient; got ok=%v err=%v", ok, err)
	}
}

func TestResolveAllowedRecipients_EmptyFailsClosed(t *testing.T) {
	t.Setenv(sendAllowlistEnv, "   ,  , ")
	if _, err := resolveAllowedRecipients(); err == nil {
		t.Fatal("expected error for set-but-empty allow-list (must fail closed)")
	}
}
