package supervisor

import (
	"fmt"
	"os"
	"path/filepath"
)

// maxSocketPath is the usable length of sockaddr_un.sun_path on Linux (108 bytes including the terminating NUL).
const maxSocketPath = 107

// socketAddress returns an address connect() accepts for path: path itself when it fits, otherwise
// /proc/self/fd/<fd>/<name> through an open descriptor of its folder. release closes that descriptor once the
// connection is made.
func socketAddress(path string) (string, func(), error) {
	if len(path) <= maxSocketPath {
		return path, func() {}, nil
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return "", nil, err
	}
	address := fmt.Sprintf("/proc/self/fd/%d/%s", dir.Fd(), filepath.Base(path))
	if len(address) > maxSocketPath {
		dir.Close()
		return "", nil, fmt.Errorf("socket name %q is too long for a unix socket address", filepath.Base(path))
	}
	return address, func() { dir.Close() }, nil
}
