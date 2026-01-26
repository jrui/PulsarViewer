package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	pulsarclient "github.com/apache/pulsar-client-go/pulsar"
	"github.com/gorilla/websocket"
	"github.com/jrui/pulsarviewer/internal/pulsar"
	"github.com/jrui/pulsarviewer/internal/store"
	"github.com/jrui/pulsarviewer/internal/stream"
)

type HTTPHandler struct {
	pulsarClient  *pulsar.ClientManager
	messageStore  *store.MessageStore
	streamManager *stream.StreamManager
	upgrader      websocket.Upgrader
	connections   map[string]*ConnectionState
	mu            sync.RWMutex
}

type ConnectionState struct {
	ID       string
	Cancel   context.CancelFunc
	Store    *store.MessageStore
	Created  time.Time
	LastSeen time.Time
}

func NewHTTPHandler(pulsarClient *pulsar.ClientManager, messageStore *store.MessageStore) http.Handler {
	mux := http.NewServeMux()
	handler := &HTTPHandler{
		pulsarClient:  pulsarClient,
		messageStore:  messageStore,
		streamManager: stream.NewStreamManager(pulsarClient, messageStore),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins in development
			},
		},
		connections: make(map[string]*ConnectionState),
	}

	// Determine the public directory path
	// The backend can be run from:
	// 1. Development: src/backend directory (cd src/backend && go run ./cmd/main.go)
	// 2. Tauri bundle: Inside Resources/_up_/src/backend/ (as bundled binary)
	// 3. CLI binary: Same directory as binary
	var publicDir string

	// Get the directory of the running binary
	exePath, _ := os.Executable()
	exeDir := filepath.Dir(exePath)

	// Try multiple paths to find the public directory
	possiblePaths := []string{
		// From development in src/backend
		"./public", // src/backend/public
		// From Tauri macOS bundle structure
		// The app structure is: PulsarViewer.app/Contents/Resources/_up_/src/backend/pulsarviewer-backend (binary)
		// Public files are at: PulsarViewer.app/Contents/Resources/_up_/public/
		filepath.Join(exeDir, "../../public"),
		filepath.Join(exeDir, "../../../public"),
		filepath.Join(exeDir, "../../../../public"),
		// Alternative paths if structure is different
		filepath.Join(exeDir, "../Resources/_up_/public"),
		filepath.Join(exeDir, "../../Resources/_up_/public"),
	}

	fmt.Printf("[Server] Executable path: %s\n", exePath)
	fmt.Printf("[Server] Executable dir: %s\n", exeDir)

	for _, path := range possiblePaths {
		absPath, _ := filepath.Abs(path)
		fmt.Printf("[Server] Trying public directory: %s\n", absPath)
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			publicDir, _ = filepath.Abs(path)
			fmt.Printf("[Server] ✓ Found public directory at: %s\n", publicDir)
			break
		}
	}

	if publicDir == "" {
		// Fallback to current directory's public
		publicDir = "public"
		fmt.Printf("[Server] WARNING: Using fallback public directory: %s\n", publicDir)
	}

	// Serve static files (React frontend)
	mux.Handle("/", http.FileServer(http.Dir(publicDir)))

	// REST API endpoints
	mux.HandleFunc("/api/messages", handler.handleGetMessages)
	mux.HandleFunc("/api/search", handler.handleSearch)
	mux.HandleFunc("/api/stats", handler.handleGetStats)
	mux.HandleFunc("/api/send", handler.handleSendMessage)
	mux.HandleFunc("/api/clear", handler.handleClearMessages)

	// WebSocket endpoint for streaming
	mux.HandleFunc("/api/stream", handler.handleStream)

	// Health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	return mux
}

func (h *HTTPHandler) handleGetMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))

	if pageSize == 0 {
		pageSize = 50
	}

	messages, total := h.messageStore.GetPage(page, pageSize)

	// Ensure messages is never nil in JSON (use empty array instead)
	if messages == nil {
		messages = []*store.Message{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"messages":            messages,
		"page":                page,
		"pageSize":            pageSize,
		"currentPageMessages": len(messages),
		"totalMessages":       total,
		"totalPages":          (total + pageSize - 1) / pageSize,
	})
}

func (h *HTTPHandler) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		http.Error(w, "Missing search query", http.StatusBadRequest)
		return
	}

	isRegex := r.URL.Query().Get("regex") == "true"
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if pageSize == 0 {
		pageSize = 50
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 0 {
		page = 0
	}

	// Search all messages
	allMatches := h.messageStore.Search(query, isRegex)
	total := len(allMatches)

	// Paginate results
	start := page * pageSize
	end := start + pageSize
	if end > total {
		end = total
	}

	var pageMessages []*store.Message
	if start < total {
		pageMessages = allMatches[start:end]
	}

	// Ensure pageMessages is never nil in JSON (use empty array instead)
	if pageMessages == nil {
		pageMessages = []*store.Message{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"messages":            pageMessages,
		"page":                page,
		"pageSize":            pageSize,
		"currentPageMessages": len(pageMessages),
		"totalMessages":       total,
		"totalPages":          (total + pageSize - 1) / pageSize,
		"searchQuery":         query,
		"isRegex":             isRegex,
	})
}

func (h *HTTPHandler) handleGetStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	count := h.messageStore.Count()
	isBuffering := h.messageStore.IsBuffering()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"totalMessages": count,
		"isBuffering":   isBuffering,
		"connections":   len(h.connections),
		"timestamp":     time.Now().Unix(),
	})
}

func (h *HTTPHandler) handleSendMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		ServiceURL string `json:"serviceUrl"`
		Topic      string `json:"topic"`
		Payload    string `json:"payload"`
		Key        string `json:"key,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	if req.ServiceURL == "" || req.Topic == "" || req.Payload == "" {
		http.Error(w, "Missing required fields", http.StatusBadRequest)
		return
	}

	client, err := h.pulsarClient.GetOrCreateClient(req.ServiceURL, "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	producer, err := client.CreateProducer(pulsarclient.ProducerOptions{
		Topic:                   req.Topic,
		SendTimeout:             30 * time.Second,
		DisableBatching:         false,
		BatchingMaxPublishDelay: 1 * time.Millisecond,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer producer.Close()

	msgID, err := producer.Send(context.Background(), &pulsarclient.ProducerMessage{
		Payload: []byte(req.Payload),
		Key:     req.Key,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":        true,
		"messageId": msgID.String(),
	})
}

func (h *HTTPHandler) handleClearMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	h.messageStore.Clear()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"message": "Messages cleared",
	})
}

type StreamRequest struct {
	ServiceURL       string `json:"serviceUrl"`
	Topic            string `json:"topic"`
	Subscription     string `json:"subscription"`
	SubscriptionType string `json:"subscriptionType"`
	InitialPosition  string `json:"initialPosition"`
	Token            string `json:"token,omitempty"`
}

type StreamMessage struct {
	Type string      `json:"type"` // "info", "error", "stats", "message"
	Data interface{} `json:"data"`
}

func applyStreamDefaults(req StreamRequest) StreamRequest {
	if req.Subscription == "" {
		req.Subscription = "viewer-sub"
	}
	if req.SubscriptionType == "" {
		req.SubscriptionType = "Exclusive"
	}
	if req.InitialPosition == "" {
		req.InitialPosition = "latest"
	}
	return req
}

func parseStreamRequestFromWebSocket(conn *websocket.Conn) (StreamRequest, error) {
	var req StreamRequest
	if err := conn.ReadJSON(&req); err != nil {
		return req, err
	}
	req = applyStreamDefaults(req)
	if req.ServiceURL == "" || req.Topic == "" {
		return req, fmt.Errorf("missing serviceUrl or topic")
	}
	return req, nil
}

func parseStreamRequestFromHTTP(r *http.Request) (StreamRequest, error) {
	q := r.URL.Query()
	req := StreamRequest{
		ServiceURL:       q.Get("serviceUrl"),
		Topic:            q.Get("topic"),
		Subscription:     q.Get("subscription"),
		SubscriptionType: q.Get("subscriptionType"),
		InitialPosition:  q.Get("initialPosition"),
		Token:            q.Get("token"),
	}

	// If body exists (POST), merge body fields over query defaults
	if r.Method == http.MethodPost {
		var bodyReq StreamRequest
		if err := json.NewDecoder(r.Body).Decode(&bodyReq); err != nil && err != io.EOF {
			return req, err
		}
		if bodyReq.ServiceURL != "" {
			req.ServiceURL = bodyReq.ServiceURL
		}
		if bodyReq.Topic != "" {
			req.Topic = bodyReq.Topic
		}
		if bodyReq.Subscription != "" {
			req.Subscription = bodyReq.Subscription
		}
		if bodyReq.SubscriptionType != "" {
			req.SubscriptionType = bodyReq.SubscriptionType
		}
		if bodyReq.InitialPosition != "" {
			req.InitialPosition = bodyReq.InitialPosition
		}
		if bodyReq.Token != "" {
			req.Token = bodyReq.Token
		}
	}

	req = applyStreamDefaults(req)
	if req.ServiceURL == "" || req.Topic == "" {
		return req, fmt.Errorf("missing serviceUrl or topic")
	}
	return req, nil
}

func (h *HTTPHandler) handleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check if this is a WebSocket upgrade request
	if r.Header.Get("Upgrade") == "websocket" {
		conn, err := h.upgrader.Upgrade(w, r, nil)
		if err != nil {
			http.Error(w, "WebSocket upgrade failed", http.StatusBadRequest)
			return
		}
		defer conn.Close()
		h.handleWebSocketStream(conn, r)
	} else {
		// Handle as SSE/HTTP stream
		h.handleHTTPStream(w, r)
	}
}

func (h *HTTPHandler) handleWebSocketStream(conn *websocket.Conn, r *http.Request) {
	req, err := parseStreamRequestFromWebSocket(conn)
	if err != nil {
		conn.WriteJSON(StreamMessage{Type: "error", Data: err.Error()})
		return
	}

	// Helper to classify fatal errors to avoid endless reconnects
	isFatal := func(e error) bool {
		if e == nil {
			return false
		}
		le := strings.ToLower(e.Error())
		fatalHints := []string{
			"invalid topic name",
			"topic does not exist",
			"not found",
			"does not exist",
			"unauthorized",
			"authorization",
			"permission",
		}
		for _, h := range fatalHints {
			if strings.Contains(le, h) {
				return true
			}
		}
		return false
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Create new message store for this connection
	connStore := store.NewMessageStore(10000)
	connID := time.Now().Format("20060102150405")

	h.mu.Lock()
	h.connections[connID] = &ConnectionState{
		ID:      connID,
		Cancel:  cancel,
		Store:   connStore,
		Created: time.Now(),
	}
	h.mu.Unlock()

	// Enable buffering when connection starts
	h.messageStore.SetBuffering(true)

	defer func() {
		h.mu.Lock()
		delete(h.connections, connID)
		h.mu.Unlock()
	}()

	// Connect to Pulsar
	conn.WriteJSON(StreamMessage{Type: "info", Data: map[string]string{"message": "Connecting to Pulsar...", "connectionId": connID}})

	var messageChan <-chan *pulsar.Message
	reconnectTicker := time.NewTicker(5 * time.Second)
	defer reconnectTicker.Stop()

	// Initial connection
	messageChan, err = h.pulsarClient.StreamMessages(ctx, pulsar.ConsumerConfig{
		ServiceURL:       req.ServiceURL,
		Topic:            req.Topic,
		Subscription:     req.Subscription,
		SubscriptionType: req.SubscriptionType,
		InitialPosition:  req.InitialPosition,
		Token:            req.Token,
	})

	if err != nil {
		conn.WriteJSON(StreamMessage{Type: "error", Data: err.Error()})
		// Stop early on fatal misconfiguration to avoid noisy retries
		if isFatal(err) {
			return
		}
		return
	}

	conn.WriteJSON(StreamMessage{Type: "info", Data: map[string]string{"message": "Connected. Streaming messages."}})

	// Ticker for periodic stats
	statsTicker := time.NewTicker(2 * time.Second)
	defer statsTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case msg, ok := <-messageChan:
			if !ok {
				// Consumer closed - attempt to reconnect
				conn.WriteJSON(StreamMessage{Type: "info", Data: map[string]string{"message": "Consumer disconnected, attempting to reconnect..."}})

				select {
				case <-reconnectTicker.C:
					// Try to reconnect
					newChan, err := h.pulsarClient.StreamMessages(ctx, pulsar.ConsumerConfig{
						ServiceURL:       req.ServiceURL,
						Topic:            req.Topic,
						Subscription:     req.Subscription,
						SubscriptionType: req.SubscriptionType,
						InitialPosition:  req.InitialPosition,
						Token:            req.Token,
					})
					if err != nil {
						conn.WriteJSON(StreamMessage{Type: "error", Data: map[string]string{"message": "Reconnect failed: " + err.Error()}})
						if isFatal(err) {
							// Stop reconnect loop on fatal errors
							conn.WriteJSON(StreamMessage{Type: "info", Data: map[string]string{"message": "Stopping reconnects due to fatal error"}})
							return
						}
					} else {
						messageChan = newChan
						conn.WriteJSON(StreamMessage{Type: "info", Data: map[string]string{"message": "Reconnected successfully"}})
					}
				case <-ctx.Done():
					return
				}
				break
			}
			// Store message but don't send it through WebSocket
			// Pause buffering when first page (100) of messages is reached
			storeMsg := toStoreMessage(msg)
			if storeMsg != nil {
				// Only add to stores if buffering is enabled or we're below threshold
				if h.messageStore.IsBuffering() || h.messageStore.Count() < 100 {
					connStore.Add(storeMsg)
					h.messageStore.Add(storeMsg)
				}
				// Once we reach 100 messages, pause buffering
				if h.messageStore.Count() >= 100 && h.messageStore.IsBuffering() {
					h.messageStore.SetBuffering(false)
				}
			}

		case <-statsTicker.C:
			stats := map[string]interface{}{
				"totalMessages": connStore.Count(),
				"isBuffering":   h.messageStore.IsBuffering(),
				"totalSizeMB":   float64(0),
				"timestamp":     time.Now().Unix(),
			}
			if err := conn.WriteJSON(StreamMessage{Type: "stats", Data: stats}); err != nil {
				return
			}
		}
	}
}

func (h *HTTPHandler) handleHTTPStream(w http.ResponseWriter, r *http.Request) {
	// Parse request first
	req, err := parseStreamRequestFromHTTP(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Ensure we have a persistent stream for this topic
	err = h.streamManager.GetOrCreateStream(stream.StreamKey{
		ServiceURL:       req.ServiceURL,
		Topic:            req.Topic,
		Subscription:     req.Subscription,
		SubscriptionType: req.SubscriptionType,
		InitialPosition:  req.InitialPosition,
		Token:            req.Token,
	})
	if err != nil {
		http.Error(w, "Failed to start stream: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// For HTTP streaming (Server-Sent Events)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// Flush headers immediately
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Server does not support streaming", http.StatusInternalServerError)
		return
	}
	flusher.Flush()

	connID := time.Now().Format("20060102150405")

	// Announce connection ID
	if err := writeSSEEvent(w, "info", map[string]string{
		"message":      "Connected. Streaming messages.",
		"connectionId": connID,
	}); err != nil {
		return
	}

	// Stream from global message store
	lastIndex := 0
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	tickerSwitched := false // Track if we've switched to slower updates

	for {
		select {
		case <-r.Context().Done():
			return

		case <-ticker.C:
			// Send new messages that have arrived
			messages := h.messageStore.GetAll()
			if len(messages) > lastIndex {
				for _, msg := range messages[lastIndex:] {
					if err := writeSSEEvent(w, "message", map[string]interface{}{
						"id":          msg.ID,
						"publishTime": msg.PublishTime,
						"eventTime":   msg.EventTime,
						"properties":  msg.Properties,
						"key":         msg.Key,
						"payload":     msg.Payload,
						"json":        msg.JSON,
					}); err != nil {
						return
					}
				}
				lastIndex = len(messages)
			}

			// Send periodic stats
			messages = h.messageStore.GetAll()
			sizeGB := h.messageStore.GetSizeGB()
			sizeMB := sizeGB * 1024 // Convert GB to MB
			stats := map[string]interface{}{
				"totalMessages": len(messages),
				"isBuffering":   h.messageStore.IsBuffering(),
				"totalSizeMB":   sizeMB,
				"isFull":        h.messageStore.IsFull(),
				"timestamp":     time.Now().Unix(),
			}
			if err := writeSSEEvent(w, "stats", stats); err != nil {
				return
			}

			// Switch to slower updates (5 sec) after initial page fills (100 messages)
			if !tickerSwitched && len(messages) >= 100 {
				ticker.Stop()
				ticker = time.NewTicker(5 * time.Second)
				tickerSwitched = true
			}

			// If store is full, send done event and close
			if h.messageStore.IsFull() {
				_ = writeSSEEvent(w, "done", map[string]string{
					"message": "Storage limit reached (1 GB). Streaming complete.",
				})
				return
			}
		}
	}
}

// toStoreMessage converts a pulsar.Message to the store.Message shape used by buffers.
func toStoreMessage(msg *pulsar.Message) *store.Message {
	if msg == nil {
		return nil
	}
	return &store.Message{
		ID:          msg.ID,
		PublishTime: msg.PublishTime,
		EventTime:   msg.EventTime,
		Properties:  msg.Properties,
		Key:         msg.Key,
		Payload:     msg.Payload,
		JSON:        msg.JSON,
	}
}

// writeSSEEvent writes a Server-Sent Event to the response writer
func writeSSEEvent(w http.ResponseWriter, eventType string, data interface{}) error {
	// Write event type
	if _, err := io.WriteString(w, "event: "+eventType+"\n"); err != nil {
		return err
	}

	// Write data as JSON
	jsonData, err := json.Marshal(data)
	if err != nil {
		return err
	}

	if _, err := io.WriteString(w, "data: "+string(jsonData)+"\n\n"); err != nil {
		return err
	}

	// Flush the response
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}

	return nil
}
