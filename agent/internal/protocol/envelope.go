package protocol

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Hand-written helpers around the generated Envelope. Shared by the panel connection (WebSocket text frames) and
// the supervisor socket (newline-delimited JSON).

// NewRequest builds a request envelope.
func NewRequest(id, msgType string, data any) (Envelope, error) {
	raw, err := Marshal(data)
	if err != nil {
		return Envelope{}, fmt.Errorf("encode %s request: %w", msgType, err)
	}
	return Envelope{Kind: MessageKindRequest, ID: id, Type: msgType, Data: raw}, nil
}

// NewEvent builds an event envelope.
func NewEvent(msgType string, data any) (Envelope, error) {
	raw, err := Marshal(data)
	if err != nil {
		return Envelope{}, fmt.Errorf("encode %s event: %w", msgType, err)
	}
	return Envelope{Kind: MessageKindEvent, Type: msgType, Data: raw}, nil
}

// NewResponse builds a successful response to req.
func NewResponse(req Envelope, data any) (Envelope, error) {
	raw, err := Marshal(data)
	if err != nil {
		return Envelope{}, fmt.Errorf("encode %s response: %w", req.Type, err)
	}
	return Envelope{Kind: MessageKindResponse, ID: req.ID, Type: req.Type, Ok: true, Data: raw}, nil
}

// NewErrorResponse builds a failed response to req.
func NewErrorResponse(req Envelope, code ErrorCode, message string) Envelope {
	return Envelope{Kind: MessageKindResponse, ID: req.ID, Type: req.Type, Ok: false, Error: &ErrorBody{Code: code, Message: message}}
}

// DecodeData unmarshals an envelope's data into T.
func DecodeData[T any](env Envelope) (T, error) {
	var out T
	if len(env.Data) == 0 {
		return out, fmt.Errorf("%s %s has no data", env.Kind, env.Type)
	}
	if err := json.Unmarshal(env.Data, &out); err != nil {
		return out, fmt.Errorf("decode %s %s: %w", env.Kind, env.Type, err)
	}
	return out, nil
}

// RemoteError is a failed response from the other side.
type RemoteError struct {
	Code    ErrorCode
	Message string
}

func (e *RemoteError) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// ErrorFromResponse returns the response's error, or nil when it succeeded.
func ErrorFromResponse(env Envelope) error {
	if env.Ok {
		return nil
	}
	if env.Error == nil {
		return &RemoteError{Code: ErrorCodeInternal, Message: "response failed without an error body"}
	}
	return &RemoteError{Code: env.Error.Code, Message: env.Error.Message}
}

// ErrFrameTooLarge is returned by ReadFrame for a line over the limit.
var ErrFrameTooLarge = errors.New("frame larger than the limit")

// ReadFrame reads one newline-delimited envelope (supervisor socket).
func ReadFrame(r *bufio.Reader) (Envelope, error) {
	var env Envelope
	line, err := r.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return env, ErrFrameTooLarge
	}
	if err != nil {
		return env, err
	}
	if err := json.Unmarshal(line, &env); err != nil {
		return env, fmt.Errorf("decode frame: %w", err)
	}
	return env, nil
}

// NewFrameReader wraps r with a buffer sized for MaxFrameBytes (MAX_FRAME_BYTES, the newline included).
func NewFrameReader(r io.Reader) *bufio.Reader {
	return bufio.NewReaderSize(r, MaxFrameBytes+1)
}

// WriteFrame writes one envelope followed by a newline (supervisor socket).
func WriteFrame(w io.Writer, env Envelope) error {
	raw, err := Marshal(env)
	if err != nil {
		return fmt.Errorf("encode frame: %w", err)
	}
	_, err = w.Write(append(raw, '\n'))
	return err
}
