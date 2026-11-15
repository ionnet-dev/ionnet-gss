package steps

import (
	"bytes"
	"strings"
	"testing"
)

// TestSteamcmdOutput feeds carriage-return progress output through the filter: a burst of progress lines of one
// phase shows only its first and last line, a new phase shows at once, and escape sequences disappear.
func TestSteamcmdOutput(t *testing.T) {
	var out bytes.Buffer
	o := newSteamcmdOutput(&out)
	_, _ = o.Write([]byte("\x1b[0mRedirecting stderr to '/data/.gss/steamcmd/logs/stderr.txt'\r\n"))
	_, _ = o.Write([]byte("[  0%] Checking for available updates...\r[----] Downloading update (0 of 43,235 KB)...\r"))
	_, _ = o.Write([]byte("[ 10%] Downloading update (4,323 of 43,235 KB)...\r[ 90%] Downloading update (38,911 of 43,235 KB)...\r"))
	for _, p := range []string{"1.00 (10 / 1000)", "2.00 (20 / 1000)", "50.00 (500 / 1000)"} {
		_, _ = o.Write([]byte(" Update state (0x61) downloading, progress: " + p + "\r"))
	}
	_, _ = o.Write([]byte(" Update state (0x81) verifying update, progress: 3.00 (30 / 1000)\n"))
	_, _ = o.Write([]byte("Success! App '1007' fully installed.\n"))
	o.Flush()
	want := strings.Join([]string{
		"Redirecting stderr to '/data/.gss/steamcmd/logs/stderr.txt'",
		"[  0%] Checking for available updates...",
		"[----] Downloading update (0 of 43,235 KB)...",
		"[ 90%] Downloading update (38,911 of 43,235 KB)...",
		"Update state: downloading 1.00% (0 kB of 1 kB)",
		"Update state: downloading 50.00% (0 kB of 1 kB)",
		"Update state: verifying update 3.00% (0 kB of 1 kB)",
		"Success! App '1007' fully installed.",
	}, "\n") + "\n"
	if out.String() != want {
		t.Fatalf("got\n%s\nwant\n%s", out.String(), want)
	}
	if permanent, err := o.failure(1007, 0); err != nil || permanent {
		t.Fatalf("a clean run failed: %v", err)
	}
}

func TestSteamcmdFailure(t *testing.T) {
	cases := []struct {
		lines     string
		code      int
		permanent bool
		contains  string
	}{
		{"ERROR! Failed to install app '4020' (No subscription)\n", 8, true, "anonymous login"},
		{"Error! App '4020' state is 0x202 after update job.\n", 8, true, "disk space"},
		{"Error! App '4020' state is 0x6 after update job.\n", 8, false, "code 8"},
		{"Logging in user 'anonymous' to Steam Public...FAILED (Rate Limit Exceeded)\n", 0, false, "Rate Limit"},
		{"Failed to init SDL priority manager: SDL not found\n", 7, false, "exited with code 7"},
		{"Update state (0x0) : Timed out waiting for update to start, bailing.\nSuccess! App '4000' fully installed.\n", 0, false, "bailing"},
	}
	for _, c := range cases {
		o := newSteamcmdOutput(&bytes.Buffer{})
		_, _ = o.Write([]byte(c.lines))
		o.Flush()
		permanent, err := o.failure(4020, c.code)
		if err == nil || permanent != c.permanent || !strings.Contains(err.Error(), c.contains) {
			t.Errorf("%q code %d: permanent %v, %v; want %v and %q", c.lines, c.code, permanent, err, c.permanent, c.contains)
		}
	}
}
