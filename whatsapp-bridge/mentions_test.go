package main

import (
	"reflect"
	"testing"
)

func TestMentionNumbers(t *testing.T) {
	got := mentionNumbers("@15550000005 hi, also @245423759483000 and @15550000005 again. $500 @ 3pm, a@123456789")
	if want := []string{"15550000005", "245423759483000"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}
