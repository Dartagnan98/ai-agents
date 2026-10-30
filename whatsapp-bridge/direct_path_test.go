package main

import "testing"

func TestExtractDirectPathKeepsSignature(t *testing.T) {
	got := extractDirectPathFromURL("https://mmg.whatsapp.net/v/t62.7119-24/1_2_n.enc?ccb=11-4&oh=01_X&oe=6A&_nc_sid=5e03e0&mms3=true")
	if want := "/v/t62.7119-24/1_2_n.enc?ccb=11-4&oh=01_X&oe=6A&_nc_sid=5e03e0"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
