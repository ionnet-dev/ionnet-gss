//go:build !linux

package supervisor

// socketAddress returns path unchanged; only Linux hosts run game servers.
func socketAddress(path string) (string, func(), error) {
	return path, func() {}, nil
}
