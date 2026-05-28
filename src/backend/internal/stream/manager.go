package stream

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/jrui/pulsarviewer/internal/proto"
	"github.com/jrui/pulsarviewer/internal/pulsar"
	"github.com/jrui/pulsarviewer/internal/store"
)

// StreamKey uniquely identifies a stream configuration
type StreamKey struct {
	ServiceURL       string
	Topic            string
	Subscription     string
	SubscriptionType string
	InitialPosition  string
	Token            string
}

// StreamManager manages persistent background consumers
type StreamManager struct {
	streams      map[string]*Stream
	mu           sync.RWMutex
	pulsarClient *pulsar.ClientManager
	messageStore *store.MessageStore
	protoRegistry *proto.Registry
}

// Stream represents a single persistent consumer
type Stream struct {
	key        StreamKey
	client     *pulsar.ClientManager
	store      *store.MessageStore
	registry   *proto.Registry
	ctx        context.Context
	cancel     context.CancelFunc
	done       chan struct{}
	retryCount int
	mu         sync.RWMutex
}

func NewStreamManager(pulsarClient *pulsar.ClientManager, messageStore *store.MessageStore, protoRegistry *proto.Registry) *StreamManager {
	return &StreamManager{
		streams:      make(map[string]*Stream),
		pulsarClient: pulsarClient,
		messageStore: messageStore,
		protoRegistry: protoRegistry,
	}
}

func (sm *StreamManager) GetOrCreateStream(key StreamKey) error {
	sm.mu.Lock()
	streamID := fmt.Sprintf("%s|%s|%s", key.ServiceURL, key.Topic, key.Subscription)

	// Check if stream already exists
	if _, exists := sm.streams[streamID]; exists {
		sm.mu.Unlock()
		return nil // Already exists
	}

	ctx, cancel := context.WithCancel(context.Background())
	stream := &Stream{
		key:    key,
		client: sm.pulsarClient,
		store:  sm.messageStore,
		registry: sm.protoRegistry,
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}

	sm.streams[streamID] = stream
	sm.mu.Unlock()

	// Start streaming in a background goroutine
	go stream.run()

	return nil
}

func (s *Stream) run() {
	defer close(s.done)

	for {
		select {
		case <-s.ctx.Done():
			return
		default:
			// Try to establish consumer and stream messages
			s.streamOnce()
		}
	}
}

func (s *Stream) streamOnce() {
	s.mu.Lock()
	retryCount := s.retryCount
	s.mu.Unlock()

	messageChan, err := s.client.StreamMessages(s.ctx, pulsar.ConsumerConfig{
		ServiceURL:       s.key.ServiceURL,
		Topic:            s.key.Topic,
		Subscription:     s.key.Subscription,
		SubscriptionType: s.key.SubscriptionType,
		InitialPosition:  s.key.InitialPosition,
		Token:            s.key.Token,
	})

	if err != nil {
		// If error is fatal (e.g., invalid topic, permissions), do not keep retrying
		if isFatalPulsarError(err) {
			log.Printf("Fatal stream error for %s:%s: %v", s.key.ServiceURL, s.key.Topic, err)
			s.publishSystemError(fmt.Sprintf("Stream failed: %v", err))
			// Cancel the stream to stop run() loop
			s.cancel()
			return
		}

		s.mu.Lock()
		s.retryCount++
		retryCount = s.retryCount
		s.mu.Unlock()

		if retryCount > 10 {
			log.Printf("Stream %s:%s exceeded max retries: %v", s.key.ServiceURL, s.key.Topic, err)
			s.publishSystemError(fmt.Sprintf("Stream exceeded max retries: %v", err))
			// Stop retrying by cancelling context so run() exits
			s.cancel()
			return
		}

		backoff := time.Duration(retryCount) * time.Second
		log.Printf("Stream %s:%s retry %d/10, backoff %v: %v", s.key.ServiceURL, s.key.Topic, retryCount, backoff, err)

		select {
		case <-time.After(backoff):
			// Retry
		case <-s.ctx.Done():
			return
		}
		return
	}

	// Successfully connected, reset retry counter
	s.mu.Lock()
	s.retryCount = 0
	s.mu.Unlock()

	// Process messages until channel closes or store is full
	for msg := range messageChan {
		if msg == nil {
			break
		}

		// Store message globally
		storeMsg := &store.Message{
			ID:          msg.ID,
			PublishTime: msg.PublishTime,
			EventTime:   msg.EventTime,
			Properties:  msg.Properties,
			Key:         msg.Key,
			Payload:     msg.Payload,
			JSON:        msg.JSON,
		}

		// If a proto registry is active, try to decode the payload so stored messages
		// are searchable and have JSON representations.
		if s.registry != nil && s.registry.IsActive() {
			// Try decode from string payload first
			if decoded, ok := s.registry.TryDecode([]byte(msg.Payload)); ok {
				storeMsg.Payload = decoded
				var jp interface{}
				if err := json.Unmarshal([]byte(decoded), &jp); err == nil {
					storeMsg.JSON = jp
				}
				if storeMsg.Properties == nil {
					storeMsg.Properties = make(map[string]string)
				}
				storeMsg.Properties["_pv_proto_decoded"] = "true"
			} else if msg.RawPayload != nil {
				if decoded, ok := s.registry.TryDecode(msg.RawPayload); ok {
					storeMsg.Payload = decoded
					var jp interface{}
					if err := json.Unmarshal([]byte(decoded), &jp); err == nil {
						storeMsg.JSON = jp
					}
					if storeMsg.Properties == nil {
						storeMsg.Properties = make(map[string]string)
					}
					storeMsg.Properties["_pv_proto_decoded"] = "true"
				}
			}
		}

		// Try to add message, if store is full, stop consuming
		if !s.store.Add(storeMsg) {
			// Store is full (reached 1 GB), close the stream
			log.Printf("Message store full (1 GB reached) for %s:%s, closing consumer", s.key.ServiceURL, s.key.Topic)
			s.cancel()
			return
		}
	}

	// Channel closed, will reconnect on next loop iteration
	log.Printf("Message channel closed for %s:%s, reconnecting...", s.key.ServiceURL, s.key.Topic)
}

// isFatalPulsarError attempts to determine if the error indicates a non-retryable condition
// such as invalid topic name or missing permissions.
func isFatalPulsarError(err error) bool {
	if err == nil {
		return false
	}
	e := strings.ToLower(err.Error())
	fatalHints := []string{
		"invalid topic name",
		"topic does not exist",
		"not found",
		"does not exist",
		"unauthorized",
		"authorization",
		"permission",
	}
	for _, hint := range fatalHints {
		if strings.Contains(e, hint) {
			return true
		}
	}
	return false
}

// publishSystemError pushes a synthetic system message to the global store so the frontend
// can surface the failure cause even when no Pulsar messages are streaming.
func (s *Stream) publishSystemError(msg string) {
	if s.store == nil {
		return
	}
	now := time.Now().UnixMilli()
	sys := &store.Message{
		ID:          fmt.Sprintf("system-%d", now),
		PublishTime: now,
		EventTime:   now,
		Properties: map[string]string{
			"type":         "system",
			"level":        "error",
			"serviceUrl":   s.key.ServiceURL,
			"topic":        s.key.Topic,
			"subscription": s.key.Subscription,
		},
		Key:     "system",
		Payload: msg,
	}
	_ = s.store.Add(sys)
}

func (sm *StreamManager) Close() {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	for _, stream := range sm.streams {
		stream.cancel()
		<-stream.done // Wait for goroutine to finish
	}
	sm.streams = make(map[string]*Stream)
}
