//go:build !linux

package files

// freeBytes is unknown off Linux (development builds only): the free-disk check is skipped.
func freeBytes(dir string) (free int64, ok bool) {
	return 0, false
}
