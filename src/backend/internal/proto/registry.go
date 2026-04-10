package proto

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/golang/protobuf/jsonpb"
	"github.com/jhump/protoreflect/desc"
	"github.com/jhump/protoreflect/desc/protoparse"
	"github.com/jhump/protoreflect/dynamic"
)

type Registry struct {
	mu          sync.RWMutex
	fileDesc    *desc.FileDescriptor
	messageDesc *desc.MessageDescriptor
	msgTypeName string
	protoSource string
}

func NewRegistry() *Registry {
	return &Registry{}
}

type RegisterResult struct {
	MessageTypes []string `json:"messageTypes"`
	Selected     string   `json:"selected,omitempty"`
}

// Register parses a .proto source string and optionally selects a message type.
// If msgType is empty and only one message exists, it is auto-selected.
func (r *Registry) Register(protoSource, msgType string) (*RegisterResult, error) {
	parser := protoparse.Parser{
		Accessor: protoparse.FileContentsFromMap(map[string]string{
			"input.proto": protoSource,
		}),
	}

	fds, err := parser.ParseFiles("input.proto")
	if err != nil {
		return nil, fmt.Errorf("failed to parse proto: %w", err)
	}
	if len(fds) == 0 {
		return nil, fmt.Errorf("no file descriptors produced")
	}

	fd := fds[0]
	msgDescs := fd.GetMessageTypes()
	if len(msgDescs) == 0 {
		return nil, fmt.Errorf("no message types found in proto definition")
	}

	names := make([]string, 0, len(msgDescs))
	for _, md := range msgDescs {
		names = append(names, md.GetFullyQualifiedName())
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	r.fileDesc = fd
	r.protoSource = protoSource

	result := &RegisterResult{MessageTypes: names}

	if msgType != "" {
		md := fd.FindSymbol(msgType)
		if md == nil {
			return nil, fmt.Errorf("message type %q not found; available: %s", msgType, strings.Join(names, ", "))
		}
		msgDesc, ok := md.(*desc.MessageDescriptor)
		if !ok {
			return nil, fmt.Errorf("%q is not a message type", msgType)
		}
		r.messageDesc = msgDesc
		r.msgTypeName = msgType
		result.Selected = msgType
	} else if len(msgDescs) == 1 {
		r.messageDesc = msgDescs[0]
		r.msgTypeName = msgDescs[0].GetFullyQualifiedName()
		result.Selected = r.msgTypeName
	}

	return result, nil
}

// SelectMessageType picks a message type from an already-registered schema.
func (r *Registry) SelectMessageType(msgType string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.fileDesc == nil {
		return fmt.Errorf("no proto schema registered")
	}

	md := r.fileDesc.FindSymbol(msgType)
	if md == nil {
		return fmt.Errorf("message type %q not found", msgType)
	}
	msgDesc, ok := md.(*desc.MessageDescriptor)
	if !ok {
		return fmt.Errorf("%q is not a message type", msgType)
	}
	r.messageDesc = msgDesc
	r.msgTypeName = msgType
	return nil
}

// Decode takes raw protobuf bytes and returns a JSON string.
func (r *Registry) Decode(raw []byte) (string, error) {
	r.mu.RLock()
	md := r.messageDesc
	r.mu.RUnlock()

	if md == nil {
		return "", fmt.Errorf("no message type selected")
	}

	msg := dynamic.NewMessage(md)
	if err := msg.Unmarshal(raw); err != nil {
		return "", fmt.Errorf("protobuf decode failed: %w", err)
	}

	jsonBytes, err := msg.MarshalJSONPB(&jsonpb.Marshaler{})
	if err != nil {
		return "", fmt.Errorf("json marshal failed: %w", err)
	}

	return string(jsonBytes), nil
}

// DecodeBase64 decodes a base64-encoded protobuf payload to JSON.
func (r *Registry) DecodeBase64(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(b64)
		if err != nil {
			return "", fmt.Errorf("invalid base64: %w", err)
		}
	}
	return r.Decode(raw)
}

// Encode takes a JSON string and returns protobuf bytes.
func (r *Registry) Encode(jsonStr string) ([]byte, error) {
	r.mu.RLock()
	md := r.messageDesc
	r.mu.RUnlock()

	if md == nil {
		return nil, fmt.Errorf("no message type selected")
	}

	msg := dynamic.NewMessage(md)
	if err := msg.UnmarshalJSONPB(&jsonpb.Unmarshaler{AllowUnknownFields: true}, []byte(jsonStr)); err != nil {
		return nil, fmt.Errorf("json to protobuf failed: %w", err)
	}

	raw, err := msg.Marshal()
	if err != nil {
		return nil, fmt.Errorf("protobuf encode failed: %w", err)
	}
	return raw, nil
}

// TryDecode attempts to decode raw bytes as protobuf. Returns the JSON string
// and true on success, or ("", false) if no schema is active or decode fails.
func (r *Registry) TryDecode(raw []byte) (string, bool) {
	r.mu.RLock()
	md := r.messageDesc
	r.mu.RUnlock()

	if md == nil {
		return "", false
	}

	msg := dynamic.NewMessage(md)
	if err := msg.Unmarshal(raw); err != nil {
		return "", false
	}

	jsonBytes, err := msg.MarshalJSONPB(&jsonpb.Marshaler{})
	if err != nil {
		return "", false
	}
	return string(jsonBytes), true
}

func (r *Registry) IsActive() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.messageDesc != nil
}

func (r *Registry) ActiveType() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.msgTypeName
}

// GetSchema returns the currently registered proto source and selected type.
func (r *Registry) GetSchema() (source string, msgType string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.protoSource, r.msgTypeName
}

// Clear removes the registered schema.
func (r *Registry) Clear() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fileDesc = nil
	r.messageDesc = nil
	r.msgTypeName = ""
	r.protoSource = ""
}

// GetMessageTypes returns all top-level message types from the registered schema.
func (r *Registry) GetMessageTypes() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if r.fileDesc == nil {
		return nil
	}

	msgDescs := r.fileDesc.GetMessageTypes()
	names := make([]string, 0, len(msgDescs))
	for _, md := range msgDescs {
		names = append(names, md.GetFullyQualifiedName())
	}
	return names
}

// DescribeFields returns a JSON-friendly description of the selected message's fields.
func (r *Registry) DescribeFields() ([]map[string]interface{}, error) {
	r.mu.RLock()
	md := r.messageDesc
	r.mu.RUnlock()

	if md == nil {
		return nil, fmt.Errorf("no message type selected")
	}

	fields := md.GetFields()
	result := make([]map[string]interface{}, 0, len(fields))
	for _, f := range fields {
		info := map[string]interface{}{
			"name":     f.GetName(),
			"number":   f.GetNumber(),
			"type":     f.GetType().String(),
			"repeated": f.IsRepeated(),
			"optional": f.IsProto3Optional(),
		}
		if f.GetType().String() == "TYPE_MESSAGE" || f.GetType().String() == "TYPE_ENUM" {
			if mt := f.GetMessageType(); mt != nil {
				info["messageType"] = mt.GetFullyQualifiedName()
			}
			if et := f.GetEnumType(); et != nil {
				info["enumType"] = et.GetFullyQualifiedName()
				vals := et.GetValues()
				enumVals := make([]string, 0, len(vals))
				for _, v := range vals {
					enumVals = append(enumVals, v.GetName())
				}
				info["enumValues"] = enumVals
			}
		}
		result = append(result, info)
	}
	return result, nil
}

// GenerateTemplate produces a sample JSON payload for the selected message type.
func (r *Registry) GenerateTemplate() (string, error) {
	r.mu.RLock()
	md := r.messageDesc
	r.mu.RUnlock()

	if md == nil {
		return "", fmt.Errorf("no message type selected")
	}

	template := generateDefaultJSON(md, 0)
	jsonBytes, err := json.MarshalIndent(template, "", "  ")
	if err != nil {
		return "", err
	}
	return string(jsonBytes), nil
}

func generateDefaultJSON(md *desc.MessageDescriptor, depth int) map[string]interface{} {
	if depth > 5 {
		return map[string]interface{}{}
	}

	result := make(map[string]interface{})
	for _, f := range md.GetFields() {
		name := f.GetJSONName()
		if name == "" {
			name = f.GetName()
		}

		var val interface{}
		switch f.GetType().String() {
		case "TYPE_STRING":
			val = ""
		case "TYPE_BOOL":
			val = false
		case "TYPE_INT32", "TYPE_INT64", "TYPE_UINT32", "TYPE_UINT64",
			"TYPE_SINT32", "TYPE_SINT64", "TYPE_FIXED32", "TYPE_FIXED64",
			"TYPE_SFIXED32", "TYPE_SFIXED64":
			val = 0
		case "TYPE_FLOAT", "TYPE_DOUBLE":
			val = 0.0
		case "TYPE_BYTES":
			val = ""
		case "TYPE_ENUM":
			if et := f.GetEnumType(); et != nil {
				vals := et.GetValues()
				if len(vals) > 0 {
					val = vals[0].GetName()
				}
			}
		case "TYPE_MESSAGE":
			if mt := f.GetMessageType(); mt != nil {
				val = generateDefaultJSON(mt, depth+1)
			}
		default:
			val = nil
		}

		if f.IsRepeated() {
			if val != nil {
				val = []interface{}{val}
			} else {
				val = []interface{}{}
			}
		}

		result[name] = val
	}
	return result
}
