package pulsar

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/apache/pulsar-client-go/pulsar"
)

type ClientManager struct {
	clients map[string]pulsar.Client
	mu      sync.RWMutex
}

func NewClientManager() *ClientManager {
	return &ClientManager{
		clients: make(map[string]pulsar.Client),
	}
}

func (cm *ClientManager) GetOrCreateClient(serviceURL, token string) (pulsar.Client, error) {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	key := serviceURL + "\x00" + token
	if client, ok := cm.clients[key]; ok {
		return client, nil
	}

	opts := pulsar.ClientOptions{URL: serviceURL}
	if token != "" {
		opts.Authentication = pulsar.NewAuthenticationToken(token)
	}

	client, err := pulsar.NewClient(opts)

	if err != nil {
		return nil, fmt.Errorf("failed to create Pulsar client: %w", err)
	}

	cm.clients[key] = client
	log.Printf("Created Pulsar client for %s", serviceURL)
	return client, nil
}

func (cm *ClientManager) Close() {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	for _, client := range cm.clients {
		client.Close()
	}
	cm.clients = make(map[string]pulsar.Client)
}

type ConsumerConfig struct {
	ServiceURL       string
	Token            string
	Topic            string
	Subscription     string
	SubscriptionType string
	InitialPosition  string
}

type Message struct {
	ID          string            `json:"id"`
	PublishTime int64             `json:"publishTime"`
	EventTime   int64             `json:"eventTime"`
	Properties  map[string]string `json:"properties,omitempty"`
	Key         string            `json:"key,omitempty"`
	Payload     string            `json:"payload"`
	RawPayload  []byte            `json:"-"`
	JSON        interface{}       `json:"json,omitempty"`
}

func (cm *ClientManager) StreamMessages(ctx context.Context, config ConsumerConfig) (<-chan *Message, error) {
	client, err := cm.GetOrCreateClient(config.ServiceURL, config.Token)
	if err != nil {
		return nil, err
	}

	consumer, err := client.Subscribe(pulsar.ConsumerOptions{
		Topics:                      []string{config.Topic},
		SubscriptionName:            config.Subscription,
		Type:                        parseSubscriptionType(config.SubscriptionType),
		SubscriptionInitialPosition: parseInitialPosition(config.InitialPosition),
		SubscriptionMode:            pulsar.NonDurable,
	})

	if err != nil {
		return nil, fmt.Errorf("failed to create consumer: %w", err)
	}

	messageChan := make(chan *Message, 100)

	go func() {
		defer close(messageChan)
		defer consumer.Close()

		retryCount := 0
		maxRetries := 10

		for {
			select {
			case <-ctx.Done():
				return
			default:
				pulsarMsg, err := consumer.Receive(ctx)
				if err != nil {
					if ctx.Err() != nil {
						return
					}
					// Error receiving message - retry with backoff
					retryCount++
					if retryCount > maxRetries {
						log.Printf("Max retries exceeded, stopping consumer: %v", err)
						return
					}
					backoff := time.Duration(retryCount) * time.Second
					log.Printf("Error receiving message (retry %d/%d, backoff %v): %v", retryCount, maxRetries, backoff, err)

					select {
					case <-time.After(backoff):
						// Continue to next iteration
					case <-ctx.Done():
						return
					}
					continue
				}

				// Reset retry count on successful message
				retryCount = 0

				rawPayload := pulsarMsg.Payload()
			rawCopy := make([]byte, len(rawPayload))
			copy(rawCopy, rawPayload)

			msg := &Message{
					ID:          pulsarMsg.ID().String(),
					PublishTime: pulsarMsg.PublishTime().UnixMilli(),
					EventTime:   pulsarMsg.EventTime().UnixMilli(),
					Properties:  pulsarMsg.Properties(),
					Key:         pulsarMsg.Key(),
					Payload:     string(rawPayload),
					RawPayload:  rawCopy,
				}

				// Try to parse payload as JSON
				var jsonPayload interface{}
				if err := json.Unmarshal(pulsarMsg.Payload(), &jsonPayload); err == nil {
					msg.JSON = jsonPayload
				}

				consumer.Ack(pulsarMsg)

				select {
				case messageChan <- msg:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	return messageChan, nil
}

func parseSubscriptionType(t string) pulsar.SubscriptionType {
	switch t {
	case "Shared":
		return pulsar.Shared
	case "Failover":
		return pulsar.Failover
	case "KeyShared":
		return pulsar.KeyShared
	default:
		return pulsar.Exclusive
	}
}

func parseInitialPosition(p string) pulsar.SubscriptionInitialPosition {
	switch p {
	case "earliest":
		return pulsar.SubscriptionPositionEarliest
	default:
		return pulsar.SubscriptionPositionLatest
	}
}
