package hostfacts

import (
	"bufio"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// maxBoundPorts caps each list in BoundPorts (the schema's limit).
const maxBoundPorts = 4096

// Socket states in /proc/net/{tcp,udp}: TCP_LISTEN, and TCP_CLOSE for a UDP socket that is bound but not connected.
const (
	stateListen = "0A"
	stateClose  = "07"
)

// readBoundPorts lists the ports bound in the agent's network namespace (the host's): listening TCP sockets and
// unconnected UDP sockets, IPv4 and IPv6. Connected sockets (outgoing connections, a DNS client's ephemeral port)
// are left out. nil when none of the files can be read.
func readBoundPorts() *protocol.BoundPorts {
	tcp, tcpOK := readSockets([]string{"/proc/net/tcp", "/proc/net/tcp6"}, stateListen)
	udp, udpOK := readSockets([]string{"/proc/net/udp", "/proc/net/udp6"}, stateClose)
	if !tcpOK && !udpOK {
		return nil
	}
	return &protocol.BoundPorts{TCP: tcp, UDP: udp}
}

// readSockets returns the sorted, unique local ports of the sockets in state, and whether any file was readable.
//
// Example line (/proc/net/tcp; local and remote address as hex ip:port, then the state):
//
//	0: 00000000:6497 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9719666 1 ...
func readSockets(files []string, state string) ([]int64, bool) {
	seen := map[int64]bool{}
	readable := false
	for _, name := range files {
		file, err := os.Open(name)
		if err != nil {
			continue
		}
		readable = true
		scanner := bufio.NewScanner(file)
		scanner.Scan() // Header.
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) < 4 || fields[3] != state {
				continue
			}
			if state == stateClose && !unconnected(fields[2]) {
				continue
			}
			colon := strings.LastIndexByte(fields[1], ':')
			if colon < 0 {
				continue
			}
			port, err := strconv.ParseInt(fields[1][colon+1:], 16, 32)
			if err == nil && port > 0 {
				seen[port] = true
			}
		}
		file.Close()
	}
	ports := make([]int64, 0, len(seen))
	for port := range seen {
		ports = append(ports, port)
	}
	sort.Slice(ports, func(i, j int) bool { return ports[i] < ports[j] })
	if len(ports) > maxBoundPorts {
		ports = ports[:maxBoundPorts]
	}
	return ports, readable
}

// unconnected reports whether a remote address (hex ip:port) is all zeros.
func unconnected(remote string) bool {
	return strings.Trim(remote, "0:") == ""
}
