package docker

import (
	"fmt"
	"testing"
)

func TestPortInUse(t *testing.T) {
	for message, want := range map[string]string{
		"failed to set up container networking: driver failed programming external connectivity on endpoint gss-x (1079): failed to bind host port 0.0.0.0:25751/tcp: address already in use": "tcp 25751",
		"failed to bind host port [::]:27015/udp: address already in use":                                                                                       "udp 27015",
		"driver failed programming external connectivity on endpoint x: Bind for 0.0.0.0:27015 failed: port is already allocated":                               " 27015",
		"driver failed programming external connectivity on endpoint x: Error starting userland proxy: listen udp4 0.0.0.0:27016: bind: address already in use": "udp 27016",
		"No such image: foo": "none",
	} {
		proto, port, ok := PortInUse(fmt.Errorf("start: %w", &APIError{Method: "POST", Path: "/start", Status: 500, Message: message}))
		got := "none"
		if ok {
			got = fmt.Sprintf("%s %d", proto, port)
		}
		if got != want {
			t.Errorf("%q: got %q, want %q", message, got, want)
		}
	}
}
