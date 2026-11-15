package docker

import (
	"errors"
	"regexp"
	"strconv"
)

// Docker's answers when a published host port is taken, by version:
//
//	failed to bind host port 0.0.0.0:25751/tcp: address already in use        (28+)
//	Bind for 0.0.0.0:27015 failed: port is already allocated                  (another container holds it)
//	Error starting userland proxy: listen udp4 0.0.0.0:27015: bind: address already in use
var (
	bindHostPort  = regexp.MustCompile(`failed to bind host port (?:\[[0-9a-fA-F:.]*\]|[0-9.]*):(\d{1,5})/(tcp|udp|sctp)`)
	bindAllocated = regexp.MustCompile(`Bind for (?:\[[0-9a-fA-F:.]*\]|[0-9.]*):(\d{1,5}) failed: port is already allocated`)
	bindProxy     = regexp.MustCompile(`listen (tcp|udp)[46]? (?:\[[0-9a-fA-F:.]*\]|[0-9.]*):(\d{1,5}): bind: address already in use`)
)

// PortInUse reports whether err is Docker refusing to publish a host port because something already holds it, and
// which one. proto is empty when Docker didn't say (the caller knows which protocols the port was published for).
func PortInUse(err error) (proto string, port int, ok bool) {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return "", 0, false
	}
	message := apiErr.Message
	if m := bindHostPort.FindStringSubmatch(message); m != nil {
		port, _ = strconv.Atoi(m[1])
		return m[2], port, port > 0
	}
	if m := bindProxy.FindStringSubmatch(message); m != nil {
		port, _ = strconv.Atoi(m[2])
		return m[1], port, port > 0
	}
	if m := bindAllocated.FindStringSubmatch(message); m != nil {
		port, _ = strconv.Atoi(m[1])
		return "", port, port > 0
	}
	return "", 0, false
}
