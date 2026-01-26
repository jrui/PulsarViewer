package store

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

type Message struct {
	ID          string            `json:"id"`
	PublishTime int64             `json:"publishTime"`
	EventTime   int64             `json:"eventTime"`
	Properties  map[string]string `json:"properties,omitempty"`
	Key         string            `json:"key,omitempty"`
	Payload     string            `json:"payload"`
	JSON        interface{}       `json:"json,omitempty"`
}

// MessageStore stores messages with a size-based limit (1 GB)
type MessageStore struct {
	messages      []*Message
	currentSizeGB int64 // Current size in bytes
	maxSizeGB     int64 // Max size in bytes (1 GB = 1073741824)
	mu            sync.RWMutex
	isBuffering   bool
	bufferingMu   sync.RWMutex
	isFull        bool // Flag to indicate when 1GB is reached
}

func NewMessageStore(maxSizeGB int64) *MessageStore {
	return &MessageStore{
		messages:  make([]*Message, 0, 10000),
		maxSizeGB: maxSizeGB, // Pass in bytes (e.g., 1073741824 for 1GB)
	}
}

// messageSize calculates the approximate size of a message in bytes
func messageSize(msg *Message) int64 {
	size := int64(0)
	size += int64(len(msg.ID))
	size += int64(len(msg.Key))
	size += int64(len(msg.Payload))

	for k, v := range msg.Properties {
		size += int64(len(k) + len(v))
	}

	if msg.JSON != nil {
		if jsonBytes, err := json.Marshal(msg.JSON); err == nil {
			size += int64(len(jsonBytes))
		}
	}

	// Add overhead for metadata
	size += 64
	return size
}

func (ms *MessageStore) Add(msg *Message) bool {
	ms.mu.Lock()
	defer ms.mu.Unlock()

	// If already full, don't add more
	if ms.isFull {
		return false
	}

	msgSize := messageSize(msg)
	ms.messages = append(ms.messages, msg)
	ms.currentSizeGB += msgSize

	// Remove oldest messages if exceeding max size
	for ms.currentSizeGB > ms.maxSizeGB && len(ms.messages) > 0 {
		removedSize := messageSize(ms.messages[0])
		ms.messages = ms.messages[1:]
		ms.currentSizeGB -= removedSize
	}

	// Mark as full when we hit the limit
	if ms.currentSizeGB >= ms.maxSizeGB {
		ms.isFull = true
		return false
	}

	return true
}

func (ms *MessageStore) IsFull() bool {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	return ms.isFull
}

func (ms *MessageStore) GetAll() []*Message {
	ms.mu.RLock()
	defer ms.mu.RUnlock()

	result := make([]*Message, len(ms.messages))
	copy(result, ms.messages)
	return result
}

func (ms *MessageStore) GetPage(page, pageSize int) ([]*Message, int) {
	ms.mu.RLock()
	defer ms.mu.RUnlock()

	total := len(ms.messages)
	start := page * pageSize
	end := start + pageSize

	if start >= total {
		return []*Message{}, total
	}

	if end > total {
		end = total
	}

	result := make([]*Message, end-start)
	copy(result, ms.messages[start:end])
	return result, total
}

func (ms *MessageStore) Count() int {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	return len(ms.messages)
}

func (ms *MessageStore) Clear() {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	ms.messages = make([]*Message, 0, 10000)
	ms.currentSizeGB = 0
	ms.isFull = false
}

func (ms *MessageStore) GetSizeGB() float64 {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	return float64(ms.currentSizeGB) / (1024.0 * 1024.0 * 1024.0)
}

func (ms *MessageStore) GetSizeBytes() int64 {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	return ms.currentSizeGB
}

func (ms *MessageStore) SetBuffering(buffering bool) {
	ms.bufferingMu.Lock()
	defer ms.bufferingMu.Unlock()
	ms.isBuffering = buffering
}

func (ms *MessageStore) IsBuffering() bool {
	ms.bufferingMu.RLock()
	defer ms.bufferingMu.RUnlock()
	return ms.isBuffering
}

func (ms *MessageStore) Search(query string, isRegex bool) []*Message {
	ms.mu.RLock()
	defer ms.mu.RUnlock()

	var matches []*Message

	for _, msg := range ms.messages {
		if ms.messageMatches(msg, query, isRegex) {
			matches = append(matches, msg)
		}
	}

	return matches
}

func (ms *MessageStore) messageMatches(msg *Message, query string, isRegex bool) bool {
	if isRegex {
		re, err := regexp.Compile(query)
		if err != nil {
			return false
		}
		if re.MatchString(msg.Payload) || re.MatchString(msg.Key) || re.MatchString(msg.ID) || re.MatchString(fmt.Sprint(msg.PublishTime)) || re.MatchString(fmt.Sprint(msg.EventTime)) {
			return true
		}
		for _, v := range msg.Properties {
			if re.MatchString(v) {
				return true
			}
		}
		return false
	}

	// Case-insensitive substring search
	lowerQuery := strings.ToLower(query)
	if strings.Contains(strings.ToLower(msg.Payload), lowerQuery) ||
		strings.Contains(strings.ToLower(msg.Key), lowerQuery) ||
		strings.Contains(strings.ToLower(msg.ID), lowerQuery) ||
		strings.Contains(strings.ToLower(fmt.Sprint(msg.PublishTime)), lowerQuery) ||
		strings.Contains(strings.ToLower(fmt.Sprint(msg.EventTime)), lowerQuery) {
		return true
	}
	for _, v := range msg.Properties {
		if strings.Contains(strings.ToLower(v), lowerQuery) {
			return true
		}
	}
	return false
}
