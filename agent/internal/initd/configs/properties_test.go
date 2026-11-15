package configs

import "testing"

func TestSetProperties(t *testing.T) {
	in := "#Minecraft server properties\r\nmotd=Old\r\nserver-port = 25565\r\nlong=a\\\r\n  b\r\nkeep=me\r\n"
	got := setProperties(in, map[string]string{
		"motd":          "Ünïcode: a=b #1",
		"server-port":   "25570",
		"long":          "short",
		"rcon.password": " lead",
	})
	want := "#Minecraft server properties\r\nmotd=\\u00DCn\\u00EFcode\\: a\\=b \\#1\r\nserver-port=25570\r\nlong=short\r\nkeep=me\r\nrcon.password=\\ lead\r\n"
	if got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	if again := setProperties(got, map[string]string{"motd": "Ünïcode: a=b #1"}); again != got {
		t.Fatalf("not idempotent: %q", again)
	}
	if empty := setProperties("", map[string]string{"b": "2", "a": "1"}); empty != "a=1\nb=2\n" {
		t.Fatalf("new file: %q", empty)
	}
}

func TestPropertyKey(t *testing.T) {
	cases := map[string]string{
		"a=b":         "a",
		"a b":         "a",
		"a:b":         "a",
		`we\ ird=x`:   "we ird",
		`k\u0041y=1`:  "kAy",
		`esc\=aped=1`: "esc=aped",
	}
	for line, want := range cases {
		if got := propertyKey(line); got != want {
			t.Errorf("propertyKey(%q) = %q, want %q", line, got, want)
		}
	}
}
