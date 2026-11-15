package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

func (c *unixClient) ContainerLogs(ctx context.Context, name string, tail, maxBytes int) (string, error) {
	query := url.Values{"stdout": {"1"}, "stderr": {"1"}, "tail": {strconv.Itoa(tail)}}
	res, err := c.send(ctx, http.MethodGet, "/containers/"+name+"/logs", query, nil, "")
	if err != nil {
		return "", fmt.Errorf("logs of container %s: %w", name, err)
	}
	defer res.Body.Close()
	out, err := demuxLogs(res.Body, maxBytes)
	if err != nil {
		return "", fmt.Errorf("logs of container %s: %w", name, err)
	}
	return out, nil
}

// demuxLogs joins the payloads of Docker's multiplexed log stream (non-TTY containers): frames of an 8-byte header
// (stream type, 3 zero bytes, big-endian uint32 length) and the payload. At most maxBytes are kept.
func demuxLogs(r io.Reader, maxBytes int) (string, error) {
	var out bytes.Buffer
	header := make([]byte, 8)
	for {
		if _, err := io.ReadFull(r, header); err != nil {
			if errors.Is(err, io.EOF) {
				return out.String(), nil
			}
			return out.String(), err
		}
		size := int64(binary.BigEndian.Uint32(header[4:]))
		keep := min(size, int64(max(maxBytes-out.Len(), 0)))
		if _, err := io.CopyN(&out, r, keep); err != nil {
			return out.String(), err
		}
		if _, err := io.CopyN(io.Discard, r, size-keep); err != nil {
			return out.String(), err
		}
	}
}
